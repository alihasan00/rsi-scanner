import type { Candle, Timeframe } from '../types'
import { isValidCandle } from './rsiHistory'

export type LiquiditySource = 'month' | 'week' | 'monday'
export type PriceBar = Candle & { isClosed: boolean }

export interface LiquidityLevel {
  id: string
  label: string
  source: LiquiditySource
  price: number
  /** Inclusive UTC start of the completed source period. */
  periodStart: number
  /** Exclusive UTC end of the completed source period. */
  periodEnd: number
  availableFrom: number
}

export interface LiquidityMap {
  levels: readonly LiquidityLevel[]
  asOf: number
  warnings: readonly string[]
}

export interface LiquidityEvent {
  level: LiquidityLevel
  direction: 'bullish' | 'bearish'
  state: 'confirmed' | 'forming'
  openTime: number
  closeTime: number
  /** Zero for the latest closed candle, or for the provisional tail. */
  barsAgo: number
}

export interface LiquidityContext {
  support: LiquidityLevel | null
  resistance: LiquidityLevel | null
  atPrice: readonly LiquidityLevel[]
  events: readonly LiquidityEvent[]
}

const DAY = 86_400_000
const WEEK = 7 * DAY
const INTERVAL_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000,
  '1d': DAY, '3d': 3 * DAY, '1w': WEEK,
}

function isTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime())
}

function startOfMonth(time: number, offset = 0): number {
  const date = new Date(time)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)
}

function startOfWeek(time: number): number {
  const day = Math.floor(time / DAY) * DAY
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY
}

function expiry(level: LiquidityLevel): number {
  return level.source === 'month' ? startOfMonth(level.periodEnd, 1) : level.periodEnd + WEEK
}

function isValidLevel(level: LiquidityLevel): boolean {
  if (!Number.isFinite(level.price) || level.price <= 0
    || !isTimestamp(level.periodStart) || !isTimestamp(level.periodEnd)
    || level.availableFrom !== level.periodEnd) return false
  if (level.source === 'month') {
    return level.periodStart === startOfMonth(level.periodStart)
      && level.periodEnd === startOfMonth(level.periodStart, 1)
  }
  if (level.source === 'week' || level.source === 'monday') {
    return level.periodStart === startOfWeek(level.periodStart)
      && level.periodEnd === level.periodStart + (level.source === 'week' ? WEEK : DAY)
  }
  return false
}

function periodCandles(
  daily: ReadonlyMap<number, Candle>, start: number, end: number,
): Candle[] | null {
  const candles: Candle[] = []
  for (let time = start; time < end; time += DAY) {
    const candle = daily.get(time)
    if (!candle) return null
    candles.push(candle)
  }
  return candles.length > 0 ? candles : null
}

function makeLevel(
  source: LiquiditySource, suffix: string, price: number, start: number, end: number,
): LiquidityLevel {
  const prefix = source === 'month' ? 'Month' : source === 'week' ? 'Week' : 'Monday body'
  const names: Readonly<Record<string, string>> = { O: 'open', H: 'high', L: 'low', C: 'close', Mid: 'midpoint' }
  return {
    id: `${source}-${start}-${suffix}`, label: `${prefix} ${names[suffix]}`, source, price,
    periodStart: start, periodEnd: end, availableFrom: end,
  }
}

function ohlcLevels(
  source: 'month' | 'week', candles: readonly Candle[], start: number, end: number,
): LiquidityLevel[] {
  let high = candles[0].high
  let low = candles[0].low
  for (const candle of candles) {
    high = Math.max(high, candle.high)
    low = Math.min(low, candle.low)
  }
  return [
    makeLevel(source, 'O', candles[0].open, start, end),
    makeLevel(source, 'H', high, start, end),
    makeLevel(source, 'L', low, start, end),
    makeLevel(source, 'C', candles[candles.length - 1].close, start, end),
  ]
}

/**
 * Builds exact calendar levels from complete, closed UTC daily candles. Gaps
 * omit only the affected period; malformed or out-of-order input rejects the
 * entire map. No partial week/month or older substitute is estimated.
 */
export function buildLiquidityMap(dailyCandles: readonly Candle[], asOf: number): LiquidityMap {
  if (!isTimestamp(asOf)) {
    return { levels: [], asOf, warnings: ['The calendar clock is invalid; levels are unavailable.'] }
  }
  const daily = new Map<number, Candle>()
  let previousOpen = -1
  for (const candle of dailyCandles) {
    if (!isValidCandle(candle) || candle.openTime % DAY !== 0
      || candle.closeTime !== candle.openTime + DAY - 1 || candle.closeTime >= asOf
      || candle.openTime <= previousOpen) {
      return {
        levels: [], asOf,
        warnings: ['Daily history must contain valid, ordered, completed UTC days; levels are unavailable.'],
      }
    }
    daily.set(candle.openTime, candle)
    previousOpen = candle.openTime
  }

  const levels: LiquidityLevel[] = []
  const warnings: string[] = []
  const monthEnd = startOfMonth(asOf)
  const monthStart = startOfMonth(asOf, -1)
  const month = periodCandles(daily, monthStart, monthEnd)
  if (month) levels.push(...ohlcLevels('month', month, monthStart, monthEnd))
  else warnings.push('Previous month is incomplete in daily history; monthly levels are unavailable.')

  const weekEnd = startOfWeek(asOf)
  const weekStart = weekEnd - WEEK
  const week = periodCandles(daily, weekStart, weekEnd)
  if (week) levels.push(...ohlcLevels('week', week, weekStart, weekEnd))
  else warnings.push('Previous week is incomplete in daily history; weekly levels are unavailable.')

  // Keep last week's Monday throughout the new Monday. Replace it only when
  // the new body is final at Tuesday 00:00 UTC, never with an older fallback.
  const mondayStart = weekEnd + DAY <= asOf ? weekEnd : weekEnd - WEEK
  const mondayEnd = mondayStart + DAY
  const monday = periodCandles(daily, mondayStart, mondayEnd)?.[0]
  if (monday) {
    const bottom = Math.min(monday.open, monday.close)
    const top = Math.max(monday.open, monday.close)
    levels.push(
      makeLevel('monday', 'L', bottom, mondayStart, mondayEnd),
      makeLevel('monday', 'Mid', bottom + (top - bottom) / 2, mondayStart, mondayEnd),
      makeLevel('monday', 'H', top, mondayStart, mondayEnd),
    )
  } else warnings.push('Latest completed Monday is missing; the Monday body range is unavailable.')
  return { levels, asOf, warnings }
}

/** Calendar OHLC spans all frames; the Monday body is intraday context only. */
export function visibleLiquidityLevels(map: LiquidityMap, timeframe: Timeframe): readonly LiquidityLevel[] {
  if (!isTimestamp(map.asOf) || !INTERVAL_MS[timeframe]) return []
  return map.levels.filter((level) => isValidLevel(level)
    && level.availableFrom <= map.asOf && map.asOf < expiry(level)
    && (level.source !== 'monday' || INTERVAL_MS[timeframe] < DAY))
}

function isValidBar(bar: PriceBar, interval: number): boolean {
  return isValidCandle(bar) && typeof bar.isClosed === 'boolean'
    && bar.closeTime === bar.openTime + interval - 1
}

function isValidHistory(bars: readonly PriceBar[], interval: number): boolean {
  return bars.every((bar, index) => isValidBar(bar, interval)
    && (index === 0 || bar.openTime > bars[index - 1].closeTime)
    && (bar.isClosed || index === bars.length - 1))
}

/**
 * A final exchange update proves its close has happened; a preview proves
 * only its opening time. Advance the cached daily map's clock consistently
 * for both visible levels and reaction detection. Invalid history cannot
 * advance time or revive/expire levels.
 */
export function advanceLiquidityMap(
  map: LiquidityMap, bars: readonly PriceBar[], timeframe: Timeframe,
): LiquidityMap {
  const interval = INTERVAL_MS[timeframe]
  if (!isTimestamp(map.asOf) || !interval || !isValidHistory(bars, interval)) return map
  const last = bars[bars.length - 1]
  if (!last) return map
  const observedNow = Math.max(map.asOf, last.isClosed ? last.closeTime + 1 : last.openTime)
  return observedNow === map.asOf ? map : { ...map, asOf: observedNow }
}

/**
 * Levels change support/resistance role with live price; equal prices remain
 * separate touches. SFPs require a strict sweep/reclaim and the preceding
 * contiguous closed candle on the approach side. Only the latest three
 * closed candles and one current forming tail may produce events.
 */
export function analyzeLiquidity(
  map: LiquidityMap, bars: readonly PriceBar[], price: number, timeframe: Timeframe,
): LiquidityContext {
  const empty: LiquidityContext = { support: null, resistance: null, atPrice: [], events: [] }
  const interval = INTERVAL_MS[timeframe]
  if (!isTimestamp(map.asOf) || !Number.isFinite(price) || price <= 0 || !interval) return empty

  const currentMap = advanceLiquidityMap(map, bars, timeframe)
  const levels = visibleLiquidityLevels(currentMap, timeframe)
  let support: LiquidityLevel | null = null
  let resistance: LiquidityLevel | null = null
  const atPrice: LiquidityLevel[] = []
  for (const level of levels) {
    if (level.price === price) atPrice.push(level)
    else if (level.price < price && (!support || level.price > support.price)) support = level
    else if (level.price > price && (!resistance || level.price < resistance.price)) resistance = level
  }

  const events: LiquidityEvent[] = []
  if (!isValidHistory(bars, interval)) return { support, resistance, atPrice, events }
  const last = bars[bars.length - 1]
  const closedEnd = bars.length - (last?.isClosed === false ? 1 : 0)
  for (let index = Math.max(1, closedEnd - 3); index < bars.length; index++) {
    const bar = bars[index]
    const previous = bars[index - 1]
    if (!previous.isClosed || previous.closeTime + 1 !== bar.openTime) continue
    // A preview left behind after its interval is stale, not a live setup.
    if (!bar.isClosed && currentMap.asOf > bar.closeTime) continue
    for (const level of levels) {
      // Do not project newly published levels onto a candle that began before
      // they existed, or use a candle spanning their scheduled replacement.
      if (bar.openTime < level.availableFrom || bar.closeTime >= expiry(level)) continue
      const bullish = previous.close > level.price && bar.low < level.price && bar.close > level.price
      const bearish = previous.close < level.price && bar.high > level.price && bar.close < level.price
      if (!bullish && !bearish) continue
      events.push({
        level, direction: bullish ? 'bullish' : 'bearish',
        state: bar.isClosed ? 'confirmed' : 'forming', openTime: bar.openTime, closeTime: bar.closeTime,
        barsAgo: bar.isClosed ? closedEnd - 1 - index : 0,
      })
    }
  }
  events.sort((left, right) => right.openTime - left.openTime || left.level.price - right.level.price)
  return { support, resistance, atPrice, events }
}

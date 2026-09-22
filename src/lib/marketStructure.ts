import type { RsiBar } from '../types'
import { analyzeVolatility, getClosedPriceSuffix, getSweepQuality } from './volatility'
import type { SweepQuality } from './volatility'

export type StructureDirection = 'bullish' | 'bearish'
export interface MarketStructureOptions {
  pivotBars?: number
  atrPeriod?: number
  volumePeriod?: number
  /** ATR tolerance for grouping equal highs/lows and for retests. */
  equalToleranceAtr?: number
  retestToleranceAtr?: number
  breakBufferAtr?: number
  /** Price-percent fallback while ATR warms up or is zero. */
  fallbackTolerancePercent?: number
  maxLevelAgeBars?: number
  retestTimeoutBars?: number
  continuationTimeoutBars?: number
}

export interface StructureLevel {
  id: string
  side: 'high' | 'low'
  kind: 'swing' | 'equal'
  price: number
  low: number
  high: number
  pivotTimes: number[]
  /** Equal clusters first exist when their second pivot is confirmed. */
  confirmedAt: number
  lastConfirmedAt: number
  status: 'active' | 'swept' | 'expired'
  sweptAt: number | null
  reclaimedAt: number | null
  brokenAt: number | null
  expiredAt: number | null
  supersededBy: string | null
  ageBars: number
  sweepQuality: SweepQuality | null
  reclaimQuality: SweepQuality | null
}

export interface StructureEvent {
  id: string
  type: 'bos' | 'choch'
  direction: StructureDirection
  confirmedAt: number
  levelId: string
  price: number
  priorTrend: StructureDirection | 'neutral'
  ageBars: number
}

export interface StructureRetest {
  id: string
  eventId: string
  direction: StructureDirection
  levelPrice: number
  band: { low: number; high: number }
  breakAt: number
  retestAt: number | null
  confirmedAt: number | null
  endedAt: number | null
  state: 'awaiting-retest' | 'retested' | 'confirmed' | 'invalidated' | 'expired'
  continuationPrice: number | null
  invalidationPrice: number
  ageBars: number
}

export interface MarketStructureAnalysis {
  levels: StructureLevel[]
  events: StructureEvent[]
  retests: StructureRetest[]
  trend: StructureDirection | 'neutral'
  asOf: number | null
  atr: number | null
  relativeVolume: number | null
  closedBarCount: number
  /** True when a tracker cannot join a new history window to its previous one. */
  historyReset: boolean
  historyResetReason?: 'history-limit'
}

const DEFAULTS: Required<MarketStructureOptions> = {
  pivotBars: 3, atrPeriod: 14, volumePeriod: 20,
  equalToleranceAtr: 0.1, retestToleranceAtr: 0.25, breakBufferAtr: 0.05,
  fallbackTolerancePercent: 0.05, maxLevelAgeBars: 120,
  retestTimeoutBars: 12, continuationTimeoutBars: 8,
}

function configuration(options: MarketStructureOptions): Required<MarketStructureOptions> {
  const config = { ...DEFAULTS, ...options }
  for (const key of ['pivotBars', 'atrPeriod', 'volumePeriod', 'maxLevelAgeBars', 'retestTimeoutBars', 'continuationTimeoutBars'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new RangeError(`${key} must be a positive integer`)
  }
  for (const key of ['equalToleranceAtr', 'retestToleranceAtr', 'breakBufferAtr', 'fallbackTolerancePercent'] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw new RangeError(`${key} must be finite and non-negative`)
  }
  return config
}

function tolerance(price: number, atr: number | null, multiplier: number, fallbackPercent: number): number {
  if (multiplier === 0) return 0
  return atr !== null && atr > 0 ? atr * multiplier : price * fallbackPercent / 100
}

function strictPivot(bars: readonly RsiBar[], index: number, side: 'high' | 'low', radius: number): boolean {
  if (index < radius) return false
  const price = bars[index][side]
  for (let offset = -radius; offset <= radius; offset++) {
    if (offset === 0) continue
    if (side === 'high' ? bars[index + offset].high >= price : bars[index + offset].low <= price) return false
  }
  return true
}

/**
 * Independently implemented closed-candle structure study. Strict symmetric pivots
 * only become available after their right-hand candles close. A wick breach is a
 * sweep; reclaim requires a strict close back. BOS/CHoCH require a close across a
 * confirmed level plus the configured buffer. All timestamps are observable closes.
 */
export function analyzeMarketStructure(bars: readonly RsiBar[], options: MarketStructureOptions = {}): MarketStructureAnalysis {
  const config = configuration(options)
  const closed = getClosedPriceSuffix(bars)
  const volatility = analyzeVolatility(closed, config)
  const levels: StructureLevel[] = []
  const events: StructureEvent[] = []
  const retests: StructureRetest[] = []
  let activeLevels: StructureLevel[] = []
  let liveRetests: StructureRetest[] = []
  let trend: MarketStructureAnalysis['trend'] = 'neutral'
  const closeIndices = new Map(closed.map((bar, index) => [bar.closeTime, index]))

  for (let index = 0; index < closed.length; index++) {
    const bar = closed[index]
    const { atr, relativeVolume } = volatility.points[index]
    const crossing: StructureLevel[] = []

    for (const retest of liveRetests) {
      const bullish = retest.direction === 'bullish'
      const startIndex = closeIndices.get(retest.retestAt ?? retest.breakAt)!
      const timeout = retest.retestAt === null ? config.retestTimeoutBars : config.continuationTimeoutBars
      // A wick through invalidation wins an ambiguous OHLC candle.
      if (bullish ? bar.low < retest.invalidationPrice : bar.high > retest.invalidationPrice) {
        retest.state = 'invalidated'
        retest.endedAt = bar.closeTime
      } else if (index - startIndex > timeout) {
        retest.state = 'expired'
        retest.endedAt = bar.closeTime
      } else if (retest.state === 'awaiting-retest' && bar.low <= retest.band.high && bar.high >= retest.band.low) {
        retest.state = 'retested'
        retest.retestAt = bar.closeTime
        retest.continuationPrice = bullish ? bar.high : bar.low
      } else if (retest.state === 'retested' && (bullish ? bar.close > retest.continuationPrice! : bar.close < retest.continuationPrice!)) {
        retest.state = 'confirmed'
        retest.confirmedAt = bar.closeTime
        retest.endedAt = bar.closeTime
      }
    }
    liveRetests = liveRetests.filter((retest) => retest.state === 'awaiting-retest' || retest.state === 'retested')

    for (const level of activeLevels) {
      if (index - closeIndices.get(level.lastConfirmedAt)! > config.maxLevelAgeBars) {
        level.status = 'expired'
        level.expiredAt = bar.closeTime
        continue
      }
      const quality = getSweepQuality(bar, level.price, level.side, atr, relativeVolume)
      if (quality.breached && level.sweptAt === null) {
        level.sweptAt = bar.closeTime
        level.status = 'swept'
        level.sweepQuality = quality
      }
      if (level.sweptAt !== null && level.reclaimedAt === null && (level.side === 'high' ? bar.close < level.price : bar.close > level.price)) {
        level.reclaimedAt = bar.closeTime
        level.reclaimQuality = quality
      }
      if (level.brokenAt !== null) continue
      const buffer = tolerance(level.price, atr, config.breakBufferAtr, config.fallbackTolerancePercent)
      const threshold = level.price + (level.side === 'high' ? buffer : -buffer)
      const previousClose = closed[index - 1]?.close
      if (previousClose !== undefined && (level.side === 'high'
        ? previousClose <= threshold && bar.close > threshold
        : previousClose >= threshold && bar.close < threshold)) {
        level.brokenAt = bar.closeTime
        crossing.push(level)
      }
    }
    activeLevels = activeLevels.filter((level) => level.status !== 'expired' && level.supersededBy === null)

    // A single close through coincident/successive levels is one structural event.
    if (crossing.length > 0) {
      const level = crossing.reduce((selected, candidate) => candidate.side === 'high'
        ? (candidate.price > selected.price ? candidate : selected)
        : (candidate.price < selected.price ? candidate : selected))
      const direction: StructureDirection = level.side === 'high' ? 'bullish' : 'bearish'
      const event: StructureEvent = {
        id: `structure:${direction}:${bar.closeTime}`, type: trend !== 'neutral' && trend !== direction ? 'choch' : 'bos',
        direction, confirmedAt: bar.closeTime, levelId: level.id, price: level.price, priorTrend: trend, ageBars: 0,
      }
      events.push(event)
      trend = direction
      const width = tolerance(level.price, atr, config.retestToleranceAtr, config.fallbackTolerancePercent)
      const retest: StructureRetest = {
        id: `retest:${event.id}`, eventId: event.id, direction, levelPrice: level.price,
        band: { low: level.price - width, high: level.price + width },
        breakAt: bar.closeTime, retestAt: null, confirmedAt: null, endedAt: null, state: 'awaiting-retest',
        continuationPrice: null, invalidationPrice: level.price + (direction === 'bullish' ? -width : width), ageBars: 0,
      }
      retests.push(retest)
      liveRetests.push(retest)
    }

    const pivotIndex = index - config.pivotBars
    if (pivotIndex < config.pivotBars) continue
    const high = strictPivot(closed, pivotIndex, 'high', config.pivotBars)
    const low = strictPivot(closed, pivotIndex, 'low', config.pivotBars)
    // Outside bars do not establish the intrabar ordering of two pivots.
    if (high === low) continue
    const side = high ? 'high' : 'low'
    const price = closed[pivotIndex][side]
    const pivotTime = closed[pivotIndex].openTime
    const margin = tolerance(price, atr, config.equalToleranceAtr, config.fallbackTolerancePercent)
    const matching = activeLevels.filter((level) => level.side === side && level.brokenAt === null
      && Math.max(price, level.high) - Math.min(price, level.low) <= margin)
      .sort((first, second) => Number(second.kind === 'equal') - Number(first.kind === 'equal') || second.lastConfirmedAt - first.lastConfirmedAt)[0]
    if (matching?.kind === 'equal') {
      matching.pivotTimes.push(pivotTime)
      matching.low = Math.min(matching.low, price)
      matching.high = Math.max(matching.high, price)
      matching.price = side === 'high' ? matching.high : matching.low
      matching.lastConfirmedAt = bar.closeTime
      // A previously swept cluster is not resurrected by a new touch.
    } else {
      const level: StructureLevel = {
        id: `${matching ? 'equal' : 'swing'}:${side}:${matching?.pivotTimes[0] ?? pivotTime}`,
        side, kind: matching ? 'equal' : 'swing', price: matching ? (side === 'high' ? Math.max(matching.price, price) : Math.min(matching.price, price)) : price,
        low: matching ? Math.min(matching.price, price) : price, high: matching ? Math.max(matching.price, price) : price,
        pivotTimes: matching ? [...matching.pivotTimes, pivotTime] : [pivotTime],
        confirmedAt: bar.closeTime, lastConfirmedAt: bar.closeTime, status: 'active',
        sweptAt: null, reclaimedAt: null, brokenAt: null, expiredAt: null, supersededBy: null, ageBars: 0, sweepQuality: null, reclaimQuality: null,
      }
      if (matching) matching.supersededBy = level.id
      levels.push(level)
      activeLevels = activeLevels.filter((candidate) => candidate.supersededBy === null)
      activeLevels.push(level)
    }
  }
  const lastIndex = closed.length - 1
  for (const level of levels) level.ageBars = lastIndex - closeIndices.get(level.lastConfirmedAt)!
  for (const event of events) event.ageBars = lastIndex - closeIndices.get(event.confirmedAt)!
  for (const retest of retests) retest.ageBars = lastIndex - closeIndices.get(retest.breakAt)!
  return {
    levels, events, retests, trend, asOf: closed.at(-1)?.closeTime ?? null,
    atr: volatility.atr, relativeVolume: volatility.relativeVolume, closedBarCount: closed.length, historyReset: false,
  }
}

/**
 * Selected-symbol/session tracker: retains closed history behind rolling snapshots.
 * Overlapping corrections replay the retained history. Disconnected windows reset
 * explicitly, rather than claiming continuity through an unknown interval. Call
 * reset when market, symbol, or timeframe changes. The tracker does not persist.
 */
export function createMarketStructureTracker(options: MarketStructureOptions = {}, requestedHistoryLimit = 10_000) {
  if (!Number.isSafeInteger(requestedHistoryLimit) || requestedHistoryLimit < 1) throw new RangeError('Structure history limit must be a positive integer')
  const config = configuration(options)
  // Keep more than a full pivot/level/retest lifecycle after a bounded reset.
  // ATR is explicitly recalculated at that boundary, rather than claiming an
  // unverifiable checkpoint or exact continuity across discarded history.
  const retainedLifetime = config.maxLevelAgeBars + 2 * config.pivotBars + config.retestTimeoutBars
    + config.continuationTimeoutBars + config.atrPeriod + config.volumePeriod
  const historyLimit = Math.max(requestedHistoryLimit, 2 * retainedLifetime)
  let retained: RsiBar[] = []
  let previousAnalysis: MarketStructureAnalysis | null = null
  const equalBar = (first: RsiBar, second: RsiBar) => first.openTime === second.openTime && first.closeTime === second.closeTime
    && first.open === second.open && first.high === second.high && first.low === second.low && first.close === second.close
    && first.volume === second.volume && first.isClosed === second.isClosed
  return {
    update(bars: readonly RsiBar[]): MarketStructureAnalysis {
      const incoming = getClosedPriceSuffix(bars)
      const first = incoming[0]
      const previous = retained.at(-1)
      let historyReset = false
      let historyResetReason: MarketStructureAnalysis['historyResetReason']
      if (!first) {
        historyReset = retained.length > 0
        retained = []
      } else if (bars.indexOf(first) > 0) {
        // Never fill an explicit interruption with a previously cached candle.
        historyReset = retained.length > 0
        retained = incoming.map((bar) => ({ ...bar }))
      } else if (!previous) retained = incoming.map((bar) => ({ ...bar }))
      else {
        const overlap = retained.findIndex((bar) => bar.openTime === first.openTime)
        const contiguous = first.openTime === previous.closeTime + 1 && first.closeTime - first.openTime === previous.closeTime - previous.openTime
        if (overlap >= 0 && previousAnalysis && incoming.length === retained.length - overlap
          && incoming.every((bar, index) => equalBar(bar, retained[overlap + index]))) return previousAnalysis
        if (overlap >= 0) retained = [...retained.slice(0, overlap), ...incoming.map((bar) => ({ ...bar }))]
        else if (contiguous) retained = [...retained, ...incoming.map((bar) => ({ ...bar }))]
        else {
          retained = incoming.map((bar) => ({ ...bar }))
          historyReset = true
        }
      }
      if (retained.length > historyLimit) {
        retained = retained.slice(-Math.ceil(historyLimit / 2))
        historyReset = true
        historyResetReason = 'history-limit'
      }
      previousAnalysis = {
        ...analyzeMarketStructure(retained, options), historyReset,
        ...(historyResetReason ? { historyResetReason } : {}),
      }
      return previousAnalysis
    },
    reset() { retained = []; previousAnalysis = null },
  }
}

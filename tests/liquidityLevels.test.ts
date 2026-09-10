import { describe, expect, test } from 'bun:test'
import type { Candle, Timeframe } from '../src/types'
import {
  advanceLiquidityMap, analyzeLiquidity, buildLiquidityMap, visibleLiquidityLevels,
  type LiquidityLevel, type LiquidityMap, type PriceBar,
} from '../src/lib/liquidityLevels'

const DAY = 86_400_000
const HOUR = 3_600_000
const time = (date: string): number => Date.parse(`${date}T00:00:00Z`)

function dailyHistory(start: string, end: string): Candle[] {
  const candles: Candle[] = []
  for (let openTime = time(start); openTime < time(end); openTime += DAY) {
    candles.push({
      openTime, closeTime: openTime + DAY - 1,
      open: 100, high: 150, low: 50, close: 110, volume: 1,
    })
  }
  return candles
}

function prices(map: LiquidityMap, source: LiquidityLevel['source']): Record<string, number> {
  return Object.fromEntries(map.levels.filter((level) => level.source === source)
    .map((level) => [level.label, level.price]))
}

function weeklyMap(asOf = time('2026-09-07')): LiquidityMap {
  const map = buildLiquidityMap(dailyHistory('2026-08-01', '2026-09-07'), asOf)
  return { ...map, levels: map.levels.filter((level) => level.label === 'Week open') }
}

function hourBars(start: number, values: Partial<PriceBar>[]): PriceBar[] {
  return values.map((value, index) => ({
    openTime: start + index * HOUR, closeTime: start + (index + 1) * HOUR - 1,
    open: 95, high: 98, low: 90, close: 95, volume: 1, isClosed: true, ...value,
  }))
}

describe('closed UTC calendar liquidity', () => {
  test('aggregates the exact previous month and cross-year previous week', () => {
    const daily = dailyHistory('2025-12-01', '2026-01-05')
    daily[0].open = 90
    daily[8].high = 190
    daily[9].low = 40
    daily[30].close = 130
    daily[28].open = 105 // Monday December 29.
    daily[34].close = 120 // Sunday January 4.
    const map = buildLiquidityMap(daily, time('2026-01-05'))
    expect(prices(map, 'month')).toEqual({ 'Month open': 90, 'Month high': 190, 'Month low': 40, 'Month close': 130 })
    expect(prices(map, 'week')).toEqual({ 'Week open': 105, 'Week high': 150, 'Week low': 50, 'Week close': 120 })
    expect(map.levels.find((level) => level.label === 'Month open')).toMatchObject({
      periodStart: time('2025-12-01'), periodEnd: time('2026-01-01'), availableFrom: time('2026-01-01'),
    })
    expect(map.levels.find((level) => level.label === 'Week open')).toMatchObject({
      periodStart: time('2025-12-29'), periodEnd: time('2026-01-05'), availableFrom: time('2026-01-05'),
    })
    expect(map.warnings).toEqual([])
  })

  test('includes leap day and does not mistake 28 days for a complete leap February', () => {
    const daily = dailyHistory('2024-02-01', '2024-03-01')
    daily[28] = { ...daily[28], high: 170, close: 140 }
    expect(prices(buildLiquidityMap(daily, time('2024-03-01')), 'month'))
      .toEqual({ 'Month open': 100, 'Month high': 170, 'Month low': 50, 'Month close': 140 })
    const incomplete = buildLiquidityMap(daily.slice(0, 28), time('2024-03-01'))
    expect(prices(incomplete, 'month')).toEqual({})
    expect(incomplete.warnings.some((warning) => warning.includes('Previous month'))).toBe(true)
  })

  test('rolls month and week immediately at their UTC close', () => {
    const daily = dailyHistory('2026-02-01', '2026-04-01')
    const before = buildLiquidityMap(daily.slice(0, -1), time('2026-04-01') - 1)
    const after = buildLiquidityMap(daily, time('2026-04-01'))
    expect(before.levels.find((level) => level.source === 'month')?.periodStart).toBe(time('2026-02-01'))
    expect(after.levels.find((level) => level.source === 'month')?.periodStart).toBe(time('2026-03-01'))
    const sunday = buildLiquidityMap(dailyHistory('2026-08-01', '2026-09-06'), time('2026-09-07') - 1)
    const monday = buildLiquidityMap(dailyHistory('2026-08-01', '2026-09-07'), time('2026-09-07'))
    expect(sunday.levels.find((level) => level.source === 'week')?.periodStart).toBe(time('2026-08-24'))
    expect(monday.levels.find((level) => level.source === 'week')?.periodStart).toBe(time('2026-08-31'))
  })

  test('carries last Monday until Tuesday, then uses only the new Monday body and midpoint', () => {
    const daily = dailyHistory('2026-08-01', '2026-09-08')
    const newMonday = daily[daily.length - 1]
    Object.assign(newMonday, { open: 120, close: 80, high: 200, low: 40 })
    const monday = buildLiquidityMap(daily.slice(0, -1), time('2026-09-08') - 1)
    const tuesday = buildLiquidityMap(daily, time('2026-09-08'))
    expect(prices(monday, 'monday')).toEqual({ 'Monday body low': 100, 'Monday body midpoint': 105, 'Monday body high': 110 })
    expect(monday.levels.find((level) => level.source === 'monday')?.periodStart).toBe(time('2026-08-31'))
    expect(prices(tuesday, 'monday')).toEqual({ 'Monday body low': 80, 'Monday body midpoint': 100, 'Monday body high': 120 })
    expect(tuesday.levels.find((level) => level.source === 'monday')).toMatchObject({
      periodStart: time('2026-09-07'), periodEnd: time('2026-09-08'), availableFrom: time('2026-09-08'),
    })
  })

  test('preserves all three Monday labels when a doji has a zero-width body', () => {
    const daily = dailyHistory('2026-08-01', '2026-09-08')
    daily[daily.length - 1].close = 100
    expect(prices(buildLiquidityMap(daily, time('2026-09-08')), 'monday'))
      .toEqual({ 'Monday body low': 100, 'Monday body midpoint': 100, 'Monday body high': 100 })
  })

  test('omits only incomplete periods and never substitutes older weeks or Mondays', () => {
    const daily = dailyHistory('2026-08-01', '2026-09-10')
    const missingWeekDay = daily.filter((candle) => candle.openTime !== time('2026-09-03'))
    const map = buildLiquidityMap(missingWeekDay, time('2026-09-10'))
    expect(map.levels.filter((level) => level.source === 'month')).toHaveLength(4)
    expect(map.levels.filter((level) => level.source === 'week')).toHaveLength(0)
    expect(map.levels.filter((level) => level.source === 'monday')).toHaveLength(3)
    expect(map.warnings).toHaveLength(1)
    const missingMonday = buildLiquidityMap(daily.slice(0, -3), time('2026-09-10'))
    expect(missingMonday.levels.filter((level) => level.source === 'monday')).toHaveLength(0)
    expect(missingMonday.warnings.some((warning) => warning.includes('Monday'))).toBe(true)
  })

  test('reports each missing source without fabricating levels', () => {
    const map = buildLiquidityMap([], time('2026-09-10'))
    expect(map.levels).toEqual([])
    expect(map.warnings).toHaveLength(3)
  })

  test.each([
    { close: NaN }, { high: Infinity }, { low: 0 }, { low: 101 }, { high: 109 },
    { volume: -1 }, { openTime: time('2026-08-01') + 1 }, { closeTime: time('2026-08-02') },
  ])('rejects malformed daily input %p without producing partial confidence', (changes) => {
    const daily = dailyHistory('2026-08-01', '2026-09-10')
    daily[0] = { ...daily[0], ...changes }
    expect(buildLiquidityMap(daily, time('2026-09-10')).levels).toEqual([])
  })

  test('rejects duplicate/reversed days and a future or still-open daily candle', () => {
    const daily = dailyHistory('2026-08-01', '2026-09-10')
    expect(buildLiquidityMap([daily[0], ...daily], time('2026-09-10')).levels).toEqual([])
    expect(buildLiquidityMap([...daily].reverse(), time('2026-09-10')).levels).toEqual([])
    expect(buildLiquidityMap(daily, time('2026-09-09') + HOUR).levels).toEqual([])
  })

  test.each([NaN, Infinity, -1, 1.5])('rejects invalid calendar time %p', (asOf) => {
    expect(buildLiquidityMap([], asOf).levels).toEqual([])
    expect(buildLiquidityMap([], asOf).warnings).toHaveLength(1)
  })
})

describe('liquidity visibility and live role', () => {
  const map = buildLiquidityMap(dailyHistory('2026-08-01', '2026-09-10'), time('2026-09-10'))

  test.each(['1d', '3d', '1w'] satisfies Timeframe[])('hides Monday on %s', (timeframe) => {
    expect(visibleLiquidityLevels(map, timeframe)).toHaveLength(8)
    expect(visibleLiquidityLevels(map, timeframe).some((level) => level.source === 'monday')).toBe(false)
  })

  test('shows all calendar levels intraday and separates exact touches including shared prices', () => {
    expect(visibleLiquidityLevels(map, '4h')).toHaveLength(11)
    const context = analyzeLiquidity(map, [], 100, '1h')
    expect(context.support?.price).toBe(50)
    expect(context.resistance?.price).toBe(105)
    expect(context.atPrice.map((level) => level.label)).toEqual(['Month open', 'Week open', 'Monday body low'])
    expect(context.events).toEqual([])
  })

  test('keeps a crossed level and flips its role with live price', () => {
    const single = weeklyMap()
    expect(analyzeLiquidity(single, [], 95, '1h').resistance?.price).toBe(100)
    expect(analyzeLiquidity(single, [], 105, '1h').support?.price).toBe(100)
    expect(analyzeLiquidity(single, [], 100, '1h')).toMatchObject({
      support: null, resistance: null, atPrice: single.levels,
    })
    expect(analyzeLiquidity(single, [], 95, '1h').resistance?.price).toBe(100)
  })

  test.each([0, -1, NaN, Infinity])('does not classify levels with invalid live price %p', (price) => {
    expect(analyzeLiquidity(map, [], price, '1h')).toEqual({
      support: null, resistance: null, atPrice: [], events: [],
    })
  })
})

describe('strict closed and provisional swing failures', () => {
  const start = time('2026-09-08')

  test('confirms bearish and bullish wick/reclaims against an existing level', () => {
    const bearish = hourBars(start, [{}, { high: 105, close: 96 }])
    expect(analyzeLiquidity(weeklyMap(), bearish, 96, '1h').events).toMatchObject([{
      direction: 'bearish', state: 'confirmed', openTime: start + HOUR,
      closeTime: start + 2 * HOUR - 1, barsAgo: 0,
    }])
    const bullish = hourBars(start, [
      { open: 105, close: 105, high: 110, low: 102 },
      { open: 105, close: 106, high: 110, low: 95 },
    ])
    expect(analyzeLiquidity(weeklyMap(), bullish, 106, '1h').events).toMatchObject([{
      direction: 'bullish', state: 'confirmed', barsAgo: 0,
    }])
  })

  test('a forming sweep is provisional and its retraction removes the event', () => {
    const bars = hourBars(start, [{}, { high: 105, close: 96, isClosed: false }])
    expect(analyzeLiquidity(weeklyMap(), bars, 96, '1h').events).toMatchObject([{
      direction: 'bearish', state: 'forming', barsAgo: 0,
    }])
    bars[1] = { ...bars[1], close: 102 }
    expect(analyzeLiquidity(weeklyMap(), bars, 102, '1h').events).toEqual([])
    bars[1] = { ...bars[1], close: 96, isClosed: true }
    expect(analyzeLiquidity(weeklyMap(), bars, 96, '1h').events[0].state).toBe('confirmed')
  })

  test('excludes touches, equal closes, and approaches starting exactly on the level', () => {
    const map = weeklyMap()
    expect(analyzeLiquidity(map, hourBars(start, [{}, { high: 100 }]), 95, '1h').events).toEqual([])
    expect(analyzeLiquidity(map, hourBars(start, [{}, { high: 105, close: 100 }]), 100, '1h').events).toEqual([])
    expect(analyzeLiquidity(map, hourBars(start, [{ high: 100, close: 100 }, { high: 105 }]), 95, '1h').events)
      .toEqual([])
    const wrongApproach = hourBars(start, [{ open: 105, high: 110, low: 102, close: 105 }, { high: 105 }])
    expect(analyzeLiquidity(map, wrongApproach, 95, '1h').events).toEqual([])
  })

  test('reports only the latest three closed bars and the single forming tail, newest first', () => {
    const bars = hourBars(start, [{}, ...Array.from({ length: 5 }, () => ({ high: 105 }))])
    const events = analyzeLiquidity(weeklyMap(), bars, 95, '1h').events
    expect(events.map((event) => event.openTime)).toEqual([start + 5 * HOUR, start + 4 * HOUR, start + 3 * HOUR])
    expect(events.map((event) => event.barsAgo)).toEqual([0, 1, 2])
    bars.push(...hourBars(start + 6 * HOUR, [{ high: 105, isClosed: false }]))
    expect(analyzeLiquidity(weeklyMap(), bars, 95, '1h').events.map((event) => [event.state, event.barsAgo]))
      .toEqual([['forming', 0], ['confirmed', 0], ['confirmed', 1], ['confirmed', 2]])
  })

  test('requires a contiguous previous close and never bridges a history gap', () => {
    const bars = hourBars(start, [{}, {}, { high: 105 }])
    expect(analyzeLiquidity(weeklyMap(), [bars[0], bars[2]], 95, '1h').events).toEqual([])
    expect(analyzeLiquidity(weeklyMap(), [bars[2]], 95, '1h').events).toEqual([])
  })

  test('does not backdate new weekly levels into a candle beginning before availability', () => {
    const startOfAvailability = time('2026-09-07')
    const bars = hourBars(startOfAvailability - 2 * HOUR, [{}, { high: 105 }])
    expect(analyzeLiquidity(weeklyMap(), bars, 95, '1h').events).toEqual([])
    bars.push(...hourBars(startOfAvailability, [{ high: 105 }]))
    expect(analyzeLiquidity(weeklyMap(), bars, 95, '1h').events).toHaveLength(1)
    expect(analyzeLiquidity(weeklyMap(), bars, 95, '1h').events[0].openTime).toBe(startOfAvailability)
  })

  test('does not project a newly available Monday range onto its own formation', () => {
    const map = buildLiquidityMap(dailyHistory('2026-08-01', '2026-09-08'), time('2026-09-08'))
    const mondayOnly = { ...map, levels: map.levels.filter((level) => level.source === 'monday') }
    const mondayBars = hourBars(time('2026-09-07') + 22 * HOUR, [{}, { high: 115 }])
    expect(analyzeLiquidity(mondayOnly, mondayBars, 95, '1h').events).toEqual([])
  })

  test('expires a stale weekly map using the observed display-candle clock', () => {
    const bars = hourBars(time('2026-09-14') - HOUR, [{}, { high: 105, isClosed: false }])
    const map = weeklyMap()
    const advanced = advanceLiquidityMap(map, bars, '1h')
    expect(advanced.asOf).toBe(time('2026-09-14'))
    expect(map.asOf).toBe(time('2026-09-07'))
    expect(visibleLiquidityLevels(advanced, '1h')).toEqual([])
    expect(analyzeLiquidity(map, bars, 95, '1h')).toEqual({
      support: null, resistance: null, atPrice: [], events: [],
    })
  })

  test('advances the map clock to a final close but only to a preview opening', () => {
    const bars = hourBars(start, [{}, { high: 105 }])
    expect(advanceLiquidityMap(weeklyMap(), bars, '1h').asOf).toBe(start + 2 * HOUR)
    bars[1].isClosed = false
    expect(advanceLiquidityMap(weeklyMap(), bars, '1h').asOf).toBe(start + HOUR)
    const laterMap = weeklyMap(start + HOUR + 1_000)
    expect(advanceLiquidityMap(laterMap, bars, '1h')).toBe(laterMap)
  })

  test('invalid or overlapping history cannot advance the shared visibility clock', () => {
    const bars = hourBars(start, [{}, { high: 105 }])
    const map = weeklyMap()
    expect(advanceLiquidityMap(map, [bars[1], bars[0]], '1h')).toBe(map)
    expect(advanceLiquidityMap(map, [{ ...bars[0], close: NaN }, bars[1]], '1h')).toBe(map)
    const overlapping = { ...bars[1], openTime: start + HOUR / 2, closeTime: start + HOUR * 1.5 - 1 }
    expect(advanceLiquidityMap(map, [bars[0], overlapping], '1h')).toBe(map)
    expect(analyzeLiquidity(map, [bars[0], overlapping], 95, '1h').events).toEqual([])
  })

  test('expires Monday at the next Tuesday and monthly levels at the next month', () => {
    const map = buildLiquidityMap(dailyHistory('2026-08-01', '2026-09-10'), time('2026-09-10'))
    expect(visibleLiquidityLevels({ ...map, asOf: time('2026-09-15') }, '1h')
      .some((level) => level.source === 'monday')).toBe(false)
    expect(visibleLiquidityLevels({ ...map, asOf: time('2026-10-01') }, '1h')).toEqual([])
  })

  test('does not confirm across a calendar replacement within a multi-day candle', () => {
    const bars = hourBars(time('2026-09-12'), [{}, { high: 105 }]).map((bar, index) => ({
      ...bar, openTime: time('2026-09-09') + index * 3 * DAY,
      closeTime: time('2026-09-09') + (index + 1) * 3 * DAY - 1,
    }))
    expect(analyzeLiquidity(weeklyMap(), bars, 95, '3d').events).toEqual([])
  })

  test.each([
    { close: NaN }, { high: Infinity }, { high: 90 }, { volume: -1 }, { closeTime: start + 3 * HOUR },
  ])('never confirms invalid candle input %p', (change) => {
    const bars = hourBars(start, [{}, { high: 105, ...change }])
    expect(analyzeLiquidity(weeklyMap(), bars, 95, '1h').events).toEqual([])
  })

  test('rejects out-of-order or duplicate display candles and an unfinished interior bar', () => {
    const bars = hourBars(start, [{}, { high: 105 }])
    expect(analyzeLiquidity(weeklyMap(), [bars[1], bars[0]], 95, '1h').events).toEqual([])
    expect(analyzeLiquidity(weeklyMap(), [bars[0], bars[0], bars[1]], 95, '1h').events).toEqual([])
    expect(analyzeLiquidity(weeklyMap(), [{ ...bars[0], isClosed: false }, bars[1]], 95, '1h').events).toEqual([])
  })

  test('does not label a stale unfinished candle as forming', () => {
    const bars = hourBars(start, [{}, { high: 105, isClosed: false }])
    expect(analyzeLiquidity(weeklyMap(start + 3 * HOUR), bars, 95, '1h').events).toEqual([])
  })

  test('preserves caller-owned candles and maps', () => {
    const daily = dailyHistory('2026-08-01', '2026-09-10')
    daily.forEach(Object.freeze)
    Object.freeze(daily)
    const map = buildLiquidityMap(daily, time('2026-09-10'))
    const original = structuredClone(map)
    map.levels.forEach(Object.freeze)
    Object.freeze(map.levels)
    Object.freeze(map)
    const bars = hourBars(time('2026-09-10'), [{}, { high: 105 }])
    bars.forEach(Object.freeze)
    Object.freeze(bars)
    analyzeLiquidity(map, bars, 95, '1h')
    expect(map).toEqual(original)
  })
})

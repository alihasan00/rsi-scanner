import { describe, expect, test } from 'bun:test'
import {
  filterLiquidityRows, levelDistancePercent, makeLiquidityRow, nearestLiquidityDistance,
  type LiquidityRow,
} from '../src/lib/liquidityScreener'
import type { LiquidityLevel, LiquidityMap, LiquiditySource } from '../src/lib/liquidityLevels'
import type { ScreenerRow } from '../src/lib/screener'
import { DEFAULT_SCREENER_PREFERENCES } from '../src/lib/screenerPreferences'
import type { ScreenerFilterPreferences } from '../src/lib/screenerPreferences'
import type { SrContextSnapshot } from '../src/store/srContextStore'
import type { RsiBar } from '../src/types'

const HOUR = 3_600_000
const time = (date: string): number => Date.parse(`${date}T00:00:00Z`)
const START = time('2026-09-10')
type Filters = Parameters<typeof filterLiquidityRows>[1]

function level(source: LiquiditySource = 'week', price = 100): LiquidityLevel {
  const [periodStart, periodEnd] = source === 'month'
    ? [time('2026-08-01'), time('2026-09-01')]
    : source === 'week' ? [time('2026-08-31'), time('2026-09-07')]
      : [time('2026-09-07'), time('2026-09-08')]
  return { id: `${source}-${price}`, label: `${source} level`, source, price, periodStart, periodEnd, availableFrom: periodEnd }
}

function bars(values: Partial<RsiBar>[], start = START): RsiBar[] {
  return values.map((value, index) => ({
    openTime: start + index * HOUR, closeTime: start + (index + 1) * HOUR - 1,
    open: 95, high: 98, low: 90, close: 95, volume: 1, rsi: 50, isClosed: true,
    ...value,
  }))
}

function row(symbol: string, price = 100, candles: RsiBar[] = []): ScreenerRow {
  return {
    symbol, snapshot: { price, bars: candles, series: candles.map((bar) => bar.rsi), volume: 1 },
    analysis: { divergences: [] }, feed: { state: 'ready', error: null, updatedAt: START },
  }
}

function history(levels: readonly LiquidityLevel[] = [level()], asOf = START): SrContextSnapshot {
  const map: LiquidityMap = { levels, asOf, warnings: [] }
  return { map, status: 'ready', error: null, updatedAt: asOf }
}

function screenRow(symbol: string, price = 100, candles: RsiBar[] = [], levels = [level()]): LiquidityRow {
  return makeLiquidityRow(row(symbol, price, candles), history(levels), 'all', '1h')
}

function filter(rows: readonly LiquidityRow[], patch: Partial<Filters> = {}, starred: string[] = []): string[] {
  return filterLiquidityRows(rows, { ...DEFAULT_SCREENER_PREFERENCES, ...patch }, starred)
    .map((item) => item.row.symbol)
}

describe('calendar source selection before analysis', () => {
  test('selects the source before finding nearest levels and detecting sweeps', () => {
    const display = row('BTCUSDT', 100, bars([
      { open: 99.5, high: 99.8, low: 99, close: 99.5 },
      { open: 99.5, high: 100.5, low: 99.3, close: 99.5 },
    ]))
    const context = history([level('month', 99), level('week', 100.2), level('monday', 101)])
    const all = makeLiquidityRow(display, context, 'all', '1h')
    expect(all.context.support?.source).toBe('month')
    expect(all.context.resistance?.source).toBe('week')
    expect(all.context.events.map((event) => event.level.source)).toEqual(['week'])

    const monthly = makeLiquidityRow(display, context, 'month', '1h')
    expect(monthly.levels.map((item) => item.source)).toEqual(['month'])
    expect(monthly.context.support?.price).toBe(99)
    expect(monthly.context.resistance).toBeNull()
    expect(monthly.context.events).toEqual([])
    expect(filter([monthly], { srSource: 'month', srSignal: 'sfp' })).toEqual([])

    const weekly = makeLiquidityRow(display, context, 'week', '1h')
    expect(weekly.context.support).toBeNull()
    expect(weekly.context.resistance?.price).toBe(100.2)
    expect(filter([weekly], { srSource: 'week', srSignal: 'bearish' })).toEqual(['BTCUSDT'])
  })

  test('omits a ready row when the selected source has no visible levels on that timeframe', () => {
    const mondayDaily = makeLiquidityRow(row('BTCUSDT'), history([level('monday')]), 'monday', '1d')
    const mondayIntraday = makeLiquidityRow(row('ETHUSDT'), history([level('monday')]), 'monday', '1h')
    expect(filter([mondayDaily, mondayIntraday], { srSource: 'monday' })).toEqual(['ETHUSDT'])
  })

  test('keeps visible levels and events consistent when display bars advance past calendar expiry', () => {
    const display = row('BTCUSDT', 95, bars([{}, { high: 105 }], time('2026-09-14')))
    const item = makeLiquidityRow(display, history([level()], time('2026-09-07')), 'week', '1h')
    expect(item.map?.asOf).toBe(time('2026-09-14') + 2 * HOUR)
    expect(item.levels).toEqual([])
    expect(item.context).toEqual({ support: null, resistance: null, atPrice: [], events: [] })
    expect(nearestLiquidityDistance(item)).toBe(Infinity)
    expect(filter([item], { srSource: 'week' })).toEqual([])
    expect(filter([item], { srSignal: 'sfp' })).toEqual([])
  })
})

describe('liquidity filter composition', () => {
  test('includes exactly 0.5% on either side, includes exact touches, and excludes farther levels', () => {
    const items = [
      screenRow('ABOVEUSDT', 200, [], [level('week', 201)]),
      screenRow('BELOWUSDT', 200, [], [level('week', 199)]),
      screenRow('FARUSDT', 200, [], [level('week', 201.0001)]),
      screenRow('TOUCHUSDT', 200, [], [level('week', 200)]),
      makeLiquidityRow(row('EMPTYUSDT', 200), history([]), 'all', '1h'),
    ]
    expect(levelDistancePercent(level('week', 201), 200)).toBe(0.5)
    expect(filter(items, { srSignal: 'near', srSort: 'symbol' })).toEqual(['ABOVEUSDT', 'BELOWUSDT', 'TOUCHUSDT'])
    expect(nearestLiquidityDistance(items[3])).toBe(0)
  })

  test('composes normalized search, favorites, and proximity rather than replacing any filter', () => {
    const items = [screenRow('BTCUSDT'), screenRow('ETHUSDT'), screenRow('ETHBTC')]
    expect(filter(items, { search: ' eth / usdt ', starredOnly: true, srSignal: 'near' }, ['BTCUSDT', 'ETHUSDT']))
      .toEqual(['ETHUSDT'])
    expect(filter(items, { search: 'eth-usdt', starredOnly: true, srSignal: 'near' }, ['BTCUSDT'])).toEqual([])
    expect(filter(items, { search: 'ETH', srSort: 'symbol' })).toEqual(['ETHBTC', 'ETHUSDT'])
  })

  test('forming sweeps remain visible in all/near views but never enter confirmed sweep filters', () => {
    const item = screenRow('BTCUSDT', 100, bars([{}, { high: 105, isClosed: false }]))
    expect(item.context.events.map((event) => event.state)).toEqual(['forming'])
    expect(filter([item])).toEqual(['BTCUSDT'])
    expect(filter([item], { srSignal: 'near' })).toEqual(['BTCUSDT'])
    for (const srSignal of ['sfp', 'bullish', 'bearish'] satisfies ScreenerFilterPreferences['srSignal'][]) {
      expect(filter([item], { srSignal })).toEqual([])
    }
  })

  test('filters confirmed sweeps by direction and allows a pair with recent sweeps in both directions', () => {
    const bearish = screenRow('BEARUSDT', 95, bars([{}, { high: 105 }]))
    const bullish = screenRow('BULLUSDT', 105, bars([
      { open: 105, high: 110, low: 102, close: 105 },
      { open: 105, high: 110, low: 95, close: 105 },
    ]))
    const both = screenRow('BOTHUSDT', 105, bars([
      {}, { high: 105 },
      { open: 105, high: 110, low: 102, close: 105 },
      { open: 105, high: 110, low: 95, close: 105 },
    ]))
    const items = [bearish, bullish, both]
    expect(filter(items, { srSignal: 'bearish', srSort: 'symbol' })).toEqual(['BEARUSDT', 'BOTHUSDT'])
    expect(filter(items, { srSignal: 'bullish', srSort: 'symbol' })).toEqual(['BOTHUSDT', 'BULLUSDT'])
    expect(filter(items, { srSignal: 'sfp', srSort: 'symbol' })).toEqual(['BEARUSDT', 'BOTHUSDT', 'BULLUSDT'])
  })

  test.each(['loading', 'error'] as const)('excludes %s calendar/display feeds from actionable filters', (state) => {
    const display = row('BTCUSDT', 100, bars([{}, { high: 105 }]))
    const calendarError = makeLiquidityRow(display, { ...history(), status: state, error: 'Unavailable' }, 'all', '1h')
    const displayError = makeLiquidityRow({
      ...display, symbol: 'ETHUSDT', feed: { state, updatedAt: START, error: 'Unavailable' },
    }, history(), 'all', '1h')
    for (const srSignal of ['near', 'sfp', 'bullish', 'bearish'] satisfies ScreenerFilterPreferences['srSignal'][]) {
      expect(filter([calendarError, displayError], { srSignal })).toEqual([])
    }
    // The unfiltered view retains these pairs so their loading/error status can be shown.
    expect(filter([calendarError, displayError], { srSort: 'symbol' })).toEqual(['BTCUSDT', 'ETHUSDT'])
  })

  test('missing context never qualifies as a nearby level or a confirmed sweep', () => {
    const item = makeLiquidityRow(row('BTCUSDT'), {
      status: 'loading', map: null, error: null, updatedAt: null,
    }, 'all', '1h')
    expect(item.map).toBeNull()
    expect(item.levels).toEqual([])
    expect(filter([item], { srSignal: 'near' })).toEqual([])
    expect(filter([item], { srSignal: 'sfp' })).toEqual([])
  })
})

describe('liquidity sorting', () => {
  test('preserves incoming order by default, including unloaded pairs and filtered subsets, with explicit sorts available', () => {
    const items = [
      makeLiquidityRow(row('EMPTYUSDT', 200), {
        status: 'loading', map: null, error: null, updatedAt: null,
      }, 'all', '1h'),
      screenRow('ZETAUSDT', 200, [], [level('week', 201)]),
      screenRow('ALPHAUSDT', 200, [], [level('week', 199)]),
      screenRow('NEARUSDT', 200, [], [level('week', 200.1)]),
    ]
    const original = [...items]
    Object.freeze(items)
    expect(filter(items)).toEqual(['EMPTYUSDT', 'ZETAUSDT', 'ALPHAUSDT', 'NEARUSDT'])
    expect(filter(items, { srSort: 'watchlist' })).toEqual(['EMPTYUSDT', 'ZETAUSDT', 'ALPHAUSDT', 'NEARUSDT'])
    expect(filter(items, { srSignal: 'near' })).toEqual(['ZETAUSDT', 'ALPHAUSDT', 'NEARUSDT'])
    expect(filter(items, { srSort: 'nearest' })).toEqual(['NEARUSDT', 'ALPHAUSDT', 'ZETAUSDT', 'EMPTYUSDT'])
    expect(filter(items, { srSort: 'symbol' })).toEqual(['ALPHAUSDT', 'EMPTYUSDT', 'NEARUSDT', 'ZETAUSDT'])
    expect(items).toEqual(original)
  })

  test('ranks newer confirmed sweeps ahead of older ones, then uses proximity and symbol', () => {
    const fresh = screenRow('FRESHUSDT', 120, bars([{}, { high: 105 }]))
    const older = screenRow('OLDERUSDT', 110, bars([{}, { high: 105 }, {}, {}]))
    const forming = screenRow('FORMINGUSDT', 100, bars([{}, { high: 105, isClosed: false }]))
    const quiet = screenRow('QUIETUSDT', 100.1)
    const tie = screenRow('ALPHAUSDT', 100)
    const items = [quiet, forming, older, fresh, tie]
    expect(filter(items, { srSort: 'signals' })).toEqual(['FRESHUSDT', 'OLDERUSDT', 'ALPHAUSDT', 'FORMINGUSDT', 'QUIETUSDT'])
    expect(filter(items, { srSort: 'nearest' })).toEqual(['ALPHAUSDT', 'FORMINGUSDT', 'QUIETUSDT', 'OLDERUSDT', 'FRESHUSDT'])
  })

  test('does not award a confirmed-sweep ranking to cached events behind a failed feed', () => {
    const display = row('FAILEDUSDT', 100, bars([{}, { high: 105 }]))
    const failed = makeLiquidityRow(display, { ...history(), status: 'error', error: 'Disconnected' }, 'all', '1h')
    const good = screenRow('GOODUSDT', 110, bars([{}, { high: 105 }, {}, {}]))
    expect(filter([failed, good], { srSort: 'signals' })).toEqual(['GOODUSDT', 'FAILEDUSDT'])
  })
})

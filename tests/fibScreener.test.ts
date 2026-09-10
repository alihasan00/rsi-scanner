import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import type { DivergenceSetup } from '../src/lib/divergenceLifecycle'
import { analyzeFibonacci } from '../src/lib/fibonacci'
import type { FibAnalysis, FibDirection, FibStatus } from '../src/lib/fibonacci'
import { DEFAULT_FIB_SETTINGS } from '../src/lib/fibPreferences'
import type { FibSettings } from '../src/lib/fibPreferences'
import { getFibAnalysis, matchesFibFilters } from '../src/lib/fibScreener'
import { filterScreenerRows } from '../src/lib/screener'
import type { ScreenerFilters, ScreenerRow } from '../src/lib/screener'

function bar(index: number, close = 100, patch: Partial<RsiBar> = {}): RsiBar {
  return {
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: close, high: close + 1, low: close - 1, close,
    volume: 10, rsi: 50, isClosed: true, ...patch,
  }
}

/** Origin 89, prior resistance 111, break at 112, confirmed endpoint 121. */
function impulse(direction: FibDirection = 'long'): RsiBar[] {
  const closes = [100, 102, 104, 106, 110, 106, 104, 102, 90, 100, 106, 112, 120, 118, 116, 114]
  return closes.map((close, index) => {
    const candle = bar(index, close)
    return direction === 'long' ? candle : {
      ...candle, open: 240 - candle.open, high: 240 - candle.low,
      low: 240 - candle.high, close: 240 - candle.close,
    }
  })
}

function fixture(
  status: FibStatus = 'watching',
  direction: FibDirection = 'long',
  smaConfluence: FibAnalysis['smaConfluence'] = 'unavailable',
): FibAnalysis {
  const analysis = analyzeFibonacci(impulse(direction))
  if (!analysis.setup) throw new Error('Synthetic impulse must produce a confirmed Fib setup')
  // Selection only depends on plan status; lifecycle transitions are engine-tested.
  const setup = { ...analysis.setup, status }
  return { ...analysis, setup, setups: [setup], smaConfluence }
}

function divergence(state: 'forming' | 'confirmed', barsElapsed = 0): DivergenceSetup {
  return {
    id: `rsi-${state}-${barsElapsed}`, kind: 'regular-bullish', state,
    start: { time: 300_000, price: 100, rsi: 20 }, end: { time: 600_000, price: 95, rsi: 30 },
    detectedAt: 659_999, confirmedAt: state === 'confirmed' ? 719_999 : null,
    resolvedAt: null, confirmation: state === 'confirmed' ? 'ordinary' : null,
    barsElapsed, expiryBars: 14, invalidationAnchor: 'second', invalidationRsi: 30, resolutionReason: null,
  }
}

function row(
  symbol: string, fib: FibAnalysis | undefined = fixture(), price = 114,
  rsi = 50, divergences: DivergenceSetup[] = [],
): ScreenerRow {
  const bars = [bar(0, 114, { rsi: 75 }), bar(1, price, { rsi, isClosed: false })]
  return {
    symbol, fib, analysis: { divergences },
    snapshot: { bars, price, volume: 10, series: bars.map((candle) => candle.rsi) },
    feed: { state: 'ready', updatedAt: bars[0].closeTime, error: null },
  }
}

function symbols(rows: readonly ScreenerRow[], patch: Partial<ScreenerFilters> = {}): string[] {
  return filterScreenerRows(rows, {
    signal: 'fib', search: '', starredOnly: false, starredSymbols: [], sort: 'watchlist', ...patch,
  }).map((item) => item.symbol)
}

describe('Fib screener closed-history cache', () => {
  test('live ticks reuse the plan while a closed entry candle recomputes and consumes the entry', () => {
    const history = impulse()
    const initial = getFibAnalysis('FIB-CACHE-LIVE', history, DEFAULT_FIB_SETTINGS)
    expect(initial.setup?.status).toBe('watching')
    expect(initial.setup?.entries.every((entry) => entry.filledAt === null)).toBe(true)
    const before = structuredClone(initial)
    const live = bar(16, 101, { open: 104, high: 105, low: 100, isClosed: false })
    for (const close of [104, 101, 80, NaN]) {
      expect(getFibAnalysis('FIB-CACHE-LIVE', [...history, { ...live, close }], { ...DEFAULT_FIB_SETTINGS })).toBe(initial)
    }
    expect(matchesFibFilters(initial, 101, { fibStage: 'pocket' })).toBe(true)
    expect(matchesFibFilters(initial, 104, { fibStage: 'pocket' })).toBe(false)
    expect(initial).toEqual(before)

    const closed = { ...live, isClosed: true }
    const entered = getFibAnalysis('FIB-CACHE-LIVE', [...history, closed], DEFAULT_FIB_SETTINGS)
    expect(entered).not.toBe(initial)
    expect(entered.closedBars).toBe(17)
    expect(entered.setup?.status).toBe('entered')
    expect(entered.setup?.entries[0].filledAt).toBe(closed.closeTime)
    expect(entered.setup?.entries.slice(1).every((entry) => entry.filledAt === null)).toBe(true)
    expect(getFibAnalysis('FIB-CACHE-LIVE', [...history, closed, bar(17, 105, { isClosed: false })], DEFAULT_FIB_SETTINGS)).toBe(entered)
    expect(initial).toEqual(before)
  })

  test('same-length anchor corrections invalidate analysis while the unchanged latest candle is retained', () => {
    const history = impulse()
    const initial = getFibAnalysis('FIB-CACHE-CORRECTION', history, DEFAULT_FIB_SETTINGS)
    const corrected = history.map((candle, index) => index === 8 ? { ...candle, low: 88 } : candle)
    expect(corrected.at(-1)).toBe(history.at(-1))
    const updated = getFibAnalysis('FIB-CACHE-CORRECTION', corrected, DEFAULT_FIB_SETTINGS)
    expect(updated).not.toBe(initial)
    expect(initial.setup?.start.price).toBe(89)
    expect(updated.setup?.start.price).toBe(88)
    expect(updated.setup?.entries[0].price).toBeCloseTo(121 - 33 * 0.618)
    expect(getFibAnalysis('FIB-CACHE-CORRECTION', [...corrected], { ...DEFAULT_FIB_SETTINGS })).toBe(updated)
  })

  test('an interior provisional candle invalidates the cache and prevents a plan from bridging missing history', () => {
    const history = impulse()
    const initial = getFibAnalysis('FIB-CACHE-GAP', history, DEFAULT_FIB_SETTINGS)
    const gap = history.map((candle, index) => index === 8 ? { ...candle, isClosed: false } : candle)
    const interrupted = getFibAnalysis('FIB-CACHE-GAP', gap, DEFAULT_FIB_SETTINGS)
    expect(interrupted).not.toBe(initial)
    expect(interrupted).toMatchObject({ setup: null, closedBars: 7, historyIssue: 'gap' })
    expect(interrupted.lastClosedAt).toBe(initial.lastClosedAt)
    expect(matchesFibFilters(interrupted, 100, {})).toBe(false)
    const recovered = getFibAnalysis('FIB-CACHE-GAP', history, DEFAULT_FIB_SETTINGS)
    expect(recovered).not.toBe(interrupted)
    expect(recovered).toEqual(initial)
  })

  test('removed interior timestamps and truncated history also invalidate a prior setup', () => {
    const history = impulse()
    const initial = getFibAnalysis('FIB-CACHE-MISSING', history, DEFAULT_FIB_SETTINGS)
    const missing = getFibAnalysis('FIB-CACHE-MISSING', history.filter((_, index) => index !== 8), DEFAULT_FIB_SETTINGS)
    expect(missing).not.toBe(initial)
    expect(missing).toMatchObject({ setup: null, closedBars: 7, historyIssue: 'gap' })
    const reset = getFibAnalysis('FIB-CACHE-MISSING', [], DEFAULT_FIB_SETTINGS)
    expect(reset).toMatchObject({ setup: null, closedBars: 0, lastClosedAt: null, historyIssue: null })
  })

  test.each([
    { setting: 'scale', patch: { scale: 'log' } },
    { setting: 'stop', patch: { stopRatio: 1.04 } },
    { setting: 'TP3', patch: { tp3Ratio: 0 } },
    { setting: 'TP4', patch: { tp4Ratio: -0.5 } },
    { setting: 'runner', patch: { runnerRatio: -1 } },
  ] satisfies { setting: string; patch: Partial<FibSettings> }[])(
    'changing $setting invalidates the cached template and changes its actual prices', ({ setting, patch }) => {
      const history = impulse()
      const symbol = `FIB-CACHE-SETTING-${setting}`
      const initial = getFibAnalysis(symbol, history, DEFAULT_FIB_SETTINGS)
      const settings = { ...DEFAULT_FIB_SETTINGS, ...patch }
      const updated = getFibAnalysis(symbol, history, settings)
      expect(updated).not.toBe(initial)
      expect(updated.setup).not.toBeNull()
      if (setting === 'scale') {
        expect(updated.setup?.scale).toBe('log')
        expect(updated.setup?.entries[0].price).not.toBe(initial.setup?.entries[0].price)
      } else if (setting === 'stop') {
        expect(updated.setup?.stopRatio).toBe(1.04)
        expect(updated.setup?.initialStop).toBeCloseTo(87.72)
      } else {
        const id = setting.toLowerCase()
        expect(updated.setup?.targets.find((target) => target.id === id)?.price)
          .not.toBe(initial.setup?.targets.find((target) => target.id === id)?.price)
      }
      expect(getFibAnalysis(symbol, [...history], { ...settings })).toBe(updated)
    },
  )

  test('different market/timeframe cache identities do not overwrite each other', () => {
    const long = impulse('long')
    const short = impulse('short')
    const spot = getFibAnalysis('spot:15m:CACHEUSDT', long, DEFAULT_FIB_SETTINGS)
    const tradfi = getFibAnalysis('tradfi:15m:CACHEUSDT', short, DEFAULT_FIB_SETTINGS)
    expect(spot.setup?.direction).toBe('long')
    expect(tradfi.setup?.direction).toBe('short')
    expect(getFibAnalysis('spot:15m:CACHEUSDT', long, DEFAULT_FIB_SETTINGS)).toBe(spot)
  })
})

describe('Fib setup selection', () => {
  test.each(['watching', 'entered', 'managing', 'runner'] as const)('accepts %s without confusing waiting with a filled position', (status) => {
    const analysis = fixture(status)
    expect(matchesFibFilters(analysis, 114, {})).toBe(true)
    expect(matchesFibFilters(analysis, 114, { fibStage: 'any', fibDirection: 'any', fibConfluence: 'any' })).toBe(true)
    expect(matchesFibFilters(analysis, 114, { fibStage: 'waiting' })).toBe(status === 'watching')
    expect(matchesFibFilters(analysis, 114, { fibStage: 'active' })).toBe(status !== 'watching')
  })

  test.each(['stopped', 'missed', 'invalidated', 'superseded'] as const)('never offers %s chart context as a fresh Fib signal', (status) => {
    const analysis = fixture(status, 'long', 'aligned')
    for (const fibStage of ['any', 'waiting', 'active', 'pocket'] as const) {
      expect(matchesFibFilters(analysis, 100, { fibStage, fibConfluence: 'aligned' })).toBe(false)
      expect(symbols([row('TERMINAL', analysis, 100, 20, [divergence('confirmed')])], { fibStage })).toEqual([])
    }
  })

  test('missing analysis, absent setup, and unloaded snapshots cannot match Fib signals', () => {
    const absent = analyzeFibonacci([])
    expect(matchesFibFilters(undefined, 100, {})).toBe(false)
    expect(matchesFibFilters(absent, 100, {})).toBe(false)
    const missing = { ...row('MISSING'), fib: undefined }
    const empty = row('EMPTY')
    empty.snapshot = { bars: [], price: 0, volume: 0, series: [] }
    expect(symbols([missing, row('ABSENT', absent), empty])).toEqual([])
    expect(symbols([missing, row('ABSENT', absent), empty], { signal: 'all' })).toEqual(['MISSING', 'ABSENT', 'EMPTY'])
  })

  test.each(['long', 'short'] as const)('%s direction and current-price pocket filters use the same closed plan', (direction) => {
    const analysis = fixture('watching', direction)
    const setup = analysis.setup!
    const { low, high } = setup.goldenPocket
    const before = structuredClone(analysis)
    expect(matchesFibFilters(analysis, (low + high) / 2, { fibDirection: direction })).toBe(true)
    expect(matchesFibFilters(analysis, (low + high) / 2, { fibDirection: direction === 'long' ? 'short' : 'long' })).toBe(false)
    for (const price of [low, (low + high) / 2, high]) {
      expect(matchesFibFilters(analysis, price, { fibStage: 'pocket' })).toBe(true)
      expect(matchesFibFilters(analysis, price, { fibStage: 'waiting' })).toBe(true)
      expect(matchesFibFilters(analysis, price, { fibStage: 'active' })).toBe(false)
    }
    for (const price of [low - 0.01, high + 0.01, 0, -1, NaN, Infinity]) {
      expect(matchesFibFilters(analysis, price, { fibStage: 'pocket' })).toBe(false)
    }
    expect(analysis).toEqual(before)
  })

  test.each(['aligned', 'against', 'unavailable', null] as const)('SMA confluence %s is accepted only when alignment is established', (smaConfluence) => {
    const analysis = fixture('entered', 'long', smaConfluence)
    expect(matchesFibFilters(analysis, 100, {})).toBe(true)
    expect(matchesFibFilters(analysis, 100, { fibConfluence: 'aligned' })).toBe(smaConfluence === 'aligned')
    expect(symbols([row('SMA', analysis)], { fibConfluence: 'aligned' })).toEqual(smaConfluence === 'aligned' ? ['SMA'] : [])
  })
})

describe('Fib screener integration', () => {
  test('search, favorites, current RSI, direction, position stage, and SMA alignment compose independently', () => {
    const aligned = fixture('entered', 'long', 'aligned')
    const rows = [
      row('BTCUSDT', aligned, 100, 25),
      row('WBTCUSDT', aligned, 100, 25),
      row('ETHUSDT', aligned, 100, 25),
      row('NEUTRALBTCUSDT', aligned, 100, 50),
      row('SHORTBTCUSDT', fixture('entered', 'short', 'aligned'), 140, 25),
      row('WAITINGBTCUSDT', fixture('watching', 'long', 'aligned'), 100, 25),
      row('NOSMABTCUSDT', fixture('entered'), 100, 25),
      row('STOPPEDBTCUSDT', fixture('stopped', 'long', 'aligned'), 100, 25),
    ]
    // The latest live RSI, rather than a stale RSI series or prior close, drives RSI state.
    rows[0].snapshot.series = [75]
    const filters: Partial<ScreenerFilters> = {
      search: ' btc/usdt ', starredOnly: true,
      starredSymbols: rows.filter((item) => item.symbol !== 'WBTCUSDT').map((item) => item.symbol),
      rsiState: 'oversold', fibDirection: 'long', fibStage: 'active', fibConfluence: 'aligned',
    }
    expect(symbols(rows, filters)).toEqual(['BTCUSDT'])
    expect(symbols(rows, { ...filters, starredOnly: false })).toEqual(['BTCUSDT', 'WBTCUSDT'])
    expect(symbols(rows, { ...filters, search: 'eth-usdt' })).toEqual(['ETHUSDT'])
    expect(symbols(rows, { ...filters, rsiState: 'neutral' })).toEqual(['NEUTRALBTCUSDT'])
    expect(symbols(rows, { ...filters, fibDirection: 'short' })).toEqual(['SHORTBTCUSDT'])
    expect(symbols(rows, { ...filters, fibStage: 'waiting' })).toEqual(['WAITINGBTCUSDT'])
    expect(symbols(rows, { ...filters, fibConfluence: 'any' })).toEqual(['BTCUSDT', 'NOSMABTCUSDT'])
  })

  test('live pocket movement changes Fib selection without consuming or replacing the closed setup', () => {
    const analysis = fixture('watching')
    const live = row('LIVE', analysis, 114)
    const before = structuredClone(analysis)
    expect(symbols([live], { fibStage: 'pocket' })).toEqual([])
    const inPocket = { ...live, snapshot: { ...live.snapshot, price: 100 } }
    expect(symbols([inPocket], { fibStage: 'pocket' })).toEqual(['LIVE'])
    expect(symbols([inPocket], { fibStage: 'active' })).toEqual([])
    const leftPocket = { ...live, snapshot: { ...live.snapshot, price: 98 } }
    expect(symbols([leftPocket], { fibStage: 'pocket' })).toEqual([])
    expect(analysis).toEqual(before)
  })

  test('Fib ranking prioritizes current pockets then positions without borrowing RSI scores or recency', () => {
    const rows = [
      row('RSI-CONFIRMED-WAITING', fixture(), 114, 50, [divergence('confirmed')]),
      row('RSI-FORMING-ACTIVE', fixture('entered'), 105, 50, [divergence('forming')]),
      row('RSI-QUIET-POCKET', fixture(), 100),
      row('RSI-OLD-RUNNER', fixture('runner'), 134, 50, [divergence('confirmed', 12)]),
    ]
    const before = structuredClone(rows)
    for (const divergenceRecency of [1, 3, 5, 'any'] as const) {
      expect(symbols(rows, { sort: 'signals', divergenceRecency })).toEqual([
        'RSI-QUIET-POCKET', 'RSI-FORMING-ACTIVE', 'RSI-OLD-RUNNER', 'RSI-CONFIRMED-WAITING',
      ])
    }
    expect(symbols(rows, { sort: 'watchlist' })).toEqual(rows.map((item) => item.symbol))
    expect(rows).toEqual(before)
  })

  test('selecting RSI or all pairs preserves RSI ranking and ignores stored Fib-specific filters', () => {
    const rows = [
      row('FIB-POCKET-ONLY', fixture(), 100),
      row('RSI-FORMING', fixture('runner'), 134, 50, [divergence('forming')]),
      row('RSI-CONFIRMED', fixture('stopped'), 100, 50, [divergence('confirmed')]),
      row('RSI-OLD', fixture(), 114, 50, [divergence('confirmed', 12)]),
    ]
    const filters: Partial<ScreenerFilters> = {
      sort: 'signals', fibDirection: 'short', fibStage: 'pocket', fibConfluence: 'aligned',
    }
    expect(symbols(rows, { ...filters, signal: 'all', divergenceRecency: 1 })).toEqual([
      'RSI-CONFIRMED', 'RSI-OLD', 'RSI-FORMING', 'FIB-POCKET-ONLY',
    ])
    expect(symbols(rows, { ...filters, signal: 'divergence' })).toEqual(['RSI-CONFIRMED', 'RSI-FORMING'])
    expect(symbols(rows, { ...filters, signal: 'divergence', divergenceRecency: 'any' })).toEqual([
      'RSI-CONFIRMED', 'RSI-OLD', 'RSI-FORMING',
    ])
    expect(symbols(rows, { ...filters, signal: 'confirmed' })).toEqual(['RSI-CONFIRMED'])
  })
})

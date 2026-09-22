import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import type { DivergenceSetup } from '../src/lib/divergenceLifecycle'
import { analyzeFibonacci, fibPrice } from '../src/lib/fibonacci'
import type { FibAnalysis, FibDirection, FibScale, FibStatus } from '../src/lib/fibonacci'
import { DEFAULT_FIB_SETTINGS } from '../src/lib/fibPreferences'
import type { FibSettings } from '../src/lib/fibPreferences'
import { createFibAnalysisCache, getFibAnalysis, matchesFibFilters } from '../src/lib/fibScreener'
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
  scale: FibScale = 'linear',
): FibAnalysis {
  const analysis = analyzeFibonacci(impulse(direction), { scale })
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
    expect(matchesFibFilters(analysis, 101.5, { fibStage: 'near' })).toBe(status === 'watching')
  })

  test.each(['stopped', 'missed', 'invalidated', 'superseded'] as const)('never offers %s chart context as a fresh Fib signal', (status) => {
    const analysis = fixture(status, 'long', 'aligned')
    for (const fibStage of ['any', 'waiting', 'near', 'active', 'pocket'] as const) {
      const price = fibStage === 'near' ? 101.5 : 100
      expect(matchesFibFilters(analysis, price, { fibStage, fibConfluence: 'aligned' })).toBe(false)
      expect(symbols([row('TERMINAL', analysis, price, 20, [divergence('confirmed')])], { fibStage })).toEqual([])
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

  test.each([
    { direction: 'long', scale: 'linear' },
    { direction: 'short', scale: 'linear' },
    { direction: 'long', scale: 'log' },
    { direction: 'short', scale: 'log' },
  ] as const)('Near entry includes 0.600 but excludes 0.618 for $direction on $scale scale', ({ direction, scale }) => {
    const analysis = fixture('watching', direction, 'aligned', scale)
    const setup = analysis.setup!
    const before = structuredClone(analysis)
    for (const ratio of [0.600, 0.609, 0.617999]) {
      const price = fibPrice(setup.start.price, setup.end.price, ratio, scale)
      expect(matchesFibFilters(analysis, price, { fibStage: 'near' })).toBe(true)
      expect(matchesFibFilters(analysis, price, { fibStage: 'waiting' })).toBe(true)
      expect(matchesFibFilters(analysis, price, { fibStage: 'pocket' })).toBe(false)
    }
    for (const ratio of [0.599999, 0.618, 0.666, 0.786]) {
      const price = fibPrice(setup.start.price, setup.end.price, ratio, scale)
      expect(matchesFibFilters(analysis, price, { fibStage: 'near' })).toBe(false)
    }
    expect(matchesFibFilters(analysis, setup.entries[0].price, { fibStage: 'near' })).toBe(false)
    expect(matchesFibFilters(analysis, setup.entries[0].price, { fibStage: 'pocket' })).toBe(true)
    expect(analysis).toEqual(before)
  })

  test('Near entry rejects unavailable or invalid live prices', () => {
    const analysis = fixture()
    for (const price of [0, -1, NaN, Infinity, -Infinity]) {
      expect(matchesFibFilters(analysis, price, { fibStage: 'near' })).toBe(false)
    }
    expect(matchesFibFilters(undefined, 101.5, { fibStage: 'near' })).toBe(false)
    expect(matchesFibFilters(analyzeFibonacci([]), 101.5, { fibStage: 'near' })).toBe(false)
  })

  test.each(['aligned', 'against', 'unavailable', null] as const)('SMA confluence %s is accepted only when alignment is established', (smaConfluence) => {
    const analysis = fixture('entered', 'long', smaConfluence)
    expect(matchesFibFilters(analysis, 100, {})).toBe(true)
    expect(matchesFibFilters(analysis, 100, { fibConfluence: 'aligned' })).toBe(smaConfluence === 'aligned')
    expect(symbols([row('SMA', analysis)], { fibConfluence: 'aligned' })).toEqual(smaConfluence === 'aligned' ? ['SMA'] : [])
  })
})

describe('Fib screener integration', () => {
  test('Near entry composes with direction and SMA alignment while excluding distant, pocket, and entered plans', () => {
    const rows = [
      row('LONG', fixture('watching', 'long', 'aligned'), 101.5),
      row('SHORT', fixture('watching', 'short', 'aligned'), 138.5),
      row('AGAINST', fixture('watching', 'long', 'against'), 101.5),
      row('DISTANT', fixture('watching', 'long', 'aligned'), 114),
      row('POCKET', fixture('watching', 'long', 'aligned'), 100),
      row('ENTERED', fixture('entered', 'long', 'aligned'), 101.5),
    ]
    const filters: Partial<ScreenerFilters> = { fibStage: 'near', fibDirection: 'long', fibConfluence: 'aligned' }
    expect(symbols(rows, filters)).toEqual(['LONG'])
    expect(symbols(rows, { ...filters, fibDirection: 'short' })).toEqual(['SHORT'])
    expect(symbols(rows, { ...filters, fibConfluence: 'any' })).toEqual(['LONG', 'AGAINST'])
  })

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
    expect(symbols([live], { fibStage: 'near' })).toEqual([])
    const nearEntry = { ...live, snapshot: { ...live.snapshot, price: 101.5 } }
    expect(symbols([nearEntry], { fibStage: 'near' })).toEqual(['LIVE'])
    expect(symbols([nearEntry], { fibStage: 'pocket' })).toEqual([])
    const inPocket = { ...live, snapshot: { ...live.snapshot, price: 100 } }
    expect(symbols([inPocket], { fibStage: 'pocket' })).toEqual(['LIVE'])
    expect(symbols([inPocket], { fibStage: 'near' })).toEqual([])
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


class MemoryCheckpointStorage {
  values = new Map<string, string>()
  writes = 0
  fail = false
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) {
    if (this.fail) throw new Error('Storage full')
    this.writes++
    this.values.set(key, value)
  }
  removeItem(key: string) { this.values.delete(key) }
}

function longRunningPlan(length = 1_105): RsiBar[] {
  const bars = impulse()
  bars.push(bar(16, 102, { low: 100, high: 105 }))
  while (bars.length < length) bars.push(bar(bars.length, 107.5, { low: 105, high: 110 }))
  return bars
}

describe('durable Fib checkpoints and corrected rolling history', () => {
  test('rolling 500-candle snapshots agree with full replay beyond 1005 candles and eventual exit', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = longRunningPlan()
    let latest: FibAnalysis | null = null
    for (let end = 16; end <= bars.length; end++) {
      latest = tracker.get('spot:1m:ROLLUSDT', bars.slice(Math.max(0, end - 500), end), DEFAULT_FIB_SETTINGS)
      if ([17, 500, 504, 505, 1005, 1105].includes(end)) {
        expect(latest.setup).toEqual(analyzeFibonacci(bars.slice(0, end)).setup)
      }
    }
    expect(latest?.setup).toMatchObject({ status: 'managing', remainingPercent: 80, resolvedAt: null })
    const saved = JSON.parse([...storage.values.values()][0])
    expect(saved.window).toHaveLength(500)
    expect(saved.baseline.history).toHaveLength(500)
    expect(saved.baseline.setups).toHaveLength(1)
    expect([...storage.values.values()][0].length).toBeLessThan(500_000)

    bars.push(bar(bars.length, 103, { low: 100, high: 106 }))
    const stopped = tracker.get('spot:1m:ROLLUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS)
    expect(stopped.setup).toEqual(analyzeFibonacci(bars).setup)
    expect(stopped.setup).toMatchObject({ status: 'stopped', remainingPercent: 0, resolvedAt: bars.at(-1)!.closeTime })
    expect(stopped.setup?.events.filter((event) => event.kind === 'stop')).toHaveLength(1)
    expect(latest?.setup?.status).toBe('managing')
  })

  test('production rolling 3000-candle snapshots keep an old plan past 3205 without live writes or replay resets', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = longRunningPlan(3_305)
    let latest: FibAnalysis | null = null
    for (const end of [17, 500, 1000, 2000, 3000, ...Array.from({ length: 305 }, (_, i) => 3001 + i)]) {
      const incoming = bars.slice(Math.max(0, end - 3000), end)
      latest = tracker.get('spot:1m:PRODUCTIONUSDT', incoming, DEFAULT_FIB_SETTINGS)
      expect(latest.setup).toEqual(analyzeFibonacci(bars.slice(0, end)).setup)
      expect(latest.continuity).toBeUndefined()
      const writes = storage.writes
      expect(tracker.get('spot:1m:PRODUCTIONUSDT', [...incoming, bar(end, 1, { isClosed: false })], DEFAULT_FIB_SETTINGS)).toBe(latest)
      expect(tracker.get('spot:1m:PRODUCTIONUSDT', structuredClone(incoming), DEFAULT_FIB_SETTINGS)).toBe(latest)
      expect(storage.writes).toBe(writes)
    }
    expect(latest?.setup?.status).toBe('managing')
    const saved = JSON.parse([...storage.values.values()][0])
    expect(saved.source).toHaveLength(3000)
    const reload = createFibAnalysisCache(storage)
    const restored = reload.get('spot:1m:PRODUCTIONUSDT', structuredClone(bars.slice(-3000)), DEFAULT_FIB_SETTINGS)
    expect(restored.setup).toEqual(latest?.setup)
    expect(restored.continuity?.state).toBe('restored')
    bars.push(bar(bars.length, 103, { low: 100, high: 106 }))
    const exited = reload.get('spot:1m:PRODUCTIONUSDT', bars.slice(-3000), DEFAULT_FIB_SETTINGS)
    expect(exited.setup).toEqual(analyzeFibonacci(bars).setup)
    expect(exited.setup?.status).toBe('stopped')
  })

  test('short reconnects and single-bar updates preserve older exact evidence for a later broad fetch', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = longRunningPlan(3305)
    const active = tracker.get('spot:1m:SHORTRECONNECT', bars, DEFAULT_FIB_SETTINGS)
    expect(tracker.get('spot:1m:SHORTRECONNECT', bars.slice(-350), DEFAULT_FIB_SETTINGS).setup).toEqual(active.setup)
    expect(tracker.get('spot:1m:SHORTRECONNECT', bars.slice(-3000), DEFAULT_FIB_SETTINGS).setup).toEqual(active.setup)
    bars.push(bar(bars.length, 107.5, { low: 105, high: 110 }))
    expect(tracker.get('spot:1m:SHORTRECONNECT', bars.slice(-1), DEFAULT_FIB_SETTINGS).setup).toEqual(active.setup)
    const reconnect = createFibAnalysisCache(storage).get('spot:1m:SHORTRECONNECT', bars.slice(-3000), DEFAULT_FIB_SETTINGS)
    expect(reconnect.setup).toEqual(active.setup)
    expect(reconnect.continuity?.state).toBe('restored')
  })

  test('in-place candle corrections invalidate exact cached source evidence', () => {
    const tracker = createFibAnalysisCache(null)
    const bars = longRunningPlan(3305)
    const initial = tracker.get('spot:1m:INPLACEUSDT', bars.slice(-3000), DEFAULT_FIB_SETTINGS)
    expect(initial.setup).toBeNull()
    // Seed full original evidence, then advance using the production-sized window.
    tracker.reset('spot:1m:INPLACEUSDT')
    const active = tracker.get('spot:1m:INPLACEUSDT', bars, DEFAULT_FIB_SETTINGS)
    tracker.get('spot:1m:INPLACEUSDT', bars.slice(-3000), DEFAULT_FIB_SETTINGS)
    bars[3000].low = 100
    const corrected = tracker.get('spot:1m:INPLACEUSDT', bars.slice(-3000), DEFAULT_FIB_SETTINGS)
    expect(corrected.setup).toMatchObject({ id: active.setup!.id, status: 'stopped', resolvedAt: bars[3000].closeTime })
    bars[800].low = 99
    const earlier = tracker.get('spot:1m:INPLACEUSDT', bars.slice(-3000), DEFAULT_FIB_SETTINGS)
    expect(earlier.continuity?.state).toBe('reset')
    expect(earlier.setup).toBeNull()
  })

  test('reload detects a correction within 3000 source identities but before the replay checkpoint', () => {
    const storage = new MemoryCheckpointStorage()
    const bars = longRunningPlan(3305)
    createFibAnalysisCache(storage).get('spot:1m:OLDSOURCEUSDT', bars, DEFAULT_FIB_SETTINGS)
    bars[800] = { ...bars[800], low: 99 }
    const corrected = createFibAnalysisCache(storage).get('spot:1m:OLDSOURCEUSDT', bars.slice(-3000), DEFAULT_FIB_SETTINGS)
    expect(corrected.setup).toBeNull()
    expect(corrected.continuity?.state).toBe('reset')
    expect(corrected.continuity?.detail).toContain('Earlier closed-candle evidence changed')
  })

  test('reload restores an old active plan using equal-valued reconnect objects and ignores live ticks', () => {
    const storage = new MemoryCheckpointStorage()
    const bars = longRunningPlan()
    const first = createFibAnalysisCache(storage).get('spot:1m:RELOADUSDT', bars, DEFAULT_FIB_SETTINGS)
    const reloaded = createFibAnalysisCache(storage)
    expect(reloaded.get('spot:1m:RELOADUSDT', [], DEFAULT_FIB_SETTINGS).setup).toBeNull()
    const restored = reloaded.get('spot:1m:RELOADUSDT', structuredClone(bars.slice(-500)), DEFAULT_FIB_SETTINGS)
    expect(restored.setup).toEqual(first.setup)
    expect(restored.continuity?.state).toBe('restored')
    const writes = storage.writes
    for (const price of [80, 150, NaN]) {
      const preview = bar(bars.length, price, { isClosed: false })
      expect(reloaded.get('spot:1m:RELOADUSDT', [...bars.slice(-500), preview], DEFAULT_FIB_SETTINGS)).toBe(restored)
    }
    expect(storage.writes).toBe(writes)
    bars.push(bar(bars.length, 103, { low: 100, high: 106 }))
    expect(reloaded.get('spot:1m:RELOADUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS).setup)
      .toEqual(analyzeFibonacci(bars).setup)
  })

  test('replays an interior correction after the old origin is absent, removing stale targets and position state', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = longRunningPlan()
    const original = tracker.get('spot:1m:FIXUSDT', bars, DEFAULT_FIB_SETTINGS)
    bars[900] = bar(900, 103, { low: 100, high: 106 })
    const corrected = tracker.get('spot:1m:FIXUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS)
    expect(corrected.setup).toEqual(analyzeFibonacci(bars).setup)
    expect(corrected.setup).toMatchObject({ status: 'stopped', resolvedAt: bars[900].closeTime })
    expect(original.setup?.status).toBe('managing')
    expect(corrected.setup?.events.filter((event) => event.kind === 'stop')).toHaveLength(1)
    const restored = createFibAnalysisCache(storage).get('spot:1m:FIXUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS)
    expect(restored.setup).toEqual(corrected.setup)
  })

  test('a full authoritative correction can rebuild old origins while partial pre-checkpoint corrections reset explicitly', () => {
    const tracker = createFibAnalysisCache(null)
    const bars = longRunningPlan()
    tracker.get('spot:1m:EARLYUSDT', bars, DEFAULT_FIB_SETTINGS)
    bars[8] = { ...bars[8], low: 88 }
    const corrected = tracker.get('spot:1m:EARLYUSDT', bars, DEFAULT_FIB_SETTINGS)
    expect(corrected.setup?.start.price).toBe(88)
    expect(corrected.setup).toEqual(analyzeFibonacci(bars).setup)
    // An unchanged broader reconnect joins through verified overlapping evidence.
    expect(tracker.get('spot:1m:EARLYUSDT', bars.slice(-750), DEFAULT_FIB_SETTINGS).setup).toEqual(corrected.setup)
    for (const count of [750, 1000]) {
      tracker.get('spot:1m:EARLYUSDT', bars, DEFAULT_FIB_SETTINGS)
      const partial = bars.slice(-count).map((candle, index) => index === 20 ? { ...candle, low: 99 } : candle)
      const reset = tracker.get('spot:1m:EARLYUSDT', partial, DEFAULT_FIB_SETTINGS)
      expect(reset.setup).toBeNull()
      expect(reset.continuity).toMatchObject({ state: 'reset', previousSetupId: corrected.setup!.id })
    }
  })

  test('settings changes never reuse lifecycle state from an incompatible template', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = longRunningPlan()
    const original = tracker.get('spot:1m:SETUSDT', bars, DEFAULT_FIB_SETTINGS)
    const settings = { ...DEFAULT_FIB_SETTINGS, stopRatio: 1.04 as const }
    const changed = tracker.get('spot:1m:SETUSDT', bars.slice(-500), settings)
    expect(changed.setup).toBeNull()
    expect(changed.continuity?.state).toBe('reset')
    const switchedBack = tracker.get('spot:1m:SETUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS)
    expect(switchedBack.setup).toEqual(original.setup)
    expect(switchedBack.continuity?.state).toBe('restored')
    expect(storage.length).toBe(2)
  })

  test('non-overlapping reconnects, interior gaps, and rewinds cannot silently bridge lifecycle evidence', () => {
    for (const kind of ['gap', 'interior', 'rewind'] as const) {
      const tracker = createFibAnalysisCache(null)
      const bars = longRunningPlan()
      const original = tracker.get(`spot:1m:${kind}`, bars, DEFAULT_FIB_SETTINGS)
      const incoming = kind === 'gap' ? Array.from({ length: 20 }, (_, i) => bar(2000 + i))
        : kind === 'interior' ? bars.slice(-500).filter((candle) => candle.openTime !== bars[900].openTime)
          : bars.slice(500, 750)
      const interrupted = tracker.get(`spot:1m:${kind}`, incoming, DEFAULT_FIB_SETTINGS)
      expect(interrupted.setup).toBeNull()
      expect(interrupted.continuity).toMatchObject({ state: 'reset', previousSetupId: original.setup!.id })
      expect(interrupted.lastClosedAt).toBe(incoming.at(-1)!.closeTime)
    }
  })

  test('explicit reset removes all template checkpoints while empty loading snapshots preserve them', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = longRunningPlan()
    tracker.get('spot:1m:RESETUSDT', bars, DEFAULT_FIB_SETTINGS)
    tracker.get('spot:1m:RESETUSDT', bars, { ...DEFAULT_FIB_SETTINGS, scale: 'log' })
    expect(storage.length).toBe(2)
    tracker.get('spot:1m:RESETUSDT', [], DEFAULT_FIB_SETTINGS)
    expect(storage.length).toBe(2)
    tracker.reset('spot:1m:RESETUSDT')
    expect(storage.length).toBe(0)
    expect(tracker.get('spot:1m:RESETUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS).setup).toBeNull()
  })

  test('bounded storage keeps eviction notices so a reload cannot silently forget an observed plan', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = impulse()
    for (let i = 0; i < 20; i++) tracker.get(`spot:1m:RETENTION${i}`, bars, DEFAULT_FIB_SETTINGS)
    const saved = [...storage.values.values()].map((value) => JSON.parse(value))
    expect(saved.filter((item) => item.baseline)).toHaveLength(16)
    expect(saved.filter((item) => item.evicted === true)).toHaveLength(4)
    expect([...storage.values.values()].reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(1_500_000)
    const reloaded = createFibAnalysisCache(storage).get('spot:1m:RETENTION0', bars, DEFAULT_FIB_SETTINGS)
    expect(reloaded.continuity?.state).toBe('reset')
    expect(reloaded.continuity?.detail).toContain('storage retention')
  })

  test('quiet markets do not evict saved plans and waiting setups cannot displace filled positions', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const filled = longRunningPlan(18)
    for (let i = 0; i < 16; i++) tracker.get(`spot:1m:POSITION${i}`, filled, DEFAULT_FIB_SETTINGS)
    for (let i = 0; i < 100; i++) tracker.get(`spot:1m:QUIET${i}`, [bar(0), bar(1)], DEFAULT_FIB_SETTINGS)
    expect(storage.length).toBe(16)
    const waiting = tracker.get('spot:1m:WAITING', impulse(), DEFAULT_FIB_SETTINGS)
    expect(waiting.persistenceIssue).toBe('unavailable')
    expect(createFibAnalysisCache(storage).get('spot:1m:POSITION0', filled, DEFAULT_FIB_SETTINGS).setup?.status).toBe('managing')
  })

  test('malformed persisted state is rejected and storage failures leave in-memory tracking usable', () => {
    const storage = new MemoryCheckpointStorage()
    const tracker = createFibAnalysisCache(storage)
    const bars = longRunningPlan()
    const original = tracker.get('spot:1m:STOREUSDT', bars, DEFAULT_FIB_SETTINGS)
    const key = storage.key(0)!
    const malformed = JSON.parse(storage.getItem(key)!)
    malformed.baseline.pending = { endIndex: -999 }
    storage.values.set(key, JSON.stringify(malformed))
    const invalid = createFibAnalysisCache(storage).get('spot:1m:STOREUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS)
    expect(invalid.setup).toBeNull()
    expect(invalid.continuity?.state).toBe('reset')
    storage.fail = true
    bars.push(bar(bars.length, 103, { low: 100, high: 106 }))
    const exited = tracker.get('spot:1m:STOREUSDT', bars.slice(-500), DEFAULT_FIB_SETTINGS)
    expect(exited.setup?.id).toBe(original.setup?.id)
    expect(exited.setup?.status).toBe('stopped')
    expect(exited.persistenceIssue).toBe('unavailable')
  })
})

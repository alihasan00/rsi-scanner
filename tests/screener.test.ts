import { describe, expect, test } from 'bun:test'
import type { RsiBar, SymbolSnapshot } from '../src/types'
import type { DivergenceSetup } from '../src/lib/divergenceLifecycle'
import {
  candleChange,
  DEFAULT_DIVERGENCE_RECENCY,
  filterDivergenceSetups,
  filterScreenerRows,
  getScreenerAnalysis,
  hasConfirmedSignal,
} from '../src/lib/screener'
import type { ScreenerAnalysis, ScreenerFilters, ScreenerRow, ScreenerSettings } from '../src/lib/screener'
import { analyzeTugOfWar, previewTugOfWar } from '../src/lib/tugOfWar'

const SETTINGS: ScreenerSettings = {
  showHiddenDivergences: false,
  requireBodyAgreement: true,
  requireSameRsiCycle: true,
  divergenceInvalidationAnchor: 'second',
}

function bar(index: number, patch: Partial<RsiBar> = {}): RsiBar {
  return {
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: 100, high: 100, low: 100, close: 100, volume: 10, rsi: 50, isClosed: true,
    ...patch,
  }
}

function snapshot(bars: RsiBar[]): SymbolSnapshot {
  return { bars, series: bars.map((item) => item.rsi), price: bars.at(-1)?.close ?? 0, volume: bars.at(-1)?.volume ?? 0 }
}

function bullishDivergence(): RsiBar[] {
  const bars = [45, 44, 40, 38, 35, 20, 40, 45, 42, 40, 30].map((rsi, index) => bar(index, {
    rsi, open: 110, close: 109, low: 105, high: 115,
  }))
  bars[5] = { ...bars[5], open: 104, close: 102, low: 100 }
  bars[10] = { ...bars[10], open: 98, close: 96, low: 95 }
  return bars
}

function neutralHistory(): RsiBar[] {
  return Array.from({ length: 21 }, (_, index) => bar(index))
}

function pendingTowHistory(): RsiBar[] {
  return [
    ...neutralHistory().slice(0, 20),
    bar(20, { open: 100, high: 140, low: 100, close: 135 }),
    bar(21, { open: 112, high: 125, low: 100, close: 115 }),
    bar(22, { open: 113, high: 125, low: 100, close: 115 }),
  ]
}

function signal(kind: DivergenceSetup['kind'], state: DivergenceSetup['state'] = 'forming'): DivergenceSetup {
  return {
    id: `${kind}-${state}`, kind, state,
    start: { time: 300_000, price: 100, rsi: 20 }, end: { time: 600_000, price: 95, rsi: 30 },
    detectedAt: 659_999, confirmedAt: state === 'confirmed' ? 719_999 : null,
    resolvedAt: null, confirmation: state === 'confirmed' ? 'ordinary' : null,
    barsElapsed: 0, expiryBars: 14, invalidationAnchor: 'second', invalidationRsi: 30, resolutionReason: null,
  }
}

function confirmedSignal(barsElapsed: number, kind: DivergenceSetup['kind'] = 'regular-bullish'): DivergenceSetup {
  return { ...signal(kind, 'confirmed'), id: `${kind}-${barsElapsed}`, barsElapsed }
}

function analysis(divergences: DivergenceSetup[] = []): ScreenerAnalysis {
  return { divergences }
}

function row(symbol: string, indicators = analysis(), bars = neutralHistory()): ScreenerRow {
  return { symbol, analysis: indicators, snapshot: snapshot(bars), feed: { state: 'ready', updatedAt: bars.at(-1)?.closeTime ?? null, error: null } }
}

function analyzedRow(symbol: string, bars: RsiBar[]): ScreenerRow {
  return row(symbol, getScreenerAnalysis(symbol, bars, SETTINGS), bars)
}

function filters(patch: Partial<ScreenerFilters> = {}): ScreenerFilters {
  return { search: '', signal: 'all', starredOnly: false, starredSymbols: [], sort: 'watchlist', ...patch }
}

function symbols(rows: readonly ScreenerRow[], options: Partial<ScreenerFilters> = {}): string[] {
  return filterScreenerRows(rows, filters(options)).map((item) => item.symbol)
}

describe('screener analysis cache', () => {
  test('keeps forming divergence during live previews and recomputes at the confirming close', () => {
    const history = bullishDivergence()
    const initial = getScreenerAnalysis('CACHE-PREVIEW', history, SETTINGS)
    expect(initial.divergences.map((item) => item.state)).toEqual(['forming'])
    expect(hasConfirmedSignal(initial)).toBe(false)

    const preview = bar(11, { rsi: 35, open: 95, close: 97, low: 94, high: 115, isClosed: false })
    expect(getScreenerAnalysis('CACHE-PREVIEW', [...history, preview], SETTINGS)).toBe(initial)
    expect(getScreenerAnalysis('CACHE-PREVIEW', [...history, { ...preview, close: 94 }], SETTINGS)).toBe(initial)

    const closed = { ...preview, isClosed: true }
    const confirmed = getScreenerAnalysis('CACHE-PREVIEW', [...history, closed], SETTINGS)
    expect(confirmed).not.toBe(initial)
    expect(confirmed.divergences.map((item) => item.state)).toEqual(['confirmed'])
    expect(hasConfirmedSignal(confirmed)).toBe(true)

    const completed = getScreenerAnalysis('CACHE-PREVIEW', [...history, closed, bar(12, { rsi: 50 })], SETTINGS)
    expect(completed.divergences).toEqual([])
    expect(hasConfirmedSignal(completed)).toBe(false)
  })

  test('historical correction invalidates the cache even with identical length and latest candle', () => {
    const history = bullishDivergence()
    const initial = getScreenerAnalysis('CACHE-CORRECTION', history, SETTINGS)
    expect(initial.divergences).toHaveLength(1)

    const corrected = history.map((item, index) => index === 5 ? { ...item, rsi: 45 } : item)
    expect(corrected.at(-1)).toBe(history.at(-1))
    const updated = getScreenerAnalysis('CACHE-CORRECTION', corrected, SETTINGS)
    expect(updated).not.toBe(initial)
    expect(updated.divergences).toEqual([])
    expect(getScreenerAnalysis('CACHE-CORRECTION', [...corrected], { ...SETTINGS })).toBe(updated)
  })

  test('body-agreement and RSI-cycle settings each change the actual analysis', () => {
    const wrongBody = bullishDivergence()
    wrongBody[10] = { ...wrongBody[10], open: 108, close: 106 }
    const strictBody = getScreenerAnalysis('CACHE-BODY', wrongBody, SETTINGS)
    const looseBody = getScreenerAnalysis('CACHE-BODY', wrongBody, { ...SETTINGS, requireBodyAgreement: false })
    expect(strictBody.divergences).toEqual([])
    expect(looseBody).not.toBe(strictBody)
    expect(looseBody.divergences).toHaveLength(1)

    const otherCycle = bullishDivergence()
    otherCycle[7] = { ...otherCycle[7], rsi: 50 }
    const strictCycle = getScreenerAnalysis('CACHE-CYCLE', otherCycle, SETTINGS)
    const looseCycle = getScreenerAnalysis('CACHE-CYCLE', otherCycle, { ...SETTINGS, requireSameRsiCycle: false })
    expect(strictCycle.divergences).toEqual([])
    expect(looseCycle).not.toBe(strictCycle)
    expect(looseCycle.divergences).toHaveLength(1)
  })

  test('hidden-divergence and invalidation-anchor settings also invalidate cached results', () => {
    const regular = bullishDivergence()
    const second = getScreenerAnalysis('CACHE-ANCHOR', regular, SETTINGS)
    const first = getScreenerAnalysis('CACHE-ANCHOR', regular, { ...SETTINGS, divergenceInvalidationAnchor: 'first' })
    expect(second.divergences[0].invalidationRsi).toBe(30)
    expect(first).not.toBe(second)
    expect(first.divergences[0].invalidationRsi).toBe(20)

    const hidden = bullishDivergence()
    hidden[10] = { ...hidden[10], rsi: 15, low: 101, open: 106, close: 104 }
    hidden.splice(10, 0, bar(10, { rsi: 40, open: 110, close: 109, low: 105, high: 115 }))
    const retimed = hidden.map((item, index) => ({ ...item, openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1 }))
    const excluded = getScreenerAnalysis('CACHE-HIDDEN', retimed, SETTINGS)
    const included = getScreenerAnalysis('CACHE-HIDDEN', retimed, { ...SETTINGS, showHiddenDivergences: true })
    expect(excluded.divergences).toEqual([])
    expect(included).not.toBe(excluded)
    expect(included.divergences.map((item) => item.kind)).toEqual(['hidden-bullish'])
  })
})

describe('divergence recency', () => {
  test('defaults to confirmations on the latest three closes, including ages zero through two', () => {
    expect(DEFAULT_DIVERGENCE_RECENCY).toBe(3)
    const rows = [0, 1, 2, 3].map((age) => row(`AGE-${age}`, analysis([confirmedSignal(age)])))
    for (const selected of ['divergence', 'confirmed'] as const) {
      expect(symbols(rows, { signal: selected })).toEqual(['AGE-0', 'AGE-1', 'AGE-2'])
    }
  })

  test.each([
    { recency: 1 as const, ages: [0] },
    { recency: 3 as const, ages: [0, 1, 2] },
    { recency: 5 as const, ages: [0, 1, 2, 3, 4] },
    { recency: 'any' as const, ages: [0, 1, 2, 3, 4, 5, 13] },
  ])('selects the requested $recency confirmation window without altering signals', ({ recency, ages }) => {
    const signals = [0, 1, 2, 3, 4, 5, 13].map((age) => confirmedSignal(age))
    const before = structuredClone(signals)
    signals.forEach(Object.freeze)
    Object.freeze(signals)
    const selected = filterDivergenceSetups(signals, recency)
    expect(selected.map((setup) => setup.barsElapsed)).toEqual(ages)
    expect(selected).not.toBe(signals)
    expect(selected.every((setup) => signals.includes(setup))).toBe(true)
    expect(signals).toEqual(before)
  })

  test('includes forming setups but never restores a resolved outcome, even with any age selected', () => {
    const forming = signal('regular-bullish')
    const confirmed = confirmedSignal(0)
    const resolved = (['completed', 'harmonised', 'expired', 'unconfirmed', 'interrupted'] as const)
      .map((state) => signal('regular-bullish', state))
    for (const recency of [1, 3, 5, 'any'] as const) {
      expect(filterDivergenceSetups([forming, confirmed, ...resolved], recency)).toEqual([forming, confirmed])
    }
    const rows = [row('FORMING', analysis([forming])), row('RESOLVED', analysis(resolved))]
    expect(symbols(rows, { signal: 'divergence', divergenceRecency: 'any' })).toEqual(['FORMING'])
    expect(symbols(rows, { signal: 'confirmed', divergenceRecency: 'any' })).toEqual([])
  })

  test('admits fresh bullish and bearish confirmations while excluding older setups of either kind', () => {
    const oldBull = confirmedSignal(3)
    const freshBull = confirmedSignal(0)
    const oldBear = confirmedSignal(3, 'regular-bearish')
    const freshBear = confirmedSignal(0, 'regular-bearish')
    expect(filterDivergenceSetups([oldBull, freshBear, oldBear, freshBull], 3)).toEqual([freshBear, freshBull])
    const rows = [
      row('FRESH-BULL', analysis([freshBull])),
      row('OLD-BULL', analysis([oldBull])),
      row('FRESH-BEAR', analysis([freshBear])),
      row('OLD-BEAR', analysis([oldBear])),
      row('MIXED', analysis([oldBull, freshBear])),
    ]
    for (const selected of ['divergence', 'confirmed'] as const) {
      expect(symbols(rows, { signal: selected })).toEqual(['FRESH-BULL', 'FRESH-BEAR', 'MIXED'])
      expect(symbols(rows, { signal: selected, divergenceRecency: 5 })).toEqual(rows.map((item) => item.symbol))
    }
  })

  test('a newly confirmed setup remains fresh when its first pivot is ten days older', () => {
    const original = bullishDivergence()
    const fourHours = 4 * 60 * 60_000
    const bars = [
      ...original.slice(0, 10),
      ...Array.from({ length: 55 }, (_, index) => bar(index, { rsi: 40, open: 110, close: 109, low: 105, high: 115 })),
      original[10],
      bar(0, { rsi: 35, open: 95, close: 97, low: 94, high: 115 }),
    ].map((item, index) => ({ ...item, openTime: index * fourHours, closeTime: (index + 1) * fourHours - 1 }))
    const current = getScreenerAnalysis('OLD-PIVOT-NEW-CONFIRMATION', bars, SETTINGS)
    expect(current.divergences).toHaveLength(1)
    const setup = current.divergences[0]
    expect(setup.end.time - setup.start.time).toBe(10 * 24 * 60 * 60_000)
    expect(setup.confirmedAt).toBe(bars.at(-1)!.closeTime)
    expect(setup.barsElapsed).toBe(0)
    expect(filterDivergenceSetups(current.divergences, 1)).toEqual([setup])
    expect(symbols([row('FRESH', current, bars)], { signal: 'confirmed', divergenceRecency: 1 })).toEqual(['FRESH'])
  })

  test('live previews keep age two visible until the third post-confirmation candle closes', () => {
    const history = [
      ...bullishDivergence(),
      bar(11, { rsi: 35, open: 95, close: 97, low: 94, high: 115 }),
      bar(12, { rsi: 40 }),
      bar(13, { rsi: 40 }),
    ]
    const current = getScreenerAnalysis('RECENCY-CLOSED-CLOCK', history, SETTINGS)
    const before = structuredClone(current)
    expect(current.divergences[0].barsElapsed).toBe(2)
    const preview = bar(14, { rsi: 40, isClosed: false })
    for (const rsi of [0, 40, 50]) {
      const bars = [...history, { ...preview, rsi }]
      const live = getScreenerAnalysis('RECENCY-CLOSED-CLOCK', bars, SETTINGS)
      expect(live).toBe(current)
      expect(symbols([row('LIVE', live, bars)], { signal: 'divergence' })).toEqual(['LIVE'])
    }
    const bars = [...history, { ...preview, isClosed: true }]
    const next = getScreenerAnalysis('RECENCY-CLOSED-CLOCK', bars, SETTINGS)
    expect(next.divergences[0]).toMatchObject({ state: 'confirmed', barsElapsed: 3 })
    expect(symbols([row('NEXT', next, bars)], { signal: 'divergence' })).toEqual([])
    expect(symbols([row('NEXT', next, bars)], { signal: 'divergence', divergenceRecency: 'any' })).toEqual(['NEXT'])
    expect(next.divergences).toHaveLength(1)
    expect(current).toEqual(before)
  })

  test('recency leaves all-pair browsing and its signal sorting unchanged', () => {
    const rows = [
      row('OLD-DIVERGENCE', analysis([confirmedSignal(13)])),
      row('QUIET'),
    ]
    for (const recency of [1, 3, 5, 'any'] as const) {
      expect(symbols(rows, { divergenceRecency: recency })).toEqual(['OLD-DIVERGENCE', 'QUIET'])
      expect(symbols(rows, { divergenceRecency: recency, sort: 'signals' })).toEqual(['OLD-DIVERGENCE', 'QUIET'])
      expect(symbols(rows, { signal: 'confirmed', divergenceRecency: recency })).toEqual(
        recency === 'any' ? ['OLD-DIVERGENCE'] : [],
      )
    }
  })

  test('signal sorting includes both directions and scores only divergences within the selected age window', () => {
    const forming = signal('regular-bullish')
    const rows = [
      row('FORMING', analysis([forming])),
      row('OLD-PLUS-FORMING', analysis([confirmedSignal(4), forming])),
      row('BEAR-PLUS-FORMING', analysis([confirmedSignal(0, 'regular-bearish'), forming])),
      row('FRESH-CONFIRMED', analysis([confirmedSignal(0)])),
    ]
    expect(symbols(rows, { signal: 'divergence', sort: 'signals' })).toEqual([
      'BEAR-PLUS-FORMING', 'FRESH-CONFIRMED', 'FORMING', 'OLD-PLUS-FORMING',
    ])
    expect(symbols(rows, { signal: 'divergence', sort: 'signals', divergenceRecency: 5 })).toEqual([
      'OLD-PLUS-FORMING', 'BEAR-PLUS-FORMING', 'FRESH-CONFIRMED', 'FORMING',
    ])
    expect(symbols(rows, { signal: 'confirmed', sort: 'signals' })).toEqual(['BEAR-PLUS-FORMING', 'FRESH-CONFIRMED'])
    expect(symbols(rows, { signal: 'confirmed', sort: 'signals', divergenceRecency: 5 })).toEqual([
      'OLD-PLUS-FORMING', 'BEAR-PLUS-FORMING', 'FRESH-CONFIRMED',
    ])
  })
})

describe('screener signal filters', () => {
  test('confirmed includes only confirmed RSI divergences, excluding forming and quiet rows', () => {
    const rows = [
      row('FORMING', analysis([signal('regular-bullish')])),
      row('CONFIRMED', analysis([signal('regular-bearish', 'confirmed')])),
      row('QUIET'),
    ]
    expect(symbols(rows, { signal: 'confirmed' })).toEqual(['CONFIRMED'])
    expect(symbols(rows, { signal: 'divergence' })).toEqual(['FORMING', 'CONFIRMED'])
  })

  test.each(['regular-bullish', 'regular-bearish', 'hidden-bullish', 'hidden-bearish'] as const)(
    '%s setups qualify by confirmation state without a direction choice', (kind) => {
      const rows = [
        row('FORMING', analysis([signal(kind)])),
        row('CONFIRMED', analysis([confirmedSignal(0, kind)])),
        row('COMPLETED', analysis([signal(kind, 'completed')])),
      ]
      expect(symbols(rows, { signal: 'divergence' })).toEqual(['FORMING', 'CONFIRMED'])
      expect(symbols(rows, { signal: 'confirmed' })).toEqual(['CONFIRMED'])
    },
  )

  test('empty and short-history symbols remain browseable without claiming RSI signals', () => {
    const shortBars = [bar(0, { high: 110, low: 90 })]
    const rows = [analyzedRow('EMPTY', []), analyzedRow('SHORT', shortBars)]
    expect(symbols(rows)).toEqual(['EMPTY', 'SHORT'])
    for (const selected of ['divergence', 'confirmed'] as const) {
      expect(symbols(rows, { signal: selected })).toEqual([])
    }
  })

  test('normalizes pair search and combines it with starred and signal filters', () => {
    const rows = [row('BTCUSDT', analysis([signal('regular-bullish')])), row('ETHUSDT'), row('WBTCUSDT')]
    for (const search of [' btc/usdt ', 'bTc-UsDt', 'BTC USDT']) {
      expect(symbols(rows, { search, starredOnly: true, starredSymbols: ['BTCUSDT'] })).toEqual(['BTCUSDT'])
    }
    expect(symbols(rows, { search: 'btc', starredOnly: true, starredSymbols: ['ETHUSDT'] })).toEqual([])
    expect(symbols(rows, { search: 'btc', signal: 'confirmed' })).toEqual([])
  })
})

describe('screener price context stays separate from RSI signals', () => {
  test.each(['bullish', 'bearish'] as const)('a %s TOW confirmation cannot match RSI filters or boost signal rank', (direction) => {
    const resolution = direction === 'bullish'
      ? { open: 115, high: 150, low: 115, close: 145 }
      : { open: 85, high: 85, low: 50, close: 55 }
    const bars = [...pendingTowHistory(), bar(23, resolution)]
    // This remains a real TOW confirmation in the independent chart indicator.
    expect(analyzeTugOfWar(bars).confirmation?.direction).toBe(direction)
    const current = analyzedRow(`PRICE-ONLY-${direction}`, bars)
    expect(current.analysis).toEqual({ divergences: [] })
    expect(hasConfirmedSignal(current.analysis)).toBe(false)
    expect(symbols([current])).toEqual([current.symbol])
    for (const selected of ['divergence', 'confirmed'] as const) {
      expect(symbols([current], { signal: selected })).toEqual([])
    }
    const quiet = row('QUIET')
    const forming = row('FORMING', analysis([signal('regular-bullish')]))
    expect(symbols([quiet, current, forming], { sort: 'signals' })).toEqual(['FORMING', 'QUIET', current.symbol])
  })

  test('opposing live price resolutions leave closed RSI analysis and signal filtering unchanged', () => {
    const history = pendingTowHistory()
    const initial = getScreenerAnalysis('PRICE-ONLY-LIVE', history, SETTINGS)
    const before = structuredClone(initial)
    for (const direction of ['bullish', 'bearish'] as const) {
      const resolution = direction === 'bullish'
        ? { open: 115, high: 150, low: 115, close: 145 }
        : { open: 85, high: 85, low: 50, close: 55 }
      const bars = [...history, bar(23, { ...resolution, isClosed: false })]
      expect(previewTugOfWar(bars)?.possibleResolution?.direction).toBe(direction)
      const current = analyzedRow('PRICE-ONLY-LIVE', bars)
      expect(current.analysis).toBe(initial)
      expect(current.analysis.divergences).toEqual([])
      expect(hasConfirmedSignal(current.analysis)).toBe(false)
      expect(symbols([current], { signal: 'divergence' })).toEqual([])
      expect(symbols([current], { signal: 'confirmed' })).toEqual([])
      expect(symbols([row('QUIET'), current], { sort: 'signals' })).toEqual(['QUIET', 'PRICE-ONLY-LIVE'])
    }
    expect(initial).toEqual(before)
  })

  test('all-pair signal ranking gives bullish and bearish confirmations equal priority over forming setups', () => {
    const forming = signal('regular-bullish')
    const rows = [
      row('FORMING', analysis([forming])),
      row('MIXED', analysis([forming, confirmedSignal(0, 'regular-bearish')])),
      row('CONFIRMED', analysis([confirmedSignal(13)])),
    ]
    expect(symbols(rows, { sort: 'signals' })).toEqual(['MIXED', 'CONFIRMED', 'FORMING'])
    expect(symbols([rows[0], rows[2], rows[1]], { sort: 'signals' })).toEqual(['CONFIRMED', 'MIXED', 'FORMING'])
  })
})

describe('screener sorting and price change', () => {
  test('preserves watchlist order without mutating input and sorts symbols alphabetically', () => {
    const rows = [row('ZZZ'), row('AAA'), row('MMM')]
    expect(symbols(rows)).toEqual(['ZZZ', 'AAA', 'MMM'])
    expect(filterScreenerRows(rows, filters())).not.toBe(rows)
    expect(symbols(rows, { sort: 'symbol' })).toEqual(['AAA', 'MMM', 'ZZZ'])
    expect(rows.map((item) => item.symbol)).toEqual(['ZZZ', 'AAA', 'MMM'])
  })

  test('places missing RSI and unloaded rows after values in either RSI sort direction', () => {
    const noRsi = row('NO-RSI')
    noRsi.snapshot = { ...noRsi.snapshot, series: [] }
    const rows = [
      noRsi,
      row('EMPTY', analysis(), []),
      row('HIGH', analysis(), [bar(0, { rsi: 80 })]),
      row('LOW', analysis(), [bar(0, { rsi: 20 })]),
      row('LOW-TIE', analysis(), [bar(0, { rsi: 20 })]),
    ]
    expect(symbols(rows, { sort: 'rsi-low' })).toEqual(['LOW', 'LOW-TIE', 'HIGH', 'NO-RSI', 'EMPTY'])
    expect(symbols(rows, { sort: 'rsi-high' })).toEqual(['HIGH', 'LOW', 'LOW-TIE', 'NO-RSI', 'EMPTY'])
  })

  test('ranks confirmations ahead of forming divergences, with loading rows last', () => {
    const rows = [
      row('EMPTY', analysis(), []),
      row('QUIET'),
      row('FORMING', analysis([signal('regular-bullish')])),
      row('CONFIRMED', analysis([confirmedSignal(0)])),
    ]
    expect(symbols(rows, { sort: 'signals' })).toEqual(['CONFIRMED', 'FORMING', 'QUIET', 'EMPTY'])
  })

  test('change uses the latest selected-timeframe candle, including its live preview', () => {
    const data = snapshot([
      bar(0, { open: 50, high: 100, low: 50, close: 100 }),
      bar(1, { open: 100, high: 110, low: 95, close: 105, isClosed: false }),
    ])
    // A separate displayed price cannot turn this candle change into a 24h metric.
    data.price = 200
    expect(candleChange(data)).toBe(5)
    expect(candleChange(snapshot([]))).toBeNull()
    expect(candleChange(snapshot([bar(0, { open: 0 })]))).toBeNull()

    const positive = row('UP', analysis(), [bar(0, { open: 100, close: 110, high: 110 })])
    const negative = row('DOWN', analysis(), [bar(0, { open: 100, close: 90, low: 90 })])
    const missing = row('EMPTY', analysis(), [])
    expect(symbols([negative, missing, positive], { sort: 'change' })).toEqual(['UP', 'DOWN', 'EMPTY'])
  })
})

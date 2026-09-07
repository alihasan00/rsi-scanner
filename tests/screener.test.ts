import { describe, expect, test } from 'bun:test'
import type { RsiBar, SymbolSnapshot } from '../src/types'
import type { DivergenceSetup } from '../src/lib/divergenceLifecycle'
import {
  candleChange,
  filterScreenerRows,
  getScreenerAnalysis,
  hasConfirmedSignal,
  isPendingTugOfWar,
  isTugOfWarSetup,
} from '../src/lib/screener'
import type { ScreenerAnalysis, ScreenerFilters, ScreenerRow, ScreenerSettings } from '../src/lib/screener'
import { analyzeTugOfWar, previewTugOfWar } from '../src/lib/tugOfWar'
import type { TugOfWarAnalysis } from '../src/lib/tugOfWar'

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

function analysis(divergences: DivergenceSetup[] = [], tugOfWar = analyzeTugOfWar(neutralHistory())): ScreenerAnalysis {
  return { divergences, tugOfWar }
}

function row(symbol: string, indicators = analysis(), bars = neutralHistory()): ScreenerRow {
  return { symbol, analysis: indicators, snapshot: snapshot(bars), feed: { state: 'ready', updatedAt: bars.at(-1)?.closeTime ?? null, error: null } }
}

function liveRow(symbol: string, bars: RsiBar[]): ScreenerRow {
  const indicators = getScreenerAnalysis(symbol, bars, SETTINGS)
  return {
    ...row(symbol, indicators, bars),
    preview: previewTugOfWar(bars, indicators.tugOfWar),
  }
}

function filters(patch: Partial<ScreenerFilters> = {}): ScreenerFilters {
  return { search: '', signal: 'all', direction: 'all', starredOnly: false, starredSymbols: [], sort: 'watchlist', ...patch }
}

function symbols(rows: readonly ScreenerRow[], options: Partial<ScreenerFilters> = {}): string[] {
  return filterScreenerRows(rows, filters(options)).map((item) => item.symbol)
}

function confirmedTow(direction: 'bullish' | 'bearish' = 'bullish'): TugOfWarAnalysis {
  const resolution = direction === 'bullish'
    ? { open: 115, high: 150, low: 115, close: 145 }
    : { open: 85, high: 85, low: 50, close: 55 }
  return analyzeTugOfWar([...pendingTowHistory(), bar(23, resolution)])
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

describe('screener signal filters', () => {
  test('confirmed includes confirmed divergences and latest TOW resolutions, excluding forming and pending', () => {
    const rows = [
      row('FORMING', analysis([signal('regular-bullish')])),
      row('DIVERGENCE', analysis([signal('regular-bearish', 'confirmed')])),
      row('PENDING', analysis([], analyzeTugOfWar(pendingTowHistory()))),
      row('RESOLVED', analysis([], confirmedTow())),
      row('QUIET'),
    ]
    expect(symbols(rows, { signal: 'confirmed' })).toEqual(['DIVERGENCE', 'RESOLVED'])
    expect(symbols(rows, { signal: 'divergence' })).toEqual(['FORMING', 'DIVERGENCE'])
    expect(symbols(rows, { signal: 'tug-of-war' })).toEqual(['PENDING', 'RESOLVED'])
  })

  test('direction must match the selected indicator on the same row', () => {
    const mixed = row('MIXED', analysis([signal('regular-bearish', 'confirmed')], confirmedTow('bullish')))
    expect(symbols([mixed], { signal: 'divergence', direction: 'bullish' })).toEqual([])
    expect(symbols([mixed], { signal: 'divergence', direction: 'bearish' })).toEqual(['MIXED'])
    expect(symbols([mixed], { signal: 'tug-of-war', direction: 'bullish' })).toEqual(['MIXED'])
    expect(symbols([mixed], { signal: 'tug-of-war', direction: 'bearish' })).toEqual([])

    const unconfirmedBull = row('FORMING-BULL', analysis([signal('regular-bullish')], confirmedTow('bearish')))
    expect(symbols([unconfirmedBull], { signal: 'confirmed', direction: 'bullish' })).toEqual([])
    expect(symbols([unconfirmedBull], { signal: 'confirmed', direction: 'bearish' })).toEqual(['FORMING-BULL'])
  })

  test('pending TOW never borrows the remembered direction', () => {
    const tow = analyzeTugOfWar(pendingTowHistory())
    expect(tow.trend).toBe('bullish')
    expect(isPendingTugOfWar(tow)).toBe(true)
    const pending = row('PENDING', analysis([], tow))
    expect(symbols([pending], { signal: 'tug-of-war' })).toEqual(['PENDING'])
    expect(symbols([pending], { direction: 'bullish' })).toEqual([])
    expect(symbols([pending], { signal: 'tug-of-war', direction: 'bullish' })).toEqual([])
  })

  test('a weak directional candle does not match remembered control as current direction', () => {
    const history = [
      ...neutralHistory().slice(0, 20),
      bar(20, { open: 100, high: 140, low: 100, close: 135 }),
      bar(21, { open: 109.375, high: 110.375, low: 109.375, close: 109.375 }),
    ]
    const tow = analyzeTugOfWar(history)
    expect(tow.control).toBe('bullish')
    expect(tow.trend).toBe('bullish')
    expect(tow.pendingTowCandles).toBe(0)
    expect(symbols([row('WEAK', analysis([], tow), history)], { direction: 'bullish' })).toEqual([])
  })

  test('empty and warming-up symbols remain browseable but cannot claim TOW signals', () => {
    const warmingBars = [bar(0, { high: 110, low: 90 })]
    const warming = analyzeTugOfWar(warmingBars)
    expect(warming.pendingTowCandles).toBe(1)
    expect(isPendingTugOfWar(warming)).toBe(false)
    const rows = [row('EMPTY', analysis([], analyzeTugOfWar([])), []), row('WARMUP', analysis([], warming), warmingBars)]
    expect(symbols(rows)).toEqual(['EMPTY', 'WARMUP'])
    for (const signalFilter of ['divergence', 'confirmed', 'tug-of-war'] as const) {
      expect(symbols(rows, { signal: signalFilter })).toEqual([])
    }
    expect(symbols(rows, { direction: 'bullish' })).toEqual([])
    expect(symbols(rows, { direction: 'bearish' })).toEqual([])
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

describe('screener live Tug of War', () => {
  test('current bearish control replaces previous closed bullish control in direction filters', () => {
    const history = pendingTowHistory().slice(0, 21)
    const falling = bar(21, { open: 110, high: 110.5, low: 60, close: 62, isClosed: false })
    const current = liveRow('LIVE-BEARISH', [...history, falling])

    expect(current.analysis.tugOfWar.control).toBe('bullish')
    expect(current.preview?.control).toBe('bearish')
    expect(current.preview?.isBodyQualified).toBe(true)
    expect(symbols([current], { direction: 'bearish' })).toEqual(['LIVE-BEARISH'])
    expect(symbols([current], { direction: 'bullish' })).toEqual([])
    expect(hasConfirmedSignal(current.analysis)).toBe(false)
  })

  test('a currently undecided candle is a TOW setup without borrowing closed bullish direction', () => {
    const history = pendingTowHistory().slice(0, 21)
    const undecided = bar(21, { open: 110, high: 110.5, low: 107, close: 110, isClosed: false })
    const current = liveRow('LIVE-PENDING', [...history, undecided])

    expect(current.analysis.tugOfWar.control).toBe('bullish')
    expect(current.analysis.tugOfWar.pendingTowCandles).toBe(0)
    expect(current.preview?.control).toBe('tugOfWar')
    expect(current.preview?.pendingTowCandles).toBe(1)
    expect(current.preview?.trend).toBe('bullish')
    expect(isTugOfWarSetup(current)).toBe(true)
    expect(symbols([current], { signal: 'tug-of-war' })).toEqual(['LIVE-PENDING'])
    for (const direction of ['bullish', 'bearish'] as const) {
      expect(symbols([current], { direction })).toEqual([])
      expect(symbols([current], { signal: 'tug-of-war', direction })).toEqual([])
    }
  })

  test('weak current control keeps a pending sequence out of both direction filters', () => {
    const history = pendingTowHistory()
    const closed = analyzeTugOfWar(history)
    const previous = closed.heikinAshi.at(-1)!
    const open = (previous.open + previous.close) / 2
    const weak = bar(23, { open, high: open + 1, low: open, close: open, isClosed: false })
    const current = liveRow('LIVE-WEAK', [...history, weak])

    expect(current.preview?.control).toBe('bullish')
    expect(current.preview?.isBodyQualified).toBe(false)
    expect(current.preview?.pendingTowCandles).toBe(2)
    expect(isTugOfWarSetup(current)).toBe(true)
    expect(symbols([current], { signal: 'tug-of-war' })).toEqual(['LIVE-WEAK'])
    expect(symbols([current], { direction: 'bullish' })).toEqual([])
    expect(symbols([current], { direction: 'bearish' })).toEqual([])
  })

  test('TOW setup filters include a possible resolution but exclude ordinary live directional control', () => {
    const resolution = liveRow('LIVE-REVERSAL', [
      ...pendingTowHistory(),
      bar(23, { open: 85, high: 85, low: 50, close: 55, isClosed: false }),
    ])
    const ordinary = liveRow('LIVE-ORDINARY', [
      ...pendingTowHistory().slice(0, 21),
      bar(21, { open: 110, high: 110.5, low: 60, close: 62, isClosed: false }),
    ])

    expect(resolution.preview?.possibleResolution).toEqual({ direction: 'bearish', kind: 'reversal', towCandleCount: 2 })
    expect(ordinary.preview?.control).toBe('bearish')
    expect(ordinary.preview?.possibleResolution).toBeNull()
    expect(ordinary.preview?.pendingTowCandles).toBe(0)
    expect(isTugOfWarSetup(resolution)).toBe(true)
    expect(isTugOfWarSetup(ordinary)).toBe(false)
    const rows = [ordinary, resolution]
    expect(symbols(rows, { direction: 'bearish' })).toEqual(['LIVE-ORDINARY', 'LIVE-REVERSAL'])
    expect(symbols(rows, { signal: 'tug-of-war' })).toEqual(['LIVE-REVERSAL'])
    expect(symbols(rows, { signal: 'tug-of-war', direction: 'bearish' })).toEqual(['LIVE-REVERSAL'])
    expect(symbols(rows, { signal: 'tug-of-war', direction: 'bullish' })).toEqual([])
    expect(symbols(rows, { signal: 'confirmed' })).toEqual([])
  })

  test('successive live ticks change filtering while reusing and preserving closed signal analysis', () => {
    const history = pendingTowHistory().slice(0, 21)
    const initial = getScreenerAnalysis('LIVE-CACHE', history, SETTINGS)
    const before = structuredClone(initial)
    const early = bar(21, { open: 110, high: 110.5, low: 107, close: 110, isClosed: false })
    const falling = { ...early, low: 60, close: 62 }
    const undecided = liveRow('LIVE-CACHE', [...history, early])
    const bearish = liveRow('LIVE-CACHE', [...history, falling])

    expect(undecided.analysis).toBe(initial)
    expect(bearish.analysis).toBe(initial)
    expect(undecided.preview?.control).toBe('tugOfWar')
    expect(bearish.preview?.control).toBe('bearish')
    expect(bearish.preview).not.toBe(undecided.preview)
    expect(symbols([undecided], { signal: 'tug-of-war' })).toEqual(['LIVE-CACHE'])
    expect(symbols([bearish], { signal: 'tug-of-war' })).toEqual([])
    expect(symbols([undecided], { direction: 'bearish' })).toEqual([])
    expect(symbols([bearish], { direction: 'bearish' })).toEqual(['LIVE-CACHE'])
    expect(initial).toEqual(before)
    expect(initial.tugOfWar.control).toBe('bullish')
    expect(initial.tugOfWar.lastClosedTime).toBe(history.at(-1)?.closeTime)

    const closed = liveRow('LIVE-CACHE', [...history, { ...falling, isClosed: true }])
    expect(closed.analysis).not.toBe(initial)
    expect(closed.analysis.tugOfWar.control).toBe('bearish')
    expect(closed.analysis.tugOfWar.lastClosedTime).toBe(falling.closeTime)
    expect(closed.preview).toBeNull()
    expect(symbols([closed], { direction: 'bearish' })).toEqual(['LIVE-CACHE'])
    expect(initial).toEqual(before)
  })

  test('closed confirmation direction stays independent of bearish or pending live previews', () => {
    const history = [
      ...pendingTowHistory(),
      bar(23, { open: 115, high: 150, low: 115, close: 145 }),
    ]
    const bearish = liveRow('CLOSED-BULL-LIVE-BEAR', [
      ...history, bar(24, { open: 120, high: 120.5, low: 60, close: 62, isClosed: false }),
    ])
    const pending = liveRow('CLOSED-BULL-LIVE-PENDING', [
      ...history, bar(24, { open: 123, high: 140, low: 110, close: 125, isClosed: false }),
    ])

    expect(bearish.preview?.control).toBe('bearish')
    expect(pending.preview?.control).toBe('tugOfWar')
    for (const current of [bearish, pending]) {
      expect(current.analysis.tugOfWar.confirmation?.direction).toBe('bullish')
      expect(symbols([current], { signal: 'confirmed', direction: 'bullish' })).toEqual([current.symbol])
      expect(symbols([current], { signal: 'confirmed', direction: 'bearish' })).toEqual([])
    }
    expect(symbols([bearish, pending], { direction: 'bearish' })).toEqual(['CLOSED-BULL-LIVE-BEAR'])
  })

  test('active sorting promotes current pending and possible resolutions without boosting stale closed states', () => {
    const history = pendingTowHistory()
    const quiet = row('QUIET')
    const oldPending = liveRow('OLD-PENDING', [
      ...history.slice(0, 22),
      bar(22, { open: 115, high: 150, low: 115, close: 145, isClosed: false }),
    ])
    const oldDecision = liveRow('OLD-DECISION', [
      ...history,
      bar(23, { open: 115, high: 150, low: 115, close: 145 }),
      bar(24, { open: 120, high: 120.5, low: 60, close: 62, isClosed: false }),
    ])
    const pending = liveRow('NEW-PENDING', [
      ...history.slice(0, 21),
      bar(21, { open: 110, high: 110.5, low: 107, close: 110, isClosed: false }),
    ])
    const resolution = liveRow('NEW-RESOLUTION', [
      ...history,
      bar(23, { open: 85, high: 85, low: 50, close: 55, isClosed: false }),
    ])

    expect(oldPending.analysis.tugOfWar.pendingTowCandles).toBe(1)
    expect(oldDecision.analysis.tugOfWar.confirmation?.direction).toBe('bullish')
    expect(isTugOfWarSetup(oldPending)).toBe(false)
    expect(isTugOfWarSetup(oldDecision)).toBe(false)
    expect(pending.analysis.tugOfWar.pendingTowCandles).toBe(0)
    expect(pending.preview?.pendingTowCandles).toBe(1)
    expect(resolution.preview?.possibleResolution?.direction).toBe('bearish')
    expect(symbols([quiet, oldPending, oldDecision, pending, resolution], { sort: 'signals' })).toEqual([
      'NEW-RESOLUTION', 'NEW-PENDING', 'QUIET', 'OLD-PENDING', 'OLD-DECISION',
    ])
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
      row('EMPTY', analysis([], analyzeTugOfWar([])), []),
      row('HIGH', analysis(), [bar(0, { rsi: 80 })]),
      row('LOW', analysis(), [bar(0, { rsi: 20 })]),
      row('LOW-TIE', analysis(), [bar(0, { rsi: 20 })]),
    ]
    expect(symbols(rows, { sort: 'rsi-low' })).toEqual(['LOW', 'LOW-TIE', 'HIGH', 'NO-RSI', 'EMPTY'])
    expect(symbols(rows, { sort: 'rsi-high' })).toEqual(['HIGH', 'LOW', 'LOW-TIE', 'NO-RSI', 'EMPTY'])
  })

  test('ranks confirmations ahead of forming divergences and pending TOW, with loading rows last', () => {
    const rows = [
      row('EMPTY', analysis([], analyzeTugOfWar([])), []),
      row('QUIET'),
      row('TOW', analysis([], analyzeTugOfWar(pendingTowHistory()))),
      row('FORMING', analysis([signal('regular-bullish')])),
      row('CONFIRMED', analysis([], confirmedTow())),
    ]
    expect(symbols(rows, { sort: 'signals' })).toEqual(['CONFIRMED', 'FORMING', 'TOW', 'QUIET', 'EMPTY'])
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
    const missing = row('EMPTY', analysis([], analyzeTugOfWar([])), [])
    expect(symbols([negative, missing, positive], { sort: 'change' })).toEqual(['UP', 'DOWN', 'EMPTY'])
  })
})

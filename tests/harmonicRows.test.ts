import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import type { ScreenerRow } from '../src/lib/screener'
import type { HarmonicSetup } from '../src/lib/harmonics'
import type { ScreenerFilterPreferences } from '../src/lib/screenerPreferences'
import { DEFAULT_SCREENER_PREFERENCES } from '../src/lib/screenerPreferences'
import { analyzeHarmonics, getHarmonicLiveContext } from '../src/lib/harmonics'
import { makeHarmonicRows, selectHarmonicSetup } from '../src/lib/harmonicRows'

function bar(index: number, price: number, patch: Partial<RsiBar> = {}): RsiBar {
  return {
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: price, high: price, low: price, close: price, volume: 10, rsi: 50, isClosed: true, ...patch,
  }
}

function pattern(): RsiBar[] {
  return [120, 115, 110, 100, 125, 150, 175, 200, 180, 160, 150, 138.2, 150, 160, 170, 176.3924, 170, 165, 160]
    .map((price, index) => bar(index, price))
}

function filters(patch: Partial<ScreenerFilterPreferences> = {}): ScreenerFilterPreferences {
  return { ...DEFAULT_SCREENER_PREFERENCES, signal: 'harmonic', ...patch }
}

function row(symbol: string, price = 160, bars = pattern()): ScreenerRow {
  return {
    symbol, snapshot: { bars, price, volume: 10, series: bars.map((candle) => candle.rsi) },
    analysis: { divergences: [] }, feed: { state: 'ready', updatedAt: bars.at(-1)?.closeTime ?? null, error: null },
  }
}

function symbols(rows: readonly ScreenerRow[], patch: Partial<ScreenerFilterPreferences> = {}, starred: readonly string[] = []): string[] {
  return makeHarmonicRows(rows, filters(patch), starred).map((item) => item.row.symbol)
}

describe('production harmonic setup selection', () => {
  test('applies family, direction, and stage before choosing the newest geometry', () => {
    const analysis = analyzeHarmonics(pattern())
    const original = analysis.setups[0]
    // Geometry is engine-tested; this isolates selection of several valid candidates.
    const older: HarmonicSetup = { ...original, id: 'older', confirmedAt: 1 }
    const newest: HarmonicSetup = { ...original, id: 'newest', kind: 'butterfly', direction: 'bearish', stage: 'zone', confirmedAt: 4 }
    const bat: HarmonicSetup = { ...original, id: 'bat', kind: 'bat', direction: 'bearish', stage: 'approaching', confirmedAt: 3 }
    const gartley: HarmonicSetup = { ...original, id: 'gartley', stage: 'approaching', confirmedAt: 2 }
    const candidates = { ...analysis, setups: [newest, older, gartley, bat] }
    const before = structuredClone(candidates)
    expect(selectHarmonicSetup(candidates, filters())).toBe(newest)
    expect(selectHarmonicSetup(candidates, filters({ harmonicPattern: 'gartley' }))).toBe(gartley)
    expect(selectHarmonicSetup(candidates, filters({ harmonicPattern: 'gartley', harmonicStage: 'forming' }))).toBe(older)
    expect(selectHarmonicSetup(candidates, filters({ harmonicDirection: 'bullish' }))).toBe(gartley)
    expect(selectHarmonicSetup(candidates, filters({ harmonicDirection: 'bearish', harmonicStage: 'approaching' }))).toBe(bat)
    expect(selectHarmonicSetup(candidates, filters({ harmonicPattern: 'bat', harmonicDirection: 'bullish' }))).toBeUndefined()
    expect(candidates).toEqual(before)
  })

  test.each(['invalidated', 'missed', 'expired', 'completed'] as const)('%s candidates cannot hide an older active setup', (status) => {
    const analysis = analyzeHarmonics(pattern())
    const active = analysis.setups[0]
    const terminal = { ...active, id: status, status, confirmedAt: active.confirmedAt + 1 }
    expect(selectHarmonicSetup({ ...analysis, setups: [terminal, active] }, filters())).toBe(active)
    expect(selectHarmonicSetup({ ...analysis, setups: [terminal] }, filters())).toBeUndefined()
  })

  test('empty analysis has no selectable geometry', () => {
    expect(selectHarmonicSetup(analyzeHarmonics([]), filters())).toBeUndefined()
  })
})

describe('production harmonic rows', () => {
  test('RSI, Fib, and support/resistance filter choices do not constrain harmonic rows', () => {
    const rows = [row('BTCUSDT'), row('ETHUSDT')]
    expect(symbols(rows, {
      rsiState: 'overbought', divergenceRecency: 1, sort: 'rsi-high',
      fibDirection: 'short', fibStage: 'pocket', fibConfluence: 'aligned',
      srSource: 'monday', srSignal: 'bearish', srSort: 'nearest',
    })).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(symbols(rows, { harmonicPattern: 'bat' })).toEqual([])
    expect(symbols(rows, { harmonicDirection: 'bearish' })).toEqual([])
    expect(symbols(rows, { harmonicStage: 'zone' })).toEqual([])
  })

  test('search normalizes case, spaces, slashes, and hyphens and composes with favorites', () => {
    const rows = [row('BTCUSDT'), row('ETHUSDT'), row('SOLUSDT')]
    expect(symbols(rows, { search: '  eth / usdt ' })).toEqual(['ETHUSDT'])
    expect(symbols(rows, { search: 'btc-usdt' })).toEqual(['BTCUSDT'])
    expect(symbols(rows, { starredOnly: true }, ['SOLUSDT', 'BTCUSDT'])).toEqual(['BTCUSDT', 'SOLUSDT'])
    expect(symbols(rows, { search: 'eth', starredOnly: true }, ['SOLUSDT'])).toEqual([])
    expect(symbols(rows, { starredOnly: true })).toEqual([])
  })

  test('watchlist order survives price changes and a newly loaded pair in its original position', () => {
    const bars = pattern()
    const rows = [row('SOLUSDT', 180, bars), row('BTCUSDT', 131, []), row('ETHUSDT', 140, bars)]
    expect(symbols(rows)).toEqual(['SOLUSDT', 'ETHUSDT'])
    const loaded = [rows[0], row('BTCUSDT', 131, bars), rows[2]]
    expect(symbols(loaded)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT'])
    const changed = loaded.map((item, index) => ({ ...item, snapshot: { ...item.snapshot, price: [124, 175, 131][index] } }))
    expect(symbols(changed)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT'])
    expect(rows.map((item) => item.symbol)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT'])
  })

  test('nearest-zone and name sorting are optional and leave source order unchanged', () => {
    const rows = [row('SOLUSDT', 180), row('BTCUSDT', 140), row('ETHUSDT', 131)]
    expect(symbols(rows, { harmonicSort: 'nearest' })).toEqual(['ETHUSDT', 'BTCUSDT', 'SOLUSDT'])
    expect(symbols(rows, { harmonicSort: 'symbol' })).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    const inZone = rows.map((item) => item.symbol === 'SOLUSDT' ? { ...item, snapshot: { ...item.snapshot, price: 124 } } : item)
    expect(symbols(inZone, { harmonicSort: 'nearest' })).toEqual(['SOLUSDT', 'ETHUSDT', 'BTCUSDT'])
    expect(rows.map((item) => item.symbol)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT'])
  })

  test('live zone contact does not promote closed stage and closes do update the production row', () => {
    const bars = pattern()
    const live = bar(19, 124, { isClosed: false })
    const preview = row('HARMONIC-STAGEUSDT', 124, [...bars, live])
    const selected = makeHarmonicRows([preview], filters(), [])[0]
    expect(selected.setup.stage).toBe('forming')
    expect(selected.setup.d).toBeNull()
    expect(getHarmonicLiveContext(selected.setup, 124, live).inZone).toBe(true)
    expect(symbols([preview], { harmonicStage: 'forming' })).toEqual(['HARMONIC-STAGEUSDT'])
    expect(symbols([preview], { harmonicStage: 'zone' })).toEqual([])
    const closed = row(preview.symbol, 124, [...bars, { ...live, isClosed: true }])
    expect(symbols([closed], { harmonicStage: 'zone' })).toEqual(['HARMONIC-STAGEUSDT'])
    expect(symbols([closed], { harmonicStage: 'forming' })).toEqual([])
  })

  test('a provisional boundary breach retains its closed setup for a warning until the violation closes', () => {
    const bars = pattern()
    const live = bar(19, 160, { high: 201, low: 155, isClosed: false })
    const preview = row('HARMONIC-WARNINGUSDT', 160, [...bars, live])
    const selected = makeHarmonicRows([preview], filters(), [])[0]
    expect(selected.setup.status).toBe('active')
    expect(getHarmonicLiveContext(selected.setup, 160, live).invalidated).toBe(true)
    const closed = row(preview.symbol, 160, [...bars, { ...live, isClosed: true }])
    expect(symbols([closed])).toEqual([])
  })

  test('missing histories and already missed zone contacts cannot produce cards', () => {
    const missed = pattern()
    missed[18] = { ...missed[18], low: 124 }
    expect(symbols([row('MISSINGUSDT', 0, []), row('MISSEDUSDT', 160, missed)])).toEqual([])
  })
})

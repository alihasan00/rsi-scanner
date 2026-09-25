import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { createHarmonicAnalysisCache, type HarmonicCheckpointStorage } from '../src/lib/harmonicReplayCache'
import { analyzeHarmonics, getHarmonicTargets } from '../src/lib/harmonics'

function bar(index: number, price: number, patch: Partial<RsiBar> = {}): RsiBar {
  return { openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: price, high: price, low: price, close: price, volume: 10, rsi: 50, isClosed: true, ...patch }
}
function history(length = 1_200): RsiBar[] {
  const bars = [120, 115, 110, 100, 125, 150, 175, 200, 180, 160, 150, 138.2, 150, 160, 170, 176.3924, 170, 165, 160]
    .map((price, i) => bar(i, price))
  while (bars.length < length) bars.push(bar(bars.length, 120, { low: 118, high: 122 }))
  return bars
}
function memory(): HarmonicCheckpointStorage & { values: Map<string, string>; writes: number } {
  const values = new Map<string, string>()
  return { values, writes: 0, get length() { return values.size }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem(key, value) { this.writes++; values.set(key, value) }, removeItem: (key) => { values.delete(key) } }
}
const identity = 'spot:1m:HARMONIC-REPLAY'

describe('harmonic lifecycle checkpoints', () => {
  test('rolling snapshots retain first contact, stable anchors and later completion across reload', () => {
    const storage = memory()
    const cache = createHarmonicAnalysisCache(storage)
    const bars = history()
    const initial = cache.get(identity, bars.slice(0, 500))
    const before = structuredClone(initial)
    for (const length of [501, 506, 800, 1_200]) {
      const analysis = cache.get(identity, bars.slice(Math.max(0, length - 500), length))
      expect(analysis.setups[0]).toMatchObject({ id: initial.setups[0].id, status: 'active', x: initial.setups[0].x, d: initial.setups[0].d })
      expect(analysis.setups[0].lastTouchIndex).toBe(length - 1)
    }
    expect(initial).toEqual(before)
    const reloaded = createHarmonicAnalysisCache(storage).get(identity, bars.slice(-500))
    expect(reloaded.setups).toEqual(analyzeHarmonics(bars).setups)
    expect(reloaded.continuity?.state).toBe('restored')
    const finished = createHarmonicAnalysisCache(storage).get(identity, [...bars.slice(-499), bar(1_200, 140)])
    expect(finished.setups[0]).toMatchObject({ status: 'completed', endedAt: bar(1_200, 140).closeTime })
    expect(getHarmonicTargets(finished.setups[0])).toEqual(getHarmonicTargets(initial.setups[0]))
    expect([...storage.values.values()].reduce((sum, item) => sum + item.length, 0)).toBeLessThan(1_500_000)
  })

  test('same-value refreshes and provisional updates do not rewrite storage or mutate prior output', () => {
    const storage = memory()
    const cache = createHarmonicAnalysisCache(storage)
    const bars = history(510)
    const first = cache.get(identity, bars)
    const writes = storage.writes
    expect(cache.get(identity, structuredClone(bars))).toBe(first)
    expect(cache.get(identity, [...bars, bar(510, NaN, { isClosed: false })])).toBe(first)
    expect(storage.writes).toBe(writes)
    bars[503].low = 99
    const corrected = cache.get(identity, bars)
    expect(corrected.setups[0]).toMatchObject({ status: 'invalidated', endedAt: bars[503].closeTime })
    expect(first.setups[0].status).toBe('active')
    expect(storage.writes).toBeGreaterThan(writes)
  })

  test('a correction inside the replay window rolls back a previously completed outcome', () => {
    const storage = memory()
    const bars = history(1_050)
    bars[1_000] = bar(1_000, 140)
    const cache = createHarmonicAnalysisCache(storage)
    expect(cache.get(identity, bars).setups[0].status).toBe('completed')
    bars[1_000] = bar(1_000, 120, { low: 118, high: 122 })
    const corrected = cache.get(identity, bars.slice(-500))
    expect(corrected.setups[0].status).toBe('active')
    expect(corrected.setups).toEqual(analyzeHarmonics(bars).setups)
    expect(createHarmonicAnalysisCache(storage).get(identity, bars.slice(-500)).setups).toEqual(corrected.setups)
  })

  test('old corrections before the replay checkpoint rebuild and report lost partial evidence', () => {
    const bars = history()
    const cache = createHarmonicAnalysisCache(null)
    const initial = cache.get(identity, bars)
    bars[3].low = 99
    const full = cache.get(identity, bars)
    expect(full.continuity?.state).toBe('reset')
    expect(full.setups[0].x.price).toBe(99)
    expect(initial.setups[0].x.price).toBe(100)
    bars[600].low = 98
    const partial = cache.get(identity, bars.slice(100))
    expect(partial.continuity?.state).toBe('reset')
    expect(partial.setups).toEqual(analyzeHarmonics(bars.slice(100)).setups)
    expect(partial.setups.some((setup) => setup.id === initial.setups[0].id)).toBe(false)
  })

  test('a contiguous append can reconnect without overlap, while missing bars reset', () => {
    const cache = createHarmonicAnalysisCache(null)
    const bars = history(900)
    const initial = cache.get(identity, bars.slice(0, 800))
    const continued = cache.get(identity, bars.slice(800, 850))
    expect(continued.setups[0].id).toBe(initial.setups[0].id)
    const missed = cache.get(identity, bars.slice(851))
    expect(missed.setups).toEqual([])
    expect(missed.continuity).toMatchObject({ state: 'reset', previousSetupId: initial.setups[0].id })
  })

  test('backwards time resets, and an empty loading snapshot preserves saved state', () => {
    const storage = memory()
    const cache = createHarmonicAnalysisCache(storage)
    const bars = history()
    cache.get(identity, bars)
    expect(cache.get(identity, [])).toEqual({ setups: [], closedBarCount: 0 })
    expect(createHarmonicAnalysisCache(storage).get(identity, bars.slice(-500)).setups[0].status).toBe('active')
    const backwards = cache.get(identity, bars.slice(300, 800))
    expect(backwards.continuity?.detail).toContain('backwards')
    expect(backwards.setups).toEqual([])
    cache.reset(identity)
    expect(storage.length).toBe(0)
  })

  test('gaps and changed durations inside a window cannot preserve old setup state', () => {
    const bars = history()
    for (const interruption of ['missing', 'provisional', 'duration', 'invalid'] as const) {
      const storage = memory()
      const cache = createHarmonicAnalysisCache(storage)
      cache.get(identity, bars)
      const changed = structuredClone(bars.slice(-500))
      if (interruption === 'missing') changed.splice(200, 1)
      else if (interruption === 'provisional') changed[200].isClosed = false
      else if (interruption === 'duration') changed[200].closeTime--
      else changed[200].low = NaN
      const result = cache.get(identity, changed)
      expect(result.setups).toEqual([])
      expect(result.continuity?.state).toBe('reset')
      expect(createHarmonicAnalysisCache(storage).get(identity, changed.slice(201)).setups).toEqual([])
    }
  })

  test('an earlier gap does not discard a later active setup once its anchors are checkpointed', () => {
    const bars = [bar(0, 100), ...history().map((candle) => ({ ...candle, openTime: candle.openTime + 120_000, closeTime: candle.closeTime + 120_000 }))]
    const storage = memory()
    const initial = createHarmonicAnalysisCache(storage).get(identity, bars)
    expect(initial.setups[0].status).toBe('active')
    const restored = createHarmonicAnalysisCache(storage).get(identity, bars.slice(-500))
    expect(restored.setups).toEqual(initial.setups)
  })

  test.each(['json', 'version', 'anchor', 'ratio', 'zone', 'indices', 'kinds', 'extreme', 'confirmation', 'window'] as const)('rejects corrupt %s checkpoints rather than resurrecting setups', (corruption) => {
    const storage = memory()
    createHarmonicAnalysisCache(storage).get(identity, history())
    const [key, encoded] = [...storage.values.entries()][0]
    const value = JSON.parse(encoded)
    if (corruption === 'json') storage.values.set(key, '{')
    else {
      if (corruption === 'version') value.version = 100
      if (corruption === 'anchor') value.baseline.setups[0].x.price = -1
      if (corruption === 'ratio') value.baseline.setups[0].bRatio = 0.1
      if (corruption === 'zone') value.baseline.setups[0].zone.high = 900
      if (corruption === 'indices') value.baseline.setups[0].x.index = 999999
      if (corruption === 'kinds') value.baseline.kinds[1] = 'high'
      if (corruption === 'extreme') value.baseline.dExtremes[value.baseline.setups[0].id].price = 900
      if (corruption === 'confirmation') value.baseline.setups[0].dConfirmedAt = 99
      if (corruption === 'window') value.window[1].openTime += 10
      storage.values.set(key, JSON.stringify(value))
    }
    const result = createHarmonicAnalysisCache(storage).get(identity, history().slice(-500))
    expect(result.setups).toEqual([])
    expect(result.continuity?.state).toBe('reset')
    expect(result.continuity?.detail).toContain('could not be verified')
  })

  test('bounded storage leaves an explicit notice when an older record is evicted', () => {
    const storage = memory()
    const cache = createHarmonicAnalysisCache(storage)
    const bars = history()
    for (let i = 0; i < 20; i++) cache.get(`spot:1m:TEST${i}`, bars)
    const saved = [...storage.values.values()].map((value) => JSON.parse(value))
    expect(saved.filter((value) => !value.evicted).length).toBeLessThanOrEqual(16)
    expect([...storage.values.values()].reduce((sum, value) => sum + value.length, 0)).toBeLessThanOrEqual(1_500_000)
    const lost = createHarmonicAnalysisCache(storage).get('spot:1m:TEST0', bars.slice(-500))
    expect(lost.setups).toEqual([])
    expect(lost.continuity?.detail).toContain('retention')
  })


  test('a failed save cannot resurrect an older baseline after an old-anchor correction', () => {
    const storage = memory()
    const cache = createHarmonicAnalysisCache(storage)
    const bars = history()
    cache.get(identity, bars)
    const write = storage.setItem.bind(storage)
    storage.setItem = (key, value) => { if (value.length > 3_000) throw new Error('Quota exceeded'); write(key, value) }
    bars[3].low = 99
    const corrected = cache.get(identity, bars)
    expect(corrected.setups[0].x.price).toBe(99)
    expect(corrected.persistenceIssue).toBe('unavailable')
    storage.setItem = write
    const restored = createHarmonicAnalysisCache(storage).get(identity, bars.slice(-500))
    expect(restored.setups).toEqual([])
    expect(restored.continuity?.state).toBe('reset')
    expect(restored.continuity?.detail).toContain('could not be saved')
  })

  test('storage write failure is visible while in-memory continuity remains intact', () => {
    const storage = memory()
    storage.setItem = () => { throw new Error('Quota exceeded') }
    const cache = createHarmonicAnalysisCache(storage)
    const bars = history()
    expect(cache.get(identity, bars).persistenceIssue).toBe('unavailable')
    expect(cache.get(identity, [...bars.slice(-499), bar(1_200, 120)]).setups[0].status).toBe('active')
  })
})

import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { findRsiTrendlines } from '../src/lib/rsiTrendlines'
import { getRsiTrendlineAnalysis, selectDisplayedTrendlines, trendlineStatusLabel } from '../src/lib/rsiTrendlineAnalysis'

function bars(values: number[]): RsiBar[] {
  return values.map((rsi, index) => ({
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: 100, close: 101, low: 99, high: 102, volume: 10, rsi, isClosed: true,
  }))
}
const resistance = [50, 55, 60, 65, 70, 75, 80, 73, 69, 65, 62, 60, 62, 65, 69, 64, 60, 55, 51, 48]
const idealBreak = [...resistance, 44, 42, 39, 38, 40, 45, 46, 47, 48, 49]

describe('shared trendline analysis', () => {
  test('live preview replacements reuse the closed analysis, then a close recomputes it', () => {
    const closed = bars(resistance)
    const first = getRsiTrendlineAnalysis('CACHE', closed)
    expect(first.displayed).toHaveLength(1)
    const preview = { ...bars([...resistance, 95]).at(-1)!, isClosed: false }
    expect(getRsiTrendlineAnalysis('CACHE', [...closed, preview])).toBe(first)
    expect(getRsiTrendlineAnalysis('CACHE', [...closed, { ...preview, rsi: 10 }])).toBe(first)
    const final = getRsiTrendlineAnalysis('CACHE', [...closed, { ...preview, isClosed: true }])
    expect(final).not.toBe(first)
    expect(final.displayed[0].state).toBe('broken')
  })

  test('corrected history and different timeframe data invalidate the cache', () => {
    const original = bars(resistance)
    const first = getRsiTrendlineAnalysis('CORRECTION', original)
    const corrected = [...original]
    corrected[14] = { ...corrected[14], rsi: 82 }
    expect(getRsiTrendlineAnalysis('CORRECTION', corrected).displayed).toHaveLength(0)
    const differentTimeframe = original.map((bar) => ({ ...bar, openTime: bar.openTime * 4, closeTime: (bar.closeTime + 1) * 4 - 1 }))
    const replacement = getRsiTrendlineAnalysis('CORRECTION', differentTimeframe)
    expect(replacement).not.toBe(first)
    expect(replacement.displayed[0].start.time).toBe(first.displayed[0].start.time * 4)
  })

  test('interior unclosed evidence interrupts lines rather than being filtered away', () => {
    const original = bars(idealBreak)
    const complete = getRsiTrendlineAnalysis('GAP', original)
    expect(complete.displayed[0].state).toBe('broken')
    const interrupted = [...original]
    interrupted[20] = { ...interrupted[20], isClosed: false }
    expect(getRsiTrendlineAnalysis('GAP', interrupted).displayed).toHaveLength(0)
  })

  test('shows at most one line per kind and preserves an active bearish warning', () => {
    const rising = findRsiTrendlines(bars(idealBreak.map((rsi) => 100 - rsi))).find((line) => line.warningActive)!
    const falling = findRsiTrendlines(bars(resistance))[0]
    expect(rising).toBeDefined()
    const newerSupport = { ...rising, id: 'new-support', state: 'formed' as const, formedAt: rising.formedAt + 1, warningActive: false }
    const expired = { ...falling, id: 'expired', state: 'expired' as const, formedAt: falling.formedAt + 100 }
    expect(selectDisplayedTrendlines([rising, newerSupport, falling, expired]).map((line) => line.id)).toEqual([falling.id, rising.id])
    expect(getRsiTrendlineAnalysis('WARNING', bars(idealBreak.map((rsi) => 100 - rsi))).noLongs).toBe(true)
  })

  test('labels break direction and quality without calling it an entry', () => {
    const ideal = findRsiTrendlines(bars(idealBreak))[0]
    expect(trendlineStatusLabel(ideal)).toBe('Bullish break · ideal')
    const sameSide = findRsiTrendlines(bars([...resistance, 95]))[0]
    expect(trendlineStatusLabel(sameSide)).toBe('Bullish break · non-ideal')
  })
})

import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import { seedRsiState } from '../src/lib/rsi'
import { buildResearchRsiBars } from '../src/lib/researchOscillators'

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + Math.sin(index / 4) * 9 + index / 10
    return { openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1, open: close, high: close + 1, low: close - 1, close, volume: 10 }
  })
}
describe('independent research oscillators', () => {
  test.each([12, 14, 16])('Wilder RSI %i reproduces the existing baseline calculation', (period) => {
    const input = candles(75)
    const expected = seedRsiState(input.map((bar) => bar.close), period)!
    const actual = buildResearchRsiBars(input, { kind: 'wilder', period })
    expect(actual.slice(0, period).every((bar) => Number.isNaN(bar.rsi))).toBe(true)
    actual.slice(period).forEach((bar, index) => expect(bar.rsi).toBeCloseTo(expected.series[index], 10))
  })

  test.each(['wilder', 'trend-weighted', 'adaptive'] as const)('%s is causal and restarts at missing bars', (kind) => {
    const input = candles(100)
    const before = buildResearchRsiBars(input.slice(0, 60), { kind, period: 14 })
    const after = buildResearchRsiBars(input, { kind, period: 14 })
    expect(after.slice(0, 60)).toEqual(before)
    expect(after.filter((bar) => Number.isFinite(bar.rsi)).every((bar) => bar.rsi >= 0 && bar.rsi <= 100)).toBe(true)
    const gap = buildResearchRsiBars([...input.slice(0, 50), ...input.slice(60)], { kind, period: 14 })
    expect(gap.slice(50, 64).every((bar) => Number.isNaN(bar.rsi))).toBe(true)
    expect(Number.isFinite(gap[64].rsi)).toBe(true)
  })

  test('experiments differ from the baseline and neutral prices remain neutral', () => {
    const input = candles(100)
    const baseline = buildResearchRsiBars(input, { kind: 'wilder', period: 14 }).at(-1)!.rsi
    for (const kind of ['trend-weighted', 'adaptive'] as const) {
      expect(buildResearchRsiBars(input, { kind, period: 14 }).at(-1)!.rsi).not.toBeCloseTo(baseline, 3)
      const flat = input.map((bar) => ({ ...bar, open: 100, close: 100, high: 100, low: 100 }))
      expect(buildResearchRsiBars(flat, { kind, period: 14 }).at(-1)!.rsi).toBe(50)
    }
  })

  test('rejects invalid periods, candles and unordered data', () => {
    expect(() => buildResearchRsiBars(candles(10), { kind: 'wilder', period: 1 })).toThrow('period')
    expect(() => buildResearchRsiBars(candles(10).reverse(), { kind: 'wilder', period: 14 })).toThrow('ordered')
    expect(() => buildResearchRsiBars([{ ...candles(1)[0], close: NaN }], { kind: 'wilder', period: 14 })).toThrow('Invalid')
    const preview = { ...candles(1)[0], isClosed: false }
    expect(() => buildResearchRsiBars([preview], { kind: 'wilder', period: 14 })).toThrow('unclosed')
  })
})

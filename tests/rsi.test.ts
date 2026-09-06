import { describe, expect, test } from 'bun:test'
import {
  RSI_LENGTH,
  SERIES_CAP,
  advanceRsiState,
  computeSma,
  seedRsiState,
} from '../src/lib/rsi'

function closesWithStep(step: number, count = RSI_LENGTH + 2): number[] {
  return Array.from({ length: count }, (_, index) => 100 + index * step)
}

describe('seedRsiState', () => {
  test('returns null without enough closes', () => {
    expect(seedRsiState(closesWithStep(1, RSI_LENGTH))).toBeNull()
  })

  test('returns neutral RSI for a flat market', () => {
    const state = seedRsiState(closesWithStep(0))

    expect(state).not.toBeNull()
    expect(state?.series.at(-1)).toBe(50)
  })

  test('returns 100 when every move is upward', () => {
    const state = seedRsiState(closesWithStep(1))

    expect(state).not.toBeNull()
    expect(state?.series.at(-1)).toBe(100)
  })

  test('returns 0 when every move is downward', () => {
    const state = seedRsiState(closesWithStep(-1))

    expect(state).not.toBeNull()
    expect(state?.series.at(-1)).toBe(0)
  })

  test('caps seeded history at the configured series length', () => {
    const closes = Array.from(
      { length: SERIES_CAP + RSI_LENGTH + 25 },
      (_, index) => 100 + Math.sin(index / 3) * 10,
    )
    const state = seedRsiState(closes)

    expect(state).not.toBeNull()
    expect(state?.series).toHaveLength(SERIES_CAP)
  })
})

describe('advanceRsiState', () => {
  test('applies Wilder smoothing, appends the RSI, and keeps the input immutable', () => {
    const originalSeries = Array.from({ length: SERIES_CAP }, (_, index) => index)
    const state = {
      avgGain: 1,
      avgLoss: 1,
      lastClose: 100,
      series: originalSeries,
    }

    const next = advanceRsiState(state, 114)

    expect(next.avgGain).toBeCloseTo(27 / 14)
    expect(next.avgLoss).toBeCloseTo(13 / 14)
    expect(next.lastClose).toBe(114)
    expect(next.series).toHaveLength(SERIES_CAP)
    expect(next.series[0]).toBe(1)
    expect(next.series.at(-1)).toBeCloseTo(67.5)
    expect(state.series).toEqual(originalSeries)
    expect(state.lastClose).toBe(100)
  })
})

describe('computeSma', () => {
  test('returns rolling simple averages', () => {
    expect(computeSma([1, 2, 3, 4, 5], 3)).toEqual([2, 3, 4])
  })

  test('returns no values when the series is shorter than the window', () => {
    expect(computeSma([1, 2], 3)).toEqual([])
  })
})

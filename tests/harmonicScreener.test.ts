import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { getHarmonicAnalysis } from '../src/lib/harmonicScreener'

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

describe('harmonic closed-history cache', () => {
  test('provisional ticks reuse analysis and a newly closed touch advances it', () => {
    const bars = pattern()
    const initial = getHarmonicAnalysis('HARMONIC-LIVE', bars)
    expect(initial.setups[0]).toMatchObject({ stage: 'forming', d: null })
    const original = structuredClone(initial)
    for (const price of [1, 124, 150, 300, NaN]) {
      expect(getHarmonicAnalysis('HARMONIC-LIVE', [...bars, bar(19, price, { isClosed: false })])).toBe(initial)
    }
    const touched = bar(19, 124)
    const updated = getHarmonicAnalysis('HARMONIC-LIVE', [...bars, touched])
    expect(updated).not.toBe(initial)
    expect(updated.setups[0]).toMatchObject({ stage: 'zone', d: { time: touched.openTime, price: 124 } })
    expect(getHarmonicAnalysis('HARMONIC-LIVE', [...bars, touched])).toBe(updated)
    expect(initial).toEqual(original)
  })

  test('same-length anchor corrections, gaps, and resets invalidate cached setups', () => {
    const bars = pattern()
    const initial = getHarmonicAnalysis('HARMONIC-CORRECTION', bars)
    const corrected = bars.map((candle, index) => index === 3 ? { ...candle, low: 99 } : candle)
    const updated = getHarmonicAnalysis('HARMONIC-CORRECTION', corrected)
    expect(updated).not.toBe(initial)
    expect(updated.setups[0].x.price).toBe(99)
    const gap = corrected.map((candle, index) => index === 11 ? { ...candle, isClosed: false } : candle)
    expect(getHarmonicAnalysis('HARMONIC-CORRECTION', gap)).toEqual({ setups: [], closedBarCount: 7 })
    expect(getHarmonicAnalysis('HARMONIC-CORRECTION', [])).toEqual({ setups: [], closedBarCount: 0 })
  })

  test('only latest 500 candle identities participate, and market/timeframe keys stay isolated', () => {
    const long = Array.from({ length: 510 }, (_, index) => bar(index, 100))
    const initial = getHarmonicAnalysis('spot:1h:HARMONIC-BOUND', long)
    expect(initial.closedBarCount).toBe(500)
    const oldCorrection = long.map((candle, index) => index === 0 ? { ...candle, low: 99 } : candle)
    expect(getHarmonicAnalysis('spot:1h:HARMONIC-BOUND', oldCorrection)).toBe(initial)
    const other = getHarmonicAnalysis('tradfi:1h:HARMONIC-BOUND', pattern())
    expect(other.setups).toHaveLength(1)
    expect(getHarmonicAnalysis('spot:1h:HARMONIC-BOUND', long)).toBe(initial)
  })
})

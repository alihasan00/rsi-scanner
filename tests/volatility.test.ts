import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { analyzeVolatility, getClosedPriceSuffix, getNormalizedDistance, getSweepQuality } from '../src/lib/volatility'

function bar(index: number, close: number, high = close + 1, low = close - 1, volume = 10): RsiBar {
  return { openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1, open: close, close, high, low, volume, rsi: 50, isClosed: true }
}

describe('closed Wilder ATR and volume', () => {
  test('matches a hand-calculated seed and Wilder update, including a price gap', () => {
    const analysis = analyzeVolatility([bar(0, 10, 11, 9), bar(1, 13, 14, 12), bar(2, 12, 13, 10), bar(3, 16, 18, 15), bar(4, 17, 18, 16)], { atrPeriod: 3 })
    expect(analysis.points.map((point) => point.trueRange)).toEqual([2, 4, 3, 6, 2])
    expect(analysis.points.map((point) => point.atr)).toEqual([null, null, 3, 4, 10 / 3])
    expect(analysis.asOf).toBe(299999)
  })

  test('uses only preceding candles for the volume mean', () => {
    const analysis = analyzeVolatility([bar(0, 10, 11, 9, 10), bar(1, 10, 11, 9, 20), bar(2, 10, 11, 9, 60), bar(3, 10, 11, 9, 40)], { volumePeriod: 2 })
    expect(analysis.points.map((point) => point.relativeVolume)).toEqual([null, null, 4, 1])
  })

  test('cannot see future candles or live revisions', () => {
    const closed = Array.from({ length: 20 }, (_, index) => bar(index, 100 + index))
    const first = analyzeVolatility(closed)
    const live = { ...bar(20, 900), isClosed: false }
    expect(analyzeVolatility([...closed, live])).toEqual(first)
    const complete = analyzeVolatility([...closed, bar(20, 200)])
    expect(complete.points.slice(0, 20)).toEqual(first.points)
  })

  test('unknown intervals, interior live markers and corrections restart warmup', () => {
    const before = Array.from({ length: 20 }, (_, index) => bar(index, 100))
    expect(analyzeVolatility([...before, bar(21, 100)]).atr).toBeNull()
    expect(analyzeVolatility([...before, { ...bar(20, 100), isClosed: false }, bar(21, 100)]).closedBarCount).toBe(1)
    expect(analyzeVolatility([...before, { ...bar(20, 100), high: NaN }, bar(21, 100)]).points).toHaveLength(1)
    const corrected = before.map((item, index) => index === 19 ? { ...item, high: 140 } : item)
    expect(analyzeVolatility(corrected).atr).toBeGreaterThan(analyzeVolatility(before).atr!)
  })

  test('flat prices and zero volume do not manufacture normalized distances', () => {
    const analysis = analyzeVolatility(Array.from({ length: 22 }, (_, index) => bar(index, 100, 100, 100, 0)))
    expect(analysis.atr).toBe(0)
    expect(analysis.relativeVolume).toBeNull()
    expect(getNormalizedDistance(100, 101, analysis.atr)).toEqual({ absolute: 1, percent: 1, atr: null })
    expect(getNormalizedDistance(0, 100, 1).atr).toBeNull()
  })

  test('distance, ATR and sweep measurements are price-scale invariant', () => {
    const bars = Array.from({ length: 20 }, (_, index) => bar(index, 100 + index))
    const scaled = bars.map((item) => ({ ...item, open: item.open * 100, close: item.close * 100, high: item.high * 100, low: item.low * 100 }))
    const atr = analyzeVolatility(bars).atr!
    const scaledAtr = analyzeVolatility(scaled).atr!
    expect(scaledAtr).toBeCloseTo(atr * 100)
    expect(getNormalizedDistance(119, 115, atr).percent).toBeCloseTo(getNormalizedDistance(11900, 11500, scaledAtr).percent)
    expect(getNormalizedDistance(119, 115, atr).atr).toBeCloseTo(getNormalizedDistance(11900, 11500, scaledAtr).atr!)
    const quality = getSweepQuality(bars[19], 119.5, 'high', atr, 2)
    const scaledQuality = getSweepQuality(scaled[19], 11950, 'high', scaledAtr, 2)
    expect(quality.penetrationAtr).toBeCloseTo(scaledQuality.penetrationAtr!)
    expect(quality.wickFraction).toBeCloseTo(scaledQuality.wickFraction!)
  })

  test('a breach alone or close at a level is not a reclaim; live bars cannot reclaim', () => {
    expect(getSweepQuality(bar(0, 101, 102, 99), 100, 'high', 2).reclaimed).toBe(false)
    expect(getSweepQuality(bar(0, 100, 102, 99), 100, 'high', 2).reclaimed).toBe(false)
    const quality = getSweepQuality({ ...bar(0, 99, 102, 98), open: 100 }, 100, 'high', 2, 1.5)
    expect(quality).toMatchObject({ breached: true, reclaimed: true, penetrationAtr: 1, closeBackAtr: 0.5, wickFraction: 0.5, bodyFraction: 0.25, relativeVolume: 1.5 })
    expect(getSweepQuality({ ...bar(0, 99, 102, 98), isClosed: false }, 100, 'high', 2).reclaimed).toBe(false)
  })

  test('rejects invalid settings and validates OHLC without requiring RSI', () => {
    expect(() => analyzeVolatility([], { atrPeriod: 0 })).toThrow()
    expect(() => analyzeVolatility([], { volumePeriod: 2.5 })).toThrow()
    expect(getClosedPriceSuffix([{ ...bar(0, 100), rsi: NaN }])).toHaveLength(1)
    expect(getClosedPriceSuffix([{ ...bar(0, 100), low: 101 }])).toHaveLength(0)
  })
})

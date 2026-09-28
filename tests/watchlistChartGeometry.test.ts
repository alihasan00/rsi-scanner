import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import type { WatchlistChartSnapshot } from '../src/lib/watchlistChart'
import { chartCandleAt, chartZoneAvailableAt, layoutChartCallouts, selectWatchlistChartCandles } from '../src/lib/watchlistChartGeometry'

const DURATION = 3_600_000
const candle = (index: number): Candle => ({ openTime: index * DURATION, closeTime: (index + 1) * DURATION - 1,
  open: 100, high: 110, low: 90, close: 105, volume: 10 })
function snapshot(): WatchlistChartSnapshot {
  return { snapshotId: 'exact-input', evaluatedAt: 150 * DURATION + 10_000, defaultTimeframe: '1h',
    frames: [{ timeframe: '1h', candles: Array.from({ length: 150 }, (_, index) => candle(index)), preview: candle(150), receivedAt: 150 * DURATION, lastClosedAt: candle(149).closeTime }],
    points: [{ label: 'X', timeframe: '1h', time: candle(20).openTime, price: 100 }, { label: 'C', timeframe: '1h', time: candle(140).openTime, price: 110 }],
    events: [{ kind: 'detected', label: 'Setup detected', timeframe: '1h', time: candle(143).closeTime, price: null }], evidence: [], notes: [] }
}

describe('frozen watchlist chart geometry', () => {
  test('setup view includes the earliest real anchor and a clearly provisional newest candle', () => {
    const input = snapshot()
    const before = structuredClone(input)
    const selected = selectWatchlistChartCandles(input, '1h', 'setup')
    expect(selected[0].candle.openTime).toBe(candle(10).openTime)
    expect(selected.at(-1)).toEqual({ candle: candle(150), preview: true })
    expect(input).toEqual(before)
    expect(selectWatchlistChartCandles(input, '1h', 'recent')).toHaveLength(80)
    expect(selectWatchlistChartCandles(input, '15m', 'setup')).toEqual([])
  })

  test('matches open and close timestamps to the observed candle but never a missing candle or projected D', () => {
    const candles = [{ candle: candle(1), preview: false }, { candle: candle(3), preview: false }]
    expect(chartCandleAt(candle(1).openTime, candles)).toBe(candles[0])
    expect(chartCandleAt(candle(1).closeTime, candles)).toBe(candles[0])
    expect(chartCandleAt(candle(2).openTime, candles)).toBeUndefined()
    expect(chartCandleAt(NaN, candles)).toBeUndefined()
    expect(snapshot().points.some((point) => point.label === 'D')).toBe(false)
  })

  test('excludes candles and previews unavailable at the captured evaluation time', () => {
    const input = snapshot()
    const earlier = { ...input, evaluatedAt: candle(149).closeTime }
    const selected = selectWatchlistChartCandles(earlier, '1h', 'recent')
    expect(selected.at(-1)?.candle).toEqual(candle(149))
    expect(selected.some((item) => item.preview)).toBe(false)
  })

  test('spreads nearly identical price callouts inside the chart without changing actual price coordinates', () => {
    const levels = [{ id: 'entry', y: 101 }, { id: 'quote', y: 101 }, { id: 'stop', y: 102 }, { id: 'target', y: 103 }]
    const labels = layoutChartCallouts(levels, 20, 280, 37)
    expect(labels.every((label) => label.labelY >= 20 && label.labelY <= 280)).toBe(true)
    expect(labels.slice(1).every((label, index) => label.labelY - labels[index].labelY >= 37)).toBe(true)
    expect(labels.map(({ id, y }) => ({ id, y }))).toEqual(levels)
    const crowded = layoutChartCallouts(levels, 20, 60, 37)
    expect(crowded[0].labelY).toBe(20)
    expect(crowded.at(-1)?.labelY).toBe(60)
    expect(levels[0]).toEqual({ id: 'entry', y: 101 })
  })

  test('begins the actionable zone at location availability, never at the historical source window', () => {
    const input = snapshot()
    const locationTime = candle(142).closeTime
    expect(chartZoneAvailableAt({ ...input, sourceWindow: { timeframe: '1h', startTime: 0, endTime: candle(100).closeTime },
      events: [...input.events, { kind: 'source', label: 'Location available', timeframe: '1h', time: locationTime, price: null }] })).toBe(locationTime)
    expect(chartZoneAvailableAt({ ...input, events: [] })).toBeNull()
    expect(chartZoneAvailableAt(input)).toBe(candle(143).closeTime)
  })
})

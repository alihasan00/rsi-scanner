import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Candle } from '../src/types'
import type { WatchlistRow } from '../src/lib/watchlist'
import type { WatchlistChartFrame } from '../src/lib/watchlistChart'
import { captureIchimoku, ichimokuCloudBands, ichimokuEvidence, isIchimokuMethod, selectIchimokuPlot } from '../src/lib/watchlistIchimoku'
import { WatchlistSetupChart } from '../src/components/WatchlistSetupChart'
import { ichimokuFixture } from './fixtures/watchlistIchimoku'

const DURATION = 3_600_000
const candles: Candle[] = Array.from({ length: 160 }, (_, index) => ({ openTime: index * DURATION,
  closeTime: (index + 1) * DURATION - 1, open: 100, high: 110, low: 90, close: 105, volume: 10 }))
const lastClosedAt = candles.at(-1)!.closeTime
const evaluatedAt = lastClosedAt + 10_000

function chartFrame(): WatchlistChartFrame {
  const { reading, series } = ichimokuFixture(candles)
  return { timeframe: '1h', candles, lastClosedAt, receivedAt: evaluatedAt, preview: null, ...captureIchimoku(reading, series, candles, evaluatedAt) }
}

describe('captured Ichimoku evidence', () => {
  test('takes an independent deeply immutable copy of every nested Go observation', () => {
    const { reading, series } = ichimokuFixture(candles)
    const expected = structuredClone({ reading, series })
    const captured = captureIchimoku(reading, series, candles, evaluatedAt)
    Object.assign(reading.cloud, { upper: 999 })
    Object.assign(reading.tkCross!, { reason: 'later scan' })
    Object.assign(reading.fibonacci.levels![0], { price: 999 })
    Object.assign(reading.projection![0], { spanA: 999 })
    Object.assign(series[100], { tenkan: 999 })
    expect(captured.ichimoku).toEqual(expected.reading)
    expect(captured.ichimokuSeries).toEqual(expected.series)
    expect(Object.isFrozen(captured.ichimoku?.cloud)).toBe(true)
    expect(Object.isFrozen(captured.ichimoku?.fibonacci.levels?.[0])).toBe(true)
    expect(Object.isFrozen(captured.ichimoku?.projection?.[0])).toBe(true)
    expect(Object.isFrozen(captured.ichimokuSeries?.[100])).toBe(true)
  })

  test('withholds evidence for a different close, bar count, plot candle or future calculation', () => {
    for (const mismatch of ['close', 'bars', 'series', 'future', 'offset'] as const) {
      const { reading, series } = ichimokuFixture(candles)
      if (mismatch === 'close') Object.assign(reading, { asOf: lastClosedAt - 1 })
      if (mismatch === 'bars') Object.assign(reading, { bars: candles.length - 1 })
      if (mismatch === 'series') Object.assign(series[3], { time: series[3].time + 1 })
      if (mismatch === 'future') Object.assign(reading.projection![0], { calculatedAt: evaluatedAt + 1 })
      if (mismatch === 'offset') Object.assign(reading.projection![0], { displayedAt: reading.projection![0].displayedAt - DURATION })
      expect(captureIchimoku(reading, series, candles, evaluatedAt)).toEqual({})
    }
    const { reading, series } = ichimokuFixture(candles)
    expect(captureIchimoku(reading, series, candles, lastClosedAt - 1)).toEqual({})
  })

  test('keeps calculated and displayed cloud times separate without fabricating future line values', () => {
    const frame = chartFrame()
    const plot = selectIchimokuPlot(frame, candles[100].openTime, lastClosedAt)
    expect(plot.lines.at(-1)?.time).toBe(lastClosedAt)
    expect(plot.cloud.filter((point) => point.projected)).toHaveLength(30)
    expect(plot.firstProjectionAt).toBe(lastClosedAt + DURATION)
    expect(plot.lastDisplayedAt).toBe(lastClosedAt + 30 * DURATION)
    expect(plot.cloud.every((point) => point.calculatedAt <= lastClosedAt)).toBe(true)
    expect(plot.cloud.at(-1)?.calculatedAt).toBe(lastClosedAt)
    expect(plot.cloud.at(-1)?.displayedAt).not.toBe(lastClosedAt)
    expect(selectIchimokuPlot(frame, candles[100].openTime, lastClosedAt, false).cloud.every((point) => !point.projected)).toBe(true)
    expect(selectIchimokuPlot(frame, candles[100].openTime, candles[120].closeTime).firstProjectionAt).toBeNull()
    expect(frame.candles).toHaveLength(160)
  })

  test('splits cloud shading at twists and does not bridge a missing cloud bar', () => {
    const points = [{ calculatedAt: 1, displayedAt: 10, spanA: 12, spanB: 8, projected: false },
      { calculatedAt: 11, displayedAt: 20, spanA: 8, spanB: 12, projected: true }]
    const bands = ichimokuCloudBands(points, 10)
    expect(bands.map((band) => band.color)).toEqual(['green', 'red'])
    expect(bands[0].points[1]).toEqual({ time: 15, price: 10 })
    expect(bands.every((band) => band.projected)).toBe(true)
    expect(ichimokuCloudBands(points, 5)).toEqual([])
  })

  test('retains cross exclusions, ages, flat references, Fib and combined retracement context in review wording', () => {
    const { reading } = ichimokuFixture(candles)
    const evidence = ichimokuEvidence(reading, String)
    expect(evidence.find((item) => item.label === 'TK cross')?.detail).toContain('1 bars ago')
    expect(evidence.find((item) => item.label === 'PK cross')?.detail).toContain('Excluded geometry')
    expect(evidence.find((item) => item.label === 'Edge to edge')?.detail).toContain('98.12345 (flat, 3 transitions)')
    expect(evidence.find((item) => item.label === 'Cloud Fibonacci')?.detail).toContain('0.236 = 94.30345')
    expect(evidence.find((item) => item.label === 'Retracement context')?.caution).toBe(true)
    expect(evidence.find((item) => item.label === 'Known forward twist')?.detail).toContain('not a price forecast')
    expect(isIchimokuMethod('TK cross · 1h')).toBe(true)
    expect(isIchimokuMethod('Pk cross · 1h')).toBe(true)
    expect(isIchimokuMethod('Cloud edge to edge · 4h')).toBe(true)
    expect(isIchimokuMethod('Gartley · 1h')).toBe(false)
    Object.assign(reading.extension, {tenkanKijunGap: 0})
    expect(ichimokuEvidence(reading).find((item) => item.label === 'Retracement context')?.detail).toContain('Gap 0 ')
  })

  test('renders known cloud and line overlays by default, preserving a labeled future display in the saved SVG', () => {
    const frame = chartFrame()
    const row = { id: 'ichimoku:one', symbol: 'BTCUSDT', timeframe: '1h', source: 'strategy', name: 'TK cross · 1h',
      price: 105, zone: { low: 99, high: 101 }, stop: 95, target: 115,
      reference: { entry: 100, planEntry: 105, chart: { snapshotId: 'saved', evaluatedAt, defaultTimeframe: '1h',
        frames: [frame], points: [], events: [], evidence: [], notes: [] } } } as WatchlistRow
    const html = renderToStaticMarkup(createElement(WatchlistSetupChart, { row }))
    expect(html).toContain('aria-pressed="true">Ichimoku')
    expect(html).toContain('watch-setup-chart__ichimoku-lines')
    expect(html).toContain('watch-setup-chart__cloud is-green is-projected')
    expect(html).toContain('Known forward cloud')
    expect(html).toContain('not forecast prices')
    const compact = renderToStaticMarkup(createElement(WatchlistSetupChart, { row, compact: true }))
    expect(compact).toContain('watch-setup-chart__ichimoku-lines')
    expect(compact).not.toContain('Known forward cloud')
    expect(renderToStaticMarkup(createElement(WatchlistSetupChart, { row: { ...row, name: 'Gartley · 1h' }, compact: true }))).not.toContain('watch-setup-chart__ichimoku-lines')
  })
})

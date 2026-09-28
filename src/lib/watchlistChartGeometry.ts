import type { Candle, Timeframe } from '../types'
import { isValidCandle } from './rsiHistory'
import type { WatchlistChartSnapshot } from './watchlistChart'

export interface WatchlistPlotCandle { candle: Candle; preview: boolean }

/** Match an observed event to its actual candle; never invent a missing pivot date. */
export function chartCandleAt(time: number, candles: readonly WatchlistPlotCandle[]): WatchlistPlotCandle | undefined {
  return Number.isFinite(time) ? candles.find(({ candle }) => time >= candle.openTime && time <= candle.closeTime) : undefined
}

export function selectWatchlistChartCandles(
  snapshot: WatchlistChartSnapshot,
  timeframe: Timeframe,
  view: 'setup' | 'recent',
): WatchlistPlotCandle[] {
  const frame = snapshot.frames.find((item) => item.timeframe === timeframe)
  if (!frame) return []
  const candles = frame.candles.filter((candle) => isValidCandle(candle) && candle.closeTime <= snapshot.evaluatedAt)
    .map((candle) => ({ candle, preview: false }))
  if (frame.preview && isValidCandle(frame.preview) && frame.preview.openTime <= snapshot.evaluatedAt
    && (!candles.length || frame.preview.openTime > candles.at(-1)!.candle.closeTime)) candles.push({ candle: frame.preview, preview: true })
  if (view === 'recent') return candles.slice(-80)
  const times = [
    ...snapshot.points.filter((point) => point.timeframe === timeframe).map((point) => point.time),
    ...snapshot.events.filter((event) => event.timeframe === timeframe).map((event) => event.time),
    ...(snapshot.sourceWindow?.timeframe === timeframe ? [snapshot.sourceWindow.startTime] : []),
  ].filter((time) => Number.isFinite(time) && time <= snapshot.evaluatedAt)
  if (!times.length) return candles.slice(-100)
  const first = candles.findIndex(({ candle }) => candle.closeTime >= Math.min(...times))
  return candles.slice(Math.max(0, Math.min(first < 0 ? 0 : first - 10, candles.length - 50)))
}

/** Order labels by actual price, spreading only the callouts, never the levels. */
export function layoutChartCallouts<T extends { id: string; y: number }>(
  items: readonly T[], top: number, bottom: number, minimumGap = 37,
): (T & { labelY: number })[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id))
  const gap = sorted.length > 1 ? Math.min(minimumGap, Math.max(0, bottom - top) / (sorted.length - 1)) : 0
  const result = sorted.map((item, index) => ({ ...item, labelY: Math.max(top + index * gap, Math.min(bottom, item.y)) }))
  for (let index = 1; index < result.length; index++) result[index].labelY = Math.max(result[index].labelY, result[index - 1].labelY + gap)
  for (let index = result.length - 1; index >= 0; index--) {
    result[index].labelY = Math.min(result[index].labelY, index === result.length - 1 ? bottom : result[index + 1].labelY - gap)
  }
  return result.map((item) => ({ ...item, labelY: Math.max(top, Math.min(bottom, item.labelY)) }))
}

/** Location availability is causal; historical source geometry is not availability. */
export function chartZoneAvailableAt(snapshot: WatchlistChartSnapshot): number | null {
  const available = snapshot.events.find((event) => event.label.toLowerCase() === 'location available')
    ?? snapshot.events.find((event) => event.kind === 'detected')
    ?? snapshot.events.find((event) => event.kind === 'break')
  return available && Number.isFinite(available.time) && available.time <= snapshot.evaluatedAt ? available.time : null
}

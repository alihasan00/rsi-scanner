import type { Timeframe } from '../types'
import { TIMEFRAME_MILLISECONDS } from './binanceHistory'

export type GoWatchlistScope = 'all' | 'ichimoku'
export const GO_WATCHLIST_TIMEFRAMES = ['1d', '4h', '15m'] as const

export function getGoWatchlistTimeframes(scope: GoWatchlistScope, timeframe: Timeframe = '1h'): readonly Timeframe[] {
  return scope === 'all' ? GO_WATCHLIST_TIMEFRAMES : [timeframe]
}

const DAY = TIMEFRAME_MILLISECONDS['1d']
const MONDAY_PHASE = 4 * DAY // Unix epoch is Thursday; Binance weeks start Monday UTC.

export function isGoWatchlistCandleAligned(openTime: number, timeframe: Timeframe): boolean {
  if (!Number.isSafeInteger(openTime) || openTime < 0) return false
  if (timeframe === '3d') return openTime % DAY === 0 // Preserve the exchange's supplied three-day phase.
  const phase = timeframe === '1w' ? MONDAY_PHASE : 0
  return (openTime - phase) % TIMEFRAME_MILLISECONDS[timeframe] === 0
}

/** Same close-boundary grace and calendar anchors as the Go market contract. */
export function getGoWatchlistExpectedClose(now: number, timeframe: Timeframe, lastClosedAt: number): number {
  const duration = TIMEFRAME_MILLISECONDS[timeframe]
  const phase = timeframe === '3d' ? lastClosedAt + 1 - duration : timeframe === '1w' ? MONDAY_PHASE : 0
  return Math.floor((now - 5_000 - phase) / duration) * duration + phase - 1
}

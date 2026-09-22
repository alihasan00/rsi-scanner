import type { RsiBar, Timeframe } from '../types'
import type { ScreenerMarket } from './markets'
import { fetchClosedCandleHistory, TIMEFRAME_MILLISECONDS } from './binanceHistory'
import { seedRsiHistory } from './rsiHistory'

export function higherTimeframeChoices(timeframe: Timeframe): Timeframe[] {
  return (Object.keys(TIMEFRAME_MILLISECONDS) as Timeframe[]).filter((value) => TIMEFRAME_MILLISECONDS[value] > TIMEFRAME_MILLISECONDS[timeframe])
}

export function defaultHigherTimeframe(timeframe: Timeframe): Timeframe | null {
  if (TIMEFRAME_MILLISECONDS[timeframe] < TIMEFRAME_MILLISECONDS['15m']) return '1h'
  if (TIMEFRAME_MILLISECONDS[timeframe] < TIMEFRAME_MILLISECONDS['4h']) return '4h'
  if (TIMEFRAME_MILLISECONDS[timeframe] < TIMEFRAME_MILLISECONDS['1d']) return '1d'
  return timeframe === '1w' ? null : '1w'
}

export interface HigherTimeframeSnapshot {
  symbol: string
  market: ScreenerMarket
  timeframe: Timeframe
  bars: RsiBar[]
  checkedAt: number
}

/** Actual exchange candles, bounded to one selected pair and one interval. */
export async function fetchHigherTimeframeContext(
  request: { symbol: string; market: ScreenerMarket; timeframe: Timeframe; signal?: AbortSignal },
  fetcher: typeof fetch = fetch,
): Promise<HigherTimeframeSnapshot> {
  const history = await fetchClosedCandleHistory({ ...request, count: 260 }, fetcher)
  request.signal?.throwIfAborted()
  if (history.error) throw new Error(history.error)
  // A missing session restarts RSI warmup. Older gaps must not hide a sufficiently
  // warmed contiguous suffix, and they must never be smoothed across as returns.
  let start = history.candles.length - 1
  while (start > 0 && history.candles[start].openTime === history.candles[start - 1].closeTime + 1) start--
  const seeded = seedRsiHistory(history.candles.slice(Math.max(0, start)))
  if (!seeded) throw new Error('Not enough completed higher-timeframe candles for RSI(14).')
  const latest = seeded.closedBars.at(-1)!
  if (history.serverTime - latest.closeTime > TIMEFRAME_MILLISECONDS[request.timeframe] + 60_000) {
    throw new Error('Higher-timeframe history is delayed. Waiting for a completed candle.')
  }
  return { ...request, bars: seeded.closedBars, checkedAt: history.serverTime }
}

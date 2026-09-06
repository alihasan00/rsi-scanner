import type { Candle, RsiBar, SymbolSnapshot } from '../types'
import { advanceRsiState, RSI_LENGTH, seedRsiState, SERIES_CAP } from './rsi'
import type { RsiState } from './rsi'

// Preserve a bounded outcome log beyond the 80 displayed candles. Historical
// backtests fetch their own warm-up and sample without changing the live feed.
export const RSI_HISTORY_CAP = 3_000

export interface RsiHistory {
  state: RsiState
  closedBars: RsiBar[]
  preview: RsiBar | null
}

export interface HistoryUpdate {
  status: 'updated' | 'ignored' | 'gap'
  history: RsiHistory
}

/** Reject malformed market data before it can poison the recursive average. */
export function isValidCandle(candle: Candle): boolean {
  return Number.isSafeInteger(candle.openTime)
    && candle.openTime >= 0
    && Number.isSafeInteger(candle.closeTime)
    && candle.closeTime >= candle.openTime
    && [candle.open, candle.high, candle.low, candle.close].every((value) => Number.isFinite(value) && value > 0)
    && Number.isFinite(candle.volume)
    && candle.volume >= 0
    && candle.high >= Math.max(candle.open, candle.close, candle.low)
    && candle.low <= Math.min(candle.open, candle.close, candle.high)
}

function assertContiguousCandles(candles: Candle[]): void {
  for (let index = 0; index < candles.length; index++) {
    if (!isValidCandle(candles[index])) throw new Error('Invalid seed candle')
    if (index > 0 && candles[index].openTime !== candles[index - 1].closeTime + 1) {
      throw new Error('Non-contiguous seed candles')
    }
  }
}

/** Seeds every RSI sample against its own closed OHLC candle. */
export function seedRsiHistory(candles: Candle[], length = RSI_LENGTH): RsiHistory | null {
  assertContiguousCandles(candles)
  let state = seedRsiState(candles.slice(0, length + 1).map((candle) => candle.close), length)
  if (!state) return null

  const bars: RsiBar[] = [{ ...candles[length], rsi: state.series[0], isClosed: true }]
  for (let index = length + 1; index < candles.length; index++) {
    state = advanceRsiState(state, candles[index].close, length)
    bars.push({ ...candles[index], rsi: state.series[state.series.length - 1], isClosed: true })
  }
  return { state, closedBars: bars.slice(-RSI_HISTORY_CAP), preview: null }
}

/**
 * Recover missed candles into the existing average whenever REST reaches the
 * next needed candle. This preserves already confirmed RSI/pivot values. A gap
 * longer than the REST window starts a fresh, warmed-up history instead.
 */
export function recoverRsiHistory(
  previous: RsiHistory | null,
  closedCandles: Candle[],
  previewCandle: Candle | null,
  length = RSI_LENGTH,
): RsiHistory | null {
  assertContiguousCandles(closedCandles)
  let history = previous
  if (history) {
    const last = history.closedBars[history.closedBars.length - 1]
    const newer = closedCandles.filter((candle) => candle.openTime > last.openTime)
    if (newer.length > 0 && newer[0].openTime !== last.closeTime + 1) {
      history = null
    } else {
      for (const candle of newer) history = updateRsiHistory(history, candle, true, length).history
    }
  }
  if (!history) history = seedRsiHistory(closedCandles, length)
  if (!history) return null
  if (previewCandle) {
    const update = updateRsiHistory(history, previewCandle, false, length)
    if (update.status === 'gap') throw new Error('Gap before seed preview candle')
    history = update.history
  }
  return history
}

/**
 * Only a final update advances committed Wilder state. Candle identity makes
 * repeated finals idempotent; a missing close must be recovered from REST.
 */
export function updateRsiHistory(
  history: RsiHistory,
  candle: Candle,
  isFinal: boolean,
  length = RSI_LENGTH,
): HistoryUpdate {
  if (!isValidCandle(candle)) return { status: 'ignored', history }
  const previous = history.closedBars[history.closedBars.length - 1]
  if (candle.openTime <= previous.openTime) return { status: 'ignored', history }
  if (candle.openTime !== previous.closeTime + 1) return { status: 'gap', history }

  const state = advanceRsiState(history.state, candle.close, length)
  const bar: RsiBar = { ...candle, rsi: state.series[state.series.length - 1], isClosed: isFinal }
  return {
    status: 'updated',
    history: isFinal
      ? { state, closedBars: [...history.closedBars, bar].slice(-RSI_HISTORY_CAP), preview: null }
      : { ...history, preview: bar },
  }
}

export function snapshotFromRsiHistory(history: RsiHistory): SymbolSnapshot {
  const bars = (history.preview ? [...history.closedBars, history.preview] : history.closedBars)
    .slice(-RSI_HISTORY_CAP)
  const latest = bars[bars.length - 1]
  return {
    price: latest.close,
    volume: latest.volume,
    series: bars.slice(-SERIES_CAP).map((bar) => bar.rsi),
    bars,
  }
}

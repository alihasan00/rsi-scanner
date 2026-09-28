import type { GoWatchlistFrameUpdate } from '../src/lib/goWatchlistFeed'
import { GO_WATCHLIST_TIMEFRAMES } from '../src/lib/goWatchlistFeed'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import { captureWatchlistEvaluation } from '../src/lib/watchlistChart'

// Local, deterministic preparation benchmark. It does not fetch prices or run
// the Go detector, and these synthetic histories make no eligibility claims.
const now = Date.parse('2026-09-28T12:07:00Z')
const histories: GoWatchlistFrameUpdate[] = Array.from({length: 440}, (_, index) => {
  const timeframe = GO_WATCHLIST_TIMEFRAMES[index % GO_WATCHLIST_TIMEFRAMES.length]
  const duration = TIMEFRAME_MILLISECONDS[timeframe]
  const lastOpen = Math.floor(now / duration) * duration - duration
  const candles = Array.from({length: 500}, (_, bar) => Object.freeze({
    openTime: lastOpen - (499 - bar) * duration, closeTime: lastOpen - (499 - bar) * duration + duration - 1,
    open: 100, high: 110, low: 90, close: 100 + bar / 100, volume: 1000,
  }))
  Object.freeze(candles)
  return {symbol: `ASSET${Math.floor(index / 4)}USDT`, timeframe, candles, preview: null, receivedAt: now, status: 'ready', error: null}
})

// The previous implementation copied and froze every bar on every scan.
function fullCopy() {
  return Object.freeze({snapshotId: 'benchmark', evaluatedAt: now, histories: Object.freeze(histories.map((history) => Object.freeze({
    ...history, candles: Object.freeze(history.candles.map((candle) => Object.freeze({...candle}))),
    preview: history.preview ? Object.freeze({...history.preview}) : null,
  })))})
}

function measure(run: () => unknown) {
  const durations: number[] = []
  for (let index = 0; index < 23; index++) {
    const started = performance.now()
    run()
    if (index >= 3) durations.push(performance.now() - started)
  }
  durations.sort((a, b) => a - b)
  return {medianMs: durations[Math.floor(durations.length / 2)], p95Ms: durations[Math.floor(durations.length * 0.95)]}
}

console.log(JSON.stringify({frames: histories.length, closedCandles: 220_000,
  fullCopy: measure(fullCopy), immutableReuse: measure(() => captureWatchlistEvaluation('benchmark', now, histories)),
}, null, 2))

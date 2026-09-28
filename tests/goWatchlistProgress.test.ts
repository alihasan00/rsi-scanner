import { describe, expect, test } from 'bun:test'
import { getGoWatchlistCoverage, getWatchlistSeedProgress, GoWatchlistScheduler } from '../src/lib/goWatchlistProgress'
import { GO_WATCHLIST_TIMEFRAMES } from '../src/lib/goWatchlistFeed'
import type { GoWatchlistFrameUpdate } from '../src/lib/goWatchlistFeed'
import type { GoWatchlistResult } from '../src/lib/goWatchlist'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'

const NOW = Date.parse('2026-09-28T12:05:00Z')
function histories(symbol: string): GoWatchlistFrameUpdate[] {
  return GO_WATCHLIST_TIMEFRAMES.map((timeframe) => {
    const duration = TIMEFRAME_MILLISECONDS[timeframe]
    const openTime = Math.floor(NOW / duration) * duration - duration
    const candle = {openTime, closeTime: openTime + duration - 1, open: 100, high: 103, low: 99, close: 102, volume: 10}
    return {symbol, timeframe, candles: [candle], preview: {...candle, openTime: openTime + duration, closeTime: candle.closeTime + duration},
      receivedAt: NOW, status: 'ready', error: null}
  })
}
function evaluation(frames: readonly GoWatchlistFrameUpdate[]): GoWatchlistResult['scan'] {
  return {series: frames.map((frame) => ({symbol: frame.symbol, interval: frame.timeframe, observedAt: frame.receivedAt,
    lastClosedAt: frame.candles.at(-1)!.closeTime, price: frame.preview!.close, closedCandles: frame.candles.length,
    ready: true, trend: 'bullish', momentum: 'bullish', internalBias: 'bullish', warnings: []})), errors: [], progress: {done: frames.length, total: frames.length}}
}

describe('progressive Go watchlist scheduling', () => {
  test('starts when one complete asset is seeded while incomplete assets remain outside the ready set', () => {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
    const scheduler = new GoWatchlistScheduler()
    const btc = histories('BTCUSDT')
    expect(scheduler.begin(NOW, getWatchlistSeedProgress(symbols, btc.slice(0, 3)))).toBeNull()
    const progress = getWatchlistSeedProgress(symbols, [...btc, ...histories('ETHUSDT').slice(0, 2)])
    expect(progress.completeSymbols).toEqual(['BTCUSDT'])
    expect(progress.attemptedFrames).toBe(6)
    const scan = scheduler.begin(NOW, progress)!
    expect(scan.allSeedsAttempted).toBe(false)
    expect(scheduler.initialScanComplete).toBe(false)
    expect(scheduler.publish(scan.id)).toBe(true)
    expect(scheduler.initialScanComplete).toBe(false)
    // Quotes and an unchanged ready set do not produce rapid startup scans.
    expect(scheduler.begin(NOW + 60_000, progress)).toBeNull()
  })

  test('coalesces added complete assets, keeps one scan in flight and publishes the final error wave before finishing', () => {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
    const btc = histories('BTCUSDT')
    const eth = histories('ETHUSDT')
    const failed = histories('SOLUSDT').map((frame) => ({...frame, status: 'error' as const, error: 'Exchange unavailable'}))
    const scheduler = new GoWatchlistScheduler()
    const first = scheduler.begin(NOW, getWatchlistSeedProgress(symbols, btc))!
    const nextProgress = getWatchlistSeedProgress(symbols, [...btc, ...eth])
    expect(scheduler.begin(NOW + 7_000, nextProgress)).toBeNull()
    expect(scheduler.publish(first.id)).toBe(true)
    expect(scheduler.begin(NOW + 5_999, nextProgress)).toBeNull()
    const second = scheduler.begin(NOW + 6_000, nextProgress)!
    expect(scheduler.publish(first.id)).toBe(false)
    const finalProgress = getWatchlistSeedProgress(symbols, [...btc, ...eth, ...failed])
    expect(scheduler.begin(NOW + 20_000, finalProgress)).toBeNull()
    expect(scheduler.publish(second.id)).toBe(true)
    const final = scheduler.begin(NOW + 12_000, finalProgress)!
    expect(final.allSeedsAttempted).toBe(true)
    expect(scheduler.initialScanComplete).toBe(false)
    expect(scheduler.publish(final.id)).toBe(true)
    expect(scheduler.initialScanComplete).toBe(true)
    expect(scheduler.begin(NOW + 41_999, finalProgress)).toBeNull()
    expect(scheduler.begin(NOW + 42_000, finalProgress)).not.toBeNull()
  })

  test('a fully rejected first wave finishes initial loading after its result is published', () => {
    const scheduler = new GoWatchlistScheduler()
    const failed = histories('BTCUSDT').map((frame) => ({...frame, status: 'error' as const, error: 'Request rejected'}))
    const progress = getWatchlistSeedProgress(['BTCUSDT'], failed)
    expect(progress.completeSymbols).toEqual([])
    const scan = scheduler.begin(NOW, progress)!
    expect(scheduler.initialScanComplete).toBe(false)
    expect(scheduler.publish(scan.id)).toBe(true)
    expect(scheduler.initialScanComplete).toBe(true)
  })
})

describe('progressive coverage publications', () => {
  test('newly arrived seeds wait for analysis instead of inheriting an earlier missing-frame error', () => {
    const btc = histories('BTCUSDT')
    const prior = evaluation(btc)
    prior.errors = [{symbol: 'ETHUSDT', interval: '15m', error: 'Required timeframe history is unavailable.'}]
    const {coverage, feedError} = getGoWatchlistCoverage([...btc, histories('ETHUSDT')[0]], prior, btc, NOW, 8)
    expect(coverage).toEqual({total: 8, fresh: 4, loading: 4, error: 0, delayed: 0})
    expect(feedError).toBeNull()
  })

  test('preview-only updates keep analyzed feeds current; changed closed history awaits evaluation', () => {
    const sources = histories('BTCUSDT')
    const prior = evaluation(sources)
    const previews = sources.map((frame) => ({...frame, preview: {...frame.preview!, close: 103}, receivedAt: NOW + 1_000}))
    expect(getGoWatchlistCoverage(previews, prior, sources, NOW + 1_000, 4).coverage).toEqual({total: 4, fresh: 4, loading: 0, error: 0, delayed: 0})
    const corrected = [...previews]
    corrected[0] = {...corrected[0], candles: corrected[0].candles.map((candle) => ({...candle, volume: 11}))}
    expect(getGoWatchlistCoverage(corrected, prior, sources, NOW + 1_000, 4).coverage).toEqual({total: 4, fresh: 3, loading: 1, error: 0, delayed: 0})
  })

  test('the completed-candle boundary changes coverage to awaiting evaluation without refreshing receipts', () => {
    const frames = histories('BTCUSDT')
    const boundary = Date.parse('2026-09-28T12:15:00Z')
    for (const frame of frames) frame.receivedAt = boundary
    const prior = evaluation(frames)
    expect(getGoWatchlistCoverage(frames, prior, frames, boundary + 4_999, 4).coverage.fresh).toBe(4)
    expect(getGoWatchlistCoverage(frames, prior, frames, boundary + 5_000, 4).coverage).toEqual({total: 4, fresh: 3, loading: 1, error: 0, delayed: 0})
  })
})

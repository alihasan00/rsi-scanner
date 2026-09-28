import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import type { GoWatchlistFrameUpdate } from '../src/lib/goWatchlistFeed'
import { captureWatchlistEvaluation } from '../src/lib/watchlistChart'

const bar = (openTime = 0, close = 100): Candle => ({openTime, closeTime: openTime + 899_999, open: 100, high: 110, low: 90, close, volume: 10})
const frame = (candles: Candle[], preview: Candle | null = null): GoWatchlistFrameUpdate => ({
  symbol: 'BTCUSDT', timeframe: '15m', candles, preview, receivedAt: 1_800_000, status: 'ready', error: null,
})

describe('immutable watchlist snapshot reuse', () => {
  test('reuses verified immutable closed histories while capturing fresh receipts and previews', () => {
    const candles = [Object.freeze(bar())]
    Object.freeze(candles)
    const firstFrame = frame(candles, bar(900_000, 101))
    const first = captureWatchlistEvaluation('first', 1_800_001, [firstFrame])
    const nextFrame = {...firstFrame, preview: bar(900_000, 102), receivedAt: 1_800_500}
    const second = captureWatchlistEvaluation('second', 1_800_501, [nextFrame])
    expect(first.histories[0].candles).toBe(candles)
    expect(second.histories[0].candles).toBe(first.histories[0].candles)
    expect(second.histories[0].preview?.close).toBe(102)
    expect(second.histories[0].receivedAt).toBe(1_800_500)
    expect(first.histories[0].preview?.close).toBe(101)
    expect(first.histories[0].receivedAt).toBe(1_800_000)
    expect(second.snapshotId).toBe('second')
    expect(second.evaluatedAt).toBe(1_800_501)
    expect(Object.isFrozen(second.histories[0])).toBe(true)
  })

  test('replaces corrected histories without changing already captured evaluations', () => {
    const candles = [Object.freeze(bar())]
    Object.freeze(candles)
    const first = captureWatchlistEvaluation('first', 1_800_000, [frame(candles)])
    const correction = [Object.freeze(bar(0, 105))]
    Object.freeze(correction)
    const second = captureWatchlistEvaluation('corrected', 1_800_000, [frame(correction)])
    expect(second.histories[0].candles).toBe(correction)
    expect(second.histories[0].candles).not.toBe(first.histories[0].candles)
    expect(first.histories[0].candles[0].close).toBe(100)
    expect(second.histories[0].candles[0].close).toBe(105)
  })

  test('a frozen array with mutable candles must still be copied on each capture', () => {
    const candles = [bar()]
    Object.freeze(candles)
    const input = frame(candles)
    const first = captureWatchlistEvaluation('first', 1_800_000, [input])
    candles[0].close = 103
    const second = captureWatchlistEvaluation('second', 1_800_000, [input])
    expect(first.histories[0].candles).not.toBe(candles)
    expect(first.histories[0].candles[0].close).toBe(100)
    expect(second.histories[0].candles[0].close).toBe(103)
    expect(Object.isFrozen(candles[0])).toBe(false)
  })

  test('mutable arrays of frozen bars can gain a final candle without mutating old captures', () => {
    const candles = [Object.freeze(bar())]
    const input = frame(candles)
    const first = captureWatchlistEvaluation('first', 1_800_000, [input])
    candles.push(Object.freeze(bar(900_000)))
    const second = captureWatchlistEvaluation('second', 1_800_000, [input])
    expect(first.histories[0].candles).not.toBe(candles)
    expect(first.histories[0].candles).toHaveLength(1)
    expect(second.histories[0].candles).toHaveLength(2)
    expect(Object.isFrozen(candles)).toBe(false)
  })
})

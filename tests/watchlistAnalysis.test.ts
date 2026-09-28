import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { analyzeSignalEvidence } from '../src/lib/signalEvidence'
import { DEFAULT_FIB_SETTINGS } from '../src/lib/fibPreferences'
import { analyzeFibonacci } from '../src/lib/fibonacci'
import { analyzeHarmonics } from '../src/lib/harmonics'
import { createWatchlistAnalysisCache } from '../src/lib/watchlistAnalysis'
import type { WatchlistAnalysisRequest } from '../src/lib/watchlistAnalysis'

function request(): WatchlistAnalysisRequest {
  const bars: RsiBar[] = Array.from({ length: 30 }, (_, i) => ({
    openTime: i * 60_000, closeTime: (i + 1) * 60_000 - 1,
    open: 100, high: 102, low: 98, close: 100, rsi: 50, volume: 100, isClosed: true,
  }))
  return { symbol: 'BTCUSDT', market: 'spot', timeframe: '1m', bars, fibOptions: { ...DEFAULT_FIB_SETTINGS }, calendarMap: null }
}

function harness(capacity = 128) {
  const calls: WatchlistAnalysisRequest[] = []
  const cache = createWatchlistAnalysisCache(capacity, (input) => {
    calls.push(input)
    return { fib: analyzeFibonacci(input.bars), harmonic: analyzeHarmonics(input.bars), evidence: analyzeSignalEvidence(input) }
  })
  return { calls, cache }
}

describe('watchlist closed-candle cache', () => {
  test('live quotes/previews reuse discovery; closing the next candle rebuilds it', () => {
    const { calls, cache } = harness()
    const input = request()
    const initial = cache.get(input)
    const live: RsiBar = { ...input.bars.at(-1)!, openTime: 1_800_000, closeTime: 1_859_999, isClosed: false }
    expect(cache.get({ ...input, bars: [...input.bars, live] })).toBe(initial)
    expect(cache.get({ ...input, bars: [...input.bars, { ...live, high: 150, rsi: 99 }] })).toBe(initial)
    expect(calls).toHaveLength(1)
    expect(cache.get({ ...input, bars: [...input.bars, { ...live, isClosed: true }] })).not.toBe(initial)
    expect(calls).toHaveLength(2)
  })

  test('same-timestamp corrections, including in-place edits, cannot reuse stale analysis', () => {
    const { calls, cache } = harness()
    const input = request()
    const before = cache.get(input)
    input.bars[0].high = 104
    expect(cache.get(input)).not.toBe(before)
    input.bars[10].rsi = 70
    cache.get(input)
    expect(calls).toHaveLength(3)
    expect(calls[2].bars).toHaveLength(30)
  })

  test('interior unfinished candles and gaps reach the detectors as interruptions', () => {
    const { calls, cache } = harness()
    const input = request()
    const before = cache.get(input)
    input.bars[28].isClosed = false
    const after = cache.get(input)
    expect(after).not.toBe(before)
    expect(calls[1].bars[28].isClosed).toBe(false)
    expect(after.evidence.structure.closedBarCount).toBe(1)
  })

  test('identity, settings and calendar changes re-evaluate evidence', () => {
    const { calls, cache } = harness()
    const input = request()
    const initial = cache.get(input)
    cache.get({ ...input, symbol: 'ETHUSDT' })
    cache.get({ ...input, market: 'tradfi' })
    cache.get({ ...input, timeframe: '4h' })
    expect(cache.get(input)).toBe(initial)
    cache.get({ ...input, divergenceOptions: { includeHidden: true } })
    cache.get({ ...input, fibOptions: { ...input.fibOptions, scale: 'log' } })
    cache.get({ ...input, calendarMap: { levels: [], asOf: 1_800_000, warnings: [] } })
    expect(calls).toHaveLength(7)
  })

  test('memory is bounded by recent instruments and can be cleared on unmount', () => {
    const { cache, calls } = harness(2)
    const input = request()
    const btc = cache.get(input)
    cache.get({ ...input, symbol: 'ETHUSDT' })
    expect(cache.get(input)).toBe(btc)
    cache.get({ ...input, symbol: 'SOLUSDT' })
    expect(cache.get(input)).toBe(btc)
    cache.get({ ...input, symbol: 'ETHUSDT' })
    expect(calls).toHaveLength(4)
    cache.clear()
    expect(cache.get(input)).not.toBe(btc)
  })
})

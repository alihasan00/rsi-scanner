import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import type { SeedResult } from '../src/lib/binanceRest'
import type { KlineListener, KlineTick } from '../src/lib/binanceSocket'
import type { ScreenerMarket } from '../src/lib/markets'
import { startRsiFeed } from '../src/lib/rsiFeed'
import { recoverRsiHistory } from '../src/lib/rsiHistory'
import type { RsiHistory } from '../src/lib/rsiHistory'

function candle(index: number, close = 100 + Math.sin(index / 3) * 10): Candle {
  return {
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: 100, high: Math.max(100, close) + 1, low: Math.min(100, close) - 1,
    close, volume: 20,
  }
}

function seed(count = 40): SeedResult {
  return {
    closedCandles: Array.from({ length: count }, (_, index) => candle(index)),
    previewCandle: candle(count),
  }
}

function tick(symbol: string, index: number, isFinal: boolean, close?: number): KlineTick {
  return { ...candle(index, close), symbol, isFinal }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function createHarness(
  symbols: readonly string[] = ['XAUUSDT'],
  market: ScreenerMarket = 'tradfi',
  timeframe = '15m',
) {
  const current = { market, timeframe }
  const events: string[] = []
  const requests: {
    symbol: string
    timeframe: string
    market: ScreenerMarket
    signal: AbortSignal
    resolve: (value: SeedResult) => void
    reject: (error: unknown) => void
  }[] = []
  const publications: { symbol: string; history: RsiHistory }[] = []
  const errors: { symbol: string; error: unknown }[] = []
  const retries: { callback: () => void; delayMs: number; cancelled: boolean }[] = []
  const streams: { market: ScreenerMarket; symbols: readonly string[]; timeframe: string }[] = []
  let listener: KlineListener = () => undefined
  let disconnected = 0
  let activeRequests = 0
  let peakRequests = 0

  const stop = startRsiFeed({
    symbols,
    market,
    timeframe,
    isCurrent: () => current.market === market && current.timeframe === timeframe,
    publishHistory: (symbol, history) => { publications.push({ symbol, history }) },
    reportError: (symbol, error) => { errors.push({ symbol, error }) },
  }, {
    fetchSeed: (symbol, interval, signal, requestMarket) => {
      events.push(`seed:${symbol}`)
      const response = deferred<SeedResult>()
      activeRequests += 1
      peakRequests = Math.max(peakRequests, activeRequests)
      let settled = false
      const finish = () => {
        if (!settled) activeRequests -= 1
        settled = true
      }
      requests.push({
        symbol, timeframe: interval, market: requestMarket ?? 'spot', signal: signal!,
        resolve: (value) => { finish(); response.resolve(value) },
        reject: (error) => { finish(); response.reject(error) },
      })
      return response.promise
    },
    createStream: (onTick, streamMarket) => {
      listener = onTick
      return {
        connect: (subscribedSymbols, interval) => {
          events.push('connect')
          streams.push({ market: streamMarket, symbols: subscribedSymbols, timeframe: interval })
        },
        disconnect: () => { disconnected += 1 },
      }
    },
    scheduleRetry: (callback, delayMs) => {
      const retry = { callback, delayMs, cancelled: false }
      retries.push(retry)
      return () => { retry.cancelled = true }
    },
  })

  return {
    current, events, requests, publications, errors, retries, streams, stop,
    emit: (event: KlineTick) => listener(event),
    get disconnected() { return disconnected },
    get peakRequests() { return peakRequests },
  }
}

describe('active market RSI feed', () => {
  test('connects first and bounds the seed queue without duplicating symbols receiving ticks', async () => {
    const symbols = Array.from({ length: 20 }, (_, index) => `ASSET${index}USDT`)
    const feed = createHarness([...symbols, symbols[0]])
    expect(feed.events[0]).toBe('connect')
    expect(feed.streams).toEqual([{ market: 'tradfi', symbols, timeframe: '15m' }])
    expect(feed.requests).toHaveLength(8)

    // This instrument is still queued. Multiple live events must not start
    // duplicate requests or let it bypass the shared concurrency limit.
    feed.emit(tick(symbols[19], 40, true))
    feed.emit(tick(symbols[19], 40, false, 80))
    expect(feed.requests).toHaveLength(8)

    for (let index = 0; index < symbols.length; index++) {
      expect(feed.requests[index]?.symbol).toBe(symbols[index])
      feed.requests[index].resolve(seed())
      await flush()
    }
    expect(feed.requests).toHaveLength(symbols.length)
    expect(feed.peakRequests).toBe(8)
    expect(feed.requests.every((request) => request.market === 'tradfi' && request.timeframe === '15m')).toBe(true)
    expect(feed.publications).toHaveLength(symbols.length)
    expect(feed.publications.at(-1)?.history.closedBars.at(-1)?.openTime).toBe(candle(40).openTime)
    expect(feed.publications.at(-1)?.history.preview).toBeNull()
    feed.stop()
  })

  test('retains finals and replays out-of-order startup ticks without double advancing RSI', async () => {
    const feed = createHarness()
    feed.emit(tick('XAUUSDT', 41, false))
    feed.emit(tick('XAUUSDT', 40, true, 125))
    feed.emit(tick('XAUUSDT', 40, false, 80))
    feed.requests[0].resolve(seed())
    await flush()

    const expected = recoverRsiHistory(null, [...seed().closedCandles, candle(40, 125)], candle(41))
    expect(feed.publications[0].history).toMatchObject(expected!)
    feed.emit(tick('XAUUSDT', 40, true, 125))
    expect(feed.publications).toHaveLength(1)
    expect(feed.requests).toHaveLength(1)
    feed.stop()
  })

  test('uses the same queue for gap recovery and buffers subsequent ticks while recovery waits', async () => {
    const symbols = Array.from({ length: 10 }, (_, index) => `ASSET${index}USDT`)
    const feed = createHarness(symbols)
    feed.requests[0].resolve(seed())
    await flush()
    expect(feed.requests).toHaveLength(9)

    feed.emit(tick(symbols[0], 42, true))
    feed.emit(tick(symbols[0], 41, true))
    feed.emit(tick(symbols[0], 40, true))
    expect(feed.requests).toHaveLength(9)
    expect(feed.publications).toHaveLength(1)

    feed.requests[1].resolve(seed())
    await flush()
    feed.requests[2].resolve(seed())
    await flush()
    expect(feed.requests).toHaveLength(11)
    expect(feed.requests[10].symbol).toBe(symbols[0])
    feed.requests[10].resolve(seed(41))
    await flush()

    expect(feed.publications.at(-1)?.history).toMatchObject(recoverRsiHistory(null, seed(43).closedCandles, null)!)
    expect(feed.requests.filter((request) => request.symbol === symbols[0])).toHaveLength(2)
    expect(feed.peakRequests).toBe(8)
    expect(feed.retries).toHaveLength(0)
    feed.stop()
  })

  for (const change of ['market', 'timeframe'] as const) {
    test(`ignores old ${change} responses, errors and ticks before effect cleanup`, async () => {
      const symbols = Array.from({ length: 10 }, (_, index) => `ASSET${index}USDT`)
      const feed = createHarness(symbols, 'spot', '15m')
      if (change === 'market') feed.current.market = 'tradfi'
      else feed.current.timeframe = '1h'

      feed.emit(tick(symbols[0], 40, true))
      feed.requests[0].resolve(seed())
      feed.requests[1].reject(new Error('Late REST failure'))
      await flush()
      expect(feed.publications).toHaveLength(0)
      expect(feed.errors).toHaveLength(0)
      expect(feed.retries).toHaveLength(0)
      expect(feed.requests).toHaveLength(8)
      feed.stop()
      expect(feed.requests.every((request) => request.signal.aborted)).toBe(true)
      expect(feed.disconnected).toBe(1)
    })
  }

  test('stopping aborts in-flight work, cancels retries, and ignores callbacks after disconnect', async () => {
    const feed = createHarness(['XAUUSDT', 'XAGUSDT', 'AAPLUSDT'])
    feed.requests[0].reject(new Error('Temporary REST failure'))
    feed.requests[1].resolve(seed())
    await flush()
    expect(feed.retries).toHaveLength(1)
    expect(feed.retries[0].delayMs).toBe(5000)
    expect(feed.errors).toHaveLength(1)
    expect(feed.publications).toHaveLength(1)

    feed.stop()
    feed.stop()
    expect(feed.disconnected).toBe(1)
    expect(feed.requests.every((request) => request.signal.aborted)).toBe(true)
    expect(feed.retries[0].cancelled).toBe(true)
    feed.retries[0].callback()
    feed.emit(tick('XAGUSDT', 40, true))
    feed.requests[2].resolve(seed())
    await flush()
    expect(feed.requests).toHaveLength(3)
    expect(feed.publications).toHaveLength(1)
    expect(feed.errors).toHaveLength(1)
  })

  test('preserves a buffered gap when REST lags and retries without overlapping requests', async () => {
    const feed = createHarness()
    feed.emit(tick('XAUUSDT', 42, true))
    feed.requests[0].resolve(seed())
    await flush()
    expect(feed.retries).toHaveLength(1)
    feed.emit(tick('XAUUSDT', 42, false, 80))
    expect(feed.requests).toHaveLength(1)

    feed.retries[0].callback()
    expect(feed.requests).toHaveLength(2)
    feed.requests[1].resolve(seed(42))
    await flush()
    expect(feed.publications.at(-1)?.history).toMatchObject(recoverRsiHistory(null, seed(43).closedCandles, null)!)
    expect(feed.retries).toHaveLength(1)
    feed.stop()
  })

  test('waits longer for a new listing to acquire enough closed candles', async () => {
    const feed = createHarness()
    feed.requests[0].resolve(seed(3))
    await flush()
    expect(feed.publications).toHaveLength(0)
    expect(feed.errors).toHaveLength(1)
    expect(feed.retries[0].delayMs).toBe(60_000)
    feed.emit(tick('XAUUSDT', 3, true))
    expect(feed.requests).toHaveLength(1)
    feed.stop()
  })

  test('does not open a feed while the active universe is empty', () => {
    const feed = createHarness([])
    expect(feed.events).toHaveLength(0)
    expect(feed.requests).toHaveLength(0)
    feed.stop()
    expect(feed.disconnected).toBe(0)
  })
})

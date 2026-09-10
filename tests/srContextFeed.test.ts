import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import type { KlineListener, KlineTick } from '../src/lib/binanceSocket'
import type { ScreenerMarket } from '../src/lib/markets'
import { startSrContextFeed } from '../src/lib/srContextFeed'
import { SR_DAY_MS, SrContextRequestError } from '../src/lib/srContextRest'
import type { SrContextHistory } from '../src/lib/srContextRest'

function candle(day: number, close = 105): Candle {
  return {
    openTime: day * SR_DAY_MS, closeTime: (day + 1) * SR_DAY_MS - 1,
    open: 100, high: Math.max(110, close), low: Math.min(90, close), close, volume: 10,
  }
}

function history(closedDays = 40): SrContextHistory {
  return {
    candles: Array.from({ length: closedDays }, (_, index) => candle(index)),
    preview: candle(closedDays), asOf: closedDays * SR_DAY_MS + 1000,
  }
}

function tick(day: number, isFinal: boolean, close = 105, symbol = 'XAUUSDT'): KlineTick {
  return { ...candle(day, close), isFinal, symbol }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function harness(symbols: readonly string[] = ['XAUUSDT']) {
  const current: { market: ScreenerMarket; tab: string; timeframe: string } = { market: 'tradfi', tab: 'sr', timeframe: '15m' }
  const requests: {
    symbol: string; market: ScreenerMarket; signal: AbortSignal;
    resolve: (seed: SrContextHistory) => void; reject: (error: unknown) => void;
  }[] = []
  const publications: { symbol: string; history: SrContextHistory }[] = []
  const errors: { symbol: string; error: unknown }[] = []
  const timers: { callback: () => void; at: number; delay: number; cancelled: boolean; fired: boolean }[] = []
  const events: string[] = []
  let onTick: KlineListener = () => undefined
  let now = 0
  let disconnected = 0
  let inFlight = 0
  let peak = 0
  const stop = startSrContextFeed({
    symbols, market: 'tradfi',
    isCurrent: () => current.market === 'tradfi' && current.tab === 'sr',
    publishHistory: (symbol, value) => publications.push({ symbol, history: value }),
    reportError: (symbol, error) => errors.push({ symbol, error }),
  }, {
    fetchSeed: (symbol, signal, market) => new Promise((resolve, reject) => {
      events.push(`seed:${symbol}`)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      requests.push({ symbol, signal, market,
        resolve: (seed) => { inFlight -= 1; resolve(seed) },
        reject: (error) => { inFlight -= 1; reject(error) },
      })
    }),
    createStream: (listener, market) => {
      onTick = listener
      return {
        connect: (items, interval) => events.push(`connect:${market}:${interval}:${items.join(',')}`),
        disconnect: () => { disconnected += 1 },
      }
    },
    schedule: (callback, delay) => {
      const timer = { callback, at: now + delay, delay, cancelled: false, fired: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
    now: () => now,
  })
  function advance(milliseconds: number): void {
    const end = now + milliseconds
    for (;;) {
      const timer = timers.filter((entry) => !entry.fired && !entry.cancelled && entry.at <= end)
        .sort((a, b) => a.at - b.at)[0]
      if (!timer) break
      now = timer.at
      timer.fired = true
      timer.callback()
    }
    now = end
  }
  return { current, requests, publications, errors, timers, events, stop, advance,
    emit: (event: KlineTick) => onTick(event),
    get peak() { return peak }, get disconnected() { return disconnected },
  }
}

describe('daily support and resistance context feed', () => {
  test('connects first, deduplicates symbols, and caps parallel requests and request starts', async () => {
    const symbols = Array.from({ length: 12 }, (_, index) => `ASSET${index}USDT`)
    const feed = harness([...symbols, symbols[0]])
    expect(feed.events[0]).toBe(`connect:tradfi:1d:${symbols.join(',')}`)
    expect(feed.requests).toHaveLength(4)
    for (let index = 0; index < 8; index++) {
      feed.requests[index].resolve(history())
      await flush()
    }
    expect(feed.requests).toHaveLength(8)
    expect(feed.peak).toBe(4)
    feed.advance(999)
    expect(feed.requests).toHaveLength(8)
    feed.advance(1)
    expect(feed.requests).toHaveLength(12)
    expect(feed.requests.every((request) => request.market === 'tradfi')).toBe(true)
    feed.stop()
  })

  test('buffers final candles during startup and cannot replace a final with a stale preview', async () => {
    const feed = harness()
    feed.emit(tick(40, true, 120))
    feed.emit(tick(40, false, 80))
    feed.emit(tick(41, false, 108))
    feed.requests[0].resolve(history())
    await flush()
    expect(feed.publications[0].history.candles.at(-1)?.close).toBe(120)
    expect(feed.publications[0].history.candles).toHaveLength(41)
    expect(feed.publications[0].history.preview?.openTime).toBe(41 * SR_DAY_MS)
    expect(feed.publications[0].history.asOf).toBe(41 * SR_DAY_MS)
    feed.emit(tick(40, true, 120))
    feed.emit(tick(40, false, 80))
    expect(feed.publications).toHaveLength(1)
    feed.stop()
  })

  test('recovers missing closes through the same queue and retains buffered finals while REST lags', async () => {
    const feed = harness()
    feed.requests[0].resolve(history())
    await flush()
    feed.emit(tick(42, true))
    expect(feed.requests).toHaveLength(2)
    feed.requests[1].resolve(history())
    await flush()
    const retry = feed.timers.find((timer) => timer.delay === 5000)
    expect(retry).toBeDefined()
    feed.emit(tick(42, false, 80))
    expect(feed.requests).toHaveLength(2)
    feed.advance(5000)
    feed.requests[2].resolve(history(42))
    await flush()
    expect(feed.publications.at(-1)?.history.candles).toHaveLength(43)
    expect(feed.publications.at(-1)?.history.candles.at(-1)?.close).toBe(105)
    expect(feed.publications.at(-1)?.history.preview).toBeNull()
    feed.stop()
  })

  test('a REST-established missing session is retained instead of padded or retried forever', async () => {
    const feed = harness()
    feed.requests[0].resolve({ candles: [candle(1), candle(3)], preview: candle(6), asOf: 6 * SR_DAY_MS + 1000 })
    await flush()
    feed.emit(tick(6, true))
    expect(feed.requests).toHaveLength(1)
    expect(feed.publications.at(-1)?.history.candles.map((bar) => bar.openTime)).toEqual([1, 3, 6].map((day) => day * SR_DAY_MS))
    feed.stop()
  })

  test('short listings publish available context and malformed stream intervals cannot poison it', async () => {
    const feed = harness()
    feed.requests[0].resolve(history(0))
    await flush()
    expect(feed.publications).toHaveLength(1)
    expect(feed.errors).toHaveLength(0)
    feed.emit({ ...tick(0, true), closeTime: 59_999 })
    feed.emit({ ...tick(0, true), close: Number.NaN })
    expect(feed.publications).toHaveLength(1)
    expect(feed.requests).toHaveLength(1)
    feed.stop()
  })

  for (const change of ['market', 'tab'] as const) {
    test(`ignores stale ${change} responses, failures and ticks before effect cleanup`, async () => {
      const feed = harness(['XAUUSDT', 'XAGUSDT', 'AAPLUSDT', 'TSLAUSDT', 'NFLXUSDT'])
      if (change === 'market') feed.current.market = 'spot'
      else feed.current.tab = 'rsi'
      feed.requests[0].resolve(history())
      feed.requests[1].reject(new Error('Late network error'))
      feed.emit(tick(40, true))
      await flush()
      expect(feed.publications).toHaveLength(0)
      expect(feed.errors).toHaveLength(0)
      expect(feed.timers).toHaveLength(0)
      expect(feed.requests).toHaveLength(4)
      feed.stop()
      expect(feed.requests.every((request) => request.signal.aborted)).toBe(true)
      expect(feed.disconnected).toBe(1)
    })
  }

  test('a display timeframe change leaves the fixed daily history active', async () => {
    const feed = harness()
    feed.current.timeframe = '4h'
    feed.requests[0].resolve(history())
    await flush()
    expect(feed.publications).toHaveLength(1)
    feed.stop()
  })

  test('applies a shared Retry-After cooldown before starting queued requests', async () => {
    const feed = harness(['XAUUSDT', 'XAGUSDT', 'AAPLUSDT', 'TSLAUSDT', 'NFLXUSDT'])
    feed.requests[0].reject(new SrContextRequestError('Slow down', 429, 12_000))
    await flush()
    feed.requests[1].resolve(history())
    await flush()
    expect(feed.requests).toHaveLength(4)
    feed.advance(11_999)
    expect(feed.requests).toHaveLength(4)
    feed.advance(1)
    expect(feed.requests).toHaveLength(6)
    expect(feed.requests[4].symbol).toBe('NFLXUSDT')
    expect(feed.requests[5].symbol).toBe('XAUUSDT')
    feed.stop()
  })

  test('refreshes calendar context after UTC midnight even when a closed market sends no ticks', async () => {
    const feed = harness()
    const initial = { ...history(), asOf: 41 * SR_DAY_MS - 2000 }
    feed.requests[0].resolve(initial)
    await flush()
    feed.advance(3499)
    expect(feed.requests).toHaveLength(1)
    feed.advance(1)
    expect(feed.requests).toHaveLength(2)
    feed.requests[1].resolve({ candles: initial.candles, preview: null, asOf: 41 * SR_DAY_MS + 2000 })
    await flush()
    expect(feed.publications.at(-1)?.history.asOf).toBe(41 * SR_DAY_MS + 2000)
    feed.stop()
  })

  test('stop aborts work, cancels timers, disconnects once, and rejects late callbacks', async () => {
    const feed = harness(['XAUUSDT', 'XAGUSDT', 'AAPLUSDT'])
    feed.requests[0].resolve(history())
    feed.requests[1].reject(new Error('Temporary failure'))
    await flush()
    feed.stop()
    feed.stop()
    for (const timer of feed.timers) timer.callback()
    feed.requests[2].resolve(history())
    feed.emit(tick(40, true))
    await flush()
    expect(feed.requests).toHaveLength(3)
    expect(feed.publications).toHaveLength(1)
    expect(feed.errors).toHaveLength(1)
    expect(feed.timers.every((timer) => timer.cancelled)).toBe(true)
    expect(feed.requests.every((request) => request.signal.aborted)).toBe(true)
    expect(feed.disconnected).toBe(1)
  })

  test('does not open connections for an empty universe', () => {
    const feed = harness([])
    expect(feed.events).toHaveLength(0)
    feed.stop()
    expect(feed.disconnected).toBe(0)
  })
})

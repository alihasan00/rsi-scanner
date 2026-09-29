import { describe, expect, test } from 'bun:test'
import type { Candle, Timeframe } from '../src/types'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import type { KlineListener, KlineTick } from '../src/lib/binanceSocket'
import type { ScreenerMarket } from '../src/lib/markets'
import { GO_WATCHLIST_TIMEFRAMES, parseGoWatchlistSeed, startGoWatchlistFeed } from '../src/lib/goWatchlistFeed'
import type { GoWatchlistFrameUpdate, GoWatchlistTimeframe } from '../src/lib/goWatchlistFeed'

const NOW = Date.parse('2026-09-28T12:00:00Z')
// Keep transport and recovery coverage across four intervals while the actual
// mixed Watchlist default is asserted separately below.
const TRANSPORT_FIXTURE_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const

function candle(index: number, timeframe: GoWatchlistTimeframe = '15m', close = 105): Candle {
  const duration = TIMEFRAME_MILLISECONDS[timeframe]
  return { openTime: index * duration, closeTime: (index + 1) * duration - 1,
    open: 100, high: Math.max(110, close), low: Math.min(90, close), close, volume: 20 }
}

function rawCandle(bar: Candle): unknown[] {
  return [bar.openTime, String(bar.open), String(bar.high), String(bar.low), String(bar.close), String(bar.volume), bar.closeTime]
}

function seed(closed = 40, timeframe: GoWatchlistTimeframe = '15m'): unknown[][] {
  return Array.from({ length: closed + 1 }, (_, index) => rawCandle(candle(index, timeframe)))
}

function tick(index: number, isFinal: boolean, close = 105, timeframe: GoWatchlistTimeframe = '15m', symbol = 'BTCUSDT'): KlineTick {
  return { ...candle(index, timeframe, close), symbol, isFinal }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 15; index++) await Promise.resolve()
}

function harness(symbols: readonly string[] = ['BTCUSDT'], market: ScreenerMarket = 'spot',
  timeframes: readonly Timeframe[] = TRANSPORT_FIXTURE_TIMEFRAMES) {
  const events: string[] = []
  const requests: { symbol: string; timeframe: GoWatchlistTimeframe; url: URL; signal: AbortSignal; startedAt: number;
    respond: (raw: unknown, status?: number, headers?: HeadersInit) => void; reject: (error: unknown) => void }[] = []
  const updates: GoWatchlistFrameUpdate[] = []
  const timers: { callback: () => void; delay: number; at: number; cancelled: boolean; fired: boolean }[] = []
  const listeners = new Map<GoWatchlistTimeframe, KlineListener>()
  let now = NOW
  let inFlight = 0
  let peak = 0
  let disconnected = 0
  const stop = startGoWatchlistFeed({ symbols, market, timeframes, onUpdate: (update) => updates.push(update) }, {
    now: () => now,
    fetcher: ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input))
      const symbol = url.searchParams.get('symbol')!
      const timeframe = url.searchParams.get('interval') as GoWatchlistTimeframe
      events.push(`seed:${symbol}:${timeframe}`)
      inFlight++
      peak = Math.max(peak, inFlight)
      return new Promise<Response>((resolve, reject) => {
        let settled = false
        const finish = () => { if (!settled) inFlight--; settled = true }
        const signal = init?.signal as AbortSignal
        signal.addEventListener('abort', () => { finish(); reject(signal.reason) }, { once: true })
        requests.push({ symbol, timeframe, url, signal, startedAt: now,
          respond: (raw, status = 200, headers) => { finish(); resolve(new Response(JSON.stringify(raw), { status, headers })) },
          reject: (cause) => { finish(); reject(cause) },
        })
      })
    }) as typeof fetch,
    createStream: (listener, streamMarket) => ({
      connect: (items, interval) => {
        events.push(`connect:${streamMarket}:${interval}:${items.join(',')}`)
        listeners.set(interval as GoWatchlistTimeframe, listener)
      },
      disconnect: () => { disconnected++ },
    }),
    schedule: (callback, delay) => {
      const timer = { callback, delay, at: now + delay, cancelled: false, fired: false }
      timers.push(timer)
      return () => { timer.cancelled = true }
    },
  })
  function advance(milliseconds: number): void {
    const end = now + milliseconds
    for (;;) {
      const next = timers.filter((timer) => !timer.cancelled && !timer.fired && timer.at <= end)
        .sort((a, b) => a.at - b.at)[0]
      if (!next) break
      now = next.at
      next.fired = true
      next.callback()
    }
    now = end
  }
  return { requests, updates, timers, events, stop, advance,
    emit: (event: KlineTick, timeframe: GoWatchlistTimeframe = '15m') => listeners.get(timeframe)?.(event),
    frameUpdates: (timeframe: GoWatchlistTimeframe = '15m') => updates.filter((update) => update.timeframe === timeframe),
    get now() { return now }, get peak() { return peak }, get disconnected() { return disconnected },
  }
}

describe('raw Go watchlist seed validation', () => {
  test('accepts Monday weekly candles and exchange-phased three-day candles, rejecting shifted weekly opens', () => {
    for (const timeframe of ['1w', '3d'] as const) {
      const duration = TIMEFRAME_MILLISECONDS[timeframe]
      const start = Date.parse('2026-09-28T00:00:00Z')
      const raw = Array.from({length: 3}, (_, i) => rawCandle({...candle(i, timeframe), openTime: start + i * duration, closeTime: start + (i + 1) * duration - 1}))
      expect(parseGoWatchlistSeed(raw, timeframe).candles).toHaveLength(2)
      const shifted = raw.map((row) => row.map((value, i) => i === 0 || i === 6 ? Number(value) + TIMEFRAME_MILLISECONDS['1d'] : value))
      if (timeframe === '1w') expect(() => parseGoWatchlistSeed(shifted, timeframe)).toThrow()
      else expect(parseGoWatchlistSeed(shifted, timeframe).candles).toHaveLength(2)
    }
  })
  test('keeps 500 completed candles and the provisional newest candle without an RSI warmup cut', () => {
    const history = parseGoWatchlistSeed(seed(500), '15m')
    expect(history.candles).toHaveLength(500)
    expect(history.candles[0]).toEqual(candle(0))
    expect(history.preview).toEqual(candle(500))
    expect(parseGoWatchlistSeed(seed(0), '15m')).toEqual({ candles: [], preview: candle(0) })
  })

  test('rejects malformed numbers, timestamp coercion, wrong intervals and unordered candles', () => {
    const invalid = [null, [], seed(501), [[...rawCandle(candle(0)).slice(0, 6)]],
      [[String(candle(0).openTime), ...rawCandle(candle(0)).slice(1)]],
      [rawCandle(candle(0, '1h'))], [rawCandle({ ...candle(0), openTime: 1 })],
      [rawCandle(candle(1)), rawCandle(candle(0))], [rawCandle(candle(0)), rawCandle(candle(0))],
    ]
    for (const raw of invalid) expect(() => parseGoWatchlistSeed(raw, '15m')).toThrow()
    for (const value of [true, null, '', ' ', 'NaN', 'Infinity', -1]) {
      const raw = rawCandle(candle(0))
      raw[4] = value
      expect(() => parseGoWatchlistSeed([raw], '15m')).toThrow()
    }
    const genuineGap = parseGoWatchlistSeed([rawCandle(candle(0)), rawCandle(candle(2)), rawCandle(candle(5))], '15m')
    expect(genuineGap.candles.map((bar) => bar.openTime)).toEqual([0, TIMEFRAME_MILLISECONDS['15m'] * 2])
  })
})

describe('Go watchlist feed sources and transport', () => {
  test('production mixed scans default to daily and four-hour feeds', () => {
    const requested: string[] = []
    const connected: string[] = []
    const stop = startGoWatchlistFeed({symbols: ['BTCUSDT'], market: 'spot', onUpdate: () => undefined}, {
      fetcher: ((input: Parameters<typeof fetch>[0]) => {
        requested.push(new URL(String(input)).searchParams.get('interval')!)
        return Promise.reject(new Error('Test seed cancelled'))
      }) as typeof fetch,
      createStream: () => ({
        connect: (_symbols, interval) => { connected.push(interval) },
        disconnect: () => undefined,
      }),
      schedule: () => () => undefined,
      now: () => NOW,
    })
    expect(GO_WATCHLIST_TIMEFRAMES).toEqual(['1d', '4h'])
    expect(connected).toEqual(['1d', '4h'])
    expect(requested).toEqual(['1d', '4h'])
    stop()
  })

  test('a dedicated scan requests only its chosen frame and cleans up on a timeframe change', async () => {
    const feed = harness(['BTCUSDT'], 'spot', ['2h', '2h'])
    expect(feed.requests.map((request) => request.timeframe)).toEqual(['2h'])
    expect(feed.events[0]).toBe('connect:spot:2h:BTCUSDT')
    for (const request of feed.requests) request.respond(seed(160, request.timeframe))
    await flush()
    expect(feed.updates.map((update) => update.timeframe)).toEqual(['2h'])
    feed.stop()
    expect(feed.disconnected).toBe(1)
    feed.emit(tick(161, true, 106, '2h'), '2h')
    expect(feed.updates).toHaveLength(1)
    const smaller = harness(['BTCUSDT'], 'spot', ['3m'])
    expect(smaller.requests.map((request) => request.timeframe)).toEqual(['3m'])
    smaller.stop()
    expect(smaller.disconnected).toBe(1)
  })
  test('invokes the browser fetch function without binding the dependency object as its receiver', async () => {
    const receivers: unknown[] = []
    const stop = startGoWatchlistFeed({ symbols: ['BTCUSDT'], market: 'spot', onUpdate: () => undefined }, {
      fetcher: (function (this: unknown) {
        receivers.push(this)
        return Promise.reject(new Error('Receiver recorded'))
      }) as typeof fetch,
      createStream: () => ({ connect: () => undefined, disconnect: () => undefined }),
      schedule: () => () => undefined,
    })
    await flush()
    expect(receivers).toEqual([undefined, undefined])
    stop()
  })

  test('connects every interval before requests, deduplicates symbols and shares an eight-request queue', async () => {
    const symbols = Array.from({ length: 6 }, (_, index) => `ASSET${index}USDT`)
    const feed = harness([...symbols, symbols[0]], 'tradfi')
    expect(feed.events.slice(0, 4)).toEqual(TRANSPORT_FIXTURE_TIMEFRAMES.map((timeframe) => `connect:tradfi:${timeframe}:${symbols.join(',')}`))
    expect(feed.requests).toHaveLength(8)
    expect(feed.requests.map((request) => request.timeframe)).toEqual([...TRANSPORT_FIXTURE_TIMEFRAMES, ...TRANSPORT_FIXTURE_TIMEFRAMES])
    for (let index = 0; index < 8; index++) {
      feed.requests[index].respond(seed(40, feed.requests[index].timeframe))
      await flush()
    }
    expect(feed.requests).toHaveLength(8)
    expect(feed.peak).toBe(8)
    feed.advance(999)
    expect(feed.requests).toHaveLength(8)
    feed.advance(1)
    expect(feed.requests).toHaveLength(16)
    expect(feed.requests.every((request) => request.url.origin === 'https://fapi.binance.com' && request.url.searchParams.get('limit') === '501')).toBe(true)
    expect(feed.updates).toHaveLength(8)
    feed.stop()
  })

  test('overlaps 750 ms responses across 440 feeds without exceeding either request budget', async () => {
    const symbols = Array.from({ length: 110 }, (_, index) => `ASSET${index}USDT`)
    const feed = harness(symbols)
    const expectedFrames = symbols.length * TRANSPORT_FIXTURE_TIMEFRAMES.length
    const latency = 750
    const fourConcurrentMinimum = Math.ceil(expectedFrames / 4) * latency
    const responded = new Set<typeof feed.requests[number]>()
    while (feed.updates.length < expectedFrames && feed.now - NOW <= fourConcurrentMinimum) {
      feed.advance(250)
      for (const request of feed.requests) {
        if (!responded.has(request) && request.startedAt + latency <= feed.now) {
          responded.add(request)
          request.respond(seed(40, request.timeframe))
        }
      }
      await flush()
    }
    const elapsed = feed.now - NOW
    expect(feed.updates).toHaveLength(expectedFrames)
    expect(feed.updates.every((frame) => frame.status === 'ready')).toBe(true)
    expect(feed.requests).toHaveLength(expectedFrames)
    expect(feed.peak).toBe(8)
    expect(elapsed).toBe(54_750)
    expect(elapsed).toBeLessThan(fourConcurrentMinimum) // Four slots need at least 82,500 ms at this latency.
    for (const request of feed.requests) {
      const rollingStarts = feed.requests.filter((other) => other.startedAt > request.startedAt - 1_000
        && other.startedAt <= request.startedAt)
      expect(rollingStarts.length).toBeLessThanOrEqual(8)
    }
    feed.stop()
  })

  test('replays startup ticks in candle order, preserves final priority and actual quote receipt', async () => {
    const feed = harness()
    feed.advance(20)
    feed.emit(tick(41, false, 108))
    feed.advance(10)
    feed.emit(tick(40, true, 125))
    feed.emit(tick(40, false, 80))
    feed.advance(170)
    feed.requests[0].respond(seed())
    await flush()
    const update = feed.frameUpdates()[0]
    expect(update.status).toBe('ready')
    expect(update.candles).toHaveLength(41)
    expect(update.candles.at(-1)?.close).toBe(125)
    expect(update.candles.at(-1)).toEqual(candle(40, '15m', 125))
    expect(update.preview).toEqual(candle(41, '15m', 108))
    expect(update.preview?.openTime).toBe(candle(41).openTime)
    expect(update.receivedAt).toBe(NOW + 20)
    feed.emit(tick(40, true, 125))
    feed.emit(tick(40, false, 80))
    expect(feed.frameUpdates()).toHaveLength(1)
    feed.stop()
  })

  test('publishes immutable histories that previews reuse and finals or corrections replace', async () => {
    const feed = harness()
    feed.requests[0].respond(seed())
    await flush()
    const original = feed.frameUpdates()[0]
    const originalValue = structuredClone(original)
    expect(Object.isFrozen(original.candles)).toBe(true)
    expect(original.candles.every(Object.isFrozen)).toBe(true)
    expect(Object.isFrozen(original.preview)).toBe(true)
    expect(() => { original.candles[0].close = 999 }).toThrow()
    expect(() => { original.candles.push(candle(40)) }).toThrow()
    expect(() => { original.preview!.close = 999 }).toThrow()

    feed.advance(100)
    feed.emit(tick(40, false, 109))
    const live = feed.frameUpdates().at(-1)!
    expect(live.candles).toBe(original.candles)
    expect(live.preview).not.toBe(original.preview)
    expect(Object.isFrozen(live.preview)).toBe(true)
    expect(live.preview?.close).toBe(109)
    expect(live.receivedAt).toBe(NOW + 100)

    feed.advance(100)
    feed.emit(tick(40, true, 115))
    const finalized = feed.frameUpdates().at(-1)!
    expect(finalized.candles).not.toBe(live.candles)
    expect(Object.isFrozen(finalized.candles)).toBe(true)
    expect(finalized.candles.every(Object.isFrozen)).toBe(true)
    expect(finalized.candles).toHaveLength(41)
    expect(finalized.candles.at(-1)?.close).toBe(115)
    expect(finalized.preview).toBeNull()
    expect(finalized.receivedAt).toBe(NOW + 200)
    expect(live.candles).toHaveLength(40)
    expect(live.preview?.close).toBe(109)

    feed.advance(100)
    feed.emit(tick(41, false, 116))
    const nextQuote = feed.frameUpdates().at(-1)!
    const nextQuoteValue = structuredClone(nextQuote)
    expect(nextQuote.candles).toBe(finalized.candles)
    expect(nextQuote.receivedAt).toBe(NOW + 300)

    feed.advance(100)
    feed.emit(tick(39, true, 120))
    const corrected = feed.frameUpdates().at(-1)!
    expect(corrected.candles).not.toBe(nextQuote.candles)
    expect(Object.isFrozen(corrected.candles)).toBe(true)
    expect(corrected.candles.every(Object.isFrozen)).toBe(true)
    expect(corrected.candles[39].close).toBe(120)
    expect(corrected.candles[0]).toBe(nextQuote.candles[0])
    expect(corrected.preview).toBe(nextQuote.preview)
    expect(corrected.receivedAt).toBe(nextQuote.receivedAt)
    expect(original).toEqual(originalValue)
    expect(nextQuote).toEqual(nextQuoteValue)
    feed.stop()
  })

  test('a new preview cannot finalize an earlier unconfirmed preview without recovering its final OHLC', async () => {
    const feed = harness()
    feed.requests[0].respond(seed())
    await flush()
    feed.advance(100)
    feed.emit(tick(41, false, 108))
    expect(feed.frameUpdates().at(-1)).toMatchObject({ status: 'error', receivedAt: NOW })
    expect(feed.frameUpdates().at(-1)?.candles.at(-1)?.openTime).toBe(candle(39).openTime)
    expect(feed.requests).toHaveLength(5)
    const recovered = seed(41)
    recovered[40] = rawCandle(candle(40, '15m', 120))
    feed.requests[4].respond(recovered)
    await flush()
    expect(feed.frameUpdates().at(-1)?.status).toBe('ready')
    expect(feed.frameUpdates().at(-1)?.candles.at(-1)?.close).toBe(120)
    expect(feed.frameUpdates().at(-1)?.preview?.close).toBe(108)
    feed.stop()
  })

  test('keeps buffered finals while REST lags, then recovers the missing closes without bridging', async () => {
    const feed = harness()
    feed.requests[0].respond(seed())
    await flush()
    feed.emit(tick(42, true, 120))
    feed.requests[4].respond(seed())
    await flush()
    expect(feed.frameUpdates().at(-1)?.status).toBe('error')
    expect(feed.frameUpdates().at(-1)?.candles).toHaveLength(40)
    feed.emit(tick(42, false, 80))
    feed.advance(4_999)
    expect(feed.requests).toHaveLength(5)
    feed.advance(1)
    expect(feed.requests).toHaveLength(6)
    feed.requests[5].respond(seed(42))
    await flush()
    expect(feed.frameUpdates().at(-1)?.status).toBe('ready')
    expect(feed.frameUpdates().at(-1)?.candles).toHaveLength(43)
    expect(feed.frameUpdates().at(-1)?.candles.at(-1)?.close).toBe(120)
    expect(feed.frameUpdates().at(-1)?.preview).toBeNull()
    expect(feed.peak).toBe(4)
    feed.stop()
  })

  test('errors retain last successful data and do not refresh the quote clock', async () => {
    const feed = harness()
    feed.requests[0].respond(seed())
    await flush()
    const original = feed.frameUpdates()[0]
    feed.advance(100)
    feed.emit(tick(42, true))
    feed.requests[4].reject(new Error('Network unavailable'))
    await flush()
    const error = feed.frameUpdates().at(-1)!
    expect(error.status).toBe('error')
    expect(error.receivedAt).toBe(original.receivedAt)
    expect(error.candles).toBe(original.candles)
    expect(error.preview).toBe(original.preview)
    const count = feed.frameUpdates().length
    feed.advance(1_000)
    expect(feed.frameUpdates()).toHaveLength(count)
    feed.stop()
  })

  test('retains a REST-established missing session and publishes short listings for Go readiness checks', async () => {
    const feed = harness()
    feed.requests[0].respond([rawCandle(candle(0)), rawCandle(candle(2)), rawCandle(candle(5))])
    feed.requests[1].respond(seed(0, '1h'))
    await flush()
    feed.emit(tick(5, true))
    expect(feed.frameUpdates().at(-1)?.candles.map((bar) => bar.openTime)).toEqual([0, 2, 5].map((index) => candle(index).openTime))
    expect(feed.frameUpdates('1h')[0]).toMatchObject({ candles: [], preview: candle(0, '1h'), status: 'ready' })
    expect(feed.requests).toHaveLength(4)
    feed.stop()
  })

  test('ignores unrelated or malformed ticks, bounds closed history, and accepts corrections without refreshing a newer quote', async () => {
    const feed = harness()
    feed.requests[0].respond(seed(500))
    await flush()
    feed.emit(tick(500, false, 105, '15m', 'UNKNOWNUSDT'))
    feed.emit(tick(500, false, 105, '1h'))
    feed.emit({ ...tick(500, false), close: NaN })
    expect(feed.frameUpdates()).toHaveLength(1)
    feed.advance(100)
    feed.emit(tick(500, true))
    feed.advance(100)
    feed.emit(tick(501, false))
    expect(feed.frameUpdates().at(-1)?.candles).toHaveLength(500)
    expect(feed.frameUpdates().at(-1)?.candles[0].openTime).toBe(candle(1).openTime)
    feed.advance(100)
    feed.emit(tick(400, true, 120))
    const corrected = feed.frameUpdates().at(-1)!
    expect(corrected.candles.find((bar) => bar.openTime === candle(400).openTime)?.close).toBe(120)
    expect(corrected.receivedAt).toBe(NOW + 200)
    expect(corrected.preview?.openTime).toBe(candle(501).openTime)
    feed.stop()
  })

  test.each([429, 418])('honors global Retry-After on HTTP %s before starting queued frames', async (status) => {
    const feed = harness(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'])
    feed.requests[0].respond({ code: -1003 }, status, { 'Retry-After': '12' })
    await flush()
    for (let index = 1; index < 8; index++) feed.requests[index].respond(seed(40, feed.requests[index].timeframe))
    await flush()
    expect(feed.requests).toHaveLength(8)
    feed.advance(11_999)
    expect(feed.requests).toHaveLength(8)
    feed.advance(1)
    expect(feed.requests).toHaveLength(16)
    expect(feed.requests.slice(8).map((request) => request.symbol)).toEqual([
      'SOLUSDT', 'SOLUSDT', 'SOLUSDT', 'SOLUSDT', 'ADAUSDT', 'ADAUSDT', 'ADAUSDT', 'ADAUSDT',
    ])
    expect(feed.peak).toBe(8)
    feed.stop()
  })

  test('supports HTTP-date cooldowns and backs off repeated failures instead of retrying on every tick', async () => {
    const feed = harness()
    feed.requests[0].respond({}, 429, { 'Retry-After': new Date(NOW + 12_000).toUTCString() })
    await flush()
    for (let index = 1; index < 4; index++) feed.requests[index].respond(seed(40, feed.requests[index].timeframe))
    await flush()
    feed.emit(tick(40, false))
    feed.advance(11_999)
    expect(feed.requests).toHaveLength(4)
    feed.advance(1)
    expect(feed.requests).toHaveLength(5)
    feed.requests[4].reject(new Error('Still unavailable'))
    await flush()
    feed.advance(9_999)
    expect(feed.requests).toHaveLength(5)
    feed.advance(1)
    expect(feed.requests).toHaveLength(6)
    feed.stop()
  })

  test('times out requests after fifteen seconds and releases slots for other queued frames', async () => {
    const feed = harness(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'])
    feed.advance(14_999)
    expect(feed.requests.every((request) => !request.signal.aborted)).toBe(true)
    feed.advance(1)
    await flush()
    expect(feed.requests.slice(0, 8).every((request) => request.signal.aborted)).toBe(true)
    expect(feed.requests).toHaveLength(16)
    expect(feed.updates).toHaveLength(8)
    expect(feed.updates.every((update) => update.status === 'error' && update.receivedAt === 0 && update.error?.includes('timed out'))).toBe(true)
    feed.stop()
  })

  test('stopping for a market change aborts requests, disconnects all streams and suppresses late callbacks and retries', async () => {
    const old = harness()
    old.requests[0].reject(new Error('Offline'))
    await flush()
    const before = old.updates.length
    old.stop()
    old.stop()
    const current = harness(['BTCUSDT'], 'tradfi')
    old.emit(tick(40, true))
    for (const timer of old.timers) timer.callback()
    old.requests[1].respond(seed(40, '1h'))
    await flush()
    expect(old.updates).toHaveLength(before)
    expect(old.requests).toHaveLength(4)
    expect(old.requests.slice(1).every((request) => request.signal.aborted)).toBe(true)
    expect(old.timers.every((timer) => timer.cancelled || timer.fired)).toBe(true)
    expect(old.disconnected).toBe(4)
    current.requests[0].respond(seed())
    await flush()
    expect(current.updates).toHaveLength(1)
    expect(current.requests[0].url.origin).toBe('https://fapi.binance.com')
    current.stop()
  })

  test('an empty universe does not open streams or start timers and requests', () => {
    const feed = harness([])
    expect(feed.events).toEqual([])
    expect(feed.timers).toEqual([])
    feed.stop()
    expect(feed.disconnected).toBe(0)
  })
})

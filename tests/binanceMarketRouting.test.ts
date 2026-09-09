import { afterEach, describe, expect, mock, test } from 'bun:test'
import { fetchSeedKlines } from '../src/lib/binanceRest'
import { KlineStreamManager } from '../src/lib/binanceSocket'
import type { KlineTick } from '../src/lib/binanceSocket'

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const managers: KlineStreamManager[] = []
const timers = new Map<number, { callback: () => void; delay?: number }>()
let nextTimer = 0

const SEED_ROWS = [
  [0, '100', '110', '90', '105', '10', 899_999],
  [900_000, '105', '115', '100', '110', '12', 1_799_999],
]

type SocketEvent = { data?: string }

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readonly url: string
  closeCount = 0
  private listeners = new Map<string, Array<(event: SocketEvent) => void>>()

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  emit(type: string, event: SocketEvent = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  message(symbol: string, close = '105') {
    this.emit('message', { data: JSON.stringify({ data: { k: {
      s: symbol, t: 0, T: 899_999, o: '100', h: '110', l: '90', c: close, v: '10', x: false,
    } } }) })
  }

  close() {
    this.closeCount += 1
    this.emit('close')
  }
}

function installSocketMocks() {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    const id = ++nextTimer
    timers.set(id, { callback, delay })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => { timers.delete(id) }) as typeof clearTimeout
}

function manager(listener: (tick: KlineTick) => void, market?: 'spot' | 'tradfi') {
  const result = new KlineStreamManager(listener, market)
  managers.push(result)
  return result
}

afterEach(() => {
  for (const stream of managers.splice(0)) stream.disconnect()
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  FakeWebSocket.instances = []
  timers.clear()
})

describe('market REST routing', () => {
  test.each([
    { market: 'spot' as const, symbol: 'BTCUSDT', base: 'https://api.binance.com/api/v3' },
    { market: 'tradfi' as const, symbol: 'XAUUSDT', base: 'https://fapi.binance.com/fapi/v1' },
  ])('$market seed requests use the correct kline endpoint and forward cancellation', async ({ market, symbol, base }) => {
    const fetcher = mock(async () => new Response(JSON.stringify(SEED_ROWS)))
    globalThis.fetch = fetcher as typeof fetch
    const controller = new AbortController()

    const result = await fetchSeedKlines(symbol, '15m', controller.signal, market)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(`${base}/klines?symbol=${symbol}&interval=15m&limit=350`, { signal: controller.signal })
    expect(result.closedCandles).toHaveLength(1)
    expect(result.closedCandles[0]).toMatchObject({ openTime: 0, close: 105 })
    expect(result.previewCandle).toMatchObject({ openTime: 900_000, close: 110 })
  })

  test('omitting the market preserves the original Spot endpoint', async () => {
    const fetcher = mock(async () => new Response(JSON.stringify(SEED_ROWS)))
    globalThis.fetch = fetcher as typeof fetch

    await fetchSeedKlines('ETHUSDT', '1h')

    expect(fetcher).toHaveBeenCalledWith('https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1h&limit=350', { signal: undefined })
  })

  test('TradFi REST errors are surfaced without retrying on the Spot endpoint', async () => {
    const fetcher = mock(async () => new Response('Unavailable', { status: 429 }))
    globalThis.fetch = fetcher as typeof fetch

    await expect(fetchSeedKlines('XAUUSDT', '1h', undefined, 'tradfi')).rejects.toThrow('Binance REST 429 for XAUUSDT')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=1h&limit=350', { signal: undefined })
  })
})

describe('market WebSocket routing and teardown', () => {
  test.each([
    { market: 'spot' as const, base: 'wss://stream.binance.com:9443/stream' },
    { market: 'tradfi' as const, base: 'wss://fstream.binance.com/market/stream' },
  ])('$market uses its combined-stream route and stops publishing after disconnect', ({ market, base }) => {
    installSocketMocks()
    const ticks: KlineTick[] = []
    const stream = manager((tick) => ticks.push(tick), market)
    stream.connect(['XAUUSDT', 'XAGUSDT'], '15m')
    const socket = FakeWebSocket.instances[0]
    expect(socket?.url).toBe(`${base}?streams=xauusdt@kline_15m/xagusdt@kline_15m`)
    socket.message('XAUUSDT')
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toMatchObject({ symbol: 'XAUUSDT', close: 105, isFinal: false })

    stream.disconnect()
    socket.message('XAUUSDT', '109')
    socket.emit('close')

    expect(socket.closeCount).toBe(1)
    expect(ticks).toHaveLength(1)
    expect(timers.size).toBe(0)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })

  test('a new TradFi manager cannot receive late messages from the previous Spot manager', () => {
    installSocketMocks()
    const ticks: string[] = []
    const spot = manager((tick) => ticks.push(`spot:${tick.symbol}`))
    spot.connect(['BTCUSDT'], '1h')
    const oldSocket = FakeWebSocket.instances[0]
    expect(oldSocket.url).toBe('wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1h')
    spot.disconnect()
    const tradfi = manager((tick) => ticks.push(`tradfi:${tick.symbol}`), 'tradfi')
    tradfi.connect(['XAUUSDT'], '1h')
    const currentSocket = FakeWebSocket.instances[1]

    oldSocket.message('BTCUSDT')
    oldSocket.emit('close')
    currentSocket.message('XAUUSDT')

    expect(ticks).toEqual(['tradfi:XAUUSDT'])
    expect(currentSocket.url).toBe('wss://fstream.binance.com/market/stream?streams=xauusdt@kline_1h')
    expect(timers.size).toBe(0)
  })

  test('reconnecting a manager ignores late events from sockets for its previous timeframe', () => {
    installSocketMocks()
    const listener = mock(() => {})
    const stream = manager(listener, 'tradfi')
    stream.connect(['XAUUSDT'], '15m')
    const oldSocket = FakeWebSocket.instances[0]
    stream.connect(['XAUUSDT'], '4h')
    const currentSocket = FakeWebSocket.instances[1]

    oldSocket.message('XAUUSDT', '109')
    oldSocket.emit('close')
    currentSocket.message('XAUUSDT')

    expect(oldSocket.closeCount).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(currentSocket.url).toBe('wss://fstream.binance.com/market/stream?streams=xauusdt@kline_4h')
    expect(timers.size).toBe(0)
  })

  test('disconnect cancels a pending futures reconnect and its late callback cannot reopen the socket', () => {
    installSocketMocks()
    const stream = manager(() => {}, 'tradfi')
    stream.connect(['XAUUSDT'], '1h')
    FakeWebSocket.instances[0].emit('close')
    expect(timers.size).toBe(1)
    const pending = [...timers.values()][0]
    expect(pending.delay).toBe(3000)

    stream.disconnect()
    expect(timers.size).toBe(0)
    pending.callback()

    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})

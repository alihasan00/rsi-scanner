import type { Candle } from '../types'
import { isValidCandle } from './rsiHistory'
import { MARKETS } from './markets'
import type { ScreenerMarket } from './markets'

// Combined kline stream manager. Binance limits how many streams a single
// connection may carry, so symbols are sharded across a few sockets.

const CHUNK_SIZE = 50
const RECONNECT_DELAY_MS = 3000

export interface KlineTick extends Candle {
  symbol: string
  isFinal: boolean
}

export type KlineListener = (tick: KlineTick) => void

export function parseKlineTick(raw: unknown): KlineTick | null {
  if (!raw || typeof raw !== 'object' || !('data' in raw)) return null
  const data = raw.data
  if (!data || typeof data !== 'object' || !('k' in data)) return null
  const k = data.k
  if (!k || typeof k !== 'object') return null
  if (!('s' in k) || typeof k.s !== 'string' || !k.s
    || !('x' in k) || typeof k.x !== 'boolean'
    || !('t' in k) || !('T' in k) || !('o' in k) || !('h' in k)
    || !('l' in k) || !('c' in k) || !('v' in k)) return null
  const tick: KlineTick = {
    symbol: k.s.toUpperCase(),
    openTime: Number(k.t),
    closeTime: Number(k.T),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    isFinal: k.x,
  }
  return isValidCandle(tick) ? tick : null
}

export class KlineStreamManager {
  private sockets = new Set<WebSocket>()
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>()
  private closed = true
  private readonly listener: KlineListener
  private readonly streamBase: string

  constructor(listener: KlineListener, market: ScreenerMarket = 'spot') {
    this.listener = listener
    this.streamBase = MARKETS[market].streamBase
  }

  connect(symbols: readonly string[], interval: string): void {
    this.disconnect()
    this.closed = false
    for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
      this.openSocket(symbols.slice(i, i + CHUNK_SIZE), interval)
    }
  }

  disconnect(): void {
    this.closed = true
    for (const timer of this.reconnectTimers) clearTimeout(timer)
    this.reconnectTimers.clear()
    const sockets = [...this.sockets]
    this.sockets.clear()
    for (const socket of sockets) socket.close()
  }

  private openSocket(symbols: string[], interval: string): void {
    if (this.closed) return

    const streams = symbols.map((s) => `${s.toLowerCase()}@kline_${interval}`).join('/')
    const socket = new WebSocket(`${this.streamBase}?streams=${streams}`)
    this.sockets.add(socket)

    socket.addEventListener('message', (event) => {
      if (this.closed || !this.sockets.has(socket)) return

      let payload: unknown
      try {
        payload = JSON.parse(event.data as string)
      } catch {
        return
      }
      const tick = parseKlineTick(payload)
      if (tick) this.listener(tick)
    })

    socket.addEventListener('close', () => {
      const wasTracked = this.sockets.delete(socket)
      if (!wasTracked || this.closed) return

      const timer = setTimeout(() => {
        this.reconnectTimers.delete(timer)
        this.openSocket(symbols, interval)
      }, RECONNECT_DELAY_MS)
      this.reconnectTimers.add(timer)
    })

    socket.addEventListener('error', () => socket.close())
  }
}

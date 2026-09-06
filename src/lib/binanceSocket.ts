// Combined kline stream manager. Binance limits how many streams a single
// connection may carry, so symbols are sharded across a few sockets.

const WS_BASE = 'wss://stream.binance.com:9443/stream'
const CHUNK_SIZE = 50
const RECONNECT_DELAY_MS = 3000

export interface KlineTick {
  symbol: string
  close: number
  volume: number
  isFinal: boolean
}

export type KlineListener = (tick: KlineTick) => void

interface RawKlineMessage {
  data?: {
    k?: { s: string; c: string; v: string; x: boolean }
  }
}

export class KlineStreamManager {
  private sockets = new Set<WebSocket>()
  private reconnectTimers = new Set<ReturnType<typeof setTimeout>>()
  private closed = true
  private readonly listener: KlineListener

  constructor(listener: KlineListener) {
    this.listener = listener
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
    const socket = new WebSocket(`${WS_BASE}?streams=${streams}`)
    this.sockets.add(socket)

    socket.addEventListener('message', (event) => {
      if (this.closed || !this.sockets.has(socket)) return

      let payload: RawKlineMessage
      try {
        payload = JSON.parse(event.data as string)
      } catch {
        return
      }
      const k = payload.data?.k
      if (!k) return
      this.listener({
        symbol: k.s.toUpperCase(),
        close: Number.parseFloat(k.c),
        volume: Number.parseFloat(k.v),
        isFinal: k.x,
      })
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

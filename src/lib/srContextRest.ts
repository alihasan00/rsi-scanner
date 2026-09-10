import type { Candle } from '../types'
import { MARKETS } from './markets'
import type { ScreenerMarket } from './markets'
import { isValidCandle } from './rsiHistory'
import { validateHistoryIdentity, validateTimestamp } from './binanceHistory'

export const SR_DAILY_HISTORY_LIMIT = 180
export const SR_DAY_MS = 86_400_000
const CLOCK_CACHE_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

export interface SrContextHistory {
  /** Closed daily candles. Missing sessions remain gaps rather than synthetic bars. */
  candles: readonly Candle[]
  preview: Candle | null
  /** Exchange clock, or a later candle boundary proved by the daily stream. */
  asOf: number
}

export class SrContextRequestError extends Error {
  readonly status: number
  readonly retryAfterMs: number | null

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message)
    this.name = 'SrContextRequestError'
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

function requestError(response: Response, purpose: string, now: number): SrContextRequestError {
  const header = response.headers.get('Retry-After')
  let retryAfterMs: number | null = null
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now
    if (Number.isFinite(delay)) retryAfterMs = Math.max(1000, delay)
  }
  if (retryAfterMs === null && (response.status === 429 || response.status === 418)) retryAfterMs = 60_000
  return new SrContextRequestError(`Binance ${purpose} unavailable (HTTP ${response.status})`, response.status, retryAfterMs)
}

/** Validate UTC daily identity while retaining real holes in a market's history. */
export function parseSrDailyHistory(raw: unknown, asOf: number): SrContextHistory {
  validateTimestamp(asOf, 'Binance server time')
  if (asOf === 0) throw new Error('Invalid Binance server time')
  if (!Array.isArray(raw) || raw.length > SR_DAILY_HISTORY_LIMIT + 1) {
    throw new Error('Invalid Binance daily history response')
  }
  const rows = raw.map((row: unknown): Candle => {
    if (!Array.isArray(row) || row.length < 7
      || typeof row[0] !== 'number' || typeof row[6] !== 'number'
      || row.slice(1, 6).some((value: unknown) =>
        (typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && value.trim() === ''))) {
      throw new Error('Invalid Binance daily candle')
    }
    const candle: Candle = {
      openTime: row[0], closeTime: row[6], open: Number(row[1]),
      high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
    }
    if (!isValidCandle(candle) || candle.openTime % SR_DAY_MS !== 0
      || candle.closeTime - candle.openTime + 1 !== SR_DAY_MS) {
      throw new Error('Invalid Binance daily candle or interval')
    }
    return candle
  })
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].openTime <= rows[index - 1].closeTime) {
      throw new Error('Unordered or overlapping Binance daily candles')
    }
  }
  // A response can arrive after midnight. Keep the cutoff read before the
  // request; buffered stream events will advance history across that boundary.
  const observed = rows.filter((candle) => candle.openTime <= asOf)
  const candles = observed.filter((candle) => candle.closeTime < asOf).slice(-SR_DAILY_HISTORY_LIMIT)
  const preview = observed.find((candle) => candle.closeTime >= asOf) ?? null
  return { candles, preview, asOf }
}

/** One clock request serves each seeding wave, including markets closed for a weekend. */
export function createSrContextRestClient(
  market: ScreenerMarket,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
): { fetchSeed: (symbol: string) => Promise<SrContextHistory>; invalidateClock: () => void } {
  let clock: { requestedAt: number; expiresAt: number; promise: Promise<number> } | null = null

  async function readJson(path: string, purpose: string): Promise<unknown> {
    signal?.throwIfAborted()
    const timeoutController = new AbortController()
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
    let rejectOnAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(requestSignal.reason)
      requestSignal.addEventListener('abort', rejectOnAbort, { once: true })
    })
    const timeout = setTimeout(() => timeoutController.abort(new DOMException(
      `Binance ${purpose} request timed out`, 'TimeoutError',
    )), requestTimeoutMs)
    try {
      // Race the whole operation, including a body stalled after HTTP headers.
      // Aborting also releases the browser's underlying network request.
      return await Promise.race([aborted, (async () => {
        const response = await fetcher(`${MARKETS[market].restBase}${path}`, { signal: requestSignal })
        if (!response.ok) throw requestError(response, purpose, now())
        return response.json()
      })()])
    } finally {
      clearTimeout(timeout)
      requestSignal.removeEventListener('abort', rejectOnAbort)
    }
  }

  function readClock(): Promise<number> {
    if (clock && now() >= clock.requestedAt && now() < clock.expiresAt) return clock.promise
    const requestedAt = now()
    const promise = (async () => {
      const raw = await readJson('/time', 'clock')
      signal?.throwIfAborted()
      if (!raw || typeof raw !== 'object' || !('serverTime' in raw) || typeof raw.serverTime !== 'number') {
        throw new Error('Invalid Binance server time')
      }
      validateTimestamp(raw.serverTime, 'Binance server time')
      if (raw.serverTime === 0) throw new Error('Invalid Binance server time')
      return raw.serverTime
    })()
    clock = { requestedAt, expiresAt: requestedAt + CLOCK_CACHE_MS, promise }
    void promise.then((serverTime) => {
      if (clock?.promise !== promise) return
      // A cached cutoff from yesterday must not hold today's completed candle
      // provisional during recovery, even while the usual 30-second TTL holds.
      const untilNextDay = (Math.floor(serverTime / SR_DAY_MS) + 1) * SR_DAY_MS - serverTime
      clock.expiresAt = requestedAt + Math.min(CLOCK_CACHE_MS, untilNextDay)
    }, () => { if (clock?.promise === promise) clock = null })
    return promise
  }

  return {
    invalidateClock: () => { clock = null },
    fetchSeed: async (symbol) => {
      validateHistoryIdentity(symbol, '1d')
      signal?.throwIfAborted()
      const asOf = await readClock()
      signal?.throwIfAborted()
      const params = new URLSearchParams({ symbol, interval: '1d', limit: String(SR_DAILY_HISTORY_LIMIT + 1) })
      const raw = await readJson(`/klines?${params}`, `daily history for ${symbol}`)
      signal?.throwIfAborted()
      return parseSrDailyHistory(raw, asOf)
    },
  }
}

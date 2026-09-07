import type { Candle, Timeframe } from '../types'
import { isValidCandle } from './rsiHistory'

const REST_BASE = 'https://api.binance.com/api/v3'
const PAGE_LIMIT = 1_000
export const MAX_HISTORY_CANDLES = 100_250

export const TIMEFRAME_MILLISECONDS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
})

export interface HistoryProgress {
  fetched: number
  requested: number
}

export interface ClosedHistoryRequest {
  symbol: string
  timeframe: Timeframe
  count: number
  /** Inclusive upper boundary for the candle CLOSE timestamp. */
  endTime?: number
  signal?: AbortSignal
  onProgress?: (progress: HistoryProgress) => void
}

export interface ClosedCandleHistory {
  symbol: string
  timeframe: Timeframe
  candles: Candle[]
  requestedCount: number
  /** Snapshot read before pagination, never the potentially skewed client clock. */
  serverTime: number
  asOf: number
  complete: boolean
  error: string | null
  warnings: string[]
}

export function validateHistoryIdentity(symbol: string, timeframe: Timeframe): void {
  if (!/^[A-Z0-9\p{Script=Han}]{2,30}$/u.test(symbol)) {
    throw new TypeError('Symbol must be an uppercase Binance pair such as BTCUSDT')
  }
  if (!Object.hasOwn(TIMEFRAME_MILLISECONDS, timeframe)) {
    throw new TypeError('Unsupported Binance timeframe')
  }
}

export function validateTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer timestamp in milliseconds`)
  }
}

function parsePage(raw: unknown, timeframe: Timeframe, cursor: number): Candle[] {
  if (!Array.isArray(raw)) throw new Error('Invalid Binance kline response')
  if (raw.length > PAGE_LIMIT) throw new Error('Oversized Binance kline response')
  const candles = raw.map((row: unknown): Candle => {
    if (!Array.isArray(row) || row.length < 7) throw new Error('Invalid Binance kline data')
    // Binance represents prices as strings and timestamps as numbers. Empty,
    // null, or boolean values must not silently coerce into market data.
    if (typeof row[0] !== 'number' || typeof row[6] !== 'number'
      || row.slice(1, 6).some((value: unknown) =>
        (typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && value.trim() === ''))) {
      throw new Error('Invalid Binance kline data')
    }
    const candle: Candle = {
      openTime: row[0], closeTime: row[6],
      open: Number(row[1]), high: Number(row[2]), low: Number(row[3]),
      close: Number(row[4]), volume: Number(row[5]),
    }
    if (!isValidCandle(candle)
      || candle.closeTime - candle.openTime + 1 !== TIMEFRAME_MILLISECONDS[timeframe]
      || candle.openTime > cursor) {
      throw new Error('Invalid Binance kline data or interval')
    }
    return candle
  })
  for (let index = 1; index < candles.length; index++) {
    if (candles[index].openTime <= candles[index - 1].closeTime) {
      throw new Error('Unordered or overlapping Binance kline data')
    }
  }
  return candles
}

/**
 * Pages backwards from a fixed exchange-clock snapshot. A candle is included
 * only if its close is strictly before that snapshot and within endTime.
 * Earlier pages retain their final candle: dropping one per page creates gaps.
 * A late page failure returns explicitly partial history; cancellation throws.
 */
export async function fetchClosedCandleHistory(
  request: ClosedHistoryRequest,
  fetcher: typeof fetch = fetch,
): Promise<ClosedCandleHistory> {
  const { symbol, timeframe, count, endTime, signal, onProgress } = request
  validateHistoryIdentity(symbol, timeframe)
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_HISTORY_CANDLES) {
    throw new RangeError(`count must be between 1 and ${MAX_HISTORY_CANDLES}`)
  }
  if (endTime !== undefined) validateTimestamp(endTime, 'endTime')
  signal?.throwIfAborted()
  const clockResponse = await fetcher(`${REST_BASE}/time`, { signal })
  if (!clockResponse.ok) throw new Error(`Binance clock request failed (HTTP ${clockResponse.status})`)
  const clockData: unknown = await clockResponse.json()
  if (!clockData || typeof clockData !== 'object' || !('serverTime' in clockData)
    || typeof clockData.serverTime !== 'number') {
    throw new Error('Invalid Binance server time')
  }
  const serverTime = clockData.serverTime
  validateTimestamp(serverTime, 'Binance server time')
  if (serverTime === 0) throw new Error('Invalid Binance server time')
  const asOf = Math.min(endTime ?? serverTime - 1, serverTime - 1)
  let cursor = asOf
  const collected: Candle[] = []
  let error: string | null = null

  while (collected.length < count && cursor >= 0) {
    signal?.throwIfAborted()
    const params = new URLSearchParams({
      symbol, interval: timeframe,
      limit: String(Math.min(PAGE_LIMIT, count - collected.length)),
      endTime: String(cursor),
    })
    let page: Candle[]
    try {
      const response = await fetcher(`${REST_BASE}/klines?${params}`, { signal })
      if (!response.ok) throw new Error(`Binance history request failed (HTTP ${response.status})`)
      page = parsePage(await response.json(), timeframe, cursor)
    } catch (cause) {
      signal?.throwIfAborted()
      if (cause instanceof Error && cause.name === 'AbortError') throw cause
      if (collected.length === 0) throw cause
      error = cause instanceof Error ? cause.message : 'Binance history request failed'
      break
    }
    signal?.throwIfAborted()
    if (page.length === 0) break
    collected.push(...page.filter((candle) => candle.closeTime <= asOf))
    onProgress?.({ fetched: collected.length, requested: count })
    cursor = page[0].openTime - 1
  }

  const candles = collected.sort((left, right) => left.openTime - right.openTime).slice(-count)
  const warnings: string[] = []
  if (error) warnings.push(`${error}; only the successfully fetched history is included.`)
  if (candles.length < count) {
    warnings.push(`Loaded ${candles.length} of ${count} requested closed candles.`)
  }
  return {
    symbol, timeframe, candles, requestedCount: count, serverTime, asOf,
    complete: candles.length === count && error === null,
    error, warnings,
  }
}

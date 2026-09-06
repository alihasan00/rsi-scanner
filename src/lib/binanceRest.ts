import type { Candle } from '../types'
import { isValidCandle } from './rsiHistory'

const REST_BASE = 'https://api.binance.com/api/v3/klines'

// Seed a modest live history; the retained log grows as candles close. Recovery
// also uses this window if the socket misses a candle during a disconnect.
const SEED_CANDLES = 350

export interface SeedResult {
  closedCandles: Candle[]
  previewCandle: Candle | null
}

export function parseSeedKlines(raw: unknown): SeedResult {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('No kline data')
  const candles: Candle[] = raw.map((k: unknown) => {
    if (!Array.isArray(k) || k.length < 7) throw new Error('Invalid kline data')
    const candle: Candle = {
      openTime: Number(k[0]),
      closeTime: Number(k[6]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }
    if (!isValidCandle(candle)) throw new Error('Invalid kline data')
    return candle
  })

  const last = candles[candles.length - 1]
  // REST does not include a final flag. A later candle proves earlier candles
  // closed; the newest remains provisional until a socket final or later bar.
  // This avoids both response-boundary races and dependence on the local clock.
  return {
    closedCandles: candles.slice(0, -1),
    previewCandle: last,
  }
}

export async function fetchSeedKlines(
  symbol: string,
  interval: string,
  signal?: AbortSignal,
): Promise<SeedResult> {
  const url = `${REST_BASE}?symbol=${symbol}&interval=${interval}&limit=${SEED_CANDLES}`
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Binance REST ${response.status} for ${symbol}`)
  }

  return parseSeedKlines(await response.json())
}

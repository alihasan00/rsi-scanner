const REST_BASE = 'https://api.binance.com/api/v3/klines'

// Enough burn-in candles for Wilder's RMA to converge well before the visible
// 80-bar tail, fetched once per symbol per timeframe change (not polled).
const SEED_CANDLES = 200

export interface SeedResult {
  closedCloses: number[]
  previewClose: number | null
  price: number
  volume: number
}

type RawKline = [number, string, string, string, string, string, number, ...unknown[]]

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

  const klines = (await response.json()) as RawKline[]
  if (klines.length === 0) {
    throw new Error(`No kline data for ${symbol}`)
  }

  const last = klines[klines.length - 1]
  const hasOpenCandle = last[6] >= Date.now()
  const closedKlines = hasOpenCandle ? klines.slice(0, -1) : klines

  return {
    closedCloses: closedKlines.map((k) => Number.parseFloat(k[4])),
    previewClose: hasOpenCandle ? Number.parseFloat(last[4]) : null,
    price: Number.parseFloat(last[4]),
    volume: Number.parseFloat(last[5]),
  }
}

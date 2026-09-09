import { SYMBOLS } from './symbols'

export type ScreenerMarket = 'spot' | 'tradfi'

export const MARKETS = {
  spot: {
    label: 'Crypto',
    venue: 'Binance Spot',
    restBase: 'https://api.binance.com/api/v3',
    streamBase: 'wss://stream.binance.com:9443/stream',
  },
  tradfi: {
    label: 'TradFi',
    venue: 'Binance Futures',
    restBase: 'https://fapi.binance.com/fapi/v1',
    streamBase: 'wss://fstream.binance.com/market/stream',
  },
} as const satisfies Record<ScreenerMarket, {
  label: string; venue: string; restBase: string; streamBase: string
}>

/** Binance spells this contract type TRADIFI, including the extra I. Crypto
 * indexes also use underlyingType INDEX, so that field cannot identify TradFi. */
export function parseTradfiSymbols(raw: unknown): readonly string[] {
  if (!raw || typeof raw !== 'object' || !('symbols' in raw) || !Array.isArray(raw.symbols)) {
    throw new Error('Invalid Binance market list')
  }
  const symbols = new Set<string>()
  for (const entry of raw.symbols) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid Binance contract metadata')
    if (entry.contractType !== 'TRADIFI_PERPETUAL' || entry.status !== 'TRADING'
      || entry.quoteAsset !== 'USDT' || entry.marginAsset !== 'USDT') continue
    if (typeof entry.symbol !== 'string' || !/^[A-Z0-9]+USDT$/.test(entry.symbol)) {
      throw new Error('Invalid Binance TradFi symbol')
    }
    symbols.add(entry.symbol)
  }
  // Exchange listing order keeps the established contracts first. There is no
  // hardcoded fallback: a failed discovery must never display crypto as TradFi.
  return [...symbols]
}

export async function fetchMarketSymbols(
  market: ScreenerMarket,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<readonly string[]> {
  signal?.throwIfAborted()
  if (market === 'spot') return SYMBOLS
  const response = await fetcher(`${MARKETS.tradfi.restBase}/exchangeInfo`, { signal })
  if (!response.ok) throw new Error(`Binance market list unavailable (HTTP ${response.status})`)
  const raw: unknown = await response.json()
  signal?.throwIfAborted()
  return parseTradfiSymbols(raw)
}

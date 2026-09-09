import { useCallback, useEffect, useState } from 'react'
import { fetchMarketSymbols } from '../lib/markets'
import type { ScreenerMarket } from '../lib/markets'
import { SYMBOLS } from '../lib/symbols'

const NO_SYMBOLS: readonly string[] = []

interface UniverseState {
  market: ScreenerMarket
  symbols: readonly string[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

export interface MarketUniverse extends UniverseState {
  retry: () => void
}

/** A new market never inherits the previous market's list while discovery runs. */
export function useMarketUniverse(market: ScreenerMarket): MarketUniverse {
  const [state, setState] = useState<UniverseState | null>(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => {
    setState(null)
    setAttempt((value) => value + 1)
  }, [])

  useEffect(() => {
    if (market === 'spot') return
    const controller = new AbortController()
    void fetchMarketSymbols(market, controller.signal).then(
      (symbols) => {
        if (!controller.signal.aborted) setState({ market, symbols, status: 'ready', error: null })
      },
      (cause: unknown) => {
        if (!controller.signal.aborted) setState({
          market, symbols: NO_SYMBOLS, status: 'error',
          error: cause instanceof Error ? cause.message : 'Binance market list unavailable',
        })
      },
    )
    return () => controller.abort()
  }, [market, attempt])

  if (market === 'spot') return { market, symbols: SYMBOLS, status: 'ready', error: null, retry }
  return state?.market === market
    ? { ...state, retry }
    : { market, symbols: NO_SYMBOLS, status: 'loading', error: null, retry }
}

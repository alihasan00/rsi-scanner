import { useEffect, useReducer } from 'react'
import type { ScreenerMarket } from '../lib/markets'
import { startSrContextFeed } from '../lib/srContextFeed'
import {
  getSrContext, publishSrContextHistory, reportSrContextError, resetSrContexts, subscribeSrContext,
} from '../store/srContextStore'
import type { SrContextSnapshot } from '../store/srContextStore'
import { useScannerStore } from '../store/scannerStore'
import { useSymbolStore } from './useSymbolStore'

const SR_CONTEXT_STORE = { get: getSrContext, subscribe: subscribeSrContext }

export function useSrContext(symbol: string, active = true): SrContextSnapshot {
  return useSymbolStore(SR_CONTEXT_STORE, symbol, active)
}

/** Daily history remains stable when the display timeframe changes. */
export function useSrContextFeed(symbols: readonly string[], market: ScreenerMarket, active = true): void {
  const [generation, restartFeed] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    const isCurrent = () => {
      const current = useScannerStore.getState()
      return current.market === market && current.screenerFilters.signal === 'sr'
    }
    if (!active || !isCurrent()) return
    resetSrContexts()
    const stop = startSrContextFeed({
      symbols, market, isCurrent,
      publishHistory: (symbol, history) => { if (isCurrent()) publishSrContextHistory(symbol, history) },
      reportError: (symbol, error) => { if (isCurrent()) reportSrContextError(symbol, error) },
    })
    let invalidated = false
    const unsubscribe = useScannerStore.subscribe(() => {
      if (!invalidated && !isCurrent()) {
        invalidated = true
        stop()
        resetSrContexts()
        restartFeed()
      }
    })
    return () => {
      unsubscribe()
      stop()
      resetSrContexts()
    }
  }, [symbols, market, active, generation])
}

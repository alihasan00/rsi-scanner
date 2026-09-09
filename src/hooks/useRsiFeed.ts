import { useEffect, useReducer } from 'react'
import type { ScreenerMarket } from '../lib/markets'
import { startRsiFeed } from '../lib/rsiFeed'
import { snapshotFromRsiHistory } from '../lib/rsiHistory'
import { resetSymbolData, setSymbolSnapshot } from '../store/dataStore'
import { resetFeedStatus, setFeedStatus } from '../store/feedStatusStore'
import { useScannerStore } from '../store/scannerStore'

export function useRsiFeed(symbols: readonly string[], market: ScreenerMarket): void {
  const timeframe = useScannerStore((state) => state.timeframe)
  const [generation, restartFeed] = useReducer((value: number) => value + 1, 0)

  useEffect(() => {
    const isCurrent = () => {
      const current = useScannerStore.getState()
      return current.market === market && current.timeframe === timeframe
    }
    if (!isCurrent()) return

    resetSymbolData()
    resetFeedStatus()
    const stopFeed = startRsiFeed({
      symbols,
      market,
      timeframe,
      isCurrent,
      publishHistory: (symbol, history) => {
        if (!isCurrent()) return
        setSymbolSnapshot(symbol, snapshotFromRsiHistory(history))
        if (isCurrent()) setFeedStatus(symbol, { state: 'ready', updatedAt: Date.now(), error: null })
      },
      reportError: (symbol, error) => {
        if (!isCurrent()) return
        console.error(`RSI seed failed for ${symbol}`, error)
        setFeedStatus(symbol, {
          state: 'error', updatedAt: null,
          error: error instanceof Error ? error.message : 'Market data unavailable',
        })
      },
    })
    // Cancel as soon as the store changes. A generation forces a restart even
    // when a batched switch away and back leaves the final effect deps equal.
    let invalidated = false
    const unsubscribe = useScannerStore.subscribe((state) => {
      if (!invalidated && (state.market !== market || state.timeframe !== timeframe)) {
        invalidated = true
        stopFeed()
        restartFeed()
      }
    })

    return () => {
      unsubscribe()
      stopFeed()
    }
  }, [symbols, market, timeframe, generation])
}

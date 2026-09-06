import { useEffect } from 'react'
import { fetchSeedKlines } from '../lib/binanceRest'
import { KlineStreamManager } from '../lib/binanceSocket'
import { advanceRsiState, seedRsiState } from '../lib/rsi'
import type { RsiState } from '../lib/rsi'
import { SYMBOLS } from '../lib/symbols'
import { resetSymbolData, setSymbolSnapshot } from '../store/dataStore'
import { useScannerStore } from '../store/scannerStore'

/**
 * Seeds RSI state from REST history, then keeps it live over combined
 * WebSocket kline streams. In-progress candles update the displayed series
 * without being committed, since Wilder's RMA only rolls forward on close.
 */
export function useRsiFeed(): void {
  const timeframe = useScannerStore((state) => state.timeframe)

  useEffect(() => {
    const controller = new AbortController()
    const committed = new Map<string, RsiState>()
    let cancelled = false

    const manager = new KlineStreamManager((tick) => {
      if (cancelled) return
      const base = committed.get(tick.symbol)
      if (!base) return
      const next = advanceRsiState(base, tick.close)
      if (tick.isFinal) committed.set(tick.symbol, next)
      setSymbolSnapshot(tick.symbol, {
        price: tick.close,
        volume: tick.volume,
        series: next.series,
      })
    })

    async function seedAndConnect(): Promise<void> {
      resetSymbolData()
      await Promise.all(
        SYMBOLS.map(async (symbol) => {
          try {
            const seed = await fetchSeedKlines(symbol, timeframe, controller.signal)
            const committedState = seedRsiState(seed.closedCloses)
            if (!committedState || cancelled) return

            committed.set(symbol, committedState)
            const displayedState = seed.previewClose === null
              ? committedState
              : advanceRsiState(committedState, seed.previewClose)
            setSymbolSnapshot(symbol, {
              price: seed.price,
              volume: seed.volume,
              series: displayedState.series,
            })
          } catch (error) {
            if (!controller.signal.aborted) console.error(`RSI seed failed for ${symbol}`, error)
          }
        }),
      )
      if (!cancelled) manager.connect(SYMBOLS, timeframe)
    }

    void seedAndConnect()

    return () => {
      cancelled = true
      controller.abort()
      manager.disconnect()
    }
  }, [timeframe])
}

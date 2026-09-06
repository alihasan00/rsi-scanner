import { useCallback, useSyncExternalStore } from 'react'
import { getSymbolSnapshot, subscribeSymbol } from '../store/dataStore'
import type { SymbolSnapshot } from '../types'

const NOOP_SUBSCRIBE = (): (() => void) => () => undefined

export function useSymbolData(symbol: string, active = true): SymbolSnapshot {
  const subscribe = useCallback(
    (callback: () => void) => active ? subscribeSymbol(symbol, callback) : NOOP_SUBSCRIBE(),
    [active, symbol],
  )
  const getSnapshot = useCallback(() => getSymbolSnapshot(symbol), [symbol])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

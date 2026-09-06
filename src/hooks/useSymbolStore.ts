import { useCallback, useSyncExternalStore } from 'react'
import type { SymbolStore } from '../store/dataStore'

const NOOP_UNSUBSCRIBE = (): void => undefined

/**
 * Subscribes one component to one symbol in a keyed external store. Inactive
 * components still read the latest value on render but receive no updates.
 */
export function useSymbolStore<T>(
  store: Pick<SymbolStore<T>, 'get' | 'subscribe'>,
  symbol: string,
  active = true,
): T {
  const subscribe = useCallback(
    (callback: () => void) => active ? store.subscribe(symbol, callback) : NOOP_UNSUBSCRIBE,
    [active, store, symbol],
  )
  const getSnapshot = useCallback(() => store.get(symbol), [store, symbol])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

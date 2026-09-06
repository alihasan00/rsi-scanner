import type { SymbolSnapshot } from '../types'

// Plain external stores keyed by symbol. Each grid cell subscribes only to its
// own symbol via useSyncExternalStore, so a tick for BTCUSDT re-renders one
// card instead of the whole ~100-cell grid.

export interface SymbolStore<T> {
  get: (symbol: string) => T
  set: (symbol: string, value: T) => void
  subscribe: (symbol: string, callback: () => void) => () => void
  /** Drops every value and notifies subscribers of the removed symbols. */
  reset: () => void
  /** Fires on any change. Market-wide views should throttle before rendering. */
  subscribeAll: (callback: () => void) => () => void
  /** Increments on every set or reset, so a version compare detects any change. */
  getVersion: () => number
}

export function createSymbolStore<T>(empty: T): SymbolStore<T> {
  const values = new Map<string, T>()
  const listeners = new Map<string, Set<() => void>>()
  const allListeners = new Set<() => void>()
  let version = 0

  function notify(symbol: string): void {
    const set = listeners.get(symbol)
    if (!set) return
    for (const callback of [...set]) callback()
  }

  function notifyAll(): void {
    for (const callback of [...allListeners]) callback()
  }

  return {
    get: (symbol) => values.get(symbol) ?? empty,
    set: (symbol, value) => {
      values.set(symbol, value)
      version += 1
      notify(symbol)
      notifyAll()
    },
    subscribe: (symbol, callback) => {
      let set = listeners.get(symbol)
      if (!set) {
        set = new Set()
        listeners.set(symbol, set)
      }
      set.add(callback)
      return () => {
        set.delete(callback)
        if (set.size === 0 && listeners.get(symbol) === set) {
          listeners.delete(symbol)
        }
      }
    },
    reset: () => {
      values.clear()
      version += 1
      for (const symbol of [...listeners.keys()]) notify(symbol)
      notifyAll()
    },
    subscribeAll: (callback) => {
      allListeners.add(callback)
      return () => { allListeners.delete(callback) }
    },
    getVersion: () => version,
  }
}

const EMPTY_SNAPSHOT: SymbolSnapshot = { price: 0, volume: 0, series: [], bars: [] }

const marketStore = createSymbolStore<SymbolSnapshot>(EMPTY_SNAPSHOT)

export const getSymbolSnapshot = marketStore.get
export const setSymbolSnapshot = marketStore.set
export const subscribeSymbol = marketStore.subscribe
export const resetSymbolData = marketStore.reset
export const subscribeAllSymbols = marketStore.subscribeAll
export const getSymbolStoreVersion = marketStore.getVersion

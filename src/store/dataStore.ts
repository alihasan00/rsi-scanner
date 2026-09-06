import type { SymbolSnapshot } from '../types'

// Plain external store keyed by symbol. Each grid cell subscribes only to its
// own symbol via useSyncExternalStore, so a tick for BTCUSDT re-renders one
// canvas instead of the whole ~100-cell grid.

const EMPTY_SNAPSHOT: SymbolSnapshot = { price: 0, volume: 0, series: [], bars: [] }

const snapshots = new Map<string, SymbolSnapshot>()
const listeners = new Map<string, Set<() => void>>()

function notifySymbol(symbol: string): void {
  const set = listeners.get(symbol)
  if (!set) return
  for (const callback of [...set]) callback()
}

export function getSymbolSnapshot(symbol: string): SymbolSnapshot {
  return snapshots.get(symbol) ?? EMPTY_SNAPSHOT
}

export function setSymbolSnapshot(symbol: string, snapshot: SymbolSnapshot): void {
  snapshots.set(symbol, snapshot)
  notifySymbol(symbol)
}

export function subscribeSymbol(symbol: string, callback: () => void): () => void {
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
}

export function resetSymbolData(): void {
  snapshots.clear()
  for (const symbol of [...listeners.keys()]) notifySymbol(symbol)
}

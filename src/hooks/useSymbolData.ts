import { getSymbolSnapshot, subscribeSymbol } from '../store/dataStore'
import type { SymbolSnapshot } from '../types'
import { useSymbolStore } from './useSymbolStore'

const MARKET_STORE = { get: getSymbolSnapshot, subscribe: subscribeSymbol }

export function useSymbolData(symbol: string, active = true): SymbolSnapshot {
  return useSymbolStore(MARKET_STORE, symbol, active)
}

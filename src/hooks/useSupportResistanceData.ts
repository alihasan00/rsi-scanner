import { getSupportResistance, subscribeSupportResistance } from '../store/supportResistanceStore'
import type { SupportResistanceSnapshot } from '../store/supportResistanceStore'
import { useSymbolStore } from './useSymbolStore'

const SUPPORT_RESISTANCE_STORE = { get: getSupportResistance, subscribe: subscribeSupportResistance }

export function useSupportResistanceData(symbol: string, active = true): SupportResistanceSnapshot {
  return useSymbolStore(SUPPORT_RESISTANCE_STORE, symbol, active)
}

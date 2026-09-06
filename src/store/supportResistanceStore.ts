import {
  buildSupportResistanceStructure,
  selectNearestLevels,
} from '../lib/supportResistance'
import type { SupportResistanceAnalysis, SupportResistanceStructure } from '../lib/supportResistance'
import type { SymbolSnapshot } from '../types'
import { createSymbolStore } from './dataStore'

export interface SupportResistanceSnapshot extends SupportResistanceAnalysis {
  price: number
  /** False until the symbol has seeded candles. */
  hasData: boolean
}

export const EMPTY_SUPPORT_RESISTANCE: SupportResistanceSnapshot = Object.freeze({
  trend: 'unknown',
  support: null,
  resistance: null,
  pendingBreaks: Object.freeze([]),
  closedBarCount: 0,
  price: 0,
  hasData: false,
})

interface CachedStructure {
  key: string
  structure: SupportResistanceStructure
}

// Derived from the market store for every symbol, not only visible cards, so a
// market-wide ranking can read levels for all pairs. The closed-bar structure
// is rebuilt only when a candle closes; live ticks just reselect the nearest
// level against the new price.
const store = createSymbolStore<SupportResistanceSnapshot>(EMPTY_SUPPORT_RESISTANCE)
const structures = new Map<string, CachedStructure>()

function structureKey(bars: SymbolSnapshot['bars']): string | null {
  let lastClosed = bars.length - 1
  while (lastClosed >= 0 && !bars[lastClosed].isClosed) lastClosed--
  if (lastClosed < 0) return null
  return `${bars[0].openTime}:${bars[lastClosed].openTime}:${lastClosed + 1}`
}

export function updateSupportResistance(symbol: string, snapshot: SymbolSnapshot): void {
  const key = structureKey(snapshot.bars)
  if (key === null) {
    structures.delete(symbol)
    store.set(symbol, EMPTY_SUPPORT_RESISTANCE)
    return
  }

  let cached = structures.get(symbol)
  if (!cached || cached.key !== key) {
    cached = { key, structure: buildSupportResistanceStructure(snapshot.bars) }
    structures.set(symbol, cached)
  }

  store.set(symbol, {
    ...selectNearestLevels(cached.structure, snapshot.price),
    price: snapshot.price,
    hasData: true,
  })
}

export function resetSupportResistance(): void {
  structures.clear()
  store.reset()
}

export const getSupportResistance = store.get
export const subscribeSupportResistance = store.subscribe
export const subscribeAllSupportResistance = store.subscribeAll
export const getSupportResistanceVersion = store.getVersion

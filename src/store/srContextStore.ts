import { buildLiquidityMap } from '../lib/liquidityLevels'
import type { LiquidityMap } from '../lib/liquidityLevels'
import { SR_DAY_MS } from '../lib/srContextRest'
import type { SrContextHistory } from '../lib/srContextRest'
import { createSymbolStore } from './dataStore'

export interface SrContextSnapshot {
  status: 'loading' | 'ready' | 'error'
  map: LiquidityMap | null
  error: string | null
  updatedAt: number | null
}

export const EMPTY_SR_CONTEXT: SrContextSnapshot = Object.freeze({
  status: 'loading', map: null, error: null, updatedAt: null,
})

const store = createSymbolStore<SrContextSnapshot>(EMPTY_SR_CONTEXT)
const histories = new Map<string, { candles: SrContextHistory['candles']; day: number; map: LiquidityMap }>()

/** Intraday price changes use the display feed; only daily changes rebuild references. */
export function publishSrContextHistory(symbol: string, history: SrContextHistory): void {
  const day = Math.floor(history.asOf / SR_DAY_MS)
  const cached = histories.get(symbol)
  const previous = store.get(symbol)
  if (cached && cached.candles === history.candles && cached.day === day && previous.status === 'ready') return
  const map = cached && cached.candles === history.candles && cached.day === day
    ? cached.map : buildLiquidityMap(history.candles, history.asOf)
  histories.set(symbol, { candles: history.candles, day, map })
  store.set(symbol, { status: 'ready', map, error: null, updatedAt: history.asOf })
}

export function reportSrContextError(symbol: string, cause: unknown): void {
  store.set(symbol, {
    ...store.get(symbol), status: 'error',
    error: cause instanceof Error ? cause.message : 'Daily market context unavailable',
  })
}

export function resetSrContexts(): void {
  histories.clear()
  store.reset()
}

export const getSrContext = store.get
export const subscribeSrContext = store.subscribe
export const getSrContextVersion = store.getVersion
export const subscribeAllSrContexts = store.subscribeAll

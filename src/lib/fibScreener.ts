import type { RsiBar } from '../types'
import { fibPrice, getFibLiveContext, isActiveFibSetup } from './fibonacci'
import type { FibAnalysis, FibSetup } from './fibonacci'
import type { FibSettings } from './fibPreferences'

import { createFibAnalysisCache } from './fibReplayCache'
export { createFibAnalysisCache } from './fibReplayCache'

const cache = createFibAnalysisCache()

/** Identity must include market, timeframe and symbol for durable lifecycle tracking. */
export function getFibAnalysis(identity: string, bars: readonly RsiBar[], settings: FibSettings): FibAnalysis {
  return cache.get(identity, bars, settings)
}

/** Explicitly forget this instrument's lifecycle checkpoints for all Fib settings. */
export function resetFibAnalysis(identity: string): void { cache.reset(identity) }

export const FIB_STATUS_LABELS: Record<FibSetup['status'], string> = {
  watching: 'Awaiting entry', entered: 'Entry reached', managing: 'Managing targets',
  runner: 'Runner', stopped: 'Stop reached', missed: 'Entry before confirmation',
  invalidated: 'Structure invalidated', superseded: 'New structure forming',
}

export type FibStage = 'any' | 'waiting' | 'near' | 'active' | 'pocket'

export interface FibRowFilters {
  fibDirection?: 'any' | 'long' | 'short'
  fibStage?: FibStage
  fibConfluence?: 'any' | 'aligned'
}

export function matchesFibFilters(analysis: FibAnalysis | undefined, price: number, filters: FibRowFilters): boolean {
  const setup = analysis?.setup
  if (!setup || !isActiveFibSetup(setup)) return false
  if (filters.fibDirection && filters.fibDirection !== 'any' && filters.fibDirection !== setup.direction) return false
  if (filters.fibConfluence === 'aligned' && analysis?.smaConfluence !== 'aligned') return false
  if (filters.fibStage === 'waiting' && setup.status !== 'watching') return false
  if (filters.fibStage === 'near') {
    if (setup.status !== 'watching' || !Number.isFinite(price) || price <= 0) return false
    // Compare prices on the chosen scale so exact 0.600/0.618 boundaries stay stable.
    const nearPrice = fibPrice(setup.start.price, setup.end.price, 0.6, setup.scale)
    const entryPrice = setup.entries[0].price
    const near = setup.direction === 'long'
      ? price <= nearPrice && price > entryPrice
      : price >= nearPrice && price < entryPrice
    if (!near) return false
  }
  if (filters.fibStage === 'active' && setup.status === 'watching') return false
  if (filters.fibStage === 'pocket' && !getFibLiveContext(setup, price)?.inGoldenPocket) return false
  return true
}

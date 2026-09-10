import type { RsiBar } from '../types'
import { analyzeFibonacci, fibPrice, getFibLiveContext, isActiveFibSetup } from './fibonacci'
import type { FibAnalysis, FibSetup } from './fibonacci'
import type { FibSettings } from './fibPreferences'

interface CachedFib {
  bars: readonly RsiBar[]
  settingsKey: string
  analysis: FibAnalysis
}
const cache = new Map<string, CachedFib>()

/** Reuse closed-candle work on live ticks; include gaps and corrections in identity. */
export function getFibAnalysis(symbol: string, bars: readonly RsiBar[], settings: FibSettings): FibAnalysis {
  let end = bars.length
  while (end > 0 && bars[end - 1].isClosed === false) end--
  const history = bars.slice(Math.max(0, end - 500), end)
  const settingsKey = JSON.stringify(settings)
  const previous = cache.get(symbol)
  if (previous?.settingsKey === settingsKey && history.length === previous.bars.length
    && history.every((bar, index) => bar === previous.bars[index])) return previous.analysis
  const analysis = analyzeFibonacci(history, settings)
  cache.set(symbol, { bars: history, settingsKey, analysis })
  return analysis
}

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

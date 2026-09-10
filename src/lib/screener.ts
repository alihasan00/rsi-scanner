import type { ChartSettings, RsiBar, SymbolSnapshot } from '../types'
import { findRsiDivergenceSetups, isLiveDivergence } from './divergenceLifecycle'
import type { DivergenceSetup } from './divergenceLifecycle'
import type { FeedStatus } from '../store/feedStatusStore'
import { getRsiState } from './rsiState'
import type { RsiStateFilter } from './rsiState'
import type { FibAnalysis } from './fibonacci'
import { getFibLiveContext, isActiveFibSetup } from './fibonacci'
import { matchesFibFilters } from './fibScreener'
import type { FibRowFilters } from './fibScreener'

export type SignalFilter = 'all' | 'divergence' | 'confirmed' | 'fib' | 'sr'
export type DivergenceRecency = 1 | 3 | 5 | 'any'
export const DEFAULT_DIVERGENCE_RECENCY: DivergenceRecency = 3
export type ScreenerSort = 'watchlist' | 'signals' | 'change' | 'rsi-low' | 'rsi-high' | 'symbol'
export type ScreenerSettings = Pick<ChartSettings, 'showHiddenDivergences' | 'requireBodyAgreement' | 'requireSameRsiCycle' | 'divergenceInvalidationAnchor'>
export interface ScreenerAnalysis { divergences: DivergenceSetup[] }
export interface ScreenerRow { symbol: string; snapshot: SymbolSnapshot; analysis: ScreenerAnalysis; feed: FeedStatus; fib?: FibAnalysis }
interface CacheEntry { closed: readonly RsiBar[]; settingsKey: string; analysis: ScreenerAnalysis }
const analysisCache = new Map<string, CacheEntry>()

/** Live ticks reuse immutable closed-bar analysis; corrected history invalidates it. */
export function getScreenerAnalysis(symbol: string, bars: readonly RsiBar[], settings: ScreenerSettings): ScreenerAnalysis {
  const closed = bars.filter((bar) => bar.isClosed)
  const settingsKey = `${settings.showHiddenDivergences}:${settings.requireBodyAgreement}:${settings.requireSameRsiCycle}:${settings.divergenceInvalidationAnchor}`
  const cached = analysisCache.get(symbol)
  if (cached && cached.settingsKey === settingsKey && cached.closed.length === closed.length
    && closed.every((bar, index) => bar === cached.closed[index])) return cached.analysis
  const analysis = {
    divergences: findRsiDivergenceSetups(bars, {
      includeHidden: settings.showHiddenDivergences,
      requireBodyAgreement: settings.requireBodyAgreement,
      requireSameRsiCycle: settings.requireSameRsiCycle,
      invalidationAnchor: settings.divergenceInvalidationAnchor,
    }).filter(isLiveDivergence),
  }
  analysisCache.set(symbol, { closed, settingsKey, analysis })
  return analysis
}
export function candleChange(snapshot: SymbolSnapshot): number | null {
  const candle = snapshot.bars.at(-1)
  return candle && candle.open > 0 ? (candle.close - candle.open) / candle.open * 100 : null
}
export function hasConfirmedSignal(analysis: ScreenerAnalysis): boolean {
  return analysis.divergences.some((signal) => signal.state === 'confirmed')
}
/** Recency starts at price confirmation, never at either historical pivot. */
export function filterDivergenceSetups(
  signals: readonly DivergenceSetup[],
  recency: DivergenceRecency,
): DivergenceSetup[] {
  return signals.filter((signal) => isLiveDivergence(signal)
    && (signal.state === 'forming' || recency === 'any' || signal.barsElapsed < recency))
}
export interface ScreenerFilters extends FibRowFilters {
  search: string; signal: SignalFilter
  starredOnly: boolean; starredSymbols: readonly string[]; sort: ScreenerSort
  divergenceRecency?: DivergenceRecency
  rsiState?: RsiStateFilter
}
/** Fib and RSI share search/favorites, with indicator-specific signal ranking. */
export function filterScreenerRows(rows: readonly ScreenerRow[], filters: ScreenerFilters): ScreenerRow[] {
  const query = filters.search.trim().toUpperCase().replace(/[\s/-]/g, '')
  const recency = filters.signal === 'all' ? 'any' : filters.divergenceRecency ?? DEFAULT_DIVERGENCE_RECENCY
  const selectedDivergences = (analysis: ScreenerAnalysis) => {
    const signals = filterDivergenceSetups(analysis.divergences, recency)
    return filters.signal === 'confirmed' ? signals.filter((signal) => signal.state === 'confirmed') : signals
  }
  const filtered = rows.filter((row) => {
    const { symbol, snapshot, analysis } = row
    if (query && !symbol.includes(query)) return false
    if (filters.starredOnly && !filters.starredSymbols.includes(symbol)) return false
    if (filters.rsiState && filters.rsiState !== 'all') {
      const state = getRsiState(snapshot.bars.at(-1)?.rsi)
      if (filters.rsiState === 'either') {
        if (state !== 'overbought' && state !== 'oversold') return false
      } else if (state !== filters.rsiState) return false
    }
    // The liquidity tab applies its own calendar-level filters to these rows.
    if (filters.signal === 'all' || filters.signal === 'sr') return true
    if (!snapshot.bars.length) return false
    if (filters.signal === 'fib') return matchesFibFilters(row.fib, snapshot.price, filters)
    return selectedDivergences(analysis).length > 0
  })
  const score = (row: ScreenerRow) => {
    if (filters.signal === 'fib') {
      const setup = row.fib?.setup
      if (!setup || !isActiveFibSetup(setup)) return 0
      return (getFibLiveContext(setup, row.snapshot.price)?.inGoldenPocket ? 4 : 0)
        + (setup.status === 'watching' ? 1 : 2)
    }
    const divergences = selectedDivergences(row.analysis)
    const rsiConfirmed = divergences.some((setup) => setup.state === 'confirmed')
    return (rsiConfirmed ? 4 : 0) + (divergences.length ? 2 : 0)
  }
  const rsi = (row: ScreenerRow) => row.snapshot.series.at(-1)
  return filtered.sort((a, b) => {
    if (filters.sort === 'watchlist') return 0
    if (filters.sort === 'symbol') return a.symbol.localeCompare(b.symbol)
    if (!a.snapshot.bars.length || !b.snapshot.bars.length) return Number(!!b.snapshot.bars.length) - Number(!!a.snapshot.bars.length)
    if (filters.sort === 'signals') return score(b) - score(a)
    if (filters.sort === 'change') return (candleChange(b.snapshot) ?? -Infinity) - (candleChange(a.snapshot) ?? -Infinity)
    if (filters.sort === 'rsi-low') return (rsi(a) ?? Infinity) - (rsi(b) ?? Infinity)
    return (rsi(b) ?? -Infinity) - (rsi(a) ?? -Infinity)
  })
}

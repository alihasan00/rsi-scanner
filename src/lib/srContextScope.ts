import type { AppView, ScreenerFilterPreferences } from './screenerPreferences'

export type SrContextScope = 'liquidity' | 'watchlist' | 'selected'

/** A saved indicator filter must not control feeds belonging to another view. */
export function isSrContextScopeCurrent(
  state: { appView: AppView; screenerFilters: Pick<ScreenerFilterPreferences, 'signal'>; selectedSymbol: string | null },
  scope: SrContextScope,
  symbols: readonly string[],
): boolean {
  const fullScope = state.appView === 'watchlist' ? 'watchlist'
    : state.appView === 'scanner' && state.screenerFilters.signal === 'sr' ? 'liquidity' : null
  if (scope !== 'selected') return fullScope === scope
  return fullScope === null && symbols.length === 1 && state.selectedSymbol === symbols[0]
}

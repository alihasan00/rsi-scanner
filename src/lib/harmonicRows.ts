import type { HarmonicAnalysis, HarmonicSetup } from './harmonics'
import { getHarmonicAnalysis } from './harmonicScreener'
import { getHarmonicLiveContext } from './harmonics'
import type { ScreenerRow } from './screener'
import type { ScreenerFilterPreferences } from './screenerPreferences'

export const HARMONIC_NAMES = { gartley: 'Gartley', bat: 'Bat', butterfly: 'Butterfly' } as const
export const HARMONIC_STAGES = { forming: 'Early setup', approaching: 'Approaching D', zone: 'D zone reached' } as const
export const HARMONIC_COLORS = { gartley: '#e9a454', bat: '#63c69b', butterfly: '#65c8dc' } as const
export interface HarmonicRow { row: ScreenerRow; analysis: HarmonicAnalysis; setup: HarmonicSetup }

/** Apply pattern filters before choosing a pair's newest matching geometry. */
export function selectHarmonicSetup(analysis: HarmonicAnalysis, filters: Pick<ScreenerFilterPreferences,
  'harmonicPattern' | 'harmonicDirection' | 'harmonicStage'>): HarmonicSetup | undefined {
  return analysis.setups.filter((setup) => setup.status === 'active'
    && (filters.harmonicPattern === 'all' || setup.kind === filters.harmonicPattern)
    && (filters.harmonicDirection === 'any' || setup.direction === filters.harmonicDirection)
    && (filters.harmonicStage === 'all' || setup.stage === filters.harmonicStage))
    .sort((a, b) => b.confirmedAt - a.confirmedAt)[0]
}

export function makeHarmonicRows(rows: readonly ScreenerRow[], filters: ScreenerFilterPreferences, starredSymbols: readonly string[]): HarmonicRow[] {
  const query = filters.search.trim().toUpperCase().replace(/[\s/-]/g, '')
  const matches: HarmonicRow[] = []
  for (const row of rows) {
    if (query && !row.symbol.includes(query)) continue
    if (filters.starredOnly && !starredSymbols.includes(row.symbol)) continue
    const analysis = getHarmonicAnalysis(row.symbol, row.snapshot.bars)
    const setup = selectHarmonicSetup(analysis, filters)
    if (setup) matches.push({ row, analysis, setup })
  }
  return matches.sort((a, b) => {
    if (filters.harmonicSort === 'symbol') return a.row.symbol.localeCompare(b.row.symbol)
    if (filters.harmonicSort === 'nearest') return getHarmonicLiveContext(a.setup, a.row.snapshot.price).distancePercent
      - getHarmonicLiveContext(b.setup, b.row.snapshot.price).distancePercent
    return 0
  })
}

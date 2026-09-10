import type { ScreenerRow } from './screener'
import type { ScreenerFilterPreferences } from './screenerPreferences'
import { advanceLiquidityMap, analyzeLiquidity, visibleLiquidityLevels } from './liquidityLevels'
import type { LiquidityContext, LiquidityLevel, LiquidityMap } from './liquidityLevels'
import type { SrContextSnapshot } from '../store/srContextStore'
import type { Timeframe } from '../types'

export const NEAR_LIQUIDITY_PERCENT = 0.5
export const LIQUIDITY_SOURCE_LABELS = { month: 'Previous month', week: 'Previous week', monday: 'Monday body' } as const

export interface LiquidityRow {
  row: ScreenerRow
  history: SrContextSnapshot
  map: LiquidityMap | null
  levels: readonly LiquidityLevel[]
  context: LiquidityContext
}

export function makeLiquidityRow(
  row: ScreenerRow,
  history: SrContextSnapshot,
  source: ScreenerFilterPreferences['srSource'],
  timeframe: Timeframe,
): LiquidityRow {
  const map = history.map ? advanceLiquidityMap({
    ...history.map,
    levels: history.map.levels.filter((level) => source === 'all' || level.source === source),
  }, row.snapshot.bars, timeframe) : null
  return {
    row, history, map,
    levels: map ? visibleLiquidityLevels(map, timeframe) : [],
    context: map ? analyzeLiquidity(map, row.snapshot.bars, row.snapshot.price, timeframe)
      : { support: null, resistance: null, atPrice: [], events: [] },
  }
}

export function levelDistancePercent(level: LiquidityLevel, price: number): number {
  return Number.isFinite(price) && price > 0 ? Math.abs(level.price - price) / price * 100 : Infinity
}

export function nearestLiquidityDistance(row: LiquidityRow): number {
  const { support, resistance, atPrice } = row.context
  return Math.min(...[support, resistance, ...atPrice]
    .filter((level): level is LiquidityLevel => level !== null)
    .map((level) => levelDistancePercent(level, row.row.snapshot.price)))
}

/** Live price controls proximity; only finalized candles qualify as sweeps. */
export function filterLiquidityRows(
  rows: readonly LiquidityRow[],
  filters: Pick<ScreenerFilterPreferences, 'search' | 'starredOnly' | 'srSource' | 'srSignal' | 'srSort'>,
  starredSymbols: readonly string[],
): LiquidityRow[] {
  const query = filters.search.trim().toUpperCase().replace(/[\s/-]/g, '')
  const confirmed = (row: LiquidityRow) => row.history.status === 'ready' && row.row.feed.state === 'ready'
    ? row.context.events.filter((event) => event.state === 'confirmed') : []
  return rows.filter((row) => {
    if (query && !row.row.symbol.includes(query)) return false
    if (filters.starredOnly && !starredSymbols.includes(row.row.symbol)) return false
    if (filters.srSource !== 'all' && row.history.status === 'ready' && row.levels.length === 0) return false
    if (filters.srSignal === 'all') return true
    if (row.history.status !== 'ready' || row.row.feed.state !== 'ready') return false
    if (filters.srSignal === 'near') return nearestLiquidityDistance(row) <= NEAR_LIQUIDITY_PERCENT
    return confirmed(row).some((event) => filters.srSignal === 'sfp' || event.direction === filters.srSignal)
  }).sort((a, b) => {
    if (filters.srSort === 'watchlist') return 0
    if (filters.srSort === 'symbol') return a.row.symbol.localeCompare(b.row.symbol)
    if (filters.srSort === 'signals') {
      const score = (row: LiquidityRow) => Math.max(0, ...confirmed(row).map((event) => 3 - event.barsAgo))
      const difference = score(b) - score(a)
      if (difference) return difference
    }
    const aDistance = nearestLiquidityDistance(a)
    const bDistance = nearestLiquidityDistance(b)
    return aDistance === bDistance ? a.row.symbol.localeCompare(b.row.symbol) : aDistance - bDistance
  })
}

/** Keep the overview to immediate neighbors plus any level being touched. */
export function nearbyLiquidityLevels(context: LiquidityContext): LiquidityLevel[] {
  return [context.support, context.resistance, ...context.atPrice]
    .filter((level): level is LiquidityLevel => level !== null)
}

export function liquidityEventLabel(context: LiquidityContext): { text: string; tone: string } {
  const confirmed = context.events.filter((event) => event.state === 'confirmed')
  const bullish = confirmed.some((event) => event.direction === 'bullish')
  const bearish = confirmed.some((event) => event.direction === 'bearish')
  if (bullish && bearish) return { text: 'Recent sweeps both ways', tone: 'mixed' }
  if (bullish || bearish) return { text: `Recent ${bullish ? 'bullish' : 'bearish'} sweep`, tone: bullish ? 'bullish' : 'bearish' }
  if (context.events.some((event) => event.state === 'forming')) return { text: 'Sweep forming · wait for close', tone: 'forming' }
  return { text: 'Watching nearby levels', tone: 'quiet' }
}

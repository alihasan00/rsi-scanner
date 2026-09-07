import type { ChartSettings, RsiBar, SymbolSnapshot } from '../types'
import { findRsiDivergenceSetups, isLiveDivergence } from './divergenceLifecycle'
import type { DivergenceSetup } from './divergenceLifecycle'
import { analyzeTugOfWar, TUG_OF_WAR_SETTINGS } from './tugOfWar'
import type { TugOfWarAnalysis, TugOfWarPreview } from './tugOfWar'
import type { FeedStatus } from '../store/feedStatusStore'

export type SignalFilter = 'all' | 'divergence' | 'tug-of-war' | 'confirmed'
export type DirectionFilter = 'all' | 'bullish' | 'bearish'
export type ScreenerSort = 'watchlist' | 'signals' | 'change' | 'rsi-low' | 'rsi-high' | 'symbol'
export type ScreenerSettings = Pick<ChartSettings, 'showHiddenDivergences' | 'requireBodyAgreement' | 'requireSameRsiCycle' | 'divergenceInvalidationAnchor'>
export interface ScreenerAnalysis { divergences: DivergenceSetup[]; tugOfWar: TugOfWarAnalysis }
export interface ScreenerRow { symbol: string; snapshot: SymbolSnapshot; analysis: ScreenerAnalysis; feed: FeedStatus; preview?: TugOfWarPreview | null }
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
    tugOfWar: analyzeTugOfWar(bars),
  }
  analysisCache.set(symbol, { closed, settingsKey, analysis })
  return analysis
}
export function candleChange(snapshot: SymbolSnapshot): number | null {
  const candle = snapshot.bars.at(-1)
  return candle && candle.open > 0 ? (candle.close - candle.open) / candle.open * 100 : null
}
export function hasConfirmedSignal(analysis: ScreenerAnalysis): boolean {
  return analysis.divergences.some((signal) => signal.state === 'confirmed') || analysis.tugOfWar.confirmation !== null
}
export function isPendingTugOfWar(tow: Pick<TugOfWarAnalysis, 'isWarmup' | 'pendingTowCandles'>): boolean {
  return !tow.isWarmup && tow.pendingTowCandles > 0
}
/** Live setups project the current candle; closed confirmations remain separate. */
export function isTugOfWarSetup(row: ScreenerRow): boolean {
  return row.preview
    ? isPendingTugOfWar(row.preview) || row.preview.possibleResolution !== null
    : isPendingTugOfWar(row.analysis.tugOfWar) || row.analysis.tugOfWar.confirmation !== null
}
export interface ScreenerFilters {
  search: string; signal: SignalFilter; direction: DirectionFilter
  starredOnly: boolean; starredSymbols: readonly string[]; sort: ScreenerSort
}
/** Direction applies to the selected indicator, so unrelated signals cannot satisfy a filter. */
export function filterScreenerRows(rows: readonly ScreenerRow[], filters: ScreenerFilters): ScreenerRow[] {
  const query = filters.search.trim().toUpperCase().replace(/[\s/-]/g, '')
  const filtered = rows.filter((row) => {
    const { symbol, snapshot, analysis, preview } = row
    if (query && !symbol.includes(query)) return false
    if (filters.starredOnly && !filters.starredSymbols.includes(symbol)) return false
    if (filters.signal === 'all' && filters.direction === 'all') return true
    if (!snapshot.bars.length) return false
    const divergences = analysis.divergences.filter((signal) => filters.signal !== 'confirmed' || signal.state === 'confirmed')
    const tow = analysis.tugOfWar
    const latestHa = tow.heikinAshi.at(-1)
    const weakBody = !!latestHa && latestHa.body < TUG_OF_WAR_SETTINGS.minBodyRatio * (latestHa.high - latestHa.low)
    const effectiveTow = preview ?? tow
    const towDirection = preview
      ? preview.isWarmup || preview.pendingTowCandles > 0 || !preview.isBodyQualified ? null
        : preview.control === 'bullish' || preview.control === 'bearish' ? preview.control : null
      : tow.isWarmup || tow.pendingTowCandles > 0 || weakBody ? null
        : tow.confirmation?.direction ?? (tow.control === tow.trend ? tow.trend : null)
    const divergenceMatch = divergences.some((signal) => filters.direction === 'all' || signal.kind.endsWith(filters.direction))
    const towMatch = !effectiveTow.isWarmup && (filters.direction === 'all' || towDirection === filters.direction)
    if (filters.signal === 'divergence') return divergenceMatch
    if (filters.signal === 'tug-of-war') {
      return isTugOfWarSetup(row) && (filters.direction === 'all' || towDirection === filters.direction)
    }
    if (filters.signal === 'confirmed') return divergenceMatch || (tow.confirmation !== null
      && (filters.direction === 'all' || tow.confirmation.direction === filters.direction))
    return divergenceMatch || towMatch
  })
  const score = (row: ScreenerRow) => {
    const rsiConfirmed = row.analysis.divergences.some((setup) => setup.state === 'confirmed')
    const towResolution = row.preview ? row.preview.possibleResolution !== null : row.analysis.tugOfWar.confirmation !== null
    return (rsiConfirmed || towResolution ? 4 : 0)
      + (row.analysis.divergences.length ? 2 : 0) + (isTugOfWarSetup(row) ? 1 : 0)
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

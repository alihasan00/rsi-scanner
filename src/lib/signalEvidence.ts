import type { RsiBar, Timeframe } from '../types'
import type { ScreenerMarket } from './markets'
import { TIMEFRAME_MILLISECONDS } from './binanceHistory'
import { findRsiDivergenceSetups, isLiveDivergence } from './divergenceLifecycle'
import type { DivergenceLifecycleOptions } from './divergenceLifecycle'
import { findRsiTrendlines } from './rsiTrendlines'
import { analyzeFibonacci, isActiveFibSetup } from './fibonacci'
import type { FibAnalysis, FibOptions } from './fibonacci'
import { analyzeHarmonics } from './harmonics'
import type { HarmonicAnalysis } from './harmonics'
import { advanceLiquidityMap, analyzeLiquidity } from './liquidityLevels'
import type { LiquidityMap } from './liquidityLevels'
import { analyzeMarketStructure } from './marketStructure'
import { getClosedPriceSuffix } from './volatility'
import type { HigherTimeframeSnapshot } from './higherTimeframe'

export type EvidenceFamily = 'momentum' | 'location' | 'liquidity' | 'structure' | 'higher-timeframe'
export interface SignalEvidence {
  id: string
  family: EvidenceFamily
  source: string
  direction: 'bullish' | 'bearish'
  role: 'trigger' | 'context'
  availableAt: number
  ageBars: number
  detail: string
  provenance: string[]
}

export interface EvidenceSummary {
  items: SignalEvidence[]
  bullishFamilies: EvidenceFamily[]
  bearishFamilies: EvidenceFamily[]
  conflict: boolean
}

/** Counts distinct evidence families, never independent votes or win probabilities. */
export function summarizeEvidence(items: readonly SignalEvidence[], asOf: number): EvidenceSummary {
  const eligible = items.filter((item) => item.availableAt <= asOf && item.availableAt >= 0)
  const families = (direction: SignalEvidence['direction']) => [...new Set(eligible.filter((item) => item.direction === direction).map((item) => item.family))]
  const bullishFamilies = families('bullish')
  const bearishFamilies = families('bearish')
  return { items: eligible, bullishFamilies, bearishFamilies, conflict: bullishFamilies.length > 0 && bearishFamilies.length > 0 }
}

export interface EvidenceRequest {
  symbol: string
  market: ScreenerMarket
  timeframe: Timeframe
  bars: readonly RsiBar[]
  asOf?: number
  divergenceOptions?: Partial<DivergenceLifecycleOptions>
  fibOptions?: Partial<FibOptions>
  /** May carry an older active plan from the durable cache; timestamp must match. */
  fibSnapshot?: FibAnalysis
  /** Durable harmonic state is eligible only at the same closed-candle time. */
  harmonicSnapshot?: HarmonicAnalysis
  calendarMap?: LiquidityMap | null
  higherTimeframe?: HigherTimeframeSnapshot | null
}

/** Every detector replays only the prefix observable at asOf, including HTF candles. */
export function analyzeSignalEvidence(request: EvidenceRequest) {
  const prefix = request.bars.filter((bar) => bar.closeTime <= (request.asOf ?? Infinity))
  const closed = getClosedPriceSuffix(prefix)
  const latest = closed.at(-1)
  const asOf = latest?.closeTime ?? 0
  const duration = TIMEFRAME_MILLISECONDS[request.timeframe]
  const items: SignalEvidence[] = []
  const missing: string[] = []
  const add = (item: Omit<SignalEvidence, 'ageBars' | 'provenance'> & { provenance?: string[] }) => {
    items.push({ ...item, ageBars: Math.max(0, Math.floor((asOf - item.availableAt) / duration)), provenance: item.provenance ?? [item.source] })
  }

  const divergences = findRsiDivergenceSetups(closed, request.divergenceOptions).filter(isLiveDivergence)
  for (const setup of divergences) add({
    id: setup.id, family: 'momentum', source: 'RSI divergence', direction: setup.kind.includes('bullish') ? 'bullish' : 'bearish',
    role: setup.state === 'confirmed' ? 'trigger' : 'context', availableAt: setup.confirmedAt ?? setup.detectedAt,
    detail: `${setup.kind.replaceAll('-', ' ')} · ${setup.state}${setup.state === 'forming' ? '; awaiting price confirmation' : ''}`,
  })
  if (!divergences.length) missing.push('No live RSI divergence')
  const trendlines = findRsiTrendlines(closed).filter((line) => line.state === 'broken' && line.brokenAt !== null && (line.barsSinceBreak ?? Infinity) <= 3)
  for (const line of trendlines) add({ id: line.id, family: 'momentum', source: 'RSI trendline', direction: line.kind === 'resistance' ? 'bullish' : 'bearish', role: 'trigger', availableAt: line.brokenAt!, detail: `${line.kind} break · ${line.breakGrade ?? 'ungraded'}` })
  if (!trendlines.length) missing.push('No RSI trendline break in the latest 4 closes')

  const fib = request.fibSnapshot?.lastClosedAt === asOf ? request.fibSnapshot : analyzeFibonacci(closed, request.fibOptions)
  const plan = fib.setup
  if (plan && isActiveFibSetup(plan) && latest) {
    const inPocket = latest.close >= plan.goldenPocket.low && latest.close <= plan.goldenPocket.high
    add({ id: plan.id, family: 'location', source: 'Fib plan', direction: plan.direction === 'long' ? 'bullish' : 'bearish', role: 'context', availableAt: plan.detectedAt, detail: `${plan.status}${inPocket ? ' · close inside golden pocket' : ' · close outside golden pocket'}; SMA200 ${fib.smaConfluence ?? 'unavailable'}` })
  } else missing.push('No active Fib plan')
  const harmonicAnalysis = request.harmonicSnapshot?.lastClosedAt === asOf ? request.harmonicSnapshot : analyzeHarmonics(closed)
  const harmonics = harmonicAnalysis.setups.filter((setup) => setup.status === 'active' && setup.confirmedAt <= asOf)
  for (const setup of harmonics) {
    const pivotConfirmed = setup.confirmedD && setup.dConfirmedAt != null && setup.dConfirmedAt <= asOf
    add({ id: setup.id, family: 'location', source: 'Harmonic', direction: setup.direction, role: 'context',
      availableAt: pivotConfirmed ? setup.dConfirmedAt! : setup.confirmedAt,
      detail: `${setup.kind} · ${latest && latest.close >= setup.zone.low && latest.close <= setup.zone.high ? 'close inside D zone' : 'close outside D zone'}; ${pivotConfirmed ? 'D pivot confirmed; reversal outcome unknown' : 'reversal unconfirmed'}` })
  }
  if (!harmonics.length) missing.push('No active harmonic pattern')

  if (request.calendarMap && latest) {
    // The supplied map may have been fetched after this replay close. Keep the
    // level publication guards, but never let that future clock expire a level
    // which was still available at the displayed close.
    const map = advanceLiquidityMap({ ...request.calendarMap, asOf: asOf + 1, levels: request.calendarMap.levels.filter((level) => level.availableFrom <= asOf) }, closed, request.timeframe)
    const reactions = analyzeLiquidity(map, closed, latest.close, request.timeframe).events.filter((event) => event.state === 'confirmed')
    const groups = new Map<string, typeof reactions>()
    for (const event of reactions) {
      const key = `${event.direction}:${event.closeTime}:${event.level.price}`
      groups.set(key, [...(groups.get(key) ?? []), event])
    }
    for (const [id, events] of groups) {
      const event = events[0]
      add({ id, family: 'liquidity', source: 'Calendar sweep', direction: event.direction, role: 'trigger', availableAt: event.closeTime, detail: `${events.map((entry) => entry.level.label).join(' / ')} · breached and closed back inside`, provenance: events.map((entry) => entry.level.id) })
    }
    if (!groups.size) missing.push('No recent confirmed calendar sweep')
  } else missing.push('Daily calendar context unavailable')

  const structure = analyzeMarketStructure(closed)
  for (const level of structure.levels.filter((level) => level.reclaimedAt !== null && asOf - level.reclaimedAt <= duration * 3 && level.supersededBy === null)) {
    add({ id: `${level.id}:reclaim`, family: 'liquidity', source: 'Swing sweep', direction: level.side === 'low' ? 'bullish' : 'bearish', role: 'trigger', availableAt: level.reclaimedAt!, detail: `${level.kind === 'equal' ? 'Equal' : 'Swing'} ${level.side} · breached and reclaimed` })
  }
  for (const event of structure.events.filter((event) => event.ageBars <= 3)) add({ id: event.id, family: 'structure', source: 'Price break', direction: event.direction, role: 'trigger', availableAt: event.confirmedAt, detail: event.type === 'choch' ? 'Change of character against previous structure direction' : 'Break of structure' })
  for (const retest of structure.retests.filter((retest) => retest.state === 'confirmed' && asOf - retest.confirmedAt! <= duration * 3)) add({ id: retest.id, family: 'structure', source: 'Retest', direction: retest.direction, role: 'trigger', availableAt: retest.confirmedAt!, detail: 'Break → retest → continuation confirmed' })
  if (!items.some((item) => item.family === 'structure')) missing.push('No recent structure break or retest continuation')

  const htf = request.higherTimeframe
  const validHtf = htf && htf.market === request.market && htf.symbol === request.symbol && TIMEFRAME_MILLISECONDS[htf.timeframe] > duration
  const htfClosed = validHtf ? getClosedPriceSuffix(htf.bars.filter((bar) => bar.closeTime <= asOf)
    .map((bar) => Number.isFinite(bar.rsi) && bar.rsi >= 0 && bar.rsi <= 100
      && bar.closeTime - bar.openTime + 1 === TIMEFRAME_MILLISECONDS[htf.timeframe]
      ? bar : { ...bar, high: NaN })) : []
  const htfLast = htfClosed.at(-1)
  if (htfLast && htf && asOf - htfLast.closeTime <= TIMEFRAME_MILLISECONDS[htf.timeframe] + 60_000) {
    if (htfLast.rsi !== 50) add({ id: 'htf-rsi', family: 'higher-timeframe', source: `${htf.timeframe} RSI regime`, direction: htfLast.rsi > 50 ? 'bullish' : 'bearish', role: 'context', availableAt: htfLast.closeTime, detail: `RSI(14) ${htfLast.rsi.toFixed(2)} · completed ${htf.timeframe} candle; trend context, not a reversal trigger` })
    else missing.push(`${htf.timeframe} RSI is neutral at 50`)
    for (const setup of findRsiDivergenceSetups(htfClosed, request.divergenceOptions).filter(isLiveDivergence)) add({ id: `htf:${setup.id}`, family: 'higher-timeframe', source: `${htf.timeframe} divergence`, direction: setup.kind.includes('bullish') ? 'bullish' : 'bearish', role: setup.state === 'confirmed' ? 'trigger' : 'context', availableAt: setup.confirmedAt ?? setup.detectedAt, detail: `${setup.kind.replaceAll('-', ' ')} · ${setup.state}` })
  } else missing.push('Completed higher-timeframe context unavailable at this close')

  return { ...summarizeEvidence(items, asOf), asOf: latest ? asOf : null, missing, structure }
}

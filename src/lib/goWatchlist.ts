import type { ScreenerMarket } from './markets'
import type { Timeframe } from '../types'
import { TIMEFRAME_MILLISECONDS } from './binanceHistory'
import type { WatchlistRow, WatchlistStatus } from './watchlist'
import { getWatchlistDisplayStatus } from './watchlistInstruments'
import type { WatchlistInstrument, WatchlistInstrumentFilters } from './watchlistInstruments'
import { getEvaluatedChartFrames } from './watchlistChart'
import type { WatchlistChartEvent, WatchlistChartSnapshot, WatchlistEvaluationInput } from './watchlistChart'
import type { IchimokuLectureSnapshot, IchimokuPoint } from './watchlistIchimoku'
import { getGoWatchlistExpectedClose, getGoWatchlistTimeframes } from './goWatchlistTimeframes'
import type { GoWatchlistScope } from './goWatchlistTimeframes'

export type { GoWatchlistScope } from './goWatchlistTimeframes'
const ICHIMOKU_FAMILIES = new Set(['kijun_reclaim', 'cloud_reclaim', 'tk_cross', 'pk_cross', 'cloud_edge_to_edge'])
const PAPER_PROFILES = new Map<string, {name: string; timeframe: Timeframe}>([
  ['donchian55_atr_trail', {name: '55-bar trend breakout', timeframe: '1d'}],
  ['donchian55_atr_trail_stoch', {name: '55-bar breakout · Stochastic', timeframe: '1d'}],
  ['donchian55_atr_trail_macd', {name: '55-bar breakout · MACD', timeframe: '1d'}],
  ['donchian55_atr_trail_adx_range', {name: '55-bar breakout · low ADX', timeframe: '1d'}],
  ['cloud_reclaim_volume_2r', {name: 'Cloud reclaim · volume + 2R cap', timeframe: '1d'}],
  ['cloud_reclaim_volume_2r_ema', {name: 'Cloud reclaim · volume + EMA + 2R cap', timeframe: '1d'}],
  ['cloud_reclaim_volume_2r_sma', {name: 'Cloud reclaim · volume + SMA + 2R cap', timeframe: '1d'}],
  ['cloud_reclaim_volume_2r_supertrend', {name: 'Cloud reclaim · volume + Supertrend + 2R cap', timeframe: '1d'}],
  ['cloud_reclaim_volume_2r_ao', {name: 'Cloud reclaim · volume + AO + 2R cap', timeframe: '1d'}],
  ['cloud_reclaim_volume_2r_sma_ema_macd', {name: 'Cloud reclaim · volume + SMA/EMA/MACD + 2R cap', timeframe: '1d'}],
  ['fresh_weekly_range_long', {name: 'Fresh weekly-level rebound', timeframe: '4h'}],
  ['tk_cross_rsi', {name: 'Tenkan / Kijun cross · RSI', timeframe: '1d'}],
])
export function isIchimokuSetup(row: WatchlistRow): boolean {
  return row.source === 'strategy' && ICHIMOKU_FAMILIES.has(row.reference?.strategyFamily ?? '')
}
function isPaperProfile(row: WatchlistRow): boolean {
  return row.source === 'strategy' && PAPER_PROFILES.get(row.reference?.strategyFamily ?? '')?.timeframe === row.timeframe
}
export interface GoPlan {
  status: string; entry: number | null; stop: number | null; target: number | null
  grossRR: number | null; netRR: number | null; feeBps: number; slippageBps: number; minNetRR: number
  trigger: string; invalidation: string; management: string; expiresAt: number | null; reasons: string[]
}
export interface GoSeries {
  symbol: string; interval: Timeframe; price: number; observedAt: number; lastClosedAt: number
  closedCandles: number; ready: boolean; trend: string; momentum: string; internalBias: string; warnings: string[]
  ichimoku?: IchimokuLectureSnapshot | null; ichimokuSeries?: IchimokuPoint[] | null
}
export interface GoHarmonicPoint { index: number; time: number; price: number }
export interface GoCandidate {
  setup: {
    symbol: string; interval: Timeframe; price: number; lastClosedAt: number
    pattern: {
      id: string; kind: string; direction: 'bullish' | 'bearish'; entry: number; zone: {low: number; high: number}; stage: string
      x?: GoHarmonicPoint; a?: GoHarmonicPoint; b?: GoHarmonicPoint; c?: GoHarmonicPoint; d?: GoHarmonicPoint | null
      detectedAt?: number; confirmedAt?: number; entryTouchedAt?: number; levelsEstablishedAt?: number
      score?: number; ratios?: Record<string, number>; target1?: number; target2?: number; referenceD?: number; levelsBasedOn?: string
    }
    decision: {
      confirmation: { interval?: Timeframe; status?: string; afterSetup?: boolean; event: { confirmedAt: number; type?: string; level?: number; pivotOccurredAt?: number; pivotConfirmedAt?: number } | null }
      reasons?: {code: string; kind: string; interval?: Timeframe; detail: string}[]
    }
  }
  plan: GoPlan; mode: string; confirmation: boolean; entryDistanceATR: number; reason: string; next: string; caution: string
}
export interface GoTrend {
  symbol: string; interval: Timeframe; direction: 'bullish' | 'bearish'; status: string; price: number
  pullbackLevel: number; distanceATR: number; breakConfirmedAt: number; triggerClosedAt: number | null
  breakType?: string; retestClosedAt?: number | null; retestHigh?: number | null; retestLow?: number | null; triggerPrice?: number | null
  plan: GoPlan; reason: string; next: string; caution: string
}
export interface GoStrategy {
  opportunity: {
    id: string; family: string; symbol: string; interval: Timeframe; direction: 'bullish' | 'bearish'; state: string
    asOf: number; availableAt: number; triggerAt: number | null; level: number; zoneLow: number | null; zoneHigh: number | null
    entryReference: number | null; referenceAtr: number | null; next: string; caution: string
    sourceStartAt?: number; sourceEndAt?: number; locationAvailableAt?: number; retestAt?: number | null
    reason?: string; invalidation?: string; entryMin?: number | null; entryMax?: number | null
  }
  plan: GoPlan; price: number; status: string; eligible: boolean; reason: string
}
export interface GoWatchlistResult {
  version: string; maxAgeMs: number; now?: number; error?: string; scope?: GoWatchlistScope; timeframe?: Timeframe
  result: {
    config: { feeBps: number; slippageBps: number; minNetRR: number }
    items: GoCandidate[]; trends: GoTrend[]; strategies: { items: GoStrategy[] }
    examined: number; eligible: number; directionFiltered: number; costFiltered: number
  }
  scan: { series: GoSeries[]; errors: {symbol: string; interval: string; error: string}[]; progress: {done: number; total: number} }
}
const humanize = (value: string) => value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()).replace(/\b(tk|pk)\b/gi, (word) => word.toUpperCase())
const finite = (value: number | null): value is number => value !== null && Number.isFinite(value)
const activePlan = new Set(['ready_for_review', 'awaiting_trigger', 'awaiting_retest', 'confirmation_expired', 'observing', 'waiting_for_retest', 'awaiting_confirmation', 'entry_confirmed'])
const timestamp = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
type ChartGeometry = Pick<WatchlistChartSnapshot, 'points' | 'events' | 'evidence' | 'notes' | 'sourceWindow'>

function chartEvent(kind: WatchlistChartEvent['kind'], label: string, timeframe: Timeframe, time: number | null | undefined, price: number | null | undefined,
  range?: {low?: number | null; high?: number | null}): WatchlistChartEvent[] {
  if (!timestamp(time)) return []
  return [{kind, label, timeframe, time, price: typeof price === 'number' && Number.isFinite(price) ? price : null,
    ...(typeof range?.low === 'number' && Number.isFinite(range.low) ? {low: range.low} : {}),
    ...(typeof range?.high === 'number' && Number.isFinite(range.high) ? {high: range.high} : {})}]
}

/** Presentation only: the Go engine owns detection and every eligibility decision. */
export function adaptGoWatchlist(output: GoWatchlistResult, market: ScreenerMarket, input?: WatchlistEvaluationInput): WatchlistRow[] {
  if (output.error) throw new Error(output.error)
  if (!output.version || output.maxAgeMs !== 120_000 || !Array.isArray(output.scan?.series)
    || !Array.isArray(output.result?.items) || !Array.isArray(output.result?.trends)
    || !Array.isArray(output.result?.strategies?.items)) throw new Error('Unsupported watchlist engine response')
  const scoped = output.scope === 'ichimoku'
  if (scoped && (!output.timeframe || !Object.hasOwn(TIMEFRAME_MILLISECONDS, output.timeframe))) throw new Error('Unsupported Ichimoku timeframe')
  const rows: WatchlistRow[] = []
  const evaluatedAt = input?.evaluatedAt ?? output.now ?? 0
  const matchingInput = input && (output.now === undefined || output.now === input.evaluatedAt) ? input : undefined
  const create = (data: {
    id: string; symbol: string; timeframe: Timeframe; source: WatchlistRow['source']; name: string
    direction: WatchlistRow['direction']; status: WatchlistStatus; nativeStatus: string; statusLabel: string
    price: number; zone: {low: number; high: number}; distanceAtr: number | null; entry: number | null
    confirmedAt: number | null; reason: string; next: string; caution: string; plan: GoPlan; mode: string
    chart: ChartGeometry; strategyFamily?: string; entryMin?: number | null; entryMax?: number | null
  }) => {
    if (scoped && (data.source !== 'strategy' || !ICHIMOKU_FAMILIES.has(data.strategyFamily ?? '') || data.timeframe !== output.timeframe)) return
    const relevant = scoped ? getGoWatchlistTimeframes('ichimoku', output.timeframe) : [data.timeframe]
    const frames = output.scan.series.filter((frame) => frame.symbol === data.symbol && relevant.includes(frame.interval))
    const frame = frames.find((item) => item.interval === data.timeframe)
    const requiredTimeframes = relevant
    if (!frame || requiredTimeframes.some((tf) => frames.filter((item) => item.interval === tf).length !== 1 || !frames.find((item) => item.interval === tf)?.ready)) return
    const readyFrames = frames.filter((item) => item.ready)
    const referenceDistance = finite(data.entry) && data.entry > 0 ? Math.abs(data.price - data.entry) / data.price * 100 : null
    const confirmationExpired = data.plan.status === 'confirmation_expired'
    const status = confirmationExpired ? 'waiting' : activePlan.has(data.plan.status) ? data.status : 'blocked'
    const next = confirmationExpired
      ? 'The confirmation window has expired. Wait for a fresh completed-candle trigger, then reassess the reference plan.'
      : !scoped && status === 'blocked'
        ? data.plan.status === 'expired'
          ? 'The paper entry window has ended. Wait for a new completed source signal before considering another plan.'
          : 'This paper plan is blocked at the saved evaluation. Reassess it after a new completed source candle; no opening entry is indicated.'
        : data.next
    const cautions = [data.caution, ...data.plan.reasons, data.plan.invalidation, data.plan.management,
      ...(market === 'tradfi' ? ['These are USDT perpetual contracts. The stated cost allowance is a screening assumption; funding, spread, depth and actual fees are not verified.'] : [])].filter(Boolean)
    const chartFrames = getEvaluatedChartFrames(matchingInput, data.symbol, frames)
    const notes = [...data.chart.notes]
    if (!chartFrames.some((item) => item.timeframe === data.timeframe)) notes.push('The evaluated candles for this setup are unavailable.')
    const chart: WatchlistChartSnapshot = Object.freeze({
      snapshotId: input?.snapshotId ?? `${output.version}:${output.now ?? 'unavailable'}`,
      evaluatedAt, defaultTimeframe: data.timeframe, frames: chartFrames,
      points: Object.freeze(data.chart.points.filter((point) => !evaluatedAt || point.time <= evaluatedAt).map((point) => Object.freeze({...point}))),
      events: Object.freeze(data.chart.events.filter((event) => !evaluatedAt || event.time <= evaluatedAt).map((event) => Object.freeze({...event}))),
      ...(data.chart.sourceWindow ? {sourceWindow: Object.freeze({...data.chart.sourceWindow})} : {}),
      evidence: Object.freeze([
        ...data.chart.evidence,
        ...(data.plan.trigger ? [{label: 'Entry condition', detail: data.plan.trigger}] : []),
        ...(data.plan.invalidation ? [{label: 'Invalidation', detail: data.plan.invalidation}] : []),
      ].map((item) => Object.freeze({...item}))),
      notes: Object.freeze(notes),
    })
    rows.push({
      id: `${market}:${data.timeframe}:${data.symbol}:${data.source}:${data.id}`, symbol: data.symbol, market, timeframe: data.timeframe,
      source: data.source, name: data.name, direction: data.direction, status, price: data.price, zone: data.zone,
      stop: data.plan.stop, target: data.plan.target, riskReward: data.plan.grossRR,
      distancePercent: referenceDistance, distanceAtr: data.distanceAtr, confirmedAt: data.confirmedAt,
      asOf: frame.lastClosedAt, updatedAt: frame.observedAt,
      reason: data.reason,
      next,
      cautions: [...new Set(cautions)], evidence: [], families: [], conflict: false,
      reference: {
        engineVersion: output.version, maxAgeMs: output.maxAgeMs, nativeStatus: data.nativeStatus,
        scope: scoped ? 'ichimoku' : 'all', requiredTimeframes,
        ...(data.strategyFamily ? {strategyFamily: data.strategyFamily} : {}),
        statusLabel: confirmationExpired ? 'Confirmation expired' : status === 'blocked' ? humanize(data.plan.status) : data.statusLabel,
        mode: data.mode, planStatus: data.plan.status, netRiskReward: data.plan.netRR,
        feeBps: data.plan.feeBps, slippageBps: data.plan.slippageBps, minNetRR: data.plan.minNetRR,
        entry: data.entry, planEntry: data.plan.entry, entryMin: data.entryMin ?? null, entryMax: data.entryMax ?? null,
        chart, expiresAt: data.plan.expiresAt,
        distanceLabel: finite(data.distanceAtr) ? `${data.distanceAtr.toFixed(2)} ATR from ${scoped ? 'entry' : 'signal reference'}`
          : scoped ? 'Entry distance unavailable' : 'Signal distance unavailable',
        frames: readyFrames.map((item) => ({timeframe: item.interval, trend: item.trend, structure: item.internalBias, asOf: item.lastClosedAt})),
      },
    })
  }
  for (const candidate of output.result.strategies.items) {
    const opportunity = candidate.opportunity
    const profile = scoped ? undefined : PAPER_PROFILES.get(opportunity.family)
    if (!scoped && (!profile || profile.timeframe !== opportunity.interval || opportunity.state !== 'entry_confirmed')) continue
    const entry = opportunity.entryReference ?? opportunity.level
    const confirmed = candidate.eligible && candidate.plan.status === 'ready_for_review'
    create({
      id: opportunity.id, symbol: opportunity.symbol, timeframe: opportunity.interval, source: 'strategy',
      strategyFamily: opportunity.family,
      entryMin: opportunity.entryMin, entryMax: opportunity.entryMax,
      name: `${profile?.name ?? humanize(opportunity.family)} · ${opportunity.interval}`, direction: opportunity.direction,
      status: confirmed ? 'confirmed' : scoped && opportunity.state === 'awaiting_confirmation' ? 'testing' : scoped ? 'waiting' : 'blocked',
      nativeStatus: candidate.status, statusLabel: scoped
        ? candidate.eligible ? 'Entry confirmed' : humanize(candidate.status)
        : confirmed ? 'Signal confirmed' : humanize(candidate.status),
      price: candidate.price, zone: {low: opportunity.zoneLow ?? opportunity.level, high: opportunity.zoneHigh ?? opportunity.level}, entry,
      distanceAtr: finite(opportunity.referenceAtr) && opportunity.referenceAtr > 0 ? Math.abs(candidate.price - entry) / opportunity.referenceAtr : null,
      confirmedAt: opportunity.triggerAt, reason: candidate.reason, next: opportunity.next,
      caution: opportunity.caution, plan: candidate.plan, mode: scoped ? 'Independent method · experimental' : 'Paper research profile',
      chart: {points: [], events: [
        ...chartEvent('source', 'Location available', opportunity.interval, opportunity.locationAvailableAt, opportunity.level),
        ...chartEvent('detected', 'Setup detected', opportunity.interval, opportunity.availableAt, opportunity.level),
        ...chartEvent('retest', 'Closed retest', opportunity.interval, opportunity.retestAt, null),
        ...chartEvent('trigger', scoped ? 'Entry confirmed' : 'Paper signal confirmed', opportunity.interval, opportunity.triggerAt, opportunity.entryReference),
      ], ...(timestamp(opportunity.sourceStartAt) && timestamp(opportunity.sourceEndAt) ? {sourceWindow: {
        timeframe: opportunity.interval, startTime: opportunity.sourceStartAt, endTime: opportunity.sourceEndAt,
      }} : {}), evidence: [{label: scoped ? 'Method evidence' : 'Profile evidence', detail: opportunity.reason ?? candidate.reason, timeframe: opportunity.interval}],
      notes: [scoped ? 'The chart shows the method’s frozen source window, location and events.'
        : 'The chart shows the source signal and original references. The source paper account uses the next whole observed one-minute opening; this scan has no intervening minute path, fill or managed exit.',
        ...(timestamp(opportunity.retestAt) ? ['The retest candle is recorded; its exact retest price was not supplied.'] : [])]},
    })
  }
  return rows
}

/** Keep Go's selected profile order, grouping every selected variant by asset. */
export function selectGoWatchlist(rows: readonly WatchlistRow[], now: number, filters: WatchlistInstrumentFilters & {stage?: 'all' | 'confirmed' | 'developing'; scope?: GoWatchlistScope; timeframe?: Timeframe} = {}): WatchlistInstrument[] {
  const query = (filters.search ?? '').toUpperCase().replace(/[\s/_-]/g, '')
  const groups = new Map<string, WatchlistRow[]>()
  // Apply scope before grouping so unrelated detector inventory cannot leak
  // into detail tabs, opposing-direction counts or portable reviews.
  const ordered = filters.scope === 'ichimoku'
    ? rows.filter((row) => isIchimokuSetup(row) && (!filters.timeframe || row.timeframe === filters.timeframe))
    : rows.filter(isPaperProfile)
  for (const row of ordered) {
    if (query && !row.symbol.toUpperCase().includes(query) || filters.starredOnly && !filters.starredSymbols?.has(row.symbol)) continue
    const id = `${row.market}:${row.symbol}`
    const status = getWatchlistDisplayStatus(row, now)
    const group = groups.get(id) ?? []
    if (!group.some((item) => item.id === row.id)) group.push(status === row.status ? row : {...row, status})
    groups.set(id, group)
  }
  const instruments: WatchlistInstrument[] = []
  for (const [id, all] of groups) {
    const allSetups = all
    const setups = allSetups.filter((row) => (!filters.direction || filters.direction === 'all' || row.direction === filters.direction)
      && (!filters.source || filters.source === 'all' || row.source === filters.source)
      && (!filters.status || filters.status === 'all' || row.status === filters.status)
      && (!filters.stage || filters.stage === 'all' || (filters.stage === 'confirmed' ? row.status === 'confirmed' : row.status !== 'confirmed')))
    const lead = setups[0]
    if (!lead) continue
    instruments.push({id, symbol: lead.symbol, market: lead.market, timeframe: lead.timeframe, lead, status: lead.status,
      allSetups, setups, direction: new Set(setups.map((row) => row.direction)).size > 1 ? 'mixed' : lead.direction,
      hasMixedDirections: new Set(all.map((row) => row.direction)).size > 1, sources: [...new Set(setups.map((row) => row.source))]})
  }
  const ranks = new Map(ordered.map((row, index) => [row.id, index]))
  instruments.sort((a, b) => ranks.get(a.lead.id)! - ranks.get(b.lead.id)!)
  return instruments
}

/** Withhold an old evaluation at a close/expiry boundary; only Go can readmit it. */
export function isGoWatchlistRowCurrent(row: WatchlistRow, now: number): boolean {
  const reference = row.reference
  if (!reference || getWatchlistDisplayStatus(row, now) === 'delayed') return false
  if (reference.planStatus === 'ready_for_review' && reference.expiresAt !== null && now >= reference.expiresAt) return false
  const required = reference.requiredTimeframes ?? [row.timeframe]
  if (!required.length || required.some((tf) => reference.frames.filter((frame) => frame.timeframe === tf).length !== 1)) return false
  return required.every((timeframe) => {
    const frame = reference.frames.find((item) => item.timeframe === timeframe)
    const expectedClose = getGoWatchlistExpectedClose(now, timeframe, frame?.asOf ?? 0)
    return frame && Number.isSafeInteger(frame.asOf) && frame.asOf <= now && frame.asOf >= expectedClose
  })
}

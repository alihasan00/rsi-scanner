import type { ScreenerMarket } from './markets'
import type { Timeframe } from '../types'
import { TIMEFRAME_MILLISECONDS } from './binanceHistory'
import type { WatchlistRow, WatchlistStatus } from './watchlist'
import { getWatchlistDisplayStatus } from './watchlistInstruments'
import type { WatchlistInstrument, WatchlistInstrumentFilters } from './watchlistInstruments'
import { getEvaluatedChartFrames } from './watchlistChart'
import type { WatchlistChartEvent, WatchlistChartEvidence, WatchlistChartPoint, WatchlistChartSnapshot, WatchlistEvaluationInput } from './watchlistChart'

export const GO_SHORTLIST_LIMIT = 12
export interface GoPlan {
  status: string; entry: number | null; stop: number | null; target: number | null
  grossRR: number | null; netRR: number | null; feeBps: number; slippageBps: number; minNetRR: number
  trigger: string; invalidation: string; management: string; expiresAt: number | null; reasons: string[]
}
export interface GoSeries {
  symbol: string; interval: Timeframe; price: number; observedAt: number; lastClosedAt: number
  closedCandles: number; ready: boolean; trend: string; momentum: string; internalBias: string; warnings: string[]
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
  version: string; maxAgeMs: number; now?: number; error?: string
  result: {
    config: { feeBps: number; slippageBps: number; minNetRR: number }
    items: GoCandidate[]; trends: GoTrend[]; strategies: { items: GoStrategy[] }
    examined: number; eligible: number; directionFiltered: number; costFiltered: number
  }
  scan: { series: GoSeries[]; errors: {symbol: string; interval: string; error: string}[]; progress: {done: number; total: number} }
}
const humanize = (value: string) => value.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase())
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

/** Presentation only: the frozen Go engine owns detection and every eligibility decision. */
export function adaptGoWatchlist(output: GoWatchlistResult, market: ScreenerMarket, input?: WatchlistEvaluationInput): WatchlistRow[] {
  if (output.error) throw new Error(output.error)
  if (!output.version || output.maxAgeMs !== 120_000 || !Array.isArray(output.scan?.series)
    || !Array.isArray(output.result?.items) || !Array.isArray(output.result?.trends)
    || !Array.isArray(output.result?.strategies?.items)) throw new Error('Unsupported watchlist engine response')
  const rows: WatchlistRow[] = []
  const evaluatedAt = input?.evaluatedAt ?? output.now ?? 0
  const matchingInput = input && (output.now === undefined || output.now === input.evaluatedAt) ? input : undefined
  const create = (data: {
    id: string; symbol: string; timeframe: Timeframe; source: WatchlistRow['source']; name: string
    direction: WatchlistRow['direction']; status: WatchlistStatus; nativeStatus: string; statusLabel: string
    price: number; zone: {low: number; high: number}; distanceAtr: number | null; entry: number | null
    confirmedAt: number | null; reason: string; next: string; caution: string; plan: GoPlan; mode: string
    chart: ChartGeometry
  }) => {
    const frames = output.scan.series.filter((frame) => frame.symbol === data.symbol)
    const frame = frames.find((item) => item.interval === data.timeframe)
    if (frames.length !== 4 || frames.some((item) => !item.ready) || !frame) return
    const referenceDistance = finite(data.entry) && data.entry > 0 ? Math.abs(data.price - data.entry) / data.price * 100 : null
    const confirmationExpired = data.plan.status === 'confirmation_expired'
    const status = confirmationExpired ? 'waiting' : activePlan.has(data.plan.status) ? data.status : 'blocked'
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
      asOf: frame.lastClosedAt, updatedAt: Math.min(...frames.map((item) => item.observedAt)),
      reason: data.reason,
      next: confirmationExpired ? 'The confirmation window has expired. Wait for a fresh completed-candle trigger, then reassess the reference plan.' : data.next,
      cautions: [...new Set(cautions)], evidence: [], families: [], conflict: false,
      reference: {
        engineVersion: output.version, maxAgeMs: output.maxAgeMs, nativeStatus: data.nativeStatus,
        statusLabel: confirmationExpired ? 'Confirmation expired' : status === 'blocked' ? humanize(data.plan.status) : data.statusLabel,
        mode: data.mode, planStatus: data.plan.status, netRiskReward: data.plan.netRR,
        feeBps: data.plan.feeBps, slippageBps: data.plan.slippageBps, minNetRR: data.plan.minNetRR,
        entry: data.entry, planEntry: data.plan.entry, chart, expiresAt: data.plan.expiresAt,
        distanceLabel: finite(data.distanceAtr) ? `${data.distanceAtr.toFixed(2)} ATR from ${data.source === 'trend' ? 'pullback' : 'entry'}` : 'Entry distance unavailable',
        frames: frames.map((item) => ({timeframe: item.interval, trend: item.trend, structure: item.internalBias, asOf: item.lastClosedAt})),
      },
    })
  }
  for (const candidate of output.result.items) {
    const { setup, plan } = candidate
    const pattern = setup.pattern
    const confirmation = setup.decision.confirmation
    const points: WatchlistChartPoint[] = (['x', 'a', 'b', 'c', 'd'] as const).flatMap((label) => {
      const point = pattern[label]
      return point && timestamp(point.time) && Number.isFinite(point.price)
        ? [{label: label.toUpperCase(), timeframe: setup.interval, time: point.time, price: point.price}] : []
    })
    const evidence: WatchlistChartEvidence[] = (setup.decision.reasons ?? []).map((item) => ({label: humanize(item.code), detail: item.detail, ...(item.interval ? {timeframe: item.interval} : {})}))
    if (typeof pattern.score === 'number') evidence.unshift({label: 'Geometry score', detail: `${pattern.score.toFixed(1)} / 100 · pattern fit, not a win probability.`})
    if (pattern.levelsBasedOn) evidence.push({label: 'Pattern references', detail: humanize(pattern.levelsBasedOn), ...(timestamp(pattern.levelsEstablishedAt) ? {time: pattern.levelsEstablishedAt} : {})})
    if (pattern.target1 !== undefined && plan.target !== null && pattern.target1 !== plan.target) evidence.push({label: 'Effective first target', detail: `The selected plan uses ${plan.target}; the original pattern target is ${pattern.target1}. The chart shows the selected plan's target.`})
    const confirmed = plan.status === 'ready_for_review'
    create({
      id: setup.pattern.id, symbol: setup.symbol, timeframe: setup.interval, source: 'harmonic',
      name: `${humanize(setup.pattern.kind)} · ${setup.interval}`, direction: setup.pattern.direction,
      status: confirmed ? 'confirmed' : 'approaching', nativeStatus: plan.status,
      statusLabel: confirmed ? 'D + 15m confirmed' : setup.pattern.stage === 'confirmed' ? 'Awaiting 15m trigger' : 'Awaiting D confirmation',
      price: plan.entry ?? setup.price, zone: setup.pattern.zone, entry: setup.pattern.entry,
      distanceAtr: candidate.entryDistanceATR, confirmedAt: confirmed ? setup.decision.confirmation.event?.confirmedAt ?? null : null,
      reason: candidate.reason, next: candidate.next, caution: candidate.caution, plan, mode: humanize(candidate.mode),
      chart: {points, events: [
        ...chartEvent('detected', 'Setup detected', setup.interval, pattern.detectedAt, null),
        ...chartEvent('entry-touch', 'Entry reference touched', setup.interval, pattern.entryTouchedAt, pattern.entry),
        ...(pattern.d ? chartEvent('confirmation', 'D pivot confirmed', setup.interval, pattern.confirmedAt, pattern.d.price) : []),
        ...chartEvent('trigger', `${confirmation.event?.type ?? 'Structure'} confirmation`, confirmation.interval ?? '15m', confirmation.event?.confirmedAt, confirmation.event?.level),
      ], evidence, notes: pattern.d === null ? ['D is still projected. The chart shows confirmed pivots and the reversal zone.'] : []},
    })
  }
  for (const trend of output.result.trends) {
    create({
      id: String(trend.breakConfirmedAt), symbol: trend.symbol, timeframe: trend.interval, source: 'trend',
      name: `Trend pullback · ${trend.interval}`, direction: trend.direction,
      status: trend.plan.status === 'ready_for_review' ? 'confirmed' : trend.status === 'retest_seen' ? 'testing' : trend.status === 'near_retest' ? 'approaching' : 'waiting',
      nativeStatus: trend.status, statusLabel: humanize(trend.status), price: trend.price,
      zone: {low: trend.pullbackLevel, high: trend.pullbackLevel}, entry: trend.pullbackLevel,
      distanceAtr: trend.distanceATR, confirmedAt: trend.triggerClosedAt, reason: trend.reason,
      next: trend.next, caution: trend.caution, plan: trend.plan, mode: '1d context · 4h / 1h trend thesis',
      chart: {points: [], events: [
        ...chartEvent('break', `${trend.breakType ?? 'Structure'} break`, '1h', trend.breakConfirmedAt, trend.pullbackLevel),
        ...chartEvent('retest', 'Closed retest', '15m', trend.retestClosedAt, trend.pullbackLevel, {low: trend.retestLow, high: trend.retestHigh}),
        ...chartEvent('trigger', 'Entry follow-through', '15m', trend.triggerClosedAt, trend.triggerPrice),
      ], evidence: [{label: 'Trend thesis', detail: trend.reason, timeframe: trend.interval}], notes: []},
    })
  }
  for (const candidate of output.result.strategies.items) {
    const opportunity = candidate.opportunity
    const entry = opportunity.entryReference ?? opportunity.level
    create({
      id: opportunity.id, symbol: opportunity.symbol, timeframe: opportunity.interval, source: 'strategy',
      name: `${humanize(opportunity.family)} · ${opportunity.interval}`, direction: opportunity.direction,
      status: candidate.eligible && candidate.plan.status === 'ready_for_review' ? 'confirmed' : opportunity.state === 'awaiting_confirmation' ? 'testing' : 'waiting',
      nativeStatus: candidate.status, statusLabel: candidate.eligible ? 'Entry confirmed' : humanize(candidate.status),
      price: candidate.price, zone: {low: opportunity.zoneLow ?? opportunity.level, high: opportunity.zoneHigh ?? opportunity.level}, entry,
      distanceAtr: finite(opportunity.referenceAtr) && opportunity.referenceAtr > 0 ? Math.abs(candidate.price - entry) / opportunity.referenceAtr : null,
      confirmedAt: opportunity.triggerAt, reason: candidate.reason, next: opportunity.next,
      caution: opportunity.caution, plan: candidate.plan, mode: 'Independent method · experimental',
      chart: {points: [], events: [
        ...chartEvent('source', 'Location available', opportunity.interval, opportunity.locationAvailableAt, opportunity.level),
        ...chartEvent('detected', 'Setup detected', opportunity.interval, opportunity.availableAt, opportunity.level),
        ...chartEvent('retest', 'Closed retest', opportunity.interval, opportunity.retestAt, null),
        ...chartEvent('trigger', 'Entry follow-through', opportunity.interval, opportunity.triggerAt, opportunity.entryReference),
      ], ...(timestamp(opportunity.sourceStartAt) && timestamp(opportunity.sourceEndAt) ? {sourceWindow: {
        timeframe: opportunity.interval, startTime: opportunity.sourceStartAt, endTime: opportunity.sourceEndAt,
      }} : {}), evidence: [{label: 'Method evidence', detail: opportunity.reason ?? candidate.reason, timeframe: opportunity.interval}],
      notes: ['The chart shows the method’s frozen source window, location and events.',
        ...(timestamp(opportunity.retestAt) ? ['The retest candle is recorded; its exact retest price was not supplied.'] : [])]},
    })
  }
  return rows
}

/** One asset across methods AND timeframes. The cap never admits a rejected detector row. */
export function selectGoWatchlist(rows: readonly WatchlistRow[], now: number, filters: WatchlistInstrumentFilters & {stage?: 'all' | 'confirmed' | 'developing'} = {}): WatchlistInstrument[] {
  const query = (filters.search ?? '').toUpperCase().replace(/[\s/_-]/g, '')
  const groups = new Map<string, WatchlistRow[]>()
  // Each source arrives ranked by Go. Interleave the three source lists without
  // re-ranking their candidates by a different browser-side scoring system.
  const sources = ['harmonic', 'trend', 'strategy'] as const
  const lanes = sources.map((source) => rows.filter((row) => row.source === source))
  const ordered: WatchlistRow[] = []
  for (let index = 0; lanes.some((lane) => index < lane.length); index++) {
    for (const lane of lanes) if (lane[index]) ordered.push(lane[index])
  }
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
  return instruments.sort((a, b) => ranks.get(a.lead.id)! - ranks.get(b.lead.id)!).slice(0, GO_SHORTLIST_LIMIT)
}

/** Withhold an old evaluation at a close/expiry boundary; only Go can readmit it. */
export function isGoWatchlistRowCurrent(row: WatchlistRow, now: number): boolean {
  const reference = row.reference
  if (!reference || getWatchlistDisplayStatus(row, now) === 'delayed') return false
  if (reference.planStatus === 'ready_for_review' && reference.expiresAt !== null && now >= reference.expiresAt) return false
  if (reference.frames.length !== 4 || new Set(reference.frames.map((frame) => frame.timeframe)).size !== 4) return false
  return ['15m', '1h', '4h', '1d'].every((timeframe) => {
    const frame = reference.frames.find((item) => item.timeframe === timeframe)
    const duration = TIMEFRAME_MILLISECONDS[timeframe as Timeframe]
    const expectedClose = Math.floor((now - 5_000) / duration) * duration - 1
    return frame && Number.isSafeInteger(frame.asOf) && frame.asOf <= now && frame.asOf >= expectedClose
  })
}

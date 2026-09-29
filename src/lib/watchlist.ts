import type { RsiBar, SymbolSnapshot, Timeframe } from '../types'
import type { FeedStatus } from '../store/feedStatusStore'
import { TIMEFRAME_MILLISECONDS } from './binanceHistory'
import type { FibAnalysis } from './fibonacci'
import { getHarmonicTargets } from './harmonics'
import type { HarmonicAnalysis } from './harmonics'
import type { ScreenerMarket } from './markets'
import { analyzeMarketStructure } from './marketStructure'
import type { EvidenceFamily, SignalEvidence, analyzeSignalEvidence } from './signalEvidence'
import { getClosedPriceSuffix, isValidPriceBar } from './volatility'
import type { WatchlistChartSnapshot } from './watchlistChart'

export type { WatchlistChartSnapshot, WatchlistChartFrame, WatchlistChartPoint, WatchlistChartEvent, WatchlistChartEvidence } from './watchlistChart'

export type WatchlistStatus = 'confirmed' | 'testing' | 'approaching' | 'waiting' | 'extended' | 'conflict' | 'blocked' | 'delayed'
export type WatchlistSource = 'fib' | 'harmonic' | 'retest' | 'trend' | 'strategy'
export type WatchlistAnalysis = ReturnType<typeof analyzeSignalEvidence>

export interface WatchlistRow {
  id: string
  symbol: string
  market: ScreenerMarket
  timeframe: Timeframe
  source: WatchlistSource
  name: string
  direction: 'bullish' | 'bearish'
  status: WatchlistStatus
  price: number | null
  zone: { low: number; high: number }
  stop: number | null
  target: number | null
  riskReward: number | null
  distancePercent: number | null
  distanceAtr: number | null
  confirmedAt: number | null
  asOf: number | null
  updatedAt: number | null
  reason: string
  next: string
  cautions: string[]
  evidence: SignalEvidence[]
  families: EvidenceFamily[]
  conflict: boolean
  reference?: {
    engineVersion: string
    scope?: 'all' | 'ichimoku'
    /** Source frames required to keep this specific selected setup current. */
    requiredTimeframes?: readonly Timeframe[]
    /** Exact Go strategy family, independent of the presentation label. */
    strategyFamily?: string
    maxAgeMs: number
    nativeStatus: string
    statusLabel: string
    mode: string
    planStatus: string
    netRiskReward: number | null
    feeBps: number
    slippageBps: number
    minNetRR: number
    entry: number | null
    /** Go plan's evaluated entry/quote, distinct from the geometric entry reference. */
    planEntry?: number | null
    /** Frozen post-slippage opening band for paper profiles with a fixed target. */
    entryMin?: number | null
    entryMax?: number | null
    chart?: WatchlistChartSnapshot
    distanceLabel: string
    expiresAt: number | null
    frames: { timeframe: string; trend: string; structure: string; asOf: number }[]
  }
}

export interface WatchlistInput {
  symbol: string
  market: ScreenerMarket
  timeframe: Timeframe
  snapshot: SymbolSnapshot
  feed: FeedStatus
  fib: FibAnalysis
  harmonic: HarmonicAnalysis
  evidence: WatchlistAnalysis
  now: number
  /** Fixed target geometry prepared once when closed analysis changes. */
  retestTargets?: Readonly<Record<string, number | null>>
}

export const WATCHLIST_STATUS_LABELS: Record<WatchlistStatus, string> = {
  confirmed: 'Trigger confirmed', testing: 'Testing zone', approaching: 'Approaching zone',
  waiting: 'Waiting', extended: 'Extended', conflict: 'Conflicting evidence',
  blocked: 'Needs review', delayed: 'Data delayed',
}
export const WATCHLIST_SOURCE_LABELS: Record<WatchlistSource, string> = {
  fib: 'Fib pocket', harmonic: 'Harmonic D zone', retest: 'Structure retest',
  trend: 'Trend pullback', strategy: 'Independent method',
}

const RECEIPT_LIMIT_MS = 60_000
const CLOCK_SKEW_MS = 5_000
const positive = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const timestamp = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const validZone = (zone: WatchlistRow['zone']) => positive(zone.low) && positive(zone.high) && zone.low <= zone.high

/** Receipt freshness and candle freshness are separate: a new tick cannot repair missing closes. */
export function getWatchlistFreshness({ snapshot, feed, timeframe, now }: Pick<WatchlistInput, 'snapshot' | 'feed' | 'timeframe' | 'now'>): 'fresh' | 'loading' | 'delayed' | 'error' {
  if (feed.state === 'error') return 'error'
  if (feed.state !== 'ready') return 'loading'
  const latest = getClosedPriceSuffix(snapshot.bars).at(-1)
  if (!latest) return 'loading'
  const duration = TIMEFRAME_MILLISECONDS[timeframe]
  if (!positive(snapshot.price) || !timestamp(now) || !timestamp(feed.updatedAt)
    || feed.updatedAt > now + CLOCK_SKEW_MS || now - feed.updatedAt > RECEIPT_LIMIT_MS
    || latest.closeTime > now + CLOCK_SKEW_MS || now - latest.closeTime > duration + CLOCK_SKEW_MS
    || latest.closeTime - latest.openTime + 1 !== duration) return 'delayed'
  return 'fresh'
}

interface Candidate {
  id: string
  source: WatchlistSource
  name: string
  direction: WatchlistRow['direction']
  zone: WatchlistRow['zone']
  stop: number | null
  target: number | null
  createdAt: number
  touchAt: number | null
  snapshotMatches: boolean
  cautions: string[]
  retestConfirmation?: number | null
  cInvalidation?: number
  consumedTarget?: boolean
}

function firstZoneTest(closed: readonly RsiBar[], zone: WatchlistRow['zone'], createdAt: number): number | null {
  return closed.find((bar) => bar.closeTime >= createdAt && bar.low <= zone.high && bar.high >= zone.low)?.closeTime ?? null
}

/** A trigger must belong to this observable price history, not just carry a small age label. */
function isRecent(item: SignalEvidence, closeIndices: ReadonlyMap<number, number>, lastIndex: number, now: number, duration: number): boolean {
  const index = closeIndices.get(item.availableAt)
  return index !== undefined && lastIndex - index <= 3
    && now >= item.availableAt - CLOCK_SKEW_MS && now - item.availableAt < duration * 4
}

/** Replay the break prefix so later equal-level changes cannot move or replace the original target. */
export function prepareWatchlistRetestTargets(bars: readonly RsiBar[], evidence: WatchlistAnalysis): Record<string, number | null> {
  const closed = getClosedPriceSuffix(bars)
  const result: Record<string, number | null> = {}
  const latest = closed.at(-1)
  if (!latest || evidence.structure.asOf !== latest.closeTime) return result
  const duration = latest.closeTime - latest.openTime + 1
  const prefixes = new Map<number, ReturnType<typeof analyzeMarketStructure>>()
  for (const retest of evidence.structure.retests) {
    if (!['awaiting-retest', 'retested', 'confirmed'].includes(retest.state) || retest.breakAt > latest.closeTime
      || (retest.state === 'confirmed' && (retest.confirmedAt === null || latest.closeTime - retest.confirmedAt > duration * 3))) continue
    result[retest.id] = null
    const breakIndex = closed.findIndex((bar) => bar.closeTime === retest.breakAt)
    if (breakIndex < 0) continue
    let structure = prefixes.get(retest.breakAt)
    if (!structure) {
      structure = analyzeMarketStructure(closed.slice(0, breakIndex + 1))
      prefixes.set(retest.breakAt, structure)
    }
    const observed = structure.retests.find((candidate) => candidate.id === retest.id && candidate.breakAt === retest.breakAt)
    if (!observed) continue
    const targets = structure.levels.filter((level) => level.side === (observed.direction === 'bullish' ? 'high' : 'low')
      && positive(level.price) && level.supersededBy === null && level.expiredAt === null && level.brokenAt === null
      && (observed.direction === 'bullish' ? level.price > observed.band.high : level.price < observed.band.low))
      .sort((a, b) => observed.direction === 'bullish' ? a.price - b.price : b.price - a.price)
    result[retest.id] = targets[0]?.price ?? null
  }
  return result
}

function relevantTrigger(item: SignalEvidence, candidate: Candidate, analysis: WatchlistAnalysis): boolean {
  if (item.role !== 'trigger' || item.direction !== candidate.direction || candidate.touchAt === null
    || item.availableAt <= candidate.touchAt || item.availableAt < candidate.createdAt) return false
  if (candidate.source === 'retest') {
    return item.source === 'Retest' && item.id === candidate.id && item.availableAt === candidate.retestConfirmation
  }
  if (item.family === 'momentum' && (item.source === 'RSI divergence' || item.source === 'RSI trendline')) return true
  if (item.source === 'Price break') {
    const event = analysis.structure.events.find((event) => event.id === item.id && event.confirmedAt === item.availableAt)
    return !!event && (candidate.direction === 'bullish' ? event.price >= candidate.zone.high : event.price <= candidate.zone.low)
  }
  if (item.source === 'Retest') {
    const retest = analysis.structure.retests.find((retest) => retest.id === item.id && retest.confirmedAt === item.availableAt)
    return !!retest && retest.state === 'confirmed' && retest.retestAt !== null && retest.retestAt >= candidate.touchAt
      && (candidate.direction === 'bullish' ? retest.levelPrice >= candidate.zone.high : retest.levelPrice <= candidate.zone.low)
  }
  if (item.source === 'Swing sweep') {
    return analysis.structure.levels.some((level) => `${level.id}:reclaim` === item.id && level.reclaimedAt === item.availableAt
      && level.price >= candidate.zone.low && level.price <= candidate.zone.high)
  }
  // Calendar sweep labels do not carry a machine-readable level reference here.
  // Keep them visible as evidence without claiming they confirmed this location.
  return false
}

function candidates(input: WatchlistInput, closed: readonly RsiBar[], asOf: number | null): Candidate[] {
  if (asOf === null) return []
  const result: Candidate[] = []
  const interruptionAt = closed.length && input.snapshot.bars.indexOf(closed[0]) > 0 ? closed[0].closeTime : 0
  const retestTargets = input.retestTargets ?? prepareWatchlistRetestTargets(input.snapshot.bars, input.evidence)
  const fib = input.fib.setup
  if (fib && (fib.status === 'watching' || fib.status === 'entered') && fib.detectedAt <= asOf && validZone(fib.goldenPocket)) {
    const touches = [firstZoneTest(closed, fib.goldenPocket, fib.detectedAt),
      ...fib.entries.filter((entry) => entry.price >= fib.goldenPocket.low && entry.price <= fib.goldenPocket.high).map((entry) => entry.touchedAt)]
      .filter((time): time is number => timestamp(time) && time >= Math.max(fib.detectedAt, interruptionAt) && time <= asOf)
    result.push({
      id: fib.id, source: 'fib', name: 'Golden-pocket retracement', direction: fib.direction === 'long' ? 'bullish' : 'bearish',
      zone: fib.goldenPocket, stop: positive(fib.currentStop) ? fib.currentStop : null,
      target: positive(fib.targets[0]?.price) ? fib.targets[0].price : null,
      createdAt: fib.detectedAt, touchAt: touches.length ? Math.min(...touches) : null,
      snapshotMatches: input.fib.lastClosedAt === asOf, consumedTarget: fib.targets[0]?.hitAt != null,
      cautions: [
        ...(input.fib.historyIssue ? ['Fib history contains an interruption; the setup uses the available contiguous history.'] : []),
        ...(input.fib.continuity?.state === 'reset' ? [input.fib.continuity.detail] : []),
        ...(input.fib.smaConfluence === 'against' ? ['The Fib direction opposes its SMA200 context.'] : []),
        ...(input.fib.smaConfluence === 'unavailable' ? ['SMA200 context is unavailable.'] : []),
      ],
    })
  }
  for (const setup of input.harmonic.setups) {
    if (setup.status !== 'active' || setup.confirmedAt > asOf || !validZone(setup.zone)) continue
    const observedTouch = setup.d ? setup.d.time + TIMEFRAME_MILLISECONDS[input.timeframe] - 1 : null
    const historyTouch = firstZoneTest(closed, setup.zone, setup.confirmedAt)
    const touchTimes = [observedTouch, historyTouch].filter((time): time is number => timestamp(time) && time >= Math.max(setup.confirmedAt, interruptionAt) && time <= asOf)
    result.push({
      id: setup.id, source: 'harmonic', name: `${setup.kind[0].toUpperCase()}${setup.kind.slice(1)} D zone`, direction: setup.direction,
      zone: setup.zone, stop: positive(setup.stopReference) ? setup.stopReference : null,
      target: getHarmonicTargets(setup)[0]?.price ?? null, createdAt: setup.confirmedAt,
      touchAt: touchTimes.length ? Math.min(...touchTimes) : null, snapshotMatches: input.harmonic.lastClosedAt === asOf,
      ...(!setup.d ? { cInvalidation: setup.cInvalidation } : {}),
      cautions: [
        'D contact and D-pivot confirmation describe the pattern; a later price or momentum trigger is still required.',
        ...(!setup.d ? ['The target uses the projected D midpoint until a completed candle tests D.'] : []),
        ...(input.harmonic.historyIssue ? ['Harmonic history contains an interruption; the pattern uses the available contiguous history.'] : []),
        ...(input.harmonic.continuity?.state === 'reset' ? [input.harmonic.continuity.detail] : []),
      ],
    })
  }
  for (const retest of input.evidence.structure.retests) {
    if (!['awaiting-retest', 'retested', 'confirmed'].includes(retest.state) || retest.breakAt > asOf || !validZone(retest.band)) continue
    if (retest.state === 'confirmed' && (!timestamp(retest.confirmedAt) || asOf - retest.confirmedAt > TIMEFRAME_MILLISECONDS[input.timeframe] * 3)) continue
    result.push({
      id: retest.id, source: 'retest', name: 'Break → retest → continuation', direction: retest.direction,
      zone: retest.band, stop: positive(retest.invalidationPrice) ? retest.invalidationPrice : null,
      target: positive(retestTargets[retest.id]) ? retestTargets[retest.id] : null, createdAt: retest.breakAt,
      touchAt: timestamp(retest.retestAt) && retest.retestAt > retest.breakAt && retest.retestAt <= asOf ? retest.retestAt : null,
      retestConfirmation: retest.state === 'confirmed' ? retest.confirmedAt : null,
      snapshotMatches: input.evidence.structure.asOf === asOf,
      cautions: ['The target is the nearest opposing structure level observable at the break.',
        ...(input.evidence.structure.historyReset ? ['Structure history was rebuilt; continuity is limited to the available candles.'] : [])],
    })
  }
  return result
}

/** Derived observations only: live prices can block a setup but never mutate detector lifecycles. */
export function buildWatchlistRows(input: WatchlistInput): WatchlistRow[] {
  const closed = getClosedPriceSuffix(input.snapshot.bars)
  const asOf = closed.at(-1)?.closeTime ?? null
  const freshness = getWatchlistFreshness(input)
  const price = positive(input.snapshot.price) ? input.snapshot.price : null
  const closeIndices = new Map(closed.map((bar, index) => [bar.closeTime, index]))
  const duration = TIMEFRAME_MILLISECONDS[input.timeframe]
  const recent = (item: SignalEvidence) => isRecent(item, closeIndices, closed.length - 1, input.now, duration)
  const evidenceMatches = asOf !== null && input.evidence.asOf === asOf
  const available = evidenceMatches ? input.evidence.items.filter((item) => timestamp(item.availableAt) && item.availableAt <= asOf!) : []
  const atr = evidenceMatches && positive(input.evidence.structure.atr) ? input.evidence.structure.atr : null
  const lastBar = input.snapshot.bars.at(-1)
  const preview = lastBar?.isClosed === false && isValidPriceBar(lastBar) && asOf !== null
    && lastBar.openTime === asOf + 1 && lastBar.closeTime - lastBar.openTime + 1 === TIMEFRAME_MILLISECONDS[input.timeframe] ? lastBar : null
  const rows = new Map<string, WatchlistRow>()

  const nearZone = (zone: WatchlistRow['zone']) => {
    if (price === null || !validZone(zone)) return false
    const distance = Math.max(zone.low - price, price - zone.high, 0)
    return atr === null ? distance / price * 100 <= 0.5 : distance / atr <= 1
  }
  const nearbyLocation = (item: SignalEvidence) => {
    if (item.family !== 'location') return false
    if (item.source === 'Fib plan' && input.fib.lastClosedAt === asOf && input.fib.setup?.id === item.id) return nearZone(input.fib.setup.goldenPocket)
    const pattern = item.source === 'Harmonic' && input.harmonic.lastClosedAt === asOf
      ? input.harmonic.setups.find((setup) => setup.id === item.id && setup.status === 'active') : null
    return !!pattern && nearZone(pattern.zone)
  }

  for (const candidate of candidates(input, closed, asOf)) {
    const { direction, zone, stop, target } = candidate
    const bullish = direction === 'bullish'
    const freshEvidence = available.filter(recent)
    const trigger = candidate.snapshotMatches ? freshEvidence.filter((item) => relevantTrigger(item, candidate, input.evidence))
      .sort((a, b) => b.availableAt - a.availableAt || a.id.localeCompare(b.id))[0] : undefined
    const materialOpposition = available.filter((item) => item.direction !== direction && (nearbyLocation(item)
      || (item.role === 'trigger' && recent(item))))
    const distantOpposition = available.filter((item) => item.direction !== direction && item.family === 'location' && !nearbyLocation(item))
    const conflict = materialOpposition.length > 0
      || (candidate.source === 'fib' && input.fib.smaConfluence === 'against')
    const distance = price === null ? null : Math.max(zone.low - price, price - zone.high, 0)
    const distancePercent = distance === null || price === null ? null : distance / price * 100
    const distanceAtr = distance === null || atr === null ? null : distance / atr
    const inZone = distance === 0
    const near = distanceAtr !== null ? distanceAtr <= 1 : distancePercent !== null && distancePercent <= 0.5
    const correctReferences = stop !== null && target !== null && (bullish
      ? stop <= zone.low && target > zone.high : stop >= zone.high && target < zone.low)
    const risk = price !== null && stop !== null ? (bullish ? price - stop : stop - price) : null
    const reward = price !== null && target !== null ? (bullish ? target - price : price - target) : null
    const riskReward = correctReferences && risk !== null && reward !== null && risk > 0 && reward > 0 && Number.isFinite(reward / risk) ? reward / risk : null
    const quoteCrossedStop = price !== null && stop !== null && (bullish ? price <= stop : price >= stop)
    const coveredRetest = candidate.source !== 'retest' || candidate.retestConfirmation == null
      || (candidate.touchAt !== null && closeIndices.has(candidate.touchAt) && closeIndices.has(candidate.retestConfirmation))
    const afterTest = candidate.touchAt === null ? [] : closed.filter((bar) => bar.closeTime > candidate.touchAt!)
    const closedCrossedStop = stop !== null && afterTest.some((bar) => candidate.source === 'fib'
      ? bullish ? bar.low <= stop : bar.high >= stop
      : bullish ? bar.low < stop : bar.high > stop)
    const closedCrossedTarget = target !== null && afterTest.some((bar) => bullish ? bar.high >= target : bar.low <= target)
    const wickCrossedStop = preview !== null && stop !== null && (candidate.source === 'fib'
      ? bullish ? preview.low <= stop : preview.high >= stop
      : bullish ? preview.low < stop : preview.high > stop)
    const quoteCrossedTarget = candidate.touchAt !== null && price !== null && target !== null && (bullish ? price >= target : price <= target)
    const wickCrossedTarget = candidate.touchAt !== null && preview !== null && target !== null && (bullish ? preview.high >= target : preview.low <= target)
    const invalidC = candidate.cInvalidation !== undefined && ((price !== null
      && (bullish ? price > candidate.cInvalidation : price < candidate.cInvalidation)) || (preview !== null
      && (bullish ? preview.high > candidate.cInvalidation : preview.low < candidate.cInvalidation)))
    const favorableSide = price !== null && (bullish ? price >= zone.low : price <= zone.high)
    const relevant = available.filter((item) => item.direction === direction || materialOpposition.includes(item) || distantOpposition.includes(item))
    const cautions = [
      'Higher-timeframe context is unchecked in this shortlist; inspect it in the chart.',
      'Reward/risk uses the first target only. Fees, spread, slippage and funding are excluded.',
      'Evidence families group related observations; their count is not a win probability.',
      ...candidate.cautions,
      ...(distantOpposition.length ? ['Other active locations point the opposite way away from this zone; review their context.'] : []),
      ...(atr === null ? ['ATR is unavailable; approaching uses a 0.5% distance to the zone.'] : []),
      ...input.evidence.missing.filter((message) => /unavailable|missing|insufficient/i.test(message)),
    ]
    let status: WatchlistStatus
    let reason: string
    let next: string
    if (freshness !== 'fresh') {
      status = 'delayed'
      reason = price === null ? 'The live quote is unavailable.' : freshness === 'loading' ? 'Waiting for completed candles and a ready feed.'
        : freshness === 'error' ? 'Market data is reconnecting; these are last-known observations.' : 'The latest receipt or completed candle is delayed.'
      next = 'Wait for a valid live quote and fresh completed candles.'
    } else if (!candidate.snapshotMatches || !evidenceMatches) {
      status = 'blocked'; reason = 'The setup and evidence do not describe the same completed candle.'; next = 'Wait for the analyses to catch up to the displayed candles.'
    } else if (!coveredRetest) {
      status = 'blocked'; reason = 'The completed history does not cover this retest through its confirmation.'
      next = 'Wait for a new setup with uninterrupted observable candles.'
    } else if (!correctReferences) {
      status = 'blocked'; reason = target === null ? 'No structural target is available.' : 'A correctly sided stop and first target are unavailable.'
      next = 'Inspect the chart for usable risk boundaries before considering this setup.'
    } else if (closedCrossedStop || quoteCrossedStop || wickCrossedStop || invalidC) {
      status = 'blocked'; reason = closedCrossedStop ? 'A completed candle crossed the stop boundary after the zone test.'
        : invalidC ? 'The live price crossed the pattern’s C boundary.' : 'The live price has reached or crossed the stop boundary.'
      next = closedCrossedStop ? 'Wait for a fresh setup; recovering beyond a consumed boundary does not restore this one.'
        : 'Wait for the candle close and detector update; this setup is not currently eligible.'
    } else if (candidate.consumedTarget || closedCrossedTarget || quoteCrossedTarget || wickCrossedTarget) {
      status = 'extended'; reason = 'The first target has already been reached by the observed price.'; next = 'Wait for a fresh setup; this first-target opportunity has passed.'
    } else if (conflict) {
      status = 'conflict'; reason = candidate.source === 'fib' && input.fib.smaConfluence === 'against'
        ? 'The setup direction opposes its SMA200 context.' : 'A nearby opposing location or recent trigger conflicts with this direction.'
      next = 'Inspect the opposing evidence and wait for the conflict to resolve.'
    } else if (trigger && riskReward !== null && favorableSide && near) {
      status = 'confirmed'; reason = `${trigger.source} confirmed after the completed-candle zone test; the quote remains near the setup zone.`
      next = 'Review the chart, higher timeframe and execution costs before making a decision.'
    } else if (trigger && !near && favorableSide) {
      status = 'extended'; reason = atr === null ? 'The quote has moved more than 0.5% from the setup zone.' : 'The quote has moved more than one ATR from the setup zone.'
      next = 'Wait for a better location or a fresh setup; a past trigger does not justify chasing.'
    } else if (inZone) {
      status = 'testing'; reason = candidate.touchAt === null ? 'The live quote is testing the zone; no completed-candle test is available.'
        : 'The zone was tested, but no qualifying trigger followed within the latest four closes.'
      next = candidate.source === 'retest' ? 'Wait for the retest’s own completed-candle continuation.' : 'Wait for a later aligned price or RSI trigger on a completed candle.'
    } else if (near && favorableSide) {
      status = 'approaching'; reason = 'The quote is near the zone, with no qualifying recent confirmation.'
      next = 'Watch for a completed-candle zone test followed by a fresh aligned trigger.'
    } else {
      status = 'waiting'; reason = favorableSide ? 'The quote is away from the setup zone.' : 'The quote is beyond the zone on the unconfirmed side.'
      next = 'Wait for a zone test and a later completed-candle confirmation.'
    }
    if (riskReward !== null && riskReward < 1) cautions.push('Less than 1R remains to the first target; partial exits and later targets are not modeled here.')
    const id = `${input.market}:${input.timeframe}:${input.symbol}:${candidate.source}:${candidate.id}`
    if (rows.has(id)) continue
    rows.set(id, {
      id, symbol: input.symbol, market: input.market, timeframe: input.timeframe, source: candidate.source,
      name: candidate.name, direction, status, price, zone: { ...zone }, stop, target, riskReward,
      distancePercent, distanceAtr, confirmedAt: trigger?.availableAt ?? null, asOf, updatedAt: input.feed.updatedAt,
      reason, next, cautions: [...new Set(cautions)], evidence: relevant, families: [...new Set(relevant.filter((item) => item.direction === direction).map((item) => item.family))], conflict,
    })
  }
  return sortWatchlistRows([...rows.values()])
}

const STATUS_ORDER: Record<WatchlistStatus, number> = { confirmed: 0, testing: 1, approaching: 2, waiting: 3, conflict: 4, extended: 5, blocked: 6, delayed: 7 }

/** Stable tie-breakers keep rows deterministic without treating evidence counts as probabilities. */
export function sortWatchlistRows(rows: readonly WatchlistRow[]): WatchlistRow[] {
  return [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    || (b.confirmedAt ?? -1) - (a.confirmedAt ?? -1)
    || b.families.length - a.families.length
    || (a.distancePercent ?? Infinity) - (b.distancePercent ?? Infinity)
    || a.symbol.localeCompare(b.symbol) || a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
}

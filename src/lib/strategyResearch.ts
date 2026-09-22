import type { Candle, Timeframe } from '../types'
import { fetchClosedCandleHistory, TIMEFRAME_MILLISECONDS, validateHistoryIdentity, validateTimestamp } from './binanceHistory'
import type { ClosedCandleHistory, HistoryProgress } from './binanceHistory'
import { findRsiDivergenceSetups } from './divergenceLifecycle'
import { buildResearchRsiBars, validateResearchOscillator } from './researchOscillators'
import type { ResearchOscillator } from './researchOscillators'
import { MARKETS } from './markets'
import type { ScreenerMarket } from './markets'
import { analyzeVolatility } from './volatility'

export const RESEARCH_WARMUP_CANDLES = 250
export const RESEARCH_SAMPLE_CANDLES = 5_000
export type ResearchPartition = 'training' | 'validation' | 'holdout'
export interface ResearchCandidate {
  id: string
  label: string
  oscillator: ResearchOscillator
}
export const RESEARCH_CANDIDATES: readonly ResearchCandidate[] = Object.freeze([
  { id: 'wilder-14', label: 'Wilder RSI 14 · baseline', oscillator: { kind: 'wilder', period: 14 } },
  { id: 'wilder-12', label: 'Wilder RSI 12', oscillator: { kind: 'wilder', period: 12 } },
  { id: 'wilder-16', label: 'Wilder RSI 16', oscillator: { kind: 'wilder', period: 16 } },
  { id: 'weighted-14', label: 'Trend-weighted RSI 14 · experiment', oscillator: { kind: 'trend-weighted', period: 14 } },
  { id: 'adaptive-14', label: 'Adaptive RSI 14 · experiment', oscillator: { kind: 'adaptive', period: 14 } },
])

export interface ResearchExecution {
  stopAtr: number
  targetAtr: number
  maxHoldingBars: number
  forwardBars: number
  /** Per side; 1 bp = 0.01%. */
  feeBps: number
  slippageBps: number
  /** Assumed daily carrying cost, not an exchange funding-history reconstruction. */
  carryingBpsPerDay: number
}
export function defaultResearchExecution(market: ScreenerMarket): ResearchExecution {
  return {
    stopAtr: 1.5, targetAtr: 3, maxHoldingBars: 20, forwardBars: 10,
    feeBps: market === 'spot' ? 10 : 4, slippageBps: 2,
    carryingBpsPerDay: market === 'spot' ? 0 : 1,
  }
}
interface ResearchIdentity { symbol: string; timeframe: Timeframe; market: ScreenerMarket }
export interface ResearchRequest extends ResearchIdentity {
  sampleCandles?: number
  endTime?: number
  candidates?: readonly ResearchCandidate[]
  execution?: Partial<ResearchExecution>
  minimumTrainingTrades?: number
  signal?: AbortSignal
  onProgress?: (progress: HistoryProgress) => void
  onPhase?: (phase: string) => void
}
export interface ResearchWindow {
  partition: ResearchPartition
  startIndex: number
  endIndex: number
  startTime: number | null
  endTime: number | null
  candleCount: number
}
export interface ResearchSignal extends ResearchIdentity {
  id: string
  candidateId: string
  confirmedIndex: number
  confirmedAt: number
  direction: 'bullish' | 'bearish'
  atr: number | null
}
export interface ResearchTrade extends ResearchIdentity {
  signalId: string
  candidateId: string
  direction: ResearchSignal['direction']
  confirmedAt: number
  entryTime: number
  exitTime: number
  entryIndex: number
  exitIndex: number
  entryPrice: number
  exitPrice: number
  stopPrice: number
  targetPrice: number
  reason: 'stop' | 'target' | 'time-stop'
  grossReturn: number
  netReturn: number
  fees: number
  slippage: number
  carryingCost: number
}
export interface ForwardObservation extends ResearchIdentity {
  signalId: string
  candidateId: string
  direction: ResearchSignal['direction']
  entryTime: number
  endTime: number
  forwardReturn: number
  mfe: number
  mae: number
}
export interface ResearchSummary {
  trades: number
  wins: number
  winRate: number | null
  expectancy: number | null
  grossExpectancy: number | null
  compoundedReturn: number | null
  maxDrawdown: number | null
  totalFees: number
  totalSlippage: number
  totalCarryingCost: number
  observations: number
  meanForwardReturn: number | null
  meanMfe: number | null
  meanMae: number | null
}
export interface ResearchEvaluation {
  candidateId: string
  window: ResearchWindow
  signals: number
  excluded: { boundary: number; gap: number; atr: number; overlap: number; spotShort: number; insolvent: number }
  summary: ResearchSummary
  trades: ResearchTrade[]
  observations: ForwardObservation[]
}
export interface CandidateResearchResult {
  candidate: ResearchCandidate
  training: ResearchEvaluation
  validation: ResearchEvaluation
  holdout: ResearchEvaluation
}
export interface StrategyResearchReport extends ResearchIdentity {
  schemaVersion: 1
  generatedAt: string
  execution: ResearchExecution
  source: { asOf: number; complete: boolean; warnings: string[]; requestedCandles: number; loadedCandles: number }
  windows: Record<ResearchPartition, ResearchWindow>
  selection: {
    candidateId: string
    frozenAt: number | null
    minimumTrainingTrades: number
    sufficientSample: boolean
    criterion: string
  }
  results: CandidateResearchResult[]
  costSensitivity: { multiplier: number; evaluation: ResearchEvaluation }[]
  candles: Candle[]
  methodology: string
}

export const RESEARCH_METHODOLOGY = 'Chronological 60% training / 20% validation / 20% holdout after 250 warmup candles. '
  + 'Candidate selection uses only training net expectancy with a minimum trade count; it is frozen before validation and holdout. '
  + 'All candidates use the existing regular-divergence lifecycle and independently recomputed RSI pivots. '
  + 'Setups must form and confirm in their own partition; the full maximum holding and forward-return horizons must fit before its end. '
  + 'Entries occur at the next contiguous candle open after confirmation, with ATR(14) known at confirmation. '
  + 'One position at a time per candidate, full equity at 1× notional; Spot is long-only, Futures permits longs and shorts. '
  + 'Stops and targets stay fixed from the raw entry open. A gap through a stop fills at the worse open; a gap beyond a target fills at the target. '
  + 'Resting exits at the open are processed before the intrabar range. If both levels are touched afterward in one OHLC bar, the stop wins. Time stops exit at the final holding-bar close. '
  + 'Fees apply to both executed notionals; slippage worsens each entry and exit. Carrying cost is a fixed daily assumption, not actual funding. '
  + 'Drawdown is measured at realized trade closes, not intratrade equity lows. Forward returns/MFE/MAE are direction-adjusted, before costs, and may overlap. '
  + 'Signals without a complete contiguous outcome horizon are excluded. Experimental oscillators are research only; results never change live settings. '
  + 'Repeatedly inspecting holdouts makes them development data; use later unseen dates before making performance claims.'

function validateExecution(execution: ResearchExecution, costLimit = 500): void {
  for (const key of ['stopAtr', 'targetAtr'] as const) {
    if (!Number.isFinite(execution[key]) || execution[key] <= 0 || execution[key] > 20) throw new RangeError(`${key} must be greater than 0 and at most 20`)
  }
  for (const key of ['maxHoldingBars', 'forwardBars'] as const) {
    if (!Number.isSafeInteger(execution[key]) || execution[key] < 1 || execution[key] > 250) throw new RangeError(`${key} must be an integer between 1 and 250`)
  }
  for (const key of ['feeBps', 'slippageBps', 'carryingBpsPerDay'] as const) {
    if (!Number.isFinite(execution[key]) || execution[key] < 0 || execution[key] > costLimit) throw new RangeError(`${key} must be between 0 and ${costLimit} basis points`)
  }
}

function validatedRequest(request: ResearchRequest) {
  validateHistoryIdentity(request.symbol, request.timeframe)
  if (!Object.hasOwn(MARKETS, request.market)) throw new TypeError('Unsupported research market')
  const sampleCandles = request.sampleCandles ?? RESEARCH_SAMPLE_CANDLES
  if (!Number.isSafeInteger(sampleCandles) || sampleCandles < 500 || sampleCandles > 30_000) throw new RangeError('Research sample must contain 500 to 30,000 candles')
  if (request.endTime !== undefined) validateTimestamp(request.endTime, 'endTime')
  const candidates = (request.candidates ?? RESEARCH_CANDIDATES).map((candidate) => ({ ...candidate, oscillator: { ...candidate.oscillator } }))
  if (candidates.length < 1 || candidates.length > 12 || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new RangeError('Choose 1 to 12 uniquely identified research candidates')
  }
  for (const candidate of candidates) {
    if (!candidate.id.trim() || !candidate.label.trim()) throw new TypeError('Research candidates require an id and label')
    validateResearchOscillator(candidate.oscillator)
  }
  const execution = { ...defaultResearchExecution(request.market), ...request.execution }
  validateExecution(execution)
  const minimumTrainingTrades = request.minimumTrainingTrades ?? 10
  if (!Number.isSafeInteger(minimumTrainingTrades) || minimumTrainingTrades < 1 || minimumTrainingTrades > 1_000) throw new RangeError('Minimum training trades must be an integer between 1 and 1,000')
  return { sampleCandles, candidates, execution, minimumTrainingTrades }
}

/** End indices are inclusive. No candle belongs to two selection partitions. */
export function researchWindows(candles: readonly Candle[], sampleCandles: number): Record<ResearchPartition, ResearchWindow> {
  const sampleStart = Math.max(RESEARCH_WARMUP_CANDLES, candles.length - sampleCandles)
  const count = Math.max(0, candles.length - sampleStart)
  const trainingEnd = sampleStart + Math.floor(count * 0.6)
  const validationEnd = sampleStart + Math.floor(count * 0.8)
  const make = (partition: ResearchPartition, startIndex: number, nextIndex: number): ResearchWindow => ({
    partition, startIndex, endIndex: nextIndex - 1,
    startTime: startIndex < nextIndex ? candles[startIndex]?.openTime ?? null : null,
    endTime: startIndex < nextIndex ? candles[nextIndex - 1]?.closeTime ?? null : null,
    candleCount: nextIndex - startIndex,
  })
  return {
    training: make('training', sampleStart, trainingEnd),
    validation: make('validation', trainingEnd, validationEnd),
    holdout: make('holdout', validationEnd, sampleStart + count),
  }
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}
export function summarizeResearch(trades: readonly ResearchTrade[], observations: readonly ForwardObservation[]): ResearchSummary {
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  for (const trade of trades) {
    equity *= Math.max(0, 1 + trade.netReturn)
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
  }
  const wins = trades.filter((trade) => trade.netReturn > 0).length
  return {
    trades: trades.length, wins, winRate: trades.length ? wins / trades.length : null,
    expectancy: average(trades.map((trade) => trade.netReturn)),
    grossExpectancy: average(trades.map((trade) => trade.grossReturn)),
    compoundedReturn: trades.length ? equity - 1 : null, maxDrawdown: trades.length ? maxDrawdown : null,
    totalFees: trades.reduce((sum, trade) => sum + trade.fees, 0),
    totalSlippage: trades.reduce((sum, trade) => sum + trade.slippage, 0),
    totalCarryingCost: trades.reduce((sum, trade) => sum + trade.carryingCost, 0),
    observations: observations.length,
    meanForwardReturn: average(observations.map((observation) => observation.forwardReturn)),
    meanMfe: average(observations.map((observation) => observation.mfe)),
    meanMae: average(observations.map((observation) => observation.mae)),
  }
}

/** Exported to make execution assumptions independently testable from detection. */
export function simulateResearchSignals(
  candles: readonly Candle[], signals: readonly ResearchSignal[], window: ResearchWindow,
  execution: ResearchExecution, candidateId: string,
): ResearchEvaluation {
  validateExecution(execution, 1_000)
  const trades: ResearchTrade[] = []
  const observations: ForwardObservation[] = []
  const excluded = { boundary: 0, gap: 0, atr: 0, overlap: 0, spotShort: 0, insolvent: 0 }
  let occupiedThrough = -1
  let insolvent = false
  const eligible = signals.filter((signal) => signal.confirmedIndex >= window.startIndex && signal.confirmedIndex <= window.endIndex)
    .sort((a, b) => a.confirmedIndex - b.confirmedIndex || a.id.localeCompare(b.id))
  for (const signal of eligible) {
    const entryIndex = signal.confirmedIndex + 1
    const lastNeeded = entryIndex + Math.max(execution.maxHoldingBars, execution.forwardBars) - 1
    if (lastNeeded > window.endIndex || !candles[lastNeeded]) { excluded.boundary++; continue }
    let contiguous = true
    for (let index = entryIndex; index <= lastNeeded; index++) {
      if (candles[index].openTime !== candles[index - 1].closeTime + 1) { contiguous = false; break }
    }
    if (!contiguous) { excluded.gap++; continue }
    const entry = candles[entryIndex]
    const side = signal.direction === 'bullish' ? 1 : -1
    const identity = { symbol: signal.symbol, timeframe: signal.timeframe, market: signal.market, candidateId, signalId: signal.id, direction: signal.direction }
    const forward = candles.slice(entryIndex, entryIndex + execution.forwardBars)
    observations.push({
      ...identity, entryTime: entry.openTime, endTime: forward.at(-1)!.closeTime,
      forwardReturn: side * (forward.at(-1)!.close / entry.open - 1),
      mfe: Math.max(0, ...forward.map((bar) => side * ((side > 0 ? bar.high : bar.low) / entry.open - 1))),
      mae: Math.min(0, ...forward.map((bar) => side * ((side > 0 ? bar.low : bar.high) / entry.open - 1))),
    })
    if (signal.market === 'spot' && side < 0) { excluded.spotShort++; continue }
    if (insolvent) { excluded.insolvent++; continue }
    if (entryIndex <= occupiedThrough) { excluded.overlap++; continue }
    const atr = signal.atr
    if (atr === null || !Number.isFinite(atr) || atr <= 0) { excluded.atr++; continue }
    const stopPrice = entry.open - side * execution.stopAtr * atr
    const targetPrice = entry.open + side * execution.targetAtr * atr
    if (stopPrice <= 0 || targetPrice <= 0) { excluded.atr++; continue }
    let exitIndex = entryIndex + execution.maxHoldingBars - 1
    let rawExit = candles[exitIndex].close
    let reason: ResearchTrade['reason'] = 'time-stop'
    for (let index = entryIndex; index <= exitIndex; index++) {
      const bar = candles[index]
      const stopGap = side > 0 ? bar.open <= stopPrice : bar.open >= stopPrice
      const targetGap = side > 0 ? bar.open >= targetPrice : bar.open <= targetPrice
      const stopHit = side > 0 ? bar.low <= stopPrice : bar.high >= stopPrice
      const targetHit = side > 0 ? bar.high >= targetPrice : bar.low <= targetPrice
      // Opens are known before the intrabar range. Beyond-target opens fill the
      // resting limit before a later reversal; ambiguous intrabar touches lose.
      if (stopGap || targetGap || stopHit || targetHit) {
        reason = stopGap || (!targetGap && stopHit) ? 'stop' : 'target'
        rawExit = stopGap ? bar.open : reason === 'stop' ? stopPrice : targetPrice
        exitIndex = index
        break
      }
    }
    const entryPrice = entry.open * (1 + side * execution.slippageBps / 10_000)
    const exitPrice = rawExit * (1 - side * execution.slippageBps / 10_000)
    const grossReturn = side * (rawExit / entry.open - 1)
    const executedReturn = side * (exitPrice / entryPrice - 1)
    const fees = execution.feeBps / 10_000 * (1 + exitPrice / entryPrice)
    const exitTime = candles[exitIndex].closeTime
    // Intrabar fill time cannot be known from OHLC. Charge through that bar's
    // close, conservatively, and retain the bar-close timestamp in the record.
    const carryingCost = execution.carryingBpsPerDay / 10_000 * (exitTime - entry.openTime + 1) / 86_400_000
    trades.push({
      ...identity, confirmedAt: signal.confirmedAt, entryTime: entry.openTime, exitTime,
      entryIndex, exitIndex, entryPrice, exitPrice, stopPrice, targetPrice, reason,
      grossReturn, netReturn: executedReturn - fees - carryingCost,
      fees, slippage: grossReturn - executedReturn, carryingCost,
    })
    occupiedThrough = exitIndex
    insolvent = executedReturn - fees - carryingCost <= -1
  }
  return { candidateId, window, signals: eligible.length, excluded, trades, observations, summary: summarizeResearch(trades, observations) }
}

/** Training records are the only input accepted by selection. Array order breaks ties. */
export function selectResearchCandidate(training: readonly ResearchEvaluation[], minimumTrades: number, baselineId: string): { candidateId: string; sufficientSample: boolean } {
  const eligible = training.filter((result) => result.summary.trades >= minimumTrades && result.summary.expectancy !== null)
  let selected = eligible[0]
  for (const result of eligible.slice(1)) {
    if (result.summary.expectancy! > selected.summary.expectancy!) selected = result
  }
  return { candidateId: selected?.candidateId ?? baselineId, sufficientSample: selected !== undefined }
}

// Shared volatility analyzes the latest contiguous suffix. Split once at gaps
// so historical research retains earlier segments without bridging a gap.
function atrSeries(candles: readonly Candle[]): (number | null)[] {
  const output: (number | null)[] = []
  let segmentStart = 0
  for (let index = 1; index <= candles.length; index++) {
    if (index === candles.length || candles[index].openTime !== candles[index - 1].closeTime + 1) {
      output.push(...analyzeVolatility(candles.slice(segmentStart, index).map((bar) => ({ ...bar, rsi: Number.NaN, isClosed: true })))
        .points.map((point) => point.atr))
      segmentStart = index
    }
  }
  return output
}

export function evaluateStrategyResearch(input: readonly Candle[], request: ResearchRequest, source?: ClosedCandleHistory): StrategyResearchReport {
  const { sampleCandles, candidates, execution, minimumTrainingTrades } = validatedRequest(request)
  request.signal?.throwIfAborted()
  if (source && (source.symbol !== request.symbol || source.timeframe !== request.timeframe || source.market !== request.market)) {
    throw new TypeError('Historical source identity does not match the research request')
  }
  const asOf = Math.min(request.endTime ?? Number.MAX_SAFE_INTEGER, source?.asOf ?? Number.MAX_SAFE_INTEGER)
  const candles = input.filter((bar) => bar.closeTime <= asOf).slice(-(sampleCandles + RESEARCH_WARMUP_CANDLES))
  // Validate even when no candidate or window has enough data to replay.
  buildResearchRsiBars(candles, { kind: 'wilder', period: 14 })
  if (candles.some((bar) => bar.closeTime - bar.openTime + 1 !== TIMEFRAME_MILLISECONDS[request.timeframe])) throw new TypeError('Historical candle interval does not match the research timeframe')
  const windows = researchWindows(candles, sampleCandles)
  const atr = atrSeries(candles)
  const closeIndices = new Map(candles.map((bar, index) => [bar.closeTime, index]))
  const warmed = new Set<number>()
  let contiguousCount = 0
  let gaps = 0
  candles.forEach((bar, index) => {
    if (index > 0 && bar.openTime !== candles[index - 1].closeTime + 1) { contiguousCount = 0; gaps++ }
    if (contiguousCount >= RESEARCH_WARMUP_CANDLES) warmed.add(index)
    contiguousCount++
  })
  const signalCache = new Map<string, ResearchSignal[]>()
  const evaluate = (candidate: ResearchCandidate, window: ResearchWindow): ResearchEvaluation => {
    request.signal?.throwIfAborted()
    const prefix = candles.slice(0, Math.max(0, window.endIndex + 1))
    const bars = buildResearchRsiBars(prefix, candidate.oscillator)
    const signals: ResearchSignal[] = findRsiDivergenceSetups(bars).flatMap((setup): ResearchSignal[] => {
      if (setup.confirmedAt === null || setup.detectedAt < (window.startTime ?? Infinity)
        || (setup.resolvedAt !== null && setup.resolvedAt <= setup.confirmedAt)) return []
      const index = closeIndices.get(setup.confirmedAt)
      const detectedIndex = closeIndices.get(setup.detectedAt)
      if (index === undefined || detectedIndex === undefined || !warmed.has(detectedIndex)) return []
      return [{
        symbol: request.symbol, timeframe: request.timeframe, market: request.market,
        id: setup.id, candidateId: candidate.id, confirmedIndex: index, confirmedAt: setup.confirmedAt,
        direction: setup.kind.endsWith('bullish') ? 'bullish' : 'bearish', atr: atr[index],
      }]
    })
    signalCache.set(`${candidate.id}:${window.partition}`, signals)
    return simulateResearchSignals(candles, signals, window, execution, candidate.id)
  }
  // Selection is performed before even evaluating a validation or holdout run.
  const training = candidates.map((candidate) => evaluate(candidate, windows.training))
  const baselineId = candidates.find((candidate) => candidate.id === 'wilder-14')?.id ?? candidates[0].id
  const selection = selectResearchCandidate(training, minimumTrainingTrades, baselineId)
  const results = candidates.map((candidate, index) => ({
    candidate, training: training[index], validation: evaluate(candidate, windows.validation), holdout: evaluate(candidate, windows.holdout),
  }))
  const sensitivitySignals = signalCache.get(`${selection.candidateId}:holdout`) ?? []
  const costSensitivity = [0, 1, 2].map((multiplier) => ({
    multiplier,
    evaluation: simulateResearchSignals(candles, sensitivitySignals, windows.holdout, {
      ...execution, feeBps: execution.feeBps * multiplier, slippageBps: execution.slippageBps * multiplier,
      carryingBpsPerDay: execution.carryingBpsPerDay * multiplier,
    }, selection.candidateId),
  }))
  const warnings = [...(source?.warnings ?? [])]
  if (candles.length < sampleCandles + RESEARCH_WARMUP_CANDLES) warnings.push(`Only ${candles.length} of ${sampleCandles + RESEARCH_WARMUP_CANDLES} requested candles are available, including warmup.`)
  if (gaps) warnings.push(`${gaps} history gaps: oscillator warmup restarts; outcomes crossing missing candles are excluded.`)
  if (windows.holdout.candleCount <= Math.max(execution.maxHoldingBars, execution.forwardBars)) warnings.push('Insufficient candles for a complete holdout outcome; load a larger sample.')
  if (!selection.sufficientSample) warnings.push(`No candidate has ${minimumTrainingTrades} training trades. The baseline is retained without evidence of a preferred candidate.`)
  const selected = results.find((result) => result.candidate.id === selection.candidateId)!
  if (selected.holdout.summary.trades < minimumTrainingTrades) warnings.push(`The selected candidate has only ${selected.holdout.summary.trades} holdout trades; the result has insufficient sample size for a performance conclusion.`)
  if (request.market === 'tradfi') warnings.push(`Futures carry assumes ${execution.carryingBpsPerDay} bp/day charged on every position. Actual funding, margin and liquidation are not reconstructed.`)
  return {
    schemaVersion: 1, symbol: request.symbol, timeframe: request.timeframe, market: request.market,
    generatedAt: new Date().toISOString(), execution,
    source: {
      asOf: source?.asOf ?? candles.at(-1)?.closeTime ?? 0,
      complete: (source?.complete ?? candles.length >= sampleCandles + RESEARCH_WARMUP_CANDLES) && gaps === 0,
      warnings, requestedCandles: sampleCandles, loadedCandles: candles.length,
    }, windows,
    selection: {
      ...selection, frozenAt: windows.training.endTime, minimumTrainingTrades,
      criterion: 'Highest training net expectancy among candidates meeting the minimum trade count; preset order breaks ties. Baseline fallback if none qualify.',
    }, results, costSensitivity, candles, methodology: RESEARCH_METHODOLOGY,
  }
}

export async function runStrategyResearch(request: ResearchRequest, fetcher: typeof fetch = fetch): Promise<StrategyResearchReport> {
  const { sampleCandles } = validatedRequest(request)
  const history = await fetchClosedCandleHistory({
    symbol: request.symbol, timeframe: request.timeframe, market: request.market,
    count: sampleCandles + RESEARCH_WARMUP_CANDLES, endTime: request.endTime,
    signal: request.signal, onProgress: request.onProgress,
  }, fetcher)
  request.signal?.throwIfAborted()
  request.onPhase?.('Comparing frozen candidates on chronological periods…')
  // Yield to render progress and honor cancellation before CPU-bound replay.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  request.signal?.throwIfAborted()
  return evaluateStrategyResearch(history.candles, request, history)
}

export function strategyResearchToCsv(report: StrategyResearchReport): string {
  const rows: (string | number | null)[][] = [[
    'market', 'symbol', 'timeframe', 'candidate', 'oscillator', 'period', 'partition', 'start_time', 'end_time',
    'frozen_selection', 'trades', 'expectancy', 'gross_expectancy', 'compounded_return', 'realized_max_drawdown',
    'fees_sum', 'slippage_sum', 'carry_sum', 'forward_observations', 'mean_forward_return', 'mean_mfe', 'mean_mae',
  ]]
  for (const result of report.results) {
    for (const partition of ['training', 'validation', 'holdout'] as const) {
      const { summary, window } = result[partition]
      rows.push([
        report.market, report.symbol, report.timeframe, result.candidate.id,
        result.candidate.oscillator.kind, result.candidate.oscillator.period, partition, window.startTime, window.endTime,
        String(report.selection.candidateId === result.candidate.id), summary.trades, summary.expectancy,
        summary.grossExpectancy, summary.compoundedReturn, summary.maxDrawdown, summary.totalFees,
        summary.totalSlippage, summary.totalCarryingCost, summary.observations, summary.meanForwardReturn, summary.meanMfe, summary.meanMae,
      ])
    }
  }
  return rows.map((row) => row.map((value) => {
    const cell = value === null ? '' : String(value)
    return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
  }).join(',')).join('\n') + '\n'
}

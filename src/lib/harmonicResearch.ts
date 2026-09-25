import type { Candle, RsiBar, Timeframe } from '../types'
import { fetchClosedCandleHistory, TIMEFRAME_MILLISECONDS, validateHistoryIdentity, validateTimestamp } from './binanceHistory'
import type { ClosedCandleHistory, HistoryProgress } from './binanceHistory'
import { advanceHarmonicReplay, createHarmonicReplay } from './harmonics'
import type { HarmonicKind, HarmonicStatus } from './harmonics'
import { getHarmonicQuality } from './harmonicQuality'
import { MARKETS } from './markets'
import type { ScreenerMarket } from './markets'
import { isValidCandle } from './rsiHistory'
import { analyzeVolatility } from './volatility'
import { defaultResearchExecution, RESEARCH_SAMPLE_CANDLES, RESEARCH_WARMUP_CANDLES, researchWindows, selectResearchCandidate, simulateResearchSignals } from './strategyResearch'
import type { ResearchEvaluation, ResearchExecution, ResearchPartition, ResearchSignal, ResearchWindow } from './strategyResearch'

export const HARMONIC_RESEARCH_CANDIDATES = Object.freeze([
  { id: 'touch-baseline', label: 'First D touch · baseline', description: 'First observable closed-candle D contact, with fixed scanner expiry.' },
  { id: 'touch-quality-80', label: 'Ratio fit ≥80 · touch', description: 'The same first-contact event, requiring B/C ratio fit of at least 80 out of 100.' },
  { id: 'confirmed-d', label: 'Confirmed D pivot', description: 'A D wick pivot confirmed by three closed candles on either side, with fixed scanner expiry.' },
  { id: 'touch-proportional', label: 'Proportional expiry · touch', description: 'First observable D contact with expiry scaled to pattern duration.' },
] as const)
export type HarmonicResearchCandidate = typeof HARMONIC_RESEARCH_CANDIDATES[number]
export type HarmonicResearchCandidateId = HarmonicResearchCandidate['id']

export interface HarmonicResearchRequest {
  symbol: string
  timeframe: Timeframe
  market: ScreenerMarket
  sampleCandles?: number
  endTime?: number
  execution?: Partial<ResearchExecution>
  minimumTrainingTrades?: number
  signal?: AbortSignal
  onProgress?: (progress: HistoryProgress) => void
  onPhase?: (phase: string) => void
}

/** Frozen at the close when this event first becomes observable, before any future candle. */
export interface HarmonicResearchEvent extends ResearchSignal {
  candidateId: HarmonicResearchCandidateId
  setupId: string
  pattern: HarmonicKind
  event: 'touch' | 'confirmed-d'
  xTime: number
  cTime: number
  setupConfirmedAt: number
  touchTime: number
  dPivotTime: number | null
  ratioFit: number
  statusAtEvent: HarmonicStatus
  warmupComplete: boolean
}

export interface HarmonicResearchEvaluation extends ResearchEvaluation {
  /** Events observed in this partition but excluded before the execution benchmark. */
  eventExclusions: { warmup: number; formationBoundary: number }
}
export interface HarmonicResearchResult {
  candidate: HarmonicResearchCandidate
  training: HarmonicResearchEvaluation
  validation: HarmonicResearchEvaluation
  holdout: HarmonicResearchEvaluation
}
export interface HarmonicResearchReport {
  schemaVersion: 1
  study: 'harmonic-atr-benchmark'
  generatedAt: string
  symbol: string
  timeframe: Timeframe
  market: ScreenerMarket
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
  results: HarmonicResearchResult[]
  costSensitivity: { multiplier: number; evaluation: HarmonicResearchEvaluation }[]
  /** Includes events later invalidated/completed and events excluded by partition or warmup rules. */
  events: HarmonicResearchEvent[]
  candles: Candle[]
  methodology: string
}

export const HARMONIC_RESEARCH_METHODOLOGY = 'Harmonic event comparison using a fixed ATR execution benchmark, independent of lecture entry zones, X/D stops and target references. '
  + 'Replay each closed candle in order and freeze events when observable; retain them even if the setup later fails, completes, expires or leaves the 500-candle discovery window. '
  + 'First-touch availability is the later of C confirmation and the touch candle close; setups already retired at their first visibility are excluded. '
  + 'Confirmed-D availability is the third right-hand candle close. A pivot confirmed on the same candle as lecture target completion is included; invalidated setups and pivots learned after a setup ends are excluded. '
  + 'Ratio fit is geometric B/C fit, not a success probability. Its ≥80 threshold is fixed before evaluation. Proportional pre-touch expiry is max(3, ceil((C−X)/3×3.5)) bars after C, and post-touch recency is max(3, ceil((D−X)/2)) bars; lengths are candle counts. '
  + 'After 250 warmup candles, use chronological 60% training / 20% validation / 20% holdout. Each contiguous segment needs 250 warmup candles before C confirmation. '
  + 'The entire X-to-event pattern must belong to its partition. Report excluded formation-boundary and warmup events; the full maximum holding and forward horizons must also fit within that partition. '
  + 'Freeze the candidate with greatest training net expectancy among those meeting the minimum trade count before evaluating validation or holdout; ties keep preset order and insufficient samples retain the baseline. '
  + 'Enter at the next contiguous candle open after the event, using ATR(14) available at the event close. Stops and targets are fixed multiples of that ATR from the raw entry open. '
  + 'One position at a time per candidate, at 1× equity notional; Spot is long-only and Futures permits shorts. Forward observations may overlap and retain bearish Spot events. '
  + 'Process resting exits at the open first: adverse stop gaps fill at the worse open and favorable target gaps at the target. For ambiguous intrabar stop/target touches, the stop wins. Time stops exit at the final holding candle close, including timed-out trades in performance. '
  + 'Fees apply to both executed notionals and slippage worsens both fills. Daily carry is an assumption, not actual funding or margin reconstruction. Report compounded returns and realized trade-close drawdown; no new trade follows an account-depleting loss. '
  + 'Missing-candle outcome horizons are excluded. Compare zero, entered and doubled costs for the frozen candidate. Repeatedly inspected holdouts become development data; use unseen dates and other symbols before performance claims. No result changes live scanner settings.'

function validatedRequest(request: HarmonicResearchRequest) {
  validateHistoryIdentity(request.symbol, request.timeframe)
  if (!Object.hasOwn(MARKETS, request.market)) throw new TypeError('Unsupported harmonic research market')
  const sampleCandles = request.sampleCandles ?? RESEARCH_SAMPLE_CANDLES
  if (!Number.isSafeInteger(sampleCandles) || sampleCandles < 500 || sampleCandles > 30_000) throw new RangeError('Research sample must contain 500 to 30,000 candles')
  if (request.endTime !== undefined) validateTimestamp(request.endTime, 'endTime')
  const execution = { ...defaultResearchExecution(request.market), ...request.execution }
  for (const key of ['stopAtr', 'targetAtr'] as const) {
    if (!Number.isFinite(execution[key]) || execution[key] <= 0 || execution[key] > 20) throw new RangeError(`${key} must be greater than zero and at most 20`)
  }
  for (const key of ['maxHoldingBars', 'forwardBars'] as const) {
    if (!Number.isSafeInteger(execution[key]) || execution[key] < 1 || execution[key] > 250) throw new RangeError(`${key} must be an integer between 1 and 250`)
  }
  for (const key of ['feeBps', 'slippageBps', 'carryingBpsPerDay'] as const) {
    if (!Number.isFinite(execution[key]) || execution[key] < 0 || execution[key] > 500) throw new RangeError(`${key} must be between zero and 500 basis points`)
  }
  const minimumTrainingTrades = request.minimumTrainingTrades ?? 10
  if (!Number.isSafeInteger(minimumTrainingTrades) || minimumTrainingTrades < 1 || minimumTrainingTrades > 1_000) throw new RangeError('Minimum training trades must be an integer between 1 and 1,000')
  return { sampleCandles, execution, minimumTrainingTrades }
}

function closedSnapshot(input: readonly Candle[], request: HarmonicResearchRequest, sampleCandles: number, source?: ClosedCandleHistory): Candle[] {
  if (source && (source.symbol !== request.symbol || source.timeframe !== request.timeframe || source.market !== request.market)) throw new TypeError('Historical source identity does not match the harmonic research request')
  if (source) validateTimestamp(source.asOf, 'source.asOf')
  const asOf = Math.min(request.endTime ?? Number.MAX_SAFE_INTEGER, source?.asOf ?? Number.MAX_SAFE_INTEGER)
  // Validate before filtering: an invalid close timestamp must not silently disappear.
  if (input.some((bar) => !bar || !isValidCandle(bar))) throw new TypeError('Invalid harmonic research candle')
  const selected = input.filter((bar) => bar.closeTime <= asOf).slice(-(sampleCandles + RESEARCH_WARMUP_CANDLES))
  for (let index = 0; index < selected.length; index++) {
    const bar = selected[index]
    if (!isValidCandle(bar)) throw new TypeError('Invalid harmonic research candle')
    if ('isClosed' in bar && bar.isClosed !== true) throw new TypeError('Harmonic research requires closed candles')
    if (bar.closeTime - bar.openTime + 1 !== TIMEFRAME_MILLISECONDS[request.timeframe]) throw new TypeError('Historical candle interval does not match the research timeframe')
    if (index > 0 && bar.openTime <= selected[index - 1].closeTime) throw new TypeError('Research candles must be ordered and non-overlapping')
  }
  return selected.map(({ openTime, closeTime, open, high, low, close, volume }) => ({ openTime, closeTime, open, high, low, close, volume }))
}

function prepareSeries(candles: readonly Candle[]) {
  const bars: RsiBar[] = candles.map((bar) => ({ ...bar, rsi: Number.NaN, isClosed: true }))
  const atr: (number | null)[] = []
  const warmed = new Set<number>()
  let start = 0
  let gaps = 0
  for (let index = 1; index <= bars.length; index++) {
    if (index === bars.length || bars[index].openTime !== bars[index - 1].closeTime + 1) {
      atr.push(...analyzeVolatility(bars.slice(start, index)).points.map((point) => point.atr))
      for (let warmedIndex = start + RESEARCH_WARMUP_CANDLES; warmedIndex < index; warmedIndex++) warmed.add(warmedIndex)
      if (index < bars.length) gaps++
      start = index
    }
  }
  return { bars, atr, warmed, gaps }
}

function* harmonicResearchSteps(input: readonly Candle[], request: HarmonicResearchRequest, source?: ClosedCandleHistory): Generator<number, HarmonicResearchReport, unknown> {
  const { sampleCandles, execution, minimumTrainingTrades } = validatedRequest(request)
  request.signal?.throwIfAborted()
  const candles = closedSnapshot(input, request, sampleCandles, source)
  const windows = researchWindows(candles, sampleCandles)
  const { bars, atr, warmed, gaps } = prepareSeries(candles)
  const closeIndices = new Map(candles.map((bar, index) => [bar.closeTime, index]))
  const events: HarmonicResearchEvent[] = []
  const engines = (['fixed', 'proportional'] as const).map((expiryMode) => ({ expiryMode, state: createHarmonicReplay({ expiryMode }), seenTouches: new Set<string>(), seenPivots: new Set<string>() }))
  let replayedThrough = -1
  const replayThrough = function* (endIndex: number): Generator<number, void, unknown> {
    const last = Math.min(endIndex, bars.length - 1)
    for (let index = replayedThrough + 1; index <= last; index++) {
      request.signal?.throwIfAborted()
      const bar = bars[index]
      for (const engine of engines) {
        advanceHarmonicReplay(engine.state, bar)
        // Consume our private mutable replay immediately; exported event fields are
        // primitives. Cloning the full outcome archive on every bar is unnecessary.
        for (const setup of engine.state.setups) {
          if (!setup.d) continue
          const emit = (candidateId: HarmonicResearchCandidateId, event: HarmonicResearchEvent['event']) => {
            const detectedIndex = closeIndices.get(setup.confirmedAt)
            events.push({
              id: `${candidateId}:${setup.id}`, candidateId, setupId: setup.id, pattern: setup.kind, event,
              symbol: request.symbol, timeframe: request.timeframe, market: request.market, direction: setup.direction,
              confirmedIndex: index, confirmedAt: bar.closeTime, atr: atr[index],
              xTime: setup.x.time, cTime: setup.c.time, setupConfirmedAt: setup.confirmedAt,
              touchTime: setup.d!.time, dPivotTime: event === 'confirmed-d' ? setup.confirmedD!.time : null,
              ratioFit: getHarmonicQuality(setup).score, statusAtEvent: setup.status,
              warmupComplete: detectedIndex !== undefined && warmed.has(detectedIndex),
            })
          }
          if (!engine.seenTouches.has(setup.id)) {
            engine.seenTouches.add(setup.id)
            const touchAvailableAt = Math.max(setup.confirmedAt, setup.d.time + TIMEFRAME_MILLISECONDS[request.timeframe] - 1)
            if (setup.status === 'active' && touchAvailableAt === bar.closeTime) {
              if (engine.expiryMode === 'proportional') emit('touch-proportional', 'touch')
              else {
                emit('touch-baseline', 'touch')
                if (getHarmonicQuality(setup).score >= 80) emit('touch-quality-80', 'touch')
              }
            }
          }
          if (engine.expiryMode === 'fixed' && setup.confirmedD && setup.dConfirmedAt === bar.closeTime && !engine.seenPivots.has(setup.id)) {
            engine.seenPivots.add(setup.id)
            if (setup.status === 'active' || (setup.status === 'completed' && setup.endedAt === bar.closeTime)) emit('confirmed-d', 'confirmed-d')
          }
        }
      }
      if ((index + 1) % 250 === 0) yield index + 1
    }
    replayedThrough = Math.max(replayedThrough, last)
  }
  const evaluate = (candidateId: HarmonicResearchCandidateId, window: ResearchWindow, settings = execution): HarmonicResearchEvaluation => {
    const inWindow = events.filter((event) => event.candidateId === candidateId && event.confirmedIndex >= window.startIndex && event.confirmedIndex <= window.endIndex)
    const eventExclusions = { warmup: 0, formationBoundary: 0 }
    const eligible = inWindow.filter((event) => {
      if (!event.warmupComplete) { eventExclusions.warmup++; return false }
      if (event.xTime < (window.startTime ?? Infinity) || event.setupConfirmedAt < (window.startTime ?? Infinity)) { eventExclusions.formationBoundary++; return false }
      return true
    })
    return { ...simulateResearchSignals(candles, eligible, window, settings, candidateId), eventExclusions }
  }
  yield* replayThrough(windows.training.endIndex)
  const training = HARMONIC_RESEARCH_CANDIDATES.map((candidate) => evaluate(candidate.id, windows.training))
  const selection = selectResearchCandidate(training, minimumTrainingTrades, 'touch-baseline')
  // Freeze selection before even replaying validation/holdout candles.
  yield* replayThrough(windows.validation.endIndex)
  const validation = HARMONIC_RESEARCH_CANDIDATES.map((candidate) => evaluate(candidate.id, windows.validation))
  yield* replayThrough(windows.holdout.endIndex)
  const results = HARMONIC_RESEARCH_CANDIDATES.map((candidate, index) => ({ candidate, training: training[index], validation: validation[index], holdout: evaluate(candidate.id, windows.holdout) }))
  const selectedId = selection.candidateId as HarmonicResearchCandidateId
  const costSensitivity = [0, 1, 2].map((multiplier) => ({ multiplier, evaluation: evaluate(selectedId, windows.holdout, {
    ...execution, feeBps: execution.feeBps * multiplier, slippageBps: execution.slippageBps * multiplier, carryingBpsPerDay: execution.carryingBpsPerDay * multiplier,
  }) }))
  const warnings = [...(source?.warnings ?? [])]
  if (candles.length < sampleCandles + RESEARCH_WARMUP_CANDLES) warnings.push(`Only ${candles.length} of ${sampleCandles + RESEARCH_WARMUP_CANDLES} requested candles are available, including warmup.`)
  if (gaps) warnings.push(`${gaps} history gaps: harmonic structure and warmup restart; outcomes spanning missing candles are excluded.`)
  if (windows.holdout.candleCount <= Math.max(execution.maxHoldingBars, execution.forwardBars)) warnings.push('Insufficient candles for a complete holdout outcome; load a larger sample.')
  if (!selection.sufficientSample) warnings.push(`No candidate has ${minimumTrainingTrades} training trades. The baseline is retained without evidence of a preferred candidate.`)
  const selected = results.find((result) => result.candidate.id === selection.candidateId)!
  if (selected.holdout.summary.trades < minimumTrainingTrades) warnings.push(`The selected candidate has only ${selected.holdout.summary.trades} holdout trades; insufficient sample size for a performance conclusion.`)
  if (request.market === 'tradfi') warnings.push(`Futures carry assumes ${execution.carryingBpsPerDay} bp/day. Actual funding, margin and liquidation are not reconstructed.`)
  return {
    schemaVersion: 1, study: 'harmonic-atr-benchmark', generatedAt: new Date().toISOString(),
    symbol: request.symbol, timeframe: request.timeframe, market: request.market, execution,
    source: { asOf: Math.min(request.endTime ?? Infinity, source?.asOf ?? candles.at(-1)?.closeTime ?? 0), complete: (source?.complete ?? true) && candles.length >= sampleCandles + RESEARCH_WARMUP_CANDLES && gaps === 0, warnings: [...new Set(warnings)], requestedCandles: sampleCandles, loadedCandles: candles.length },
    windows, selection: { ...selection, frozenAt: windows.training.endTime, minimumTrainingTrades, criterion: 'Highest training net expectancy among candidates meeting the minimum trade count; preset order breaks ties. Baseline fallback when none qualify.' },
    results, costSensitivity, events, candles, methodology: HARMONIC_RESEARCH_METHODOLOGY,
  }
}

export function evaluateHarmonicResearch(input: readonly Candle[], request: HarmonicResearchRequest, source?: ClosedCandleHistory): HarmonicResearchReport {
  const steps = harmonicResearchSteps(input, request, source)
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}

export async function runHarmonicResearch(request: HarmonicResearchRequest, fetcher: typeof fetch = fetch): Promise<HarmonicResearchReport> {
  const { sampleCandles } = validatedRequest(request)
  const history = await fetchClosedCandleHistory({ symbol: request.symbol, timeframe: request.timeframe, market: request.market, count: sampleCandles + RESEARCH_WARMUP_CANDLES, endTime: request.endTime, signal: request.signal, onProgress: request.onProgress }, fetcher)
  request.signal?.throwIfAborted()
  request.onPhase?.('Comparing harmonic events across chronological periods…')
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  request.signal?.throwIfAborted()
  const steps = harmonicResearchSteps(history.candles, request, history)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
    request.onPhase?.(`Replayed ${step.value.toLocaleString()} closed candles…`)
    // Release the main thread between bounded replay batches so Cancel, market
    // switches, and progress updates remain responsive during computation.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    request.signal?.throwIfAborted()
  }
}

export function exportHarmonicResearchCsv(report: HarmonicResearchReport): string {
  const rows: (string | number | null)[][] = [[
    'market', 'symbol', 'timeframe', 'candidate', 'partition', 'start_time', 'end_time', 'frozen_selection',
    'signals', 'excluded_warmup', 'excluded_formation_boundary', 'excluded_outcome_boundary', 'excluded_gap', 'excluded_atr', 'excluded_overlap', 'excluded_spot_short', 'excluded_insolvent',
    'trades', 'win_rate', 'expectancy', 'gross_expectancy', 'compounded_return', 'realized_max_drawdown', 'fees_sum', 'slippage_sum', 'carry_sum', 'forward_observations', 'mean_forward_return', 'mean_mfe', 'mean_mae',
  ]]
  for (const result of report.results) for (const partition of ['training', 'validation', 'holdout'] as const) {
    const { summary, window, excluded, eventExclusions, signals } = result[partition]
    rows.push([
      report.market, report.symbol, report.timeframe, result.candidate.id, partition, window.startTime, window.endTime, String(report.selection.candidateId === result.candidate.id),
      signals, eventExclusions.warmup, eventExclusions.formationBoundary, excluded.boundary, excluded.gap, excluded.atr, excluded.overlap, excluded.spotShort, excluded.insolvent,
      summary.trades, summary.winRate, summary.expectancy, summary.grossExpectancy, summary.compoundedReturn, summary.maxDrawdown, summary.totalFees, summary.totalSlippage, summary.totalCarryingCost, summary.observations, summary.meanForwardReturn, summary.meanMfe, summary.meanMae,
    ])
  }
  return rows.map((row) => row.map((value) => {
    const text = value === null ? '' : String(value)
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }).join(',')).join('\n') + '\n'
}

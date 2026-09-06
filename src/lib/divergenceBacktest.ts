import type { Candle, RsiBar, Timeframe } from '../types'
import type { DivergenceKind } from './divergence'
import {
  DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS,
  findRsiDivergenceSetups,
} from './divergenceLifecycle'
import type { DivergenceLifecycleOptions, DivergenceSetup } from './divergenceLifecycle'
import {
  fetchClosedCandleHistory,
  TIMEFRAME_MILLISECONDS,
  validateHistoryIdentity,
  validateTimestamp,
} from './binanceHistory'
import type { HistoryProgress } from './binanceHistory'
import { advanceRsiState, RSI_LENGTH, seedRsiState } from './rsi'
import type { RsiState } from './rsi'
import { isValidCandle } from './rsiHistory'

export const BACKTEST_SAMPLE_CANDLES = 3_000
/** 250 preceding closes settle Wilder smoothing and supply historical pivots. */
export const BACKTEST_WARMUP_CANDLES = 250
export const MAX_BACKTEST_SAMPLE_CANDLES = 100_000

export type BacktestDisposition =
  | 'hit' | 'harmonised' | 'expired' | 'still-open'
  | 'unconfirmed' | 'preconfirmation-harmonised' | 'interrupted'
  | 'confirmation-target' | 'invalid-outcome'

export interface BacktestSummary {
  detected: number
  confirmed: number
  targetHits: number
  confirmedHarmonised: number
  expired: number
  /** Exactly targetHits + confirmedHarmonised + expired. */
  denominator: number
  /** A proportion in [0, 1]; null when there are no eligible resolved setups. */
  targetHitRate: number | null
  excluded: {
    stillOpen: number
    unconfirmed: number
    preconfirmationHarmonised: number
    interrupted: number
    confirmationTarget: number
    invalidOutcome: number
  }
}

export interface BacktestSource {
  kind: 'binance' | 'offline'
  asOf: number
  serverTime: number | null
  complete: boolean
  error: string | null
  warnings: string[]
}

export interface BacktestHistoryOptions {
  symbol: string
  timeframe: Timeframe
  sampleCandles?: number
  options?: Partial<DivergenceLifecycleOptions>
  /** Inclusive lower boundary for evaluated candle OPEN times; warmup precedes it. */
  startTime?: number
  /** Inclusive upper boundary for candle CLOSE times. */
  endTime?: number
  source?: BacktestSource
}

export interface BacktestRequest extends Omit<BacktestHistoryOptions, 'source'> {
  signal?: AbortSignal
  onProgress?: (progress: HistoryProgress) => void
}

export interface DivergenceBacktestReport {
  schemaVersion: 1
  symbol: string
  timeframe: Timeframe
  generatedAt: string
  settings: DivergenceLifecycleOptions
  source: BacktestSource
  window: {
    requestedCandles: number
    requestedStartTime: number | null
    requestedEndTime: number | null
    loadedCandles: number
    sampleCandles: number
    evaluatedCandles: number
    warmupCandles: number
    warmupExcludedCandles: number
    warmupExcludedSetups: number
    startTime: number | null
    endTime: number | null
    gaps: number
  }
  summary: BacktestSummary
  byKind: Record<DivergenceKind, BacktestSummary>
  setups: (DivergenceSetup & { backtestDisposition: BacktestDisposition })[]
  /** The closed OHLC snapshot is retained so JSON exports can be replayed offline. */
  candles: Candle[]
  methodology: string
}

export const BACKTEST_METHODOLOGY = 'RSI 50 target outcomes, not trade P&L. '
  + 'Hit rate = targets reached after confirmation / (those targets + confirmed harmonisations + expiries). '
  + 'Still-open, interrupted, unconfirmed, preconfirmation-harmonised, and confirmation-candle target outcomes '
  + 'are excluded. Only setups detected inside the sampled window after 250 contiguous warmup candles '
  + 'are evaluated. Counts can contain overlapping setups and are not independent trades; fees, fills, '
  + 'slippage, position sizing, and price returns are not modeled.'

export function backtestDisposition(setup: DivergenceSetup): BacktestDisposition {
  if (setup.state === 'interrupted') return 'interrupted'
  if (setup.state === 'forming' || setup.state === 'confirmed') return 'still-open'
  if (setup.state === 'unconfirmed') return 'unconfirmed'
  if (setup.state === 'harmonised') {
    return setup.confirmedAt === null ? 'preconfirmation-harmonised' : 'harmonised'
  }
  if (setup.state === 'expired' && setup.confirmedAt !== null) return 'expired'
  if (setup.state === 'completed' && setup.confirmedAt !== null && setup.resolvedAt !== null) {
    return setup.resolvedAt > setup.confirmedAt ? 'hit' : 'confirmation-target'
  }
  return 'invalid-outcome'
}

export function summarizeDivergenceSetups(setups: readonly DivergenceSetup[]): BacktestSummary {
  const summary: BacktestSummary = {
    detected: setups.length, confirmed: 0, targetHits: 0,
    confirmedHarmonised: 0, expired: 0, denominator: 0, targetHitRate: null,
    excluded: {
      stillOpen: 0, unconfirmed: 0, preconfirmationHarmonised: 0,
      interrupted: 0, confirmationTarget: 0, invalidOutcome: 0,
    },
  }
  for (const setup of setups) {
    if (setup.confirmedAt !== null) summary.confirmed++
    switch (backtestDisposition(setup)) {
      case 'hit': summary.targetHits++; break
      case 'harmonised': summary.confirmedHarmonised++; break
      case 'expired': summary.expired++; break
      case 'still-open': summary.excluded.stillOpen++; break
      case 'unconfirmed': summary.excluded.unconfirmed++; break
      case 'preconfirmation-harmonised': summary.excluded.preconfirmationHarmonised++; break
      case 'interrupted': summary.excluded.interrupted++; break
      case 'confirmation-target': summary.excluded.confirmationTarget++; break
      case 'invalid-outcome': summary.excluded.invalidOutcome++; break
    }
  }
  summary.denominator = summary.targetHits + summary.confirmedHarmonised + summary.expired
  summary.targetHitRate = summary.denominator > 0 ? summary.targetHits / summary.denominator : null
  return summary
}

interface FullRsiHistory {
  bars: RsiBar[]
  warmedUpCloseTimes: Set<number>
  gaps: number
}

/** Never use the live feed's 200-bar cap for a historical run. */
export function buildHistoricalRsiBars(candles: readonly Candle[]): FullRsiHistory {
  const bars: RsiBar[] = []
  const warmedUpCloseTimes = new Set<number>()
  let state: RsiState | null = null
  let segment: Candle[] = []
  let segmentLength = 0
  let gaps = 0
  for (let index = 0; index < candles.length; index++) {
    const candle = candles[index]
    if (!isValidCandle(candle)) throw new TypeError('Invalid historical candle')
    const previous = candles[index - 1]
    if (previous && candle.openTime <= previous.closeTime) {
      throw new TypeError('Historical candles must be ordered without duplicates or overlaps')
    }
    if (previous && candle.openTime !== previous.closeTime + 1) {
      gaps++
      segment = []
      segmentLength = 0
      state = null
    }
    if (state) {
      state = advanceRsiState(state, candle.close)
    } else {
      segment.push(candle)
      if (segment.length === RSI_LENGTH + 1) {
        state = seedRsiState(segment.map((entry) => entry.close))
        segment = []
      }
    }
    // NaN warmup markers preserve gap boundaries even when the final segment
    // is too short to seed RSI. The shared engine marks live setups interrupted.
    bars.push({ ...candle, rsi: state?.series.at(-1) ?? Number.NaN, isClosed: true })
    if (segmentLength >= BACKTEST_WARMUP_CANDLES) warmedUpCloseTimes.add(candle.closeTime)
    segmentLength++
  }
  return { bars, warmedUpCloseTimes, gaps }
}

function validateRequest(request: BacktestHistoryOptions): number {
  validateHistoryIdentity(request.symbol, request.timeframe)
  const sampleCandles = request.sampleCandles ?? BACKTEST_SAMPLE_CANDLES
  if (!Number.isSafeInteger(sampleCandles) || sampleCandles < 1 || sampleCandles > MAX_BACKTEST_SAMPLE_CANDLES) {
    throw new RangeError(`sampleCandles must be between 1 and ${MAX_BACKTEST_SAMPLE_CANDLES}`)
  }
  if (request.startTime !== undefined) validateTimestamp(request.startTime, 'startTime')
  if (request.endTime !== undefined) validateTimestamp(request.endTime, 'endTime')
  if (request.startTime !== undefined && request.endTime !== undefined && request.startTime > request.endTime) {
    throw new RangeError('startTime must not be later than endTime')
  }
  // The shared engine is also the authority for lifecycle option validation.
  findRsiDivergenceSetups([], request.options)
  return sampleCandles
}

/** Evaluate a closed snapshot with the exact same state machine as the cards. */
export function backtestDivergenceHistory(
  input: readonly Candle[],
  request: BacktestHistoryOptions,
): DivergenceBacktestReport {
  const sampleCandles = validateRequest(request)
  const settings = { ...DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS, ...request.options }
  const snapshotEnd = Math.min(request.endTime ?? Number.MAX_SAFE_INTEGER, request.source?.asOf ?? Number.MAX_SAFE_INTEGER)
  const candles = input.filter((candle) => candle.closeTime <= snapshotEnd)
  for (const candle of candles) {
    if (candle.closeTime - candle.openTime + 1 !== TIMEFRAME_MILLISECONDS[request.timeframe]) {
      throw new TypeError('Historical candle interval does not match the selected timeframe')
    }
  }
  const { bars, warmedUpCloseTimes, gaps } = buildHistoricalRsiBars(candles)
  const sample = candles.slice(BACKTEST_WARMUP_CANDLES)
    .filter((candle) => request.startTime === undefined || candle.openTime >= request.startTime)
    .slice(-sampleCandles)
  const first = sample[0]
  const last = sample.at(-1)
  const windowSetups = findRsiDivergenceSetups(bars, settings).filter((setup) =>
    first !== undefined && last !== undefined
    && setup.detectedAt >= first.closeTime && setup.detectedAt <= last.closeTime)
  const setups = windowSetups.filter((setup) => warmedUpCloseTimes.has(setup.detectedAt))
    .map((setup) => ({ ...setup, backtestDisposition: backtestDisposition(setup) }))
  const kinds: readonly DivergenceKind[] = ['regular-bullish', 'regular-bearish', 'hidden-bullish', 'hidden-bearish']
  const byKind = Object.fromEntries(kinds.map((kind) => [
    kind, summarizeDivergenceSetups(setups.filter((setup) => setup.kind === kind)),
  ])) as Record<DivergenceKind, BacktestSummary>
  const evaluatedCandles = sample.filter((candle) => warmedUpCloseTimes.has(candle.closeTime)).length
  const warnings = [...(request.source?.warnings ?? [])]
  if (candles.length < sampleCandles + BACKTEST_WARMUP_CANDLES && !request.source?.warnings.length) {
    warnings.push(`Only ${candles.length} closed candles are available; ${BACKTEST_WARMUP_CANDLES} are reserved for warmup.`)
  }
  if (gaps > 0) warnings.push(`${gaps} history gap${gaps === 1 ? '' : 's'}: RSI restarts with a fresh 250-candle warmup after each gap.`)
  if (evaluatedCandles === 0) warnings.push('No candles remain for evaluation after the date boundaries and RSI warmup.')
  return {
    schemaVersion: 1,
    symbol: request.symbol,
    timeframe: request.timeframe,
    generatedAt: new Date().toISOString(),
    settings,
    source: {
      kind: request.source?.kind ?? 'offline',
      asOf: request.source?.asOf ?? (request.endTime ?? candles.at(-1)?.closeTime ?? 0),
      serverTime: request.source?.serverTime ?? null,
      complete: (request.source?.complete ?? candles.length >= sampleCandles + BACKTEST_WARMUP_CANDLES) && gaps === 0,
      error: request.source?.error ?? null,
      warnings,
    },
    window: {
      requestedCandles: sampleCandles,
      requestedStartTime: request.startTime ?? null,
      requestedEndTime: request.endTime ?? null,
      loadedCandles: candles.length,
      sampleCandles: sample.length,
      evaluatedCandles,
      warmupCandles: Math.min(candles.length, BACKTEST_WARMUP_CANDLES),
      warmupExcludedCandles: sample.length - evaluatedCandles,
      warmupExcludedSetups: windowSetups.length - setups.length,
      startTime: first?.openTime ?? null,
      endTime: last?.closeTime ?? null,
      gaps,
    },
    summary: summarizeDivergenceSetups(setups),
    byKind,
    setups,
    candles,
    methodology: BACKTEST_METHODOLOGY,
  }
}

export async function runDivergenceBacktest(
  request: BacktestRequest,
  fetcher: typeof fetch = fetch,
): Promise<DivergenceBacktestReport> {
  const sampleCandles = validateRequest(request)
  const history = await fetchClosedCandleHistory({
    symbol: request.symbol, timeframe: request.timeframe,
    count: sampleCandles + BACKTEST_WARMUP_CANDLES,
    endTime: request.endTime, signal: request.signal, onProgress: request.onProgress,
  }, fetcher)
  request.signal?.throwIfAborted()
  return backtestDivergenceHistory(history.candles, {
    ...request,
    source: {
      kind: 'binance', asOf: history.asOf, serverTime: history.serverTime,
      complete: history.complete, error: history.error, warnings: history.warnings,
    },
  })
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** A summary row is emitted even for symbols with zero detected setups. */
export function divergenceBacktestsToCsv(reports: readonly DivergenceBacktestReport[]): string {
  const rows: (string | number | null)[][] = [[
    'record_type', 'symbol', 'timeframe', 'source_complete', 'as_of', 'sample_candles', 'evaluated_candles',
    'detected', 'target_hits', 'confirmed_harmonised', 'expired', 'denominator', 'target_hit_rate',
    'excluded_still_open', 'excluded_unconfirmed', 'excluded_preconfirmation_harmonised',
    'excluded_interrupted', 'excluded_confirmation_target', 'excluded_invalid_outcome',
    'settings_json', 'setup_id', 'kind', 'state', 'disposition', 'detected_at', 'confirmed_at',
    'resolved_at', 'confirmation', 'first_pivot_time', 'first_pivot_price', 'first_pivot_rsi',
    'second_pivot_time', 'second_pivot_price', 'second_pivot_rsi', 'bars_elapsed', 'expiry_bars',
    'invalidation_anchor', 'invalidation_rsi', 'resolution_reason',
  ]]
  for (const report of reports) {
    const { summary, source, window: windowInfo } = report
    const common: (string | number | null)[] = [
      report.symbol, report.timeframe, String(source.complete), source.asOf,
      windowInfo.sampleCandles, windowInfo.evaluatedCandles, summary.detected,
      summary.targetHits, summary.confirmedHarmonised, summary.expired,
      summary.denominator, summary.targetHitRate,
      summary.excluded.stillOpen, summary.excluded.unconfirmed, summary.excluded.preconfirmationHarmonised,
      summary.excluded.interrupted, summary.excluded.confirmationTarget, summary.excluded.invalidOutcome,
      JSON.stringify(report.settings),
    ]
    rows.push(['summary', ...common, ...Array<string>(19).fill('')])
    for (const setup of report.setups) {
      rows.push([
        'setup', ...common, setup.id, setup.kind, setup.state, setup.backtestDisposition,
        setup.detectedAt, setup.confirmedAt, setup.resolvedAt, setup.confirmation,
        setup.start.time, setup.start.price, setup.start.rsi,
        setup.end.time, setup.end.price, setup.end.rsi,
        setup.barsElapsed, setup.expiryBars, setup.invalidationAnchor, setup.invalidationRsi,
        setup.resolutionReason,
      ])
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n'
}

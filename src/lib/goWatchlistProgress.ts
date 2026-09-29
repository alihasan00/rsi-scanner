import type { Timeframe } from '../types'
import { GO_WATCHLIST_TIMEFRAMES, getGoWatchlistExpectedClose } from './goWatchlistTimeframes'
import type { GoWatchlistFrameUpdate } from './goWatchlistFeed'
import type { GoWatchlistResult } from './goWatchlist'

export interface WatchlistSeedProgress {
  readonly completeSymbols: readonly string[]
  /** Independent source frames can make the same asset eligible at different times. */
  readonly readySourceKeys?: readonly string[]
  readonly attemptedFrames: number
  readonly totalFrames: number
}

export function getWatchlistSeedProgress(symbols: readonly string[], frames: readonly GoWatchlistFrameUpdate[],
  timeframes: readonly Timeframe[] = GO_WATCHLIST_TIMEFRAMES, mode: 'complete' | 'independent' = 'complete'): WatchlistSeedProgress {
  const allowed = new Set(symbols)
  const indexed = new Map(frames.filter((frame) => allowed.has(frame.symbol) && timeframes.includes(frame.timeframe)).map((frame) => [`${frame.symbol}:${frame.timeframe}`, frame]))
  const readySourceKeys = symbols.flatMap((symbol) => timeframes.filter((timeframe) => indexed.get(`${symbol}:${timeframe}`)?.status === 'ready')
    .map((timeframe) => `${symbol}:${timeframe}`))
  return {
    completeSymbols: symbols.filter((symbol) => mode === 'independent'
      ? timeframes.some((timeframe) => indexed.get(`${symbol}:${timeframe}`)?.status === 'ready')
      : timeframes.every((timeframe) => indexed.get(`${symbol}:${timeframe}`)?.status === 'ready')),
    ...(mode === 'independent' ? {readySourceKeys} : {}),
    attemptedFrames: indexed.size,
    totalFrames: symbols.length * timeframes.length,
  }
}

export interface ScheduledWatchlistScan { readonly id: number; readonly evaluatedAt: number; readonly allSeedsAttempted: boolean }

/** A revised closed candle invalidates the saved evaluation even when its close time is unchanged. */
export function isEvaluatedWatchlistSourceCurrent(
  current: GoWatchlistFrameUpdate | undefined,
  evaluated: GoWatchlistFrameUpdate | undefined,
  now: number,
): boolean {
  return !!current && !!evaluated && current.status === 'ready' && evaluated.status === 'ready'
    && current.candles === evaluated.candles
    && current.receivedAt <= now + 5_000 && now - current.receivedAt <= 120_000
}

/** Deterministic admission gate: one scan at a time and no tick-driven startup scans. */
export class GoWatchlistScheduler {
  private pending: ScheduledWatchlistScan | null = null
  private lastStartedAt: number | null = null
  private lastSeedKey = ''
  private sequence = 0
  private completedInitialScan = false

  get busy(): boolean { return this.pending !== null }
  get initialScanComplete(): boolean { return this.completedInitialScan }

  begin(now: number, progress: WatchlistSeedProgress): ScheduledWatchlistScan | null {
    if (this.pending) return null
    const allSeedsAttempted = progress.totalFrames > 0 && progress.attemptedFrames === progress.totalFrames
    const seedKey = `${(progress.readySourceKeys ?? progress.completeSymbols).join(',')}:${allSeedsAttempted}`
    if (!this.completedInitialScan && ((!progress.completeSymbols.length && !allSeedsAttempted) || seedKey === this.lastSeedKey)) return null
    const interval = this.completedInitialScan ? 30_000 : 6_000
    if (this.lastStartedAt !== null && now - this.lastStartedAt < interval) return null
    this.lastStartedAt = now
    this.lastSeedKey = seedKey
    this.pending = {id: ++this.sequence, evaluatedAt: now, allSeedsAttempted}
    return this.pending
  }

  /** Initial loading ends only when the final attempted-input scan is published. */
  publish(id: number): boolean {
    if (id !== this.pending?.id) return false
    this.completedInitialScan ||= this.pending.allSeedsAttempted
    this.pending = null
    return true
  }

  fail(): void {
    this.pending = null
    this.lastSeedKey = ''
  }
}

export function getGoWatchlistCoverage(
  frames: readonly GoWatchlistFrameUpdate[],
  evaluation: GoWatchlistResult['scan'] | null,
  evaluatedSources: readonly GoWatchlistFrameUpdate[],
  now: number,
  total: number,
) {
  const coverage = {total, fresh: 0, loading: 0, error: 0, delayed: 0}
  const evaluatedFrames = new Map(evaluation?.series.map((frame) => [`${frame.symbol}:${frame.interval}`, frame]) ?? [])
  const evaluationErrors = new Map(evaluation?.errors.map((frame) => [`${frame.symbol}:${frame.interval}`, frame.error]) ?? [])
  const sources = new Map(evaluatedSources.map((frame) => [`${frame.symbol}:${frame.timeframe}`, frame]))
  let feedError: string | null = null
  for (const frame of frames) {
    const key = `${frame.symbol}:${frame.timeframe}`
    const source = sources.get(key)
    const evaluated = evaluatedFrames.get(key)
    const expectedClose = getGoWatchlistExpectedClose(now, frame.timeframe, frame.candles.at(-1)?.closeTime ?? 0)
    if (frame.status === 'error') {
      coverage.error++
      feedError ??= frame.error
    } else if (now - frame.receivedAt > 120_000) coverage.delayed++
    else if (!source || source.candles !== frame.candles || source.status !== frame.status
      || (evaluated?.ready && evaluated.lastClosedAt < expectedClose)
      || (!evaluated?.ready && source.receivedAt !== frame.receivedAt)) coverage.loading++
    else if (evaluationErrors.has(key) || evaluated?.ready !== true) {
      coverage.error++
      feedError ??= evaluationErrors.get(key) ?? 'Some histories lack complete, current analysis on the required timeframes.'
    } else coverage.fresh++
  }
  const remainingInitialFrames = Math.max(0, total - frames.length)
  coverage.loading += remainingInitialFrames
  return {coverage, feedError, remainingInitialFrames}
}

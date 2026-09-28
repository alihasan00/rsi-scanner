import type { Candle, Timeframe } from '../types'
import type { GoWatchlistFrameUpdate } from './goWatchlistFeed'
import { captureIchimoku } from './watchlistIchimoku'
import type { IchimokuLectureSnapshot, IchimokuPoint } from './watchlistIchimoku'

export interface WatchlistChartFrame {
  readonly timeframe: Timeframe
  readonly candles: readonly Candle[]
  readonly preview: Candle | null
  readonly receivedAt: number
  readonly lastClosedAt: number
  readonly ichimoku?: IchimokuLectureSnapshot
  readonly ichimokuSeries?: readonly IchimokuPoint[]
}

export interface WatchlistChartPoint {
  readonly label: string
  readonly timeframe: Timeframe
  /** Actual source candle opening time, never a projected pivot time. */
  readonly time: number
  readonly price: number
}

export interface WatchlistChartEvent {
  readonly kind: 'detected' | 'confirmation' | 'break' | 'retest' | 'trigger' | 'entry-touch' | 'source'
  readonly label: string
  readonly timeframe: Timeframe
  /** Original Go event time; confirmation events use inclusive candle closes. */
  readonly time: number
  readonly price: number | null
  readonly low?: number
  readonly high?: number
}

export interface WatchlistChartEvidence {
  readonly label: string
  readonly detail: string
  readonly timeframe?: Timeframe
  readonly time?: number
}

export interface WatchlistChartSnapshot {
  readonly snapshotId: string
  readonly evaluatedAt: number
  readonly defaultTimeframe: Timeframe
  readonly frames: readonly WatchlistChartFrame[]
  readonly points: readonly WatchlistChartPoint[]
  readonly events: readonly WatchlistChartEvent[]
  readonly sourceWindow?: { readonly timeframe: Timeframe; readonly startTime: number; readonly endTime: number }
  readonly evidence: readonly WatchlistChartEvidence[]
  readonly notes: readonly string[]
}

export interface WatchlistEvaluatedHistory {
  readonly symbol: string
  readonly timeframe: Timeframe
  readonly candles: readonly Candle[]
  readonly preview: Candle | null
  readonly receivedAt: number
  readonly status: 'ready' | 'error'
  readonly error: string | null
}

export interface WatchlistEvaluationInput {
  readonly snapshotId: string
  readonly evaluatedAt: number
  readonly histories: readonly WatchlistEvaluatedHistory[]
}

// Feed publications are immutable. Verify an array once, then share it across
// evaluations until a final candle or REST correction replaces that array.
const immutableHistories = new WeakSet<readonly Candle[]>()
function captureCandles(candles: readonly Candle[]): readonly Candle[] {
  if (immutableHistories.has(candles)) return candles
  if (Object.isFrozen(candles) && candles.every((candle) => Object.isFrozen(candle))) {
    immutableHistories.add(candles)
    return candles
  }
  // Other callers may still supply mutable arrays or mutable candle objects.
  return Object.freeze(candles.map((candle) => Object.freeze({...candle})))
}

/** Capture once, before dispatch. Later socket ticks cannot change this scan. */
export function captureWatchlistEvaluation(
  snapshotId: string,
  evaluatedAt: number,
  histories: readonly GoWatchlistFrameUpdate[],
): WatchlistEvaluationInput {
  return Object.freeze({snapshotId, evaluatedAt, histories: Object.freeze(histories.map((history) => Object.freeze({
    ...history,
    candles: captureCandles(history.candles),
    preview: history.preview ? Object.freeze({...history.preview}) : null,
  })))})
}

/** Only attach the exact input whose successful receipt and close Go returned. */
export function getEvaluatedChartFrames(
  input: WatchlistEvaluationInput | undefined,
  symbol: string,
  evidence: readonly {interval: Timeframe; observedAt: number; lastClosedAt: number; ready: boolean;
    ichimoku?: IchimokuLectureSnapshot | null; ichimokuSeries?: readonly IchimokuPoint[] | null}[],
): readonly WatchlistChartFrame[] {
  if (!input) return []
  const frames: WatchlistChartFrame[] = []
  for (const history of input.histories) {
    if (history.symbol !== symbol || history.status !== 'ready') continue
    const frame = evidence.find((item) => item.interval === history.timeframe)
    if (!frame?.ready || history.receivedAt !== frame.observedAt || history.candles.at(-1)?.closeTime !== frame.lastClosedAt
      || history.candles.some((candle) => candle.closeTime > input.evaluatedAt)) continue
    frames.push(Object.freeze({
      timeframe: history.timeframe, candles: history.candles,
      preview: history.preview && history.preview.openTime <= input.evaluatedAt ? history.preview : null,
      receivedAt: history.receivedAt, lastClosedAt: frame.lastClosedAt,
      ...captureIchimoku(frame.ichimoku, frame.ichimokuSeries, history.candles, input.evaluatedAt),
    }))
  }
  return Object.freeze(frames)
}

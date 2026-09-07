import type { RsiBar } from '../types'
import { isValidCandle } from './rsiHistory'

/** The same screening filters used by the independent CLI. */
export const TUG_OF_WAR_SETTINGS = {
  warmupCandles: 20,
  minWickRatio: 0.05,
  minTowCandles: 2,
  minBodyRatio: 0.3,
} as const

export type TugOfWarDirection = 'bullish' | 'bearish'
export type TugOfWarControl = TugOfWarDirection | 'tugOfWar' | 'neutral'

/** Synthetic chart prices; use the raw close for market price references. */
export interface HeikinAshiBar {
  openTime: number
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  body: number
  upperWick: number
  lowerWick: number
  isClosed: true
  startsNewSegment: boolean
}

export interface TugOfWarConfirmation {
  direction: TugOfWarDirection
  kind: 'continuation' | 'reversal' | 'undetermined'
  towStartTime: number
  towCandleCount: number
  confirmedAt: number
  /** The confirming NORMAL candle's close, never a synthetic HA price. */
  referencePrice: number
}

export interface TugOfWarAnalysis {
  control: TugOfWarControl | null
  /** Last accepted direction in this segment, including during pending TOW. */
  trend: TugOfWarDirection | null
  pendingTowCandles: number
  isWarmup: boolean
  /** Only a confirmation on the latest closed candle, never an older signal. */
  confirmation: TugOfWarConfirmation | null
  lastClosedTime: number | null
  lastClose: number | null
  analyzedCandles: number
  segmentCandles: number
  excludedOpenCandles: number
  gapCount: number
  heikinAshi: HeikinAshiBar[]
}

/** Current candle shape only; none of these projected decisions are closed. */
export interface TugOfWarPreview {
  control: TugOfWarControl
  /** Direction if the current shape closes; the cached closed trend is intact. */
  trend: TugOfWarDirection | null
  /** Projected pending sequence, including the current candle when it is TOW. */
  pendingTowCandles: number
  isWarmup: boolean
  isBodyQualified: boolean
  openTime: number
  closeTime: number
  heikinAshi: Omit<HeikinAshiBar, 'isClosed'> & { isClosed: false }
  possibleResolution: {
    direction: TugOfWarDirection
    kind: TugOfWarConfirmation['kind']
    towCandleCount: number
  } | null
}

export interface TugOfWarPresentation {
  label: string
  tone: TugOfWarDirection | 'neutral' | 'pending'
  detail: string
}

// Positive finite prices allow this midpoint without overflowing their sum.
function midpoint(first: number, second: number): number {
  const low = Math.min(first, second)
  return low + (Math.max(first, second) - low) / 2
}

function classifyControl(bar: Pick<HeikinAshiBar, 'high' | 'low' | 'upperWick' | 'lowerWick'>): TugOfWarControl {
  const threshold = Math.max(
    8 * Number.EPSILON * Math.max(Math.abs(bar.high), Math.abs(bar.low)),
    TUG_OF_WAR_SETTINGS.minWickRatio * (bar.high - bar.low),
  )
  const upper = bar.upperWick > threshold
  const lower = bar.lowerWick > threshold
  if (upper && lower) return 'tugOfWar'
  if (upper) return 'bullish'
  if (lower) return 'bearish'
  return 'neutral'
}

/**
 * Analyze chronological browser candle history without contacting the CLI.
 * Closure comes from the feed's isClosed flag. Forming bars cannot alter HA
 * recursion, remembered control, pending decisions, or confirmations.
 * Gaps restart both HA and TOW state; invalid/overlapping candles are rejected.
 */
export function analyzeTugOfWar(bars: readonly RsiBar[]): TugOfWarAnalysis {
  const result: TugOfWarAnalysis = {
    control: null,
    trend: null,
    pendingTowCandles: 0,
    isWarmup: false,
    confirmation: null,
    lastClosedTime: null,
    lastClose: null,
    analyzedCandles: 0,
    segmentCandles: 0,
    excludedOpenCandles: 0,
    gapCount: 0,
    heikinAshi: [],
  }
  let towStartTime: number | null = null

  for (let index = 0; index < bars.length; index++) {
    const raw = bars[index]
    if (!isValidCandle(raw)) throw new Error(`Invalid tug-of-war candle at index ${index}`)
    if (index > 0 && raw.openTime <= bars[index - 1].closeTime) {
      throw new Error('Tug-of-war candles must be chronological without overlap')
    }
    if (!raw.isClosed) {
      result.excludedOpenCandles += 1
      continue
    }

    const previous = result.heikinAshi.at(-1)
    const startsNewSegment = !previous || raw.openTime !== previous.closeTime + 1
    if (startsNewSegment) {
      if (previous) result.gapCount += 1
      result.segmentCandles = 0
      result.trend = null
      result.pendingTowCandles = 0
      towStartTime = null
    }

    const open = startsNewSegment
      ? midpoint(raw.open, raw.close)
      : midpoint(previous.open, previous.close)
    const close = midpoint(midpoint(raw.open, raw.high), midpoint(raw.low, raw.close))
    const high = Math.max(raw.high, open, close)
    const low = Math.min(raw.low, open, close)
    const ha: HeikinAshiBar = {
      openTime: raw.openTime,
      closeTime: raw.closeTime,
      open,
      high,
      low,
      close,
      body: Math.abs(close - open),
      upperWick: Math.max(0, high - Math.max(open, close)),
      lowerWick: Math.max(0, Math.min(open, close) - low),
      isClosed: true,
      startsNewSegment,
    }
    result.heikinAshi.push(ha)
    result.isWarmup = result.segmentCandles < TUG_OF_WAR_SETTINGS.warmupCandles
    result.segmentCandles += 1
    result.analyzedCandles += 1
    result.control = classifyControl(ha)
    result.confirmation = null
    result.lastClosedTime = raw.closeTime
    result.lastClose = raw.close

    if (result.control === 'tugOfWar') {
      towStartTime ??= raw.openTime
      result.pendingTowCandles += 1
    } else if (result.control !== 'neutral' && ha.body >= TUG_OF_WAR_SETTINGS.minBodyRatio * (high - low)) {
      const direction = result.control
      if (towStartTime !== null && !result.isWarmup && result.pendingTowCandles >= TUG_OF_WAR_SETTINGS.minTowCandles) {
        result.confirmation = {
          direction,
          kind: result.trend === null ? 'undetermined' : result.trend === direction ? 'continuation' : 'reversal',
          towStartTime,
          towCandleCount: result.pendingTowCandles,
          confirmedAt: raw.closeTime,
          referencePrice: raw.close,
        }
      }
      // Short TOW sequences and warmup decisions resolve silently. Neutral and
      // weak directional candles preserve pending TOW and remembered trend.
      towStartTime = null
      result.pendingTowCandles = 0
      result.trend = direction
    }
  }

  return result
}

/**
 * Project only the latest open candle from immutable closed HA/TOW state.
 * Supplying the matching closed analysis avoids replaying history on every
 * price tick. A missing candle restarts the live seed and warmup, as it would
 * in the closed analyzer; a provisional resolution never becomes confirmation.
 */
export function previewTugOfWar(
  bars: readonly RsiBar[],
  closedAnalysis?: TugOfWarAnalysis,
): TugOfWarPreview | null {
  const raw = bars.at(-1)
  if (!raw || raw.isClosed) return null
  if (!isValidCandle(raw)) throw new Error(`Invalid tug-of-war candle at index ${bars.length - 1}`)
  const preceding = bars.at(-2)
  if (preceding && raw.openTime <= preceding.closeTime) {
    throw new Error('Tug-of-war candles must be chronological without overlap')
  }

  const closed = closedAnalysis ?? analyzeTugOfWar(bars)
  const previous = closed.heikinAshi.at(-1)
  if (previous && raw.openTime <= previous.closeTime) {
    throw new Error('Tug-of-war preview must follow the closed analysis')
  }
  const startsNewSegment = !previous || raw.openTime !== previous.closeTime + 1
  const open = startsNewSegment
    ? midpoint(raw.open, raw.close)
    : midpoint(previous.open, previous.close)
  const close = midpoint(midpoint(raw.open, raw.high), midpoint(raw.low, raw.close))
  const high = Math.max(raw.high, open, close)
  const low = Math.min(raw.low, open, close)
  const heikinAshi: TugOfWarPreview['heikinAshi'] = {
    openTime: raw.openTime,
    closeTime: raw.closeTime,
    open,
    high,
    low,
    close,
    body: Math.abs(close - open),
    upperWick: Math.max(0, high - Math.max(open, close)),
    lowerWick: Math.max(0, Math.min(open, close) - low),
    isClosed: false,
    startsNewSegment,
  }
  const control = classifyControl(heikinAshi)
  const isBodyQualified = high > low && heikinAshi.body >= TUG_OF_WAR_SETTINGS.minBodyRatio * (high - low)
  const isWarmup = startsNewSegment || closed.segmentCandles < TUG_OF_WAR_SETTINGS.warmupCandles
  let trend = startsNewSegment ? null : closed.trend
  let pendingTowCandles = startsNewSegment ? 0 : closed.pendingTowCandles
  let possibleResolution: TugOfWarPreview['possibleResolution'] = null

  if (control === 'tugOfWar') {
    pendingTowCandles += 1
  } else if (control !== 'neutral' && isBodyQualified) {
    if (!isWarmup && pendingTowCandles >= TUG_OF_WAR_SETTINGS.minTowCandles) {
      possibleResolution = {
        direction: control,
        kind: trend === null ? 'undetermined' : trend === control ? 'continuation' : 'reversal',
        towCandleCount: pendingTowCandles,
      }
    }
    pendingTowCandles = 0
    trend = control
  }

  return {
    control,
    trend,
    pendingTowCandles,
    isWarmup,
    isBodyQualified,
    openTime: raw.openTime,
    closeTime: raw.closeTime,
    heikinAshi,
    possibleResolution,
  }
}

/** Current control is provisional even when its shape could resolve a TOW. */
export function liveTugOfWarPresentation(preview: TugOfWarPreview): TugOfWarPresentation {
  const details = ['Live candle · still forming']
  const { control, pendingTowCandles, possibleResolution } = preview
  if (possibleResolution) {
    const { direction, kind, towCandleCount } = possibleResolution
    details.push(`possible ${direction} ${kind === 'undetermined' ? 'resolution' : kind} after ${towCandleCount} TOW candles`)
  } else if (pendingTowCandles > 0) {
    details.push(`${pendingTowCandles} TOW candle${pendingTowCandles === 1 ? '' : 's'} awaiting control`)
  }
  if (preview.isWarmup) details.push('HA warmup · confirmations paused')

  if (control === 'tugOfWar') {
    return { label: 'Tug of war', tone: 'pending', detail: details.join(' · ') }
  }
  if (control === 'neutral' || !preview.isBodyQualified) {
    details.push(control === 'neutral' ? 'no directional wick evidence' : 'body is not strong enough')
    return { label: 'No clear control', tone: 'neutral', detail: details.join(' · ') }
  }
  return {
    label: `${control === 'bullish' ? 'Bullish' : 'Bearish'} control`,
    tone: control,
    detail: details.join(' · '),
  }
}

/** Short card copy that keeps indecision and warmup distinct from confirmation. */
export function tugOfWarPresentation(analysis: TugOfWarAnalysis): TugOfWarPresentation {
  if (analysis.control === null) {
    return { label: 'Waiting for candles', tone: 'neutral', detail: 'Uses closed Heikin-Ashi candles' }
  }
  if (analysis.isWarmup) {
    return {
      label: 'Warming up',
      tone: 'neutral',
      detail: `${analysis.segmentCandles}/${TUG_OF_WAR_SETTINGS.warmupCandles} closed candles · confirmations paused`,
    }
  }
  if (analysis.confirmation) {
    const { direction, kind, towCandleCount } = analysis.confirmation
    const side = direction === 'bullish' ? 'Bullish' : 'Bearish'
    return {
      label: `${side} ${kind === 'undetermined' ? 'resolution' : kind}`,
      tone: direction,
      detail: `Confirmed on latest close · ${towCandleCount} TOW candles`,
    }
  }
  if (analysis.pendingTowCandles > 0) {
    const count = analysis.pendingTowCandles
    return {
      label: 'Tug of war',
      tone: 'pending',
      detail: `${count} undecided candle${count === 1 ? '' : 's'} · awaiting control`,
    }
  }

  const latest = analysis.heikinAshi.at(-1)
  const weak = latest && latest.body < TUG_OF_WAR_SETTINGS.minBodyRatio * (latest.high - latest.low)
  if (analysis.control === 'neutral' || weak) {
    return {
      label: 'No clear control',
      tone: 'neutral',
      detail: weak ? 'Latest candle lacks a strong enough body' : 'No directional wick evidence',
    }
  }
  const direction = analysis.control === 'bullish' ? 'bullish' : 'bearish'
  return {
    label: `${direction === 'bullish' ? 'Bullish' : 'Bearish'} control`,
    tone: direction,
    detail: 'Closed candle control · no new TOW confirmation',
  }
}

import type { RsiBar } from '../types'

export type DivergenceKind =
  | 'regular-bullish'
  | 'regular-bearish'
  | 'hidden-bullish'
  | 'hidden-bearish'

export interface DivergencePoint {
  /** Opening timestamp of the candle containing the RSI pivot. */
  time: number
  /** Candle low for bullish signals, candle high for bearish signals. */
  price: number
  rsi: number
}

export interface DivergenceSignal {
  id: string
  kind: DivergenceKind
  start: DivergencePoint
  end: DivergencePoint
  /** Close time of the final right-hand candle needed to confirm the pivot. */
  confirmedAt: number
}

export interface DivergenceOptions {
  leftBars: number
  rightBars: number
  /** Inclusive distance between pivot candle indices, not confirmation bars. */
  minBars: number
  maxBars: number
  includeHidden: boolean
  /** Require candle-body extrema to move in the same direction as wick extrema. */
  requireBodyAgreement: boolean
  /**
   * Require every RSI sample from the first pivot through the second to stay
   * strictly below 50 for bullish pairs (a W under the midline) and strictly
   * above 50 for bearish pairs (an M over the midline). A touch of 50 resets
   * the RSI cycle, so the two pivots would belong to different cycles.
   */
  requireSameRsiCycle: boolean
}

export const DEFAULT_DIVERGENCE_OPTIONS: Readonly<DivergenceOptions> = Object.freeze({
  leftBars: 5,
  rightBars: 5,
  minBars: 5,
  maxBars: 60,
  includeHidden: false,
  requireBodyAgreement: false,
  requireSameRsiCycle: false,
})

export function validateDivergenceOptions(options: DivergenceOptions): void {
  for (const name of ['leftBars', 'rightBars', 'minBars', 'maxBars'] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 1) {
      throw new RangeError(`${name} must be a positive safe integer`)
    }
  }
  if (options.maxBars < options.minBars) {
    throw new RangeError('maxBars must be greater than or equal to minBars')
  }
  for (const name of ['includeHidden', 'requireBodyAgreement', 'requireSameRsiCycle'] as const) {
    if (typeof options[name] !== 'boolean') {
      throw new TypeError(`${name} must be a boolean`)
    }
  }
}

export function isValidClosedRsiBar(bar: RsiBar): boolean {
  return bar.isClosed === true
    && Number.isSafeInteger(bar.openTime)
    && Number.isSafeInteger(bar.closeTime)
    && bar.openTime >= 0
    && bar.closeTime >= bar.openTime
    && Number.isFinite(bar.rsi)
    && bar.rsi >= 0
    && bar.rsi <= 100
    && Number.isFinite(bar.open)
    && Number.isFinite(bar.high)
    && Number.isFinite(bar.low)
    && Number.isFinite(bar.close)
    && bar.low > 0
    && bar.low <= Math.min(bar.open, bar.close)
    && bar.high >= Math.max(bar.open, bar.close)
    && Number.isFinite(bar.volume)
    && bar.volume >= 0
}

/**
 * Finds divergences between consecutive confirmed RSI pivots. Each RSI pivot
 * uses its own candle's low/high; price is not independently pivoted. Regular
 * bullish = price LL / RSI HL; regular bearish = price HH / RSI LH. Hidden
 * bullish = price HL / RSI LL; hidden bearish = price LH / RSI HH.
 *
 * Pivots are strictly lower/higher than ALL left and right RSI neighbors;
 * equal plateaus are deliberately excluded. Every confirmation candle must be
 * closed. Live/malformed candles and timestamp gaps split independent segments.
 * Binance candle timestamps are inclusive: next.openTime = previous.closeTime + 1.
 *
 * minBars/maxBars measure the direct, inclusive pivot-index distance. Some Pine
 * scripts count bars since a shifted pivot flag instead (distance minus one).
 * Once confirmed, a signal cannot change when later candles are appended.
 * Optional body/cycle filters only inspect the selected pivot pair; rejecting
 * a candidate never skips that pivot when choosing the next consecutive pair.
 */
export function findRsiDivergences(
  bars: readonly RsiBar[],
  options: Partial<DivergenceOptions> = {},
): DivergenceSignal[] {
  const settings = { ...DEFAULT_DIVERGENCE_OPTIONS, ...options }
  validateDivergenceOptions(settings)
  const {
    leftBars, rightBars, minBars, maxBars, includeHidden,
    requireBodyAgreement, requireSameRsiCycle,
  } = settings
  const signals: DivergenceSignal[] = []
  let segmentStart = 0
  let previousLow: number | null = null
  let previousHigh: number | null = null

  function comparePivots(previousIndex: number | null, index: number, low: boolean, confirmedAt: number) {
    if (previousIndex === null) return
    const distance = index - previousIndex
    if (distance < minBars || distance > maxBars) return

    const first = bars[previousIndex]
    const second = bars[index]
    const firstPrice = low ? first.low : first.high
    const secondPrice = low ? second.low : second.high
    const priceChange = secondPrice - firstPrice
    const rsiChange = second.rsi - first.rsi
    let kind: DivergenceKind | null = null
    if (low) {
      if (priceChange < 0 && rsiChange > 0) kind = 'regular-bullish'
      else if (includeHidden && priceChange > 0 && rsiChange < 0) kind = 'hidden-bullish'
    } else {
      if (priceChange > 0 && rsiChange < 0) kind = 'regular-bearish'
      else if (includeHidden && priceChange < 0 && rsiChange > 0) kind = 'hidden-bearish'
    }
    if (kind === null) return

    if (requireBodyAgreement) {
      const firstBody = low ? Math.min(first.open, first.close) : Math.max(first.open, first.close)
      const secondBody = low ? Math.min(second.open, second.close) : Math.max(second.open, second.close)
      if (Math.sign(secondBody - firstBody) !== Math.sign(priceChange)) return
    }

    if (requireSameRsiCycle) {
      // Bullish patterns compare lows inside a below-50 cycle; bearish patterns
      // compare highs inside an above-50 cycle. The pattern's side is fixed by
      // its kind, not by wherever the first pivot happens to sit.
      for (let between = previousIndex; between <= index; between++) {
        if (low ? bars[between].rsi >= 50 : bars[between].rsi <= 50) return
      }
    }

    signals.push({
      id: `${kind}:${first.openTime}:${second.openTime}`,
      kind,
      start: { time: first.openTime, price: firstPrice, rsi: first.rsi },
      end: { time: second.openTime, price: secondPrice, rsi: second.rsi },
      confirmedAt,
    })
  }

  for (let confirmation = 0; confirmation < bars.length; confirmation++) {
    const current = bars[confirmation]
    if (!isValidClosedRsiBar(current)) {
      segmentStart = confirmation + 1
      previousLow = null
      previousHigh = null
      continue
    }

    if (confirmation > segmentStart && current.openTime !== bars[confirmation - 1].closeTime + 1) {
      segmentStart = confirmation
      previousLow = null
      previousHigh = null
    }

    const pivot = confirmation - rightBars
    if (pivot - leftBars < segmentStart) continue
    const pivotRsi = bars[pivot].rsi
    let isLow = true
    let isHigh = true
    for (let neighbor = pivot - leftBars; neighbor <= confirmation; neighbor++) {
      if (neighbor === pivot) continue
      isLow = isLow && pivotRsi < bars[neighbor].rsi
      isHigh = isHigh && pivotRsi > bars[neighbor].rsi
      if (!isLow && !isHigh) break
    }

    if (isLow) {
      comparePivots(previousLow, pivot, true, current.closeTime)
      previousLow = pivot
    }
    if (isHigh) {
      comparePivots(previousHigh, pivot, false, current.closeTime)
      previousHigh = pivot
    }
  }

  return signals
}

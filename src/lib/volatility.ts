import type { RsiBar } from '../types'

export interface VolatilityOptions {
  atrPeriod?: number
  volumePeriod?: number
}

export interface VolatilityPoint {
  openTime: number
  closeTime: number
  trueRange: number
  atr: number | null
  /** Current volume divided by the mean of the preceding completed candles. */
  relativeVolume: number | null
}

export interface VolatilityAnalysis {
  atr: number | null
  relativeVolume: number | null
  asOf: number | null
  closedBarCount: number
  points: VolatilityPoint[]
}

export function isValidPriceBar(bar: RsiBar): boolean {
  return [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)
    && Number.isFinite(bar.volume) && bar.volume >= 0
    && Number.isSafeInteger(bar.openTime) && Number.isSafeInteger(bar.closeTime)
    && bar.openTime >= 0 && bar.closeTime >= bar.openTime
    && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close)
}

/**
 * Trailing previews have no effect. Missing/invalid/interior live candles restart
 * the calculation, so an unknown price interval never becomes an invented move.
 * A price gap between two consecutive valid candles is still part of true range.
 */
export function getClosedPriceSuffix(bars: readonly RsiBar[]): RsiBar[] {
  let end = bars.length
  while (end > 0 && bars[end - 1].isClosed === false) end--
  let start = 0
  for (let index = 0; index < end; index++) {
    const bar = bars[index]
    if (bar.isClosed !== true || !isValidPriceBar(bar)) {
      start = index + 1
      continue
    }
    if (index > start) {
      const previous = bars[index - 1]
      if (bar.openTime !== previous.closeTime + 1
        || bar.closeTime - bar.openTime !== previous.closeTime - previous.openTime) start = index
    }
  }
  return bars.slice(start, end)
}

function positivePeriod(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

/** Wilder ATR seeds from the first period true ranges; the first range is high-low. */
export function analyzeVolatility(bars: readonly RsiBar[], options: VolatilityOptions = {}): VolatilityAnalysis {
  const atrPeriod = positivePeriod(options.atrPeriod ?? 14, 'ATR period')
  const volumePeriod = positivePeriod(options.volumePeriod ?? 20, 'Volume period')
  const closed = getClosedPriceSuffix(bars)
  const points: VolatilityPoint[] = []
  let rangeSum = 0
  let volumeSum = 0
  let atr: number | null = null
  for (let index = 0; index < closed.length; index++) {
    const bar = closed[index]
    const previous = closed[index - 1]
    const trueRange = previous
      ? Math.max(bar.high - bar.low, Math.abs(bar.high - previous.close), Math.abs(bar.low - previous.close))
      : bar.high - bar.low
    rangeSum += trueRange
    if (index === atrPeriod - 1) atr = rangeSum / atrPeriod
    else if (index >= atrPeriod && atr !== null) atr = (atr * (atrPeriod - 1) + trueRange) / atrPeriod
    const relativeVolume = index >= volumePeriod && volumeSum > 0 ? bar.volume / (volumeSum / volumePeriod) : null
    points.push({ openTime: bar.openTime, closeTime: bar.closeTime, trueRange, atr, relativeVolume })
    volumeSum += bar.volume
    if (index >= volumePeriod) volumeSum -= closed[index - volumePeriod].volume
  }
  return { atr, relativeVolume: points.at(-1)?.relativeVolume ?? null, asOf: closed.at(-1)?.closeTime ?? null, closedBarCount: closed.length, points }
}

export interface NormalizedDistance {
  absolute: number
  percent: number
  atr: number | null
}

/** Absolute distance; percent uses the displayed price, and flat/missing ATR stays unavailable. */
export function getNormalizedDistance(price: number, level: number, atr: number | null): NormalizedDistance {
  const valid = Number.isFinite(price) && price > 0 && Number.isFinite(level) && level > 0
  const absolute = valid ? Math.abs(level - price) : Infinity
  return {
    absolute,
    percent: valid ? absolute / price * 100 : Infinity,
    atr: valid && atr !== null && Number.isFinite(atr) && atr > 0 ? absolute / atr : null,
  }
}

export interface SweepQuality {
  breached: boolean
  /** A breach and a strict close back on the original side in this same candle. */
  reclaimed: boolean
  penetration: number
  penetrationAtr: number | null
  closeBack: number
  closeBackAtr: number | null
  wickFraction: number | null
  bodyFraction: number | null
  relativeVolume: number | null
}

/** OHLCV measurements only; these do not establish traded-side volume or absorption. */
export function getSweepQuality(
  bar: RsiBar, level: number, side: 'high' | 'low', atr: number | null, relativeVolume: number | null = null,
): SweepQuality {
  const valid = bar.isClosed === true && isValidPriceBar(bar) && Number.isFinite(level) && level > 0
  const penetration = valid ? Math.max(0, side === 'high' ? bar.high - level : level - bar.low) : 0
  const closeBack = valid ? Math.max(0, side === 'high' ? level - bar.close : bar.close - level) : 0
  const range = valid ? bar.high - bar.low : 0
  const wick = side === 'high' ? bar.high - Math.max(bar.open, bar.close) : Math.min(bar.open, bar.close) - bar.low
  const normalize = (value: number) => valid && atr !== null && Number.isFinite(atr) && atr > 0 ? value / atr : null
  return {
    breached: penetration > 0,
    reclaimed: penetration > 0 && closeBack > 0,
    penetration,
    penetrationAtr: normalize(penetration),
    closeBack,
    closeBackAtr: normalize(closeBack),
    wickFraction: range > 0 ? wick / range : null,
    bodyFraction: range > 0 ? Math.abs(bar.close - bar.open) / range : null,
    relativeVolume: valid && relativeVolume !== null && Number.isFinite(relativeVolume) && relativeVolume >= 0 ? relativeVolume : null,
  }
}

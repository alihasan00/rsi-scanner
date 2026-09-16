import type { RsiBar } from '../types'

/**
 * Compares a candidate with every RSI neighbor in its left/right window.
 * Equal plateaus are excluded. One-sided windows are allowed; missing or
 * invalid windows are never pivots. Callers validate samples, candle closure,
 * and segment continuity before using the result.
 */
export function strictRsiPivot(
  bars: readonly Pick<RsiBar, 'rsi'>[],
  pivot: number,
  leftBars: number,
  rightBars: number,
): { low: boolean; high: boolean } {
  if (!Number.isSafeInteger(pivot)
    || !Number.isSafeInteger(leftBars) || leftBars < 0
    || !Number.isSafeInteger(rightBars) || rightBars < 0
    || leftBars + rightBars < 1
    || pivot - leftBars < 0 || pivot + rightBars >= bars.length) {
    return { low: false, high: false }
  }

  const pivotRsi = bars[pivot].rsi
  let low = true
  let high = true
  for (let neighbor = pivot - leftBars; neighbor <= pivot + rightBars; neighbor++) {
    if (neighbor === pivot) continue
    low = low && pivotRsi < bars[neighbor].rsi
    high = high && pivotRsi > bars[neighbor].rsi
    if (!low && !high) break
  }
  return { low, high }
}

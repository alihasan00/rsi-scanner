// Wilder's smoothed RSI (RMA-based), matching TradingView's default RSI.

export const RSI_LENGTH = 14
export const SERIES_CAP = 80

export interface RsiState {
  avgGain: number
  avgLoss: number
  lastClose: number
  series: number[]
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (const v of values) sum += v
  return sum / values.length
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

/** Seeds RSI state from a closes history. Returns null if there isn't enough data. */
export function seedRsiState(closes: number[], length = RSI_LENGTH): RsiState | null {
  if (closes.length < length + 1) return null

  const gains: number[] = []
  const losses: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    gains.push(Math.max(0, change))
    losses.push(Math.max(0, -change))
  }

  let avgGain = average(gains.slice(0, length))
  let avgLoss = average(losses.slice(0, length))
  // The average of the first `length` changes already yields the first RSI,
  // aligned with closes[length]. Subsequent closes apply Wilder smoothing.
  const series: number[] = [rsiFromAverages(avgGain, avgLoss)]

  for (let i = length; i < gains.length; i++) {
    avgGain = (avgGain * (length - 1) + gains[i]) / length
    avgLoss = (avgLoss * (length - 1) + losses[i]) / length
    series.push(rsiFromAverages(avgGain, avgLoss))
  }

  return {
    avgGain,
    avgLoss,
    lastClose: closes[closes.length - 1],
    series: series.slice(-SERIES_CAP),
  }
}

/**
 * Advances RSI state by one new close. Callers decide whether to persist the
 * returned state: an in-progress (unclosed) candle should be rendered but not
 * committed, since Wilder's RMA can only roll forward once per closed candle.
 */
export function advanceRsiState(state: RsiState, close: number, length = RSI_LENGTH): RsiState {
  const change = close - state.lastClose
  const gain = Math.max(0, change)
  const loss = Math.max(0, -change)
  const avgGain = (state.avgGain * (length - 1) + gain) / length
  const avgLoss = (state.avgLoss * (length - 1) + loss) / length
  const rsi = rsiFromAverages(avgGain, avgLoss)
  const series = state.series.length >= SERIES_CAP
    ? [...state.series.slice(1), rsi]
    : [...state.series, rsi]

  return { avgGain, avgLoss, lastClose: close, series }
}

/** Simple moving average of an RSI series, aligned to the tail of the input. */
export function computeSma(series: number[], length: number): number[] {
  if (series.length < length) return []
  const sma: number[] = []
  let windowSum = 0
  for (let i = 0; i < length; i++) windowSum += series[i]
  sma.push(windowSum / length)
  for (let i = length; i < series.length; i++) {
    windowSum += series[i] - series[i - length]
    sma.push(windowSum / length)
  }
  return sma
}

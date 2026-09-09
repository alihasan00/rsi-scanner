export const RSI_OVERBOUGHT = 70
export const RSI_OVERSOLD = 30

export type RsiState = 'overbought' | 'oversold' | 'neutral'
export type RsiStateFilter = 'all' | 'overbought' | 'oversold' | 'either' | 'neutral'

export const RSI_STATE_LABELS: Readonly<Record<RsiState, string>> = Object.freeze({
  overbought: 'Overbought',
  oversold: 'Oversold',
  neutral: 'Neutral',
})

/** Inclusive 70/30 thresholds apply to valid RSI values, including provisional live bars. */
export function getRsiState(value: number | null | undefined): RsiState | null {
  if (value == null || !Number.isFinite(value) || value < 0 || value > 100) return null
  if (value >= RSI_OVERBOUGHT) return 'overbought'
  if (value <= RSI_OVERSOLD) return 'oversold'
  return 'neutral'
}

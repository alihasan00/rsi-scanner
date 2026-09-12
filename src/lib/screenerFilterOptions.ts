import type { DivergenceRecency } from './screener'
import { RSI_OVERBOUGHT, RSI_OVERSOLD } from './rsiState'
import type { RsiStateFilter } from './rsiState'
import type { FibStage } from './fibScreener'
import type { ScreenerFilterPreferences } from './screenerPreferences'

export const HARMONIC_PATTERN_OPTIONS: { value: ScreenerFilterPreferences['harmonicPattern']; label: string }[] = [
  { value: 'all', label: 'All patterns' },
  { value: 'gartley', label: 'Gartley' },
  { value: 'bat', label: 'Bat' },
  { value: 'butterfly', label: 'Butterfly' },
]

export const HARMONIC_DIRECTION_OPTIONS: { value: ScreenerFilterPreferences['harmonicDirection']; label: string }[] = [
  { value: 'any', label: 'Both directions' },
  { value: 'bullish', label: 'Bullish' },
  { value: 'bearish', label: 'Bearish' },
]

export const HARMONIC_STAGE_OPTIONS: { value: ScreenerFilterPreferences['harmonicStage']; label: string }[] = [
  { value: 'all', label: 'All active patterns' },
  { value: 'forming', label: 'Early setup' },
  { value: 'approaching', label: 'Approaching D' },
  { value: 'zone', label: 'D zone reached' },
]

export const FIB_STAGE_OPTIONS: { value: FibStage; label: string }[] = [
  { value: 'any', label: 'Any active setup' },
  { value: 'waiting', label: 'Awaiting entry' },
  { value: 'near', label: 'Near entry' },
  { value: 'active', label: 'Entry reached' },
  { value: 'pocket', label: 'In golden pocket' },
]

export const DIVERGENCE_RECENCY_OPTIONS: { value: DivergenceRecency; label: string }[] = [
  { value: 1, label: 'Latest closed candle' },
  { value: 3, label: 'Latest 3 closed candles' },
  { value: 5, label: 'Latest 5 closed candles' },
  { value: 'any', label: 'Any age' },
]

export const RSI_FILTER_OPTIONS: { value: RsiStateFilter; label: string }[] = [
  { value: 'all', label: 'Any state' },
  { value: 'overbought', label: `Overbought ≥ ${RSI_OVERBOUGHT}` },
  { value: 'oversold', label: `Oversold ≤ ${RSI_OVERSOLD}` },
  { value: 'either', label: 'Overbought or oversold' },
  { value: 'neutral', label: 'Neutral' },
]

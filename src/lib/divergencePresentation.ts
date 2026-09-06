import type { DivergenceKind } from './divergence'
import type { DivergenceSetup } from './divergenceLifecycle'

export const DIVERGENCE_LABELS: Record<DivergenceKind, string> = {
  'regular-bullish': 'Regular bullish',
  'regular-bearish': 'Regular bearish',
  'hidden-bullish': 'Hidden bullish',
  'hidden-bearish': 'Hidden bearish',
}

export const DIVERGENCE_STATE_LABELS: Record<DivergenceSetup['state'], string> = {
  forming: 'Forming',
  confirmed: 'Confirmed',
  completed: 'Completed',
  harmonised: 'Harmonised',
  expired: 'Expired',
  unconfirmed: 'Unconfirmed',
  interrupted: 'Interrupted',
}

export function divergenceStatus(signal: DivergenceSetup): string {
  const state = DIVERGENCE_STATE_LABELS[signal.state]
  return signal.confirmedAt === null ? state : `${state} · ${signal.barsElapsed}/${signal.expiryBars}`
}

export function liveDivergenceLabel(signal: DivergenceSetup): string {
  const side = signal.kind.endsWith('bullish') ? 'Bull' : 'Bear'
  const hidden = signal.kind.startsWith('hidden') ? 'H ' : ''
  return `${hidden}${side} · ${divergenceStatus(signal).toLowerCase()}`
}

export function divergenceResolution(signal: DivergenceSetup): string {
  switch (signal.resolutionReason) {
    case 'rsi-50': return signal.resolvedAt === signal.confirmedAt ? 'RSI 50 reached at confirmation' : 'RSI 50 reached'
    case 'rsi-anchor': return `${signal.invalidationAnchor === 'first' ? 'First' : 'Second'} pivot RSI breached`
    case 'window-elapsed': return `${signal.expiryBars} candles elapsed without RSI 50`
    case 'confirmation-missed': return 'Next candle had wrong colour or was a doji'
    case 'data-gap': return 'Interrupted by missing or invalid candle data'
    default: return signal.state === 'forming' ? 'Awaiting the next candle close' : 'Waiting for RSI 50'
  }
}

export function formatSignalTime(time: number): string {
  return new Date(time).toISOString().replace('T', ' ').slice(0, 19)
}

export function formatSignalPrice(price: number): string {
  return price.toLocaleString('en-US', { maximumSignificantDigits: 8 })
}

import type { Candle, RsiBar } from '../types'
import { isValidCandle } from './rsiHistory'

export type ResearchOscillatorKind = 'wilder' | 'trend-weighted' | 'adaptive'
export interface ResearchOscillator {
  kind: ResearchOscillatorKind
  period: number
}

export function validateResearchOscillator(config: ResearchOscillator): void {
  if (!['wilder', 'trend-weighted', 'adaptive'].includes(config.kind)) {
    throw new TypeError('Unknown research oscillator')
  }
  if (!Number.isSafeInteger(config.period) || config.period < 2 || config.period > 100) {
    throw new RangeError('Research RSI period must be an integer between 2 and 100')
  }
}

/**
 * Independently defined experiments; neither is a LuxAlgo indicator port.
 * Trend-weighted: weight each signed close change by 1 + trailing efficiency
 * when its direction agrees with the trailing period's net change.
 * Adaptive: use Wilder smoothing with effective period p * (1.5 - efficiency).
 * Efficiency is abs(net change) / sum(abs(changes)), using known closes only.
 * Standard Wilder uses the same arithmetic seed and recurrence as live RSI.
 */
export function buildResearchRsiBars(input: readonly Candle[], config: ResearchOscillator): RsiBar[] {
  validateResearchOscillator(config)
  const bars: RsiBar[] = []
  let segment: Candle[] = []
  let avgGain = 0
  let avgLoss = 0
  let changes = 0
  for (let index = 0; index < input.length; index++) {
    const candle = input[index]
    if (!isValidCandle(candle) || ('isClosed' in candle && candle.isClosed !== true)) throw new TypeError('Invalid or unclosed research candle')
    const previous = input[index - 1]
    if (previous && candle.openTime <= previous.closeTime) {
      throw new TypeError('Research candles must be ordered without overlaps')
    }
    if (!previous || candle.openTime !== previous.closeTime + 1) {
      segment = []
      avgGain = 0
      avgLoss = 0
      changes = 0
    }
    const last = segment.at(-1)
    segment.push(candle)
    if (segment.length > config.period + 1) segment.shift()
    let rsi = Number.NaN
    if (last) {
      const change = candle.close - last.close
      const net = candle.close - segment[0].close
      let movement = 0
      for (let offset = 1; offset < segment.length; offset++) {
        movement += Math.abs(segment[offset].close - segment[offset - 1].close)
      }
      const efficiency = movement > 0 ? Math.min(1, Math.abs(net) / movement) : 0
      const weight = config.kind === 'trend-weighted' && Math.sign(net) === Math.sign(change)
        ? 1 + efficiency : 1
      const gain = Math.max(0, change) * weight
      const loss = Math.max(0, -change) * weight
      changes++
      if (changes <= config.period) {
        avgGain += gain / config.period
        avgLoss += loss / config.period
      } else {
        const length = config.kind === 'adaptive' ? config.period * (1.5 - efficiency) : config.period
        // Written in Wilder recurrence order to preserve baseline rounding.
        avgGain = (avgGain * (length - 1) + gain) / length
        avgLoss = (avgLoss * (length - 1) + loss) / length
      }
      if (changes >= config.period) rsi = avgLoss === 0 ? (avgGain === 0 ? 50 : 100) : 100 - 100 / (1 + avgGain / avgLoss)
    }
    bars.push({ ...candle, rsi, isClosed: true })
  }
  return bars
}

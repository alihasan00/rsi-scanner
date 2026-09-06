import {
  DEFAULT_DIVERGENCE_OPTIONS,
  isValidClosedRsiBar,
  validateDivergenceOptions,
} from './divergence'
import type { DivergenceKind, DivergenceOptions, DivergencePoint } from './divergence'
import type { RsiBar } from '../types'

export type DivergenceState =
  | 'forming' | 'confirmed' | 'completed' | 'harmonised'
  | 'expired' | 'unconfirmed' | 'interrupted'

export type InvalidationAnchor = 'first' | 'second'

export interface DivergenceSetup {
  id: string
  kind: DivergenceKind
  start: DivergencePoint
  end: DivergencePoint
  state: DivergenceState
  /** The second pivot's close: the first moment this setup is observable. */
  detectedAt: number
  /** Price confirmation, never the right-side confirmation of an RSI pivot. */
  confirmedAt: number | null
  resolvedAt: number | null
  confirmation: 'ordinary' | 'strong' | null
  /** Confirmation is 0; following closed candles are 1 through expiryBars. */
  barsElapsed: number
  expiryBars: number
  /** Actual anchor; hidden setups always use the second pivot. */
  invalidationAnchor: InvalidationAnchor
  invalidationRsi: number
  resolutionReason: 'rsi-50' | 'rsi-anchor' | 'window-elapsed'
    | 'confirmation-missed' | 'data-gap' | null
}

export interface DivergenceLifecycleOptions extends DivergenceOptions {
  /** Total second-pivot lookback, INCLUDING the candidate candle. */
  provisionalBars: number
  expiryBars: number
  invalidationAnchor: InvalidationAnchor
}

export const DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS: Readonly<DivergenceLifecycleOptions> = Object.freeze({
  ...DEFAULT_DIVERGENCE_OPTIONS,
  provisionalBars: 5,
  expiryBars: 14,
  invalidationAnchor: 'second',
})

export function isLiveDivergence(setup: Pick<DivergenceSetup, 'state'>): boolean {
  return setup.state === 'forming' || setup.state === 'confirmed'
}

function validateOptions(options: DivergenceLifecycleOptions): void {
  validateDivergenceOptions(options)
  if (!Number.isSafeInteger(options.provisionalBars) || options.provisionalBars < 2) {
    throw new RangeError('provisionalBars must be a safe integer of at least 2')
  }
  if (!Number.isSafeInteger(options.expiryBars) || options.expiryBars < 1) {
    throw new RangeError('expiryBars must be a positive safe integer')
  }
  if (options.invalidationAnchor !== 'first' && options.invalidationAnchor !== 'second') {
    throw new TypeError('invalidationAnchor must be first or second')
  }
}

/**
 * Sequential, closed-candle replay used by both the live scanner and backtest.
 * The first pivot needs its full left/right evidence at detection time. The
 * second is provisional: a strict extreme of provisionalBars INCLUDING itself.
 * Each attempt keeps its original endpoints, even if the very next bar breaks
 * that extreme and forms another attempt. Future bars cannot erase attempts.
 *
 * Only the immediately following candle may confirm. Strict anchor breaches
 * have priority; wrong-colour/doji candles otherwise end as unconfirmed. The
 * confirmation close may reach 50, but that is separately identifiable as a
 * completed outcome with barsElapsed=0, not a post-confirmation trading success.
 * Closes c+1..c+14 are eligible; target beats expiry on c+14. Gaps are censored
 * as interrupted, never silently counted as expiry or crossed by a setup.
 */
export function findRsiDivergenceSetups(
  bars: readonly RsiBar[],
  options: Partial<DivergenceLifecycleOptions> = {},
): DivergenceSetup[] {
  const settings = { ...DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS, ...options }
  validateOptions(settings)
  const { leftBars, rightBars, provisionalBars, minBars, maxBars, expiryBars } = settings
  const setups: DivergenceSetup[] = []
  let active: DivergenceSetup[] = []
  let segmentStart = 0
  let previousLow: number | null = null
  let previousHigh: number | null = null

  function resolve(
    setup: DivergenceSetup,
    state: DivergenceSetup['state'],
    reason: DivergenceSetup['resolutionReason'],
    time: number,
  ): void {
    setup.state = state
    setup.resolutionReason = reason
    setup.resolvedAt = time
  }

  function interrupt(time: number): void {
    for (const setup of active) {
      resolve(setup, 'interrupted', 'data-gap', Math.max(time, setup.confirmedAt ?? setup.detectedAt))
    }
    active = []
    previousLow = null
    previousHigh = null
  }

  function advanceSetups(current: RsiBar, previous: RsiBar): void {
    for (const setup of active) {
      const bullish = setup.kind.endsWith('bullish')
      if (setup.state === 'confirmed') setup.barsElapsed++

      // Equality preserves the setup: the selected RSI level must be breached.
      if (bullish ? current.rsi < setup.invalidationRsi : current.rsi > setup.invalidationRsi) {
        resolve(setup, 'harmonised', 'rsi-anchor', current.closeTime)
        continue
      }

      if (setup.state === 'forming') {
        const confirms = bullish ? current.close > current.open : current.close < current.open
        if (!confirms) {
          resolve(setup, 'unconfirmed', 'confirmation-missed', current.closeTime)
          continue
        }
        const strong = bullish ? current.close > previous.open : current.close < previous.open
        setup.state = 'confirmed'
        setup.confirmedAt = current.closeTime
        setup.confirmation = strong ? 'strong' : 'ordinary'
      }

      if (bullish ? current.rsi >= 50 : current.rsi <= 50) {
        resolve(setup, 'completed', 'rsi-50', current.closeTime)
      } else if (setup.barsElapsed >= expiryBars) {
        resolve(setup, 'expired', 'window-elapsed', current.closeTime)
      }
    }
    active = active.filter(isLiveDivergence)
  }

  function formSetup(firstIndex: number | null, index: number, bullish: boolean): void {
    if (firstIndex === null) return
    const distance = index - firstIndex
    if (distance < minBars || distance > maxBars) return
    const first = bars[firstIndex]
    const second = bars[index]
    const firstPrice = bullish ? first.low : first.high
    const secondPrice = bullish ? second.low : second.high
    const priceChange = secondPrice - firstPrice
    const rsiChange = second.rsi - first.rsi
    let kind: DivergenceKind | null = null
    if (bullish) {
      if (priceChange < 0 && rsiChange > 0) kind = 'regular-bullish'
      else if (settings.includeHidden && priceChange > 0 && rsiChange < 0) kind = 'hidden-bullish'
    } else {
      if (priceChange > 0 && rsiChange < 0) kind = 'regular-bearish'
      else if (settings.includeHidden && priceChange < 0 && rsiChange > 0) kind = 'hidden-bearish'
    }
    if (kind === null) return

    // The dynamic target must still be ahead when the setup first appears.
    // Turning off the cycle filter permits intervening 50 touches, not a target
    // already reached on the second-pivot candle.
    if (bullish ? second.rsi >= 50 : second.rsi <= 50) return

    if (settings.requireBodyAgreement) {
      const edge = bullish ? Math.min : Math.max
      const bodyChange = edge(second.open, second.close) - edge(first.open, first.close)
      if (Math.sign(bodyChange) !== Math.sign(priceChange)) return
    }
    if (settings.requireSameRsiCycle) {
      for (let cursor = firstIndex; cursor <= index; cursor++) {
        if (bullish ? bars[cursor].rsi >= 50 : bars[cursor].rsi <= 50) return
      }
    }

    // The first RSI anchor is already breached at hidden-pattern formation.
    // Their optional lifecycle extension therefore always uses the second.
    const invalidationAnchor = kind.startsWith('hidden') ? 'second' : settings.invalidationAnchor
    const setup: DivergenceSetup = {
      id: `${kind}:${first.openTime}:${second.openTime}`,
      kind,
      start: { time: first.openTime, price: firstPrice, rsi: first.rsi },
      end: { time: second.openTime, price: secondPrice, rsi: second.rsi },
      state: 'forming',
      detectedAt: second.closeTime,
      confirmedAt: null,
      resolvedAt: null,
      confirmation: null,
      barsElapsed: 0,
      expiryBars,
      invalidationAnchor,
      invalidationRsi: invalidationAnchor === 'first' ? first.rsi : second.rsi,
      resolutionReason: null,
    }
    setups.push(setup)
    active.push(setup)
  }

  for (let index = 0; index < bars.length; index++) {
    const current = bars[index]
    if (!isValidClosedRsiBar(current)) {
      if (current.isClosed) {
        const knownTime = Number.isSafeInteger(current.closeTime) && current.closeTime >= 0
          ? current.closeTime
          : (bars[index - 1]?.closeTime ?? 0)
        interrupt(Number.isSafeInteger(knownTime) ? knownTime : 0)
      }
      // A trailing preview cannot affect a committed state. If later closed
      // data appears, the next segment will censor the unfinished attempts.
      segmentStart = index + 1
      previousLow = null
      previousHigh = null
      continue
    }

    if (index > 0 && (index === segmentStart || current.openTime !== bars[index - 1].closeTime + 1)) {
      interrupt(current.closeTime)
      segmentStart = index
    }
    if (index > segmentStart) advanceSetups(current, bars[index - 1])

    // Only now can the historical first pivot use this closed right-hand bar.
    const pivot = index - rightBars
    if (pivot - leftBars >= segmentStart) {
      let low = true
      let high = true
      for (let neighbor = pivot - leftBars; neighbor <= index; neighbor++) {
        if (neighbor === pivot) continue
        low = low && bars[pivot].rsi < bars[neighbor].rsi
        high = high && bars[pivot].rsi > bars[neighbor].rsi
      }
      if (low) previousLow = pivot
      if (high) previousHigh = pivot
    }

    if (index - provisionalBars + 1 < segmentStart) continue
    let low = true
    let high = true
    for (let neighbor = index - provisionalBars + 1; neighbor < index; neighbor++) {
      low = low && current.rsi < bars[neighbor].rsi
      high = high && current.rsi > bars[neighbor].rsi
    }
    if (low) formSetup(previousLow, index, true)
    if (high) formSetup(previousHigh, index, false)
  }

  return setups
}

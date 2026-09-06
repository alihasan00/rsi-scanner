import type { Candle } from '../types'
import { isValidCandle } from './rsiHistory'

export type SupportResistanceTrend = 'uptrend' | 'downtrend' | 'sideways' | 'unknown'

export type PriceBar = Candle & { isClosed: boolean }

export interface SupportResistanceLevel {
  /** Mean price of the confirmed swings merged into this zone. */
  price: number
  /** Confirmed swings merged into this zone since its last confirmed break. */
  touches: number
}

/** A crossed zone whose break has not been confirmed beyond the close buffer. */
export interface PendingBreakout extends SupportResistanceLevel {
  kind: 'support' | 'resistance'
}

/** Everything derived from closed candles only. Changes once per candle close. */
export interface SupportResistanceStructure {
  trend: SupportResistanceTrend
  /** Surviving support zones, ascending by price. */
  supports: readonly SupportResistanceLevel[]
  /** Surviving resistance zones, ascending by price. */
  resistances: readonly SupportResistanceLevel[]
  closedBarCount: number
}

export interface SupportResistanceAnalysis {
  trend: SupportResistanceTrend
  /** Nearest surviving support at or below the live price. */
  support: SupportResistanceLevel | null
  /** Nearest surviving resistance at or above the live price. */
  resistance: SupportResistanceLevel | null
  /** Nearest crossed surviving zone per side, separate from nearby levels. */
  pendingBreakouts: readonly PendingBreakout[]
  closedBarCount: number
}

export interface SupportResistanceOptions {
  leftBars: number
  rightBars: number
  lookbackBars: number
  /** Swings within this percent of a surviving zone's price merge into it. */
  zoneTolerancePercent: number
  /** A close must exceed a zone by this percent before the zone retires. */
  breakBufferPercent: number
}

export const DEFAULT_SUPPORT_RESISTANCE_OPTIONS: Readonly<SupportResistanceOptions> = Object.freeze({
  leftBars: 3,
  rightBars: 3,
  lookbackBars: 300,
  zoneTolerancePercent: 0.1,
  breakBufferPercent: 0.1,
})

const INTEGER_OPTIONS = ['leftBars', 'rightBars', 'lookbackBars'] as const
const PERCENT_OPTIONS = ['zoneTolerancePercent', 'breakBufferPercent'] as const

function resolveOptions(options: Partial<SupportResistanceOptions>): SupportResistanceOptions {
  const settings = { ...DEFAULT_SUPPORT_RESISTANCE_OPTIONS, ...options }
  for (const name of INTEGER_OPTIONS) {
    if (!Number.isSafeInteger(settings[name]) || settings[name] < 1) {
      throw new RangeError(`${name} must be a positive safe integer`)
    }
  }
  for (const name of PERCENT_OPTIONS) {
    if (!Number.isFinite(settings[name]) || settings[name] < 0 || settings[name] >= 100) {
      throw new RangeError(`${name} must be a finite percent from 0 up to 100`)
    }
  }
  return settings
}

function closedSegment(bars: readonly PriceBar[], lookbackBars: number): readonly PriceBar[] {
  let end = bars.length
  // The developing tail cannot change already confirmed structure, even if
  // its current range crosses a level. An unfinished interior bar is a gap.
  while (end > 0 && bars[end - 1].isClosed === false) end--

  let start = end
  while (start > 0 && end - start < lookbackBars) {
    const bar = bars[start - 1]
    if (bar.isClosed !== true || !isValidCandle(bar)) break
    if (start < end && bar.closeTime + 1 !== bars[start].openTime) break
    start--
  }
  return bars.slice(start, end)
}

/** Merge into the closest surviving zone within tolerance, else open a new zone. */
function addTouch(levels: SupportResistanceLevel[], price: number, tolerance: number): void {
  let nearest = -1
  let nearestDistance = Infinity
  for (let index = 0; index < levels.length; index++) {
    const distance = Math.abs(levels[index].price - price)
    if (distance <= levels[index].price * tolerance && distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }
  if (nearest === -1) {
    levels.push({ price, touches: 1 })
    return
  }
  const zone = levels[nearest]
  const touches = zone.touches + 1
  levels[nearest] = { price: (zone.price * zone.touches + price) / touches, touches }
}

function retire(levels: SupportResistanceLevel[], isBroken: (price: number) => boolean): void {
  for (let index = levels.length - 1; index >= 0; index--) {
    if (isBroken(levels[index].price)) levels.splice(index, 1)
  }
}

/**
 * Finds nearby historical price zones, not predictions of future prices.
 * Strict swing highs/lows need all left and right candles to be closed. Only
 * the latest contiguous closed segment, capped at lookbackBars, is analysed.
 *
 * Confirmed swings within zoneTolerancePercent of a surviving zone merge into
 * it, so touches count a zone rather than one exact float. A closed close
 * beyond a zone by more than breakBufferPercent retires it; wicks, equal
 * closes, and closes inside the buffer do not. A later independently confirmed
 * swing may establish a fresh zone, but a break never flips a zone's role.
 * Trend compares the latest two confirmed highs and latest two confirmed lows.
 */
export function buildSupportResistanceStructure(
  bars: readonly PriceBar[],
  options: Partial<SupportResistanceOptions> = {},
): SupportResistanceStructure {
  const { leftBars, rightBars, lookbackBars, zoneTolerancePercent, breakBufferPercent } = resolveOptions(options)
  const tolerance = zoneTolerancePercent / 100
  const supportBreak = 1 - breakBufferPercent / 100
  const resistanceBreak = 1 + breakBufferPercent / 100

  const closed = closedSegment(bars, lookbackBars)
  const supports: SupportResistanceLevel[] = []
  const resistances: SupportResistanceLevel[] = []
  const highs: number[] = []
  const lows: number[] = []

  for (let confirmation = 0; confirmation < closed.length; confirmation++) {
    const current = closed[confirmation]
    retire(supports, (price) => current.close < price * supportBreak)
    retire(resistances, (price) => current.close > price * resistanceBreak)

    const pivotIndex = confirmation - rightBars
    if (pivotIndex - leftBars < 0) continue
    const pivot = closed[pivotIndex]
    let isHigh = true
    let isLow = true
    for (let neighbor = pivotIndex - leftBars; neighbor <= confirmation; neighbor++) {
      if (neighbor === pivotIndex) continue
      isHigh = isHigh && pivot.high > closed[neighbor].high
      isLow = isLow && pivot.low < closed[neighbor].low
      if (!isHigh && !isLow) break
    }

    if (isHigh) {
      highs.push(pivot.high)
      if (highs.length > 2) highs.shift()
      addTouch(resistances, pivot.high, tolerance)
    }
    if (isLow) {
      lows.push(pivot.low)
      if (lows.length > 2) lows.shift()
      addTouch(supports, pivot.low, tolerance)
    }
  }

  let trend: SupportResistanceTrend = 'unknown'
  if (highs.length === 2 && lows.length === 2) {
    const highDirection = Math.sign(highs[1] - highs[0])
    const lowDirection = Math.sign(lows[1] - lows[0])
    trend = highDirection > 0 && lowDirection > 0 ? 'uptrend'
      : highDirection < 0 && lowDirection < 0 ? 'downtrend'
        : 'sideways'
  }

  const byPrice = (a: SupportResistanceLevel, b: SupportResistanceLevel): number => a.price - b.price
  return {
    trend,
    supports: supports.sort(byPrice),
    resistances: resistances.sort(byPrice),
    closedBarCount: closed.length,
  }
}

/**
 * Picks support at or below the live price and resistance at or above it.
 * Crossed surviving zones are reported separately as pending breakouts: the
 * lowest support above price and the highest resistance below price. A recross
 * clears the pending status; only a closed close beyond the buffer retires a
 * zone. The live price never creates, retires, or changes the role of zones.
 */
export function selectNearestLevels(
  structure: SupportResistanceStructure,
  currentPrice: number,
): SupportResistanceAnalysis {
  const { trend, closedBarCount } = structure
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { trend, support: null, resistance: null, pendingBreakouts: [], closedBarCount }
  }

  const pendingBreakouts: PendingBreakout[] = []
  let support: SupportResistanceLevel | null = null
  for (const level of structure.supports) {
    if (level.price <= currentPrice) {
      support = level
    } else {
      pendingBreakouts.push({ ...level, kind: 'support' })
      break
    }
  }

  let resistance: SupportResistanceLevel | null = null
  let crossedResistance: SupportResistanceLevel | null = null
  for (const level of structure.resistances) {
    if (level.price < currentPrice) {
      crossedResistance = level
    } else {
      resistance = level
      break
    }
  }
  if (crossedResistance) {
    pendingBreakouts.push({ ...crossedResistance, kind: 'resistance' })
  }

  return {
    trend,
    support: support ? { ...support } : null,
    resistance: resistance ? { ...resistance } : null,
    pendingBreakouts,
    closedBarCount,
  }
}

/** Convenience for callers that do not cache the closed-bar structure. */
export function analyzeSupportResistance(
  bars: readonly PriceBar[],
  currentPrice: number,
  options: Partial<SupportResistanceOptions> = {},
): SupportResistanceAnalysis {
  return selectNearestLevels(buildSupportResistanceStructure(bars, options), currentPrice)
}

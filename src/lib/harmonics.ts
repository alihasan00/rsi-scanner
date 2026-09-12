import type { RsiBar } from '../types'

export type HarmonicKind = 'gartley' | 'bat' | 'butterfly'
export type HarmonicDirection = 'bullish' | 'bearish'
export type HarmonicStage = 'forming' | 'approaching' | 'zone'

export interface HarmonicPoint {
  /** Index in the analyzed contiguous closed suffix, at most 500 candles. */
  index: number
  time: number
  price: number
}

export interface HarmonicSetup {
  id: string
  kind: HarmonicKind
  direction: HarmonicDirection
  stage: HarmonicStage
  x: HarmonicPoint
  a: HarmonicPoint
  b: HarmonicPoint
  c: HarmonicPoint
  /** First closed touch after confirmation; never an assumed fill or a future pivot. */
  d: HarmonicPoint | null
  /** XA band before optional Butterfly BC confluence narrows it. */
  baseZone: { low: number; high: number }
  zone: { low: number; high: number }
  zoneNarrowed: boolean
  bRatio: number
  cRatio: number
  dRatioRange: readonly [number, number]
  cInvalidation: number
  /** Reference boundary only: the lecture places the stop beyond this price. */
  stopReference: number
  confirmedAt: number
  endedAt: number | null
  status: 'active' | 'invalidated' | 'completed' | 'missed' | 'expired'
}

export interface HarmonicAnalysis {
  setups: HarmonicSetup[]
  closedBarCount: number
}

export const HARMONIC_MAX_HISTORY = 500
export const HARMONIC_PIVOT_BARS = 3
/** Scanner conventions, not lecture trading rules or modeled holding periods. */
export const HARMONIC_EXPIRY_BARS = 60
export const HARMONIC_TOUCH_RECENCY_BARS = 3

/** Literal saved-template ratios verified in the L17 video settings dialogs. */
export const HARMONIC_RATIOS = {
  gartley: { b: [0.556, 0.678], d: [0.707, 0.864] },
  bat: { b: [0.343, 0.55], d: [0.797, 0.974] },
  butterfly: { b: [0.707, 0.864], d: [1.144, 1.779] },
} as const
export const HARMONIC_C_RANGE = [0.343, 0.974] as const
export const HARMONIC_BUTTERFLY_BC_RANGE = [1.4562, 2.8798] as const
export const HARMONIC_TARGET_RATIOS = {
  gartley: [0.236, 0.382, 0.618],
  bat: [0.382, 0.618, 0.886, 1.382, 1.618],
  butterfly: [0.236, 0.618, 0.886, 1.12, 1.27],
} as const

interface Pivot extends HarmonicPoint { kind: 'high' | 'low' }

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function validBar(bar: RsiBar): boolean {
  return [bar.open, bar.high, bar.low, bar.close].every(positiveFinite)
    && Number.isFinite(bar.volume) && bar.volume >= 0
    && Number.isSafeInteger(bar.openTime) && Number.isSafeInteger(bar.closeTime)
    && bar.openTime >= 0 && bar.closeTime >= bar.openTime
    && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close)
}

/** Interior gaps reset structure. Trailing previews cannot change closed analysis. */
function closedSuffix(bars: readonly RsiBar[]): RsiBar[] {
  let end = bars.length
  while (end > 0 && bars[end - 1].isClosed === false) end--
  let closed: RsiBar[] = []
  for (let i = Math.max(0, end - HARMONIC_MAX_HISTORY); i < end; i++) {
    const bar = bars[i]
    if (bar.isClosed !== true || !validBar(bar)) {
      closed = []
      continue
    }
    const previous = closed.at(-1)
    if (previous && (bar.openTime !== previous.closeTime + 1
      || bar.closeTime - bar.openTime !== previous.closeTime - previous.openTime)) closed = []
    closed.push(bar)
  }
  return closed
}

function strictPivot(bars: readonly RsiBar[], index: number, kind: Pivot['kind']): boolean {
  if (index < HARMONIC_PIVOT_BARS) return false
  const price = bars[index][kind]
  for (let offset = -HARMONIC_PIVOT_BARS; offset <= HARMONIC_PIVOT_BARS; offset++) {
    if (offset === 0) continue
    if (kind === 'high' ? bars[index + offset].high >= price : bars[index + offset].low <= price) return false
  }
  return true
}

function inRange(value: number, range: readonly [number, number]): boolean {
  // Absorb only floating-point roundoff at inclusive decimal ratio boundaries.
  const epsilon = Number.EPSILON * 16
  return Number.isFinite(value) && value >= range[0] - epsilon && value <= range[1] + epsilon
}

function point(pivot: Pivot): HarmonicPoint {
  return { index: pivot.index, time: pivot.time, price: pivot.price }
}

/** L18: use BC confluence only when it actually cuts the established XA D band. */
export function narrowButterflyZone(
  baseZone: { low: number; high: number },
  b: number,
  c: number,
): { zone: { low: number; high: number }; zoneNarrowed: boolean } {
  const first = c - (c - b) * HARMONIC_BUTTERFLY_BC_RANGE[0]
  const second = c - (c - b) * HARMONIC_BUTTERFLY_BC_RANGE[1]
  const low = Math.max(baseZone.low, Math.min(first, second))
  const high = Math.min(baseZone.high, Math.max(first, second))
  if (!positiveFinite(low) || !positiveFinite(high) || low >= high) return { zone: { ...baseZone }, zoneNarrowed: false }
  return { zone: { low, high }, zoneNarrowed: low > baseZone.low || high < baseZone.high }
}

/** Template projections, never filled orders or target-hit claims. */
export function getHarmonicTargets(setup: HarmonicSetup): { ratio: number; price: number }[] {
  const d = setup.d?.price ?? setup.zone.low + (setup.zone.high - setup.zone.low) / 2
  const anchor = setup.kind === 'butterfly' ? setup.c.price : setup.a.price
  return HARMONIC_TARGET_RATIOS[setup.kind]
    .map((ratio) => ({ ratio, price: d + ratio * (anchor - d) }))
    .filter((target) => positiveFinite(target.price))
}

function touches(setup: HarmonicSetup, bar: RsiBar): boolean {
  return bar.low <= setup.zone.high && bar.high >= setup.zone.low
}

function crossesB(setup: HarmonicSetup, bar: RsiBar): boolean {
  return setup.direction === 'bullish' ? bar.close < setup.b.price : bar.close > setup.b.price
}

function invalidated(setup: HarmonicSetup, bar: Pick<RsiBar, 'high' | 'low'>): boolean {
  return setup.direction === 'bullish'
    ? bar.high > setup.cInvalidation || bar.low < setup.zone.low
    : bar.low < setup.cInvalidation || bar.high > setup.zone.high
}

function end(setup: HarmonicSetup, status: HarmonicSetup['status'], time: number): void {
  setup.status = status
  setup.endedAt = time
}

function advance(setup: HarmonicSetup, bar: RsiBar, index: number): void {
  if (setup.status !== 'active') return
  if (setup.d && index - setup.d.index >= HARMONIC_TOUCH_RECENCY_BARS) {
    end(setup, 'completed', bar.closeTime)
    return
  }
  // A wick through C's outer boundary or D's far edge wins an ambiguous touch.
  if (invalidated(setup, bar)) {
    end(setup, 'invalidated', bar.closeTime)
    return
  }
  if (!setup.d && index - setup.c.index >= HARMONIC_EXPIRY_BARS) {
    end(setup, 'expired', bar.closeTime)
    return
  }
  if (!setup.d && touches(setup, bar)) {
    setup.d = {
      index, time: bar.openTime,
      // The observed extreme within D, rather than an invented future endpoint.
      price: setup.direction === 'bullish' ? Math.max(bar.low, setup.zone.low) : Math.min(bar.high, setup.zone.high),
    }
    setup.stage = 'zone'
  } else if (!setup.d && crossesB(setup, bar)) {
    setup.stage = 'approaching'
  }
}

function createSetup(pivots: readonly Pivot[], bars: readonly RsiBar[], confirmationIndex: number): HarmonicSetup | null {
  const [x, a, b, c] = pivots
  const xa = a.price - x.price
  const ab = a.price - b.price
  if (!Number.isFinite(xa) || xa === 0 || !Number.isFinite(ab) || ab === 0) return null
  const direction: HarmonicDirection = xa > 0 ? 'bullish' : 'bearish'
  if ((direction === 'bullish') !== (x.kind === 'low')) return null
  const bRatio = ab / xa
  const cRatio = (c.price - b.price) / ab
  const kind = (Object.keys(HARMONIC_RATIOS) as HarmonicKind[])
    .find((candidate) => inRange(bRatio, HARMONIC_RATIOS[candidate].b))
  if (!kind || !inRange(cRatio, HARMONIC_C_RANGE)) return null
  const dRatioRange = HARMONIC_RATIOS[kind].d
  const near = a.price - xa * dRatioRange[0]
  const far = a.price - xa * dRatioRange[1]
  const cInvalidation = b.price + ab * HARMONIC_C_RANGE[1]
  if (![near, far, cInvalidation].every(positiveFinite)) return null
  const baseZone = { low: Math.min(near, far), high: Math.max(near, far) }
  const { zone, zoneNarrowed } = kind === 'butterfly'
    ? narrowButterflyZone(baseZone, b.price, c.price)
    : { zone: { ...baseZone }, zoneNarrowed: false }
  const setup: HarmonicSetup = {
    id: `${kind}:${direction}:${x.time}:${a.time}:${b.time}:${c.time}`,
    kind, direction, stage: 'forming', x: point(x), a: point(a), b: point(b), c: point(c), d: null,
    baseZone, zone, zoneNarrowed,
    bRatio, cRatio, dRatioRange, cInvalidation,
    stopReference: kind === 'butterfly' ? (direction === 'bullish' ? zone.low : zone.high) : x.price,
    confirmedAt: bars[confirmationIndex].closeTime, endedAt: null, status: 'active',
  }
  // The candidate did not exist before the final right-hand candle closed.
  // Reject already-invalid structure first; never backdate a D touch to that window.
  for (let index = b.index + 1; index <= confirmationIndex; index++) {
    const bar = bars[index]
    const outsideC = direction === 'bullish' ? bar.high > cInvalidation : bar.low < cInvalidation
    const beyondD = index >= c.index && (direction === 'bullish' ? bar.low < setup.zone.low : bar.high > setup.zone.high)
    if (outsideC || beyondD) {
      end(setup, 'invalidated', setup.confirmedAt)
      return setup
    }
  }
  for (let index = c.index; index <= confirmationIndex; index++) {
    if (touches(setup, bars[index])) {
      end(setup, 'missed', setup.confirmedAt)
      return setup
    }
    if (crossesB(setup, bars[index])) setup.stage = 'approaching'
  }
  return setup
}

/**
 * Causal, linear-price harmonic scanner for L17/L18. Consecutive strict 3/3 wick
 * pivots alternate; a later, more extreme same-side pivot replaces the last one.
 * Each X-A-B is used once so a later C retest cannot revive a consumed setup.
 * Template targets and optional BC narrowing are projections, without order or P&L simulation.
 */
export function analyzeHarmonics(bars: readonly RsiBar[]): HarmonicAnalysis {
  const closed = closedSuffix(bars)
  const setups: HarmonicSetup[] = []
  const pivots: Pivot[] = []
  const consumed = new Set<string>()
  let active: HarmonicSetup[] = []
  for (let index = 0; index < closed.length; index++) {
    for (const setup of active) advance(setup, closed[index], index)
    active = active.filter((setup) => setup.status === 'active')
    const pivotIndex = index - HARMONIC_PIVOT_BARS
    const high = strictPivot(closed, pivotIndex, 'high')
    const low = strictPivot(closed, pivotIndex, 'low')
    // Outside candles have no knowable intrabar high/low order.
    if (high === low) continue
    const kind = high ? 'high' : 'low'
    const pivot: Pivot = { index: pivotIndex, time: closed[pivotIndex].openTime, price: closed[pivotIndex][kind], kind }
    const previous = pivots.at(-1)
    if (previous?.kind === kind) {
      const moreExtreme = kind === 'high' ? pivot.price > previous.price : pivot.price < previous.price
      if (!moreExtreme) continue
      pivots[pivots.length - 1] = pivot
    } else {
      pivots.push(pivot)
      if (pivots.length > 4) pivots.shift()
    }
    if (pivots.length !== 4) continue
    const key = pivots.slice(0, 3).map((anchor) => anchor.time).join(':')
    if (consumed.has(key)) continue
    const setup = createSetup(pivots, closed, index)
    if (!setup) continue
    consumed.add(key)
    setups.push(setup)
    if (setup.status === 'active') active.push(setup)
  }
  return { setups, closedBarCount: closed.length }
}

export interface HarmonicLiveContext {
  inZone: boolean
  distancePercent: number
  invalidated: boolean
}

/** Latest-price context is provisional and cannot mutate the confirmed analysis. */
export function getHarmonicLiveContext(
  setup: HarmonicSetup,
  price: number,
  liveBar?: Pick<RsiBar, 'high' | 'low' | 'isClosed'>,
): HarmonicLiveContext {
  if (!positiveFinite(price)) return { inZone: false, distancePercent: Infinity, invalidated: true }
  const distance = price < setup.zone.low ? setup.zone.low - price : price > setup.zone.high ? price - setup.zone.high : 0
  const provisional = liveBar?.isClosed === false ? liveBar : undefined
  const invalidPreview = provisional !== undefined
    && (![provisional.high, provisional.low].every(positiveFinite) || provisional.low > provisional.high)
  const outside = invalidPreview || invalidated(setup, { high: price, low: price })
    || (provisional !== undefined && invalidated(setup, provisional))
  return {
    inZone: setup.status === 'active' && !outside && distance === 0,
    distancePercent: distance / price * 100,
    invalidated: setup.status !== 'active' || outside,
  }
}

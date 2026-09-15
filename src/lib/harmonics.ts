import type { RsiBar } from '../types'

export type HarmonicKind = 'gartley' | 'bat' | 'butterfly'
export type HarmonicDirection = 'bullish' | 'bearish'
export type HarmonicStage = 'forming' | 'approaching' | 'zone'
export type HarmonicStatus = 'active' | 'invalidated' | 'completed' | 'expired' | 'superseded'

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
  /** First closed candle that touched D after C formed; never an assumed fill or a future pivot. */
  d: HarmonicPoint | null
  /** Latest closed candle that touched D; drives the stale-zone expiry. */
  lastTouchIndex: number | null
  /** XA band before optional Butterfly BC confluence narrows it. */
  baseZone: { low: number; high: number }
  zone: { low: number; high: number }
  zoneNarrowed: boolean
  bRatio: number
  cRatio: number
  dRatioRange: readonly [number, number]
  cInvalidation: number
  /** L18 stop boundary: X for Gartley and Bat, the far edge of D for Butterfly. A wick beyond it ends the setup. */
  stopReference: number
  confirmedAt: number
  endedAt: number | null
  status: HarmonicStatus
}

export interface HarmonicAnalysis {
  setups: HarmonicSetup[]
  closedBarCount: number
}

export const HARMONIC_MAX_HISTORY = 500
export const HARMONIC_PIVOT_BARS = 3
/** Scanner conventions, not lecture trading rules or modeled holding periods. */
export const HARMONIC_EXPIRY_BARS = 60
/** Closed candles a touched setup may spend outside D before it is treated as stale. */
export const HARMONIC_TOUCH_RECENCY_BARS = 12

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

type PivotKind = 'high' | 'low'
interface Pivot extends HarmonicPoint { kind: PivotKind }

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

function strictPivot(bars: readonly RsiBar[], index: number, kind: PivotKind): boolean {
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

function touches(setup: HarmonicSetup, bar: Pick<RsiBar, 'high' | 'low'>): boolean {
  return bar.low <= setup.zone.high && bar.high >= setup.zone.low
}

function crossesB(setup: HarmonicSetup, bar: RsiBar): boolean {
  return setup.direction === 'bullish' ? bar.close < setup.b.price : bar.close > setup.b.price
}

/** A wick beyond the stop boundary always ends the setup; C's outer boundary only matters before D is reached. */
function breaches(setup: HarmonicSetup, bar: Pick<RsiBar, 'high' | 'low'>): boolean {
  const bullish = setup.direction === 'bullish'
  if (bullish ? bar.low < setup.stopReference : bar.high > setup.stopReference) return true
  if (setup.d) return false
  return bullish ? bar.high > setup.cInvalidation : bar.low < setup.cInvalidation
}

function reachesFirstTarget(setup: HarmonicSetup, bar: Pick<RsiBar, 'high' | 'low'>): boolean {
  const first = getHarmonicTargets(setup)[0]
  if (!first) return false
  return setup.direction === 'bullish' ? bar.high >= first.price : bar.low <= first.price
}

function end(setup: HarmonicSetup, status: HarmonicStatus, time: number): void {
  setup.status = status
  setup.endedAt = time
}

function advance(setup: HarmonicSetup, bar: RsiBar, index: number): void {
  if (setup.status !== 'active') return
  // A wick through a boundary wins an ambiguous candle; OHLC cannot order intrabar events.
  if (breaches(setup, bar)) {
    end(setup, 'invalidated', bar.closeTime)
    return
  }
  if (!setup.d) {
    if (index - setup.c.index >= HARMONIC_EXPIRY_BARS) {
      end(setup, 'expired', bar.closeTime)
    } else if (touches(setup, bar)) {
      setup.d = {
        index, time: bar.openTime,
        // The observed extreme within D, rather than an invented future endpoint.
        price: setup.direction === 'bullish' ? Math.max(bar.low, setup.zone.low) : Math.min(bar.high, setup.zone.high),
      }
      setup.lastTouchIndex = index
      setup.stage = 'zone'
    } else if (crossesB(setup, bar)) {
      setup.stage = 'approaching'
    }
    return
  }
  if (reachesFirstTarget(setup, bar)) end(setup, 'completed', bar.closeTime)
  else if (touches(setup, bar)) setup.lastTouchIndex = index
  else if (index - setup.lastTouchIndex! >= HARMONIC_TOUCH_RECENCY_BARS) end(setup, 'expired', bar.closeTime)
}

function createSetup(
  kind: HarmonicKind, direction: HarmonicDirection, x: HarmonicPoint, a: HarmonicPoint, b: HarmonicPoint, c: HarmonicPoint,
  bRatio: number, cRatio: number, bars: readonly RsiBar[], confirmationIndex: number,
): HarmonicSetup | null {
  const xa = a.price - x.price
  const ab = a.price - b.price
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
    kind, direction, stage: 'forming', x, a, b, c, d: null, lastTouchIndex: null,
    baseZone, zone, zoneNarrowed,
    bRatio, cRatio, dRatioRange, cInvalidation,
    stopReference: kind === 'butterfly' ? (direction === 'bullish' ? zone.low : zone.high) : x.price,
    confirmedAt: bars[confirmationIndex].closeTime, endedAt: null, status: 'active',
  }
  // The pattern only exists once C's third right-hand candle closes. Replay the candles
  // since C so a touch already in progress is reported, and a dead-on-arrival candidate is dropped.
  for (let index = c.index + 1; index <= confirmationIndex; index++) advance(setup, bars[index], index)
  return setup.status === 'active' ? setup : null
}

/**
 * Enumerate XABC candidates that end at the newly confirmed pivot C, the way L18 draws them:
 * A is the extreme of the whole X..C window, B is the deepest retracement between A and C,
 * C is the extreme after B, and X is the extreme before A. Several X can validate the same
 * A-B-C at different ratio bands; the nearest X per family is kept.
 */
function discover(
  bars: readonly RsiBar[], kinds: readonly (PivotKind | undefined)[], c: Pivot, confirmationIndex: number,
): HarmonicSetup[] {
  const bullish = c.kind === 'high'
  const direction: HarmonicDirection = bullish ? 'bullish' : 'bearish'
  // Orient so that bullish geometry applies: "up" is toward A, "down" is toward X and B.
  const up = (index: number) => bullish ? bars[index].high : -bars[index].low
  const down = (index: number) => bullish ? bars[index].low : -bars[index].high
  const point = (index: number, side: 'up' | 'down'): HarmonicPoint => ({
    index, time: bars[index].openTime,
    price: (side === 'up') === bullish ? bars[index].high : bars[index].low,
  })
  const found: HarmonicSetup[] = []
  let interiorUp = up(c.index)
  let interiorDown = Infinity
  let bIndex = -1
  for (let aIndex = c.index - 1; aIndex >= 0; aIndex--) {
    const aIsPivot = kinds[aIndex] === (bullish ? 'high' : 'low')
    if (aIsPivot && bIndex >= 0 && up(aIndex) > interiorUp) {
      let cDominant = true
      for (let index = bIndex + 1; index < c.index && cDominant; index++) if (up(index) >= up(c.index)) cDominant = false
      if (cDominant) {
        const a = point(aIndex, 'up')
        const b = point(bIndex, 'down')
        const ab = a.price - b.price
        const families = new Set<HarmonicKind>()
        let beforeAUp = -Infinity
        let beforeADown = Math.min(interiorDown, down(aIndex))
        for (let xIndex = aIndex - 1; xIndex >= 0 && families.size < 3; xIndex--) {
          if (Math.max(beforeAUp, up(xIndex)) >= up(aIndex)) break
          if (kinds[xIndex] === (bullish ? 'low' : 'high') && down(xIndex) < beforeADown) {
            const x = point(xIndex, 'down')
            const xa = a.price - x.price
            const bRatio = ab / xa
            const cRatio = (c.price - b.price) / ab
            const kind = (Object.keys(HARMONIC_RATIOS) as HarmonicKind[])
              .find((candidate) => inRange(bRatio, HARMONIC_RATIOS[candidate].b))
            if (kind && !families.has(kind)) {
              families.add(kind)
              if (inRange(cRatio, HARMONIC_C_RANGE)) {
                const setup = createSetup(kind, direction, x, a, b, point(c.index, 'up'), bRatio, cRatio, bars, confirmationIndex)
                if (setup) found.push(setup)
              }
            }
          }
          beforeAUp = Math.max(beforeAUp, up(xIndex))
          beforeADown = Math.min(beforeADown, down(xIndex))
        }
      }
    }
    interiorUp = Math.max(interiorUp, up(aIndex))
    if (down(aIndex) < interiorDown) {
      interiorDown = down(aIndex)
      bIndex = aIndex
    }
  }
  return found
}

/**
 * Causal, linear-price harmonic scanner for L17/L18. Strict 3/3 wick pivots become
 * available three closed candles late; each new pivot is tried as C against every
 * dominant A and X behind it. A later C for the same X, A, and family supersedes the
 * earlier drawing. Targets and BC narrowing are projections, without order or P&L simulation.
 */
export function analyzeHarmonics(bars: readonly RsiBar[]): HarmonicAnalysis {
  const closed = closedSuffix(bars)
  const setups: HarmonicSetup[] = []
  const kinds: (PivotKind | undefined)[] = new Array(closed.length)
  const latest = new Map<string, HarmonicSetup>()
  let active: HarmonicSetup[] = []
  for (let index = 0; index < closed.length; index++) {
    for (const setup of active) advance(setup, closed[index], index)
    active = active.filter((setup) => setup.status === 'active')
    const pivotIndex = index - HARMONIC_PIVOT_BARS
    if (pivotIndex < 0) continue
    const high = strictPivot(closed, pivotIndex, 'high')
    const low = strictPivot(closed, pivotIndex, 'low')
    // Outside candles have no knowable intrabar high/low order.
    if (high === low) continue
    const kind: PivotKind = high ? 'high' : 'low'
    kinds[pivotIndex] = kind
    const c: Pivot = { index: pivotIndex, time: closed[pivotIndex].openTime, price: closed[pivotIndex][kind], kind }
    for (const setup of discover(closed, kinds, c, index)) {
      const key = `${setup.x.index}:${setup.a.index}:${setup.kind}`
      const previous = latest.get(key)
      if (previous?.status === 'active') end(previous, 'superseded', setup.confirmedAt)
      latest.set(key, setup)
      setups.push(setup)
      active.push(setup)
    }
    active = active.filter((setup) => setup.status === 'active')
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
  const outside = invalidPreview || breaches(setup, { high: price, low: price })
    || (provisional !== undefined && breaches(setup, provisional))
  return {
    inZone: setup.status === 'active' && !outside && distance === 0,
    distancePercent: distance / price * 100,
    invalidated: setup.status !== 'active' || outside,
  }
}

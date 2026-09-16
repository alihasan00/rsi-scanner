import type { RsiBar } from '../types'
import { isValidClosedRsiBar } from './divergence'
import { strictRsiPivot } from './rsiPivots'

export type RsiTrendlineKind = 'resistance' | 'support'
export type RsiTrendlineState = 'formed' | 'approaching' | 'broken' | 'expired' | 'superseded' | 'interrupted'

export interface RsiTrendline {
  id: string
  kind: RsiTrendlineKind
  /** Anchor candle opening timestamps; both anchors belong to one known cycle. */
  start: { time: number; rsi: number }
  end: { time: number; rsi: number }
  /** Close timestamp at which all right-side anchor candles were available. */
  formedAt: number
  state: RsiTrendlineState
  brokenAt: number | null
  breakTime: number | null
  breakRsi: number | null
  breakGrade: 'ideal' | 'same-side' | null
  touches: number
  barsSinceBreak: number | null
  warningActive: boolean
  /** First resolution close; a recorded break is never replaced by its expiry. */
  resolvedAt: number | null
  /** A support breakdown warning ends permanently on the first close back on/above its ray. */
  reclaimedAt: number | null
  breakId: string | null
  slopePerBar: number
}

export interface RsiTrendlineOptions {
  leftBars: number
  rightBars: number
  minAnchorBars: number
  minAnchorChange: number
  minSlope: number
  maxSlope: number
  touchTolerance: number
  breakMargin: number
  approachDistance: number
  activeBars: number
  brokenRelevanceBars: number
}

/** Numeric tolerances and lifetimes are scanner conventions, not lecture rules. */
export const DEFAULT_RSI_TRENDLINE_OPTIONS: Readonly<RsiTrendlineOptions> = Object.freeze({
  leftBars: 5,
  rightBars: 5,
  minAnchorBars: 5,
  minAnchorChange: 3,
  minSlope: 0.05,
  maxSlope: 1.5,
  touchTolerance: 0.5,
  breakMargin: 0.5,
  approachDistance: 2,
  activeBars: 120,
  brokenRelevanceBars: 12,
})

function validateOptions(options: RsiTrendlineOptions): void {
  for (const key of ['leftBars', 'rightBars', 'minAnchorBars', 'activeBars', 'brokenRelevanceBars'] as const) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) {
      throw new RangeError(`${key} must be a positive safe integer`)
    }
  }
  for (const key of ['minAnchorChange', 'minSlope', 'maxSlope', 'touchTolerance', 'breakMargin', 'approachDistance'] as const) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new RangeError(`${key} must be finite and non-negative`)
    }
  }
  if (options.minSlope <= 0 || options.maxSlope < options.minSlope) {
    throw new RangeError('Slope bounds must be positive and maxSlope must be at least minSlope')
  }
  if (options.breakMargin < options.touchTolerance) {
    throw new RangeError('breakMargin must be at least touchTolerance')
  }
}

/** Extend the ray by time so charts can clip anchors outside their visible window. */
export function trendlineRsiAtTime(line: Pick<RsiTrendline, 'start' | 'end'>, time: number): number {
  return line.start.rsi + (line.end.rsi - line.start.rsi)
    * (time - line.start.time) / (line.end.time - line.start.time)
}

export function isVisibleRsiTrendline(line: RsiTrendline): boolean {
  return line.state === 'formed' || line.state === 'approaching' || line.state === 'broken'
}

interface Cycle {
  side: -1 | 1
  knownStart: boolean
  extreme: number
  active: TrackedLine | null
}

interface TrackedLine {
  line: RsiTrendline
  cycle: Cycle
  formedIndex: number
  brokenIndex: number | null
}

function isUnbroken(line: RsiTrendline): boolean {
  return line.state === 'formed' || line.state === 'approaching'
}

function safeDistance(line: Pick<RsiTrendline, 'kind' | 'start' | 'end'>, bar: RsiBar): number {
  const ray = trendlineRsiAtTime(line, bar.openTime)
  return line.kind === 'support' ? bar.rsi - ray : ray - bar.rsi
}

/**
 * Replay only information available on each close. A cycle is a contiguous
 * stretch strictly above/below 50; equality and crossings start fresh cycles.
 * The initial, possibly truncated cycle of each data segment is excluded.
 *
 * The first anchor is the cycle extreme observable at formation, itself a
 * confirmed strict pivot. A later mature pivot supplies a tangent contact:
 * no sample from the extreme through formation may violate that ray beyond
 * touchTolerance. Earlier contacts on the same ray keep the original anchors.
 * A different eligible ray supersedes an unbroken line in that same cycle.
 *
 * Lines survive 50 crossings and only start watching for breaks AFTER their
 * formation close. A close more than breakMargin through the ray records one
 * immutable event. "Ideal" means that close is strictly on the opposite side
 * of 50 from the anchors; equality gets the conservative same-side grade.
 *
 * activeBars counts closes after formation. Broken lines remain visible for
 * ages 0 through brokenRelevanceBars - 1. A bearish support-break warning lasts
 * until the first reclaim close, expiry, or a data interruption. Reclaims keep
 * the original break visible, and never reactivate that event's warning.
 * Trailing live previews do nothing; interior invalid bars or gaps interrupt
 * existing records and require a freshly observed cycle before new anchors.
 */
export function findRsiTrendlines(
  bars: readonly RsiBar[],
  options: Partial<RsiTrendlineOptions> = {},
): RsiTrendline[] {
  const settings = { ...DEFAULT_RSI_TRENDLINE_OPTIONS, ...options }
  validateOptions(settings)
  const records: RsiTrendline[] = []
  const live = new Set<TrackedLine>()
  const cycleAt: (Cycle | null)[] = []
  const confirmedHighs = new Set<number>()
  const confirmedLows = new Set<number>()
  let cycle: Cycle | null = null
  let previousValid: number | null = null
  let previousSide: -1 | 0 | 1 | null = null
  let segmentStart = 0

  function retire(tracked: TrackedLine, state: 'expired' | 'superseded' | 'interrupted', time: number) {
    tracked.line.state = state
    tracked.line.resolvedAt ??= time
    tracked.line.warningActive = false
    live.delete(tracked)
    if (tracked.cycle.active === tracked) tracked.cycle.active = null
  }

  function interrupt(time: number) {
    for (const tracked of live) retire(tracked, 'interrupted', time)
    cycle = null
    previousValid = null
    previousSide = null
  }

  function advance(tracked: TrackedLine, index: number) {
    const { line } = tracked
    const current = bars[index]
    if (tracked.brokenIndex !== null) {
      line.barsSinceBreak = index - tracked.brokenIndex
      if (line.barsSinceBreak >= settings.brokenRelevanceBars) {
        retire(tracked, 'expired', current.closeTime)
      } else if (line.warningActive && safeDistance(line, current) >= 0) {
        line.warningActive = false
        line.reclaimedAt = current.closeTime
      }
      return
    }
    if (index - tracked.formedIndex >= settings.activeBars) {
      retire(tracked, 'expired', current.closeTime)
      return
    }
    const distance = safeDistance(line, current)
    if (distance < -settings.breakMargin) {
      line.state = 'broken'
      line.brokenAt = current.closeTime
      line.breakTime = current.openTime
      line.breakRsi = current.rsi
      line.breakGrade = (line.kind === 'support' ? current.rsi > 50 : current.rsi < 50) ? 'ideal' : 'same-side'
      line.breakId = `${line.id}:break:${current.openTime}`
      line.resolvedAt = current.closeTime
      line.barsSinceBreak = 0
      line.warningActive = line.kind === 'support'
      tracked.brokenIndex = index
      if (tracked.cycle.active === tracked) tracked.cycle.active = null
    } else {
      line.state = distance <= settings.approachDistance ? 'approaching' : 'formed'
    }
  }

  function considerContact(pivot: number, confirmation: number, low: boolean) {
    const anchorCycle = cycleAt[pivot]
    if (!anchorCycle?.knownStart || (anchorCycle.side === -1) !== low) return
    const firstIndex = anchorCycle.extreme
    const distance = pivot - firstIndex
    if (distance < settings.minAnchorBars) return
    if (!(low ? confirmedLows : confirmedHighs).has(firstIndex)) return
    const first = bars[firstIndex]
    const second = bars[pivot]
    const change = second.rsi - first.rsi
    const slope = change / distance
    if ((low ? change <= 0 : change >= 0)
      || Math.abs(change) < settings.minAnchorChange
      || Math.abs(slope) < settings.minSlope
      || Math.abs(slope) > settings.maxSlope) return

    const candidate = {
      kind: low ? 'support' as const : 'resistance' as const,
      start: { time: first.openTime, rsi: first.rsi },
      end: { time: second.openTime, rsi: second.rsi },
    }
    let touches = 0
    const confirmedContacts = low ? confirmedLows : confirmedHighs
    for (let sample = firstIndex; sample <= confirmation; sample++) {
      const contactDistance = safeDistance(candidate, bars[sample])
      if (contactDistance < -settings.touchTolerance) return
      if (sample <= pivot && confirmedContacts.has(sample)
        && cycleAt[sample] === anchorCycle && Math.abs(contactDistance) <= settings.touchTolerance) touches++
    }

    const previous = anchorCycle.active
    if (previous && isUnbroken(previous.line)) {
      if (previous.line.start.time === first.openTime
        && Math.abs(safeDistance(previous.line, second)) <= settings.touchTolerance) {
        previous.line.touches++
        return
      }
      retire(previous, 'superseded', bars[confirmation].closeTime)
    }
    const line: RsiTrendline = {
      ...candidate,
      id: `rsi-${candidate.kind}:${first.openTime}:${second.openTime}`,
      formedAt: bars[confirmation].closeTime,
      state: safeDistance(candidate, bars[confirmation]) <= settings.approachDistance ? 'approaching' : 'formed',
      brokenAt: null,
      breakTime: null,
      breakRsi: null,
      breakGrade: null,
      touches,
      barsSinceBreak: null,
      warningActive: false,
      resolvedAt: null,
      reclaimedAt: null,
      breakId: null,
      slopePerBar: slope,
    }
    const tracked: TrackedLine = { line, cycle: anchorCycle, formedIndex: confirmation, brokenIndex: null }
    records.push(line)
    live.add(tracked)
    anchorCycle.active = tracked
  }

  for (let index = 0; index < bars.length; index++) {
    const current = bars[index]
    // An in-progress trailing candle is not an observation about closed history.
    if (index === bars.length - 1 && current.isClosed === false) break
    if (!isValidClosedRsiBar(current)) {
      const lastClose = previousValid === null ? 0 : bars[previousValid].closeTime
      const interruptionTime = Number.isSafeInteger(current.closeTime) && current.closeTime >= lastClose
        ? current.closeTime : lastClose
      interrupt(interruptionTime)
      segmentStart = index + 1
      cycleAt[index] = null
      continue
    }
    if (previousValid !== null && current.openTime !== bars[previousValid].closeTime + 1) {
      interrupt(current.closeTime)
      segmentStart = index
    }

    const side = current.rsi === 50 ? 0 : current.rsi < 50 ? -1 : 1
    if (side === 0) {
      cycle = null
    } else if (!cycle || cycle.side !== side) {
      cycle = { side, knownStart: previousSide !== null, extreme: index, active: null }
    } else if (side === -1 ? current.rsi < bars[cycle.extreme].rsi : current.rsi > bars[cycle.extreme].rsi) {
      cycle.extreme = index
    }
    cycleAt[index] = cycle
    previousSide = side
    previousValid = index

    // These lines existed before this close; a newly mature ray cannot backfill
    // a break on its formation candle or anywhere in its right-side window.
    for (const tracked of live) advance(tracked, index)

    const pivot = index - settings.rightBars
    if (pivot - settings.leftBars < segmentStart) continue
    const flags = strictRsiPivot(bars, pivot, settings.leftBars, settings.rightBars)
    if (flags.low) {
      confirmedLows.add(pivot)
      considerContact(pivot, index, true)
    }
    if (flags.high) {
      confirmedHighs.add(pivot)
      considerContact(pivot, index, false)
    }
  }
  return records
}

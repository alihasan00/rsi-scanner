import type { Candle } from '../types'

export type FibBar = Candle & { isClosed: boolean }
export type FibScale = 'linear' | 'log'
export type FibDirection = 'long' | 'short'
export type FibStopRatio = 0.92 | 1.04 | 1.14 | 1.272

export interface FibOptions {
  scale: FibScale
  stopRatio: FibStopRatio
  tp3Ratio: 0 | -0.236
  tp4Ratio: number
  runnerRatio: number
}

/** Enabled reference grid from the supplied tool-settings screenshot. */
export const FIB_REFERENCE_RATIOS = Object.freeze([
  0, 0.236, 0.382, 0.5, 0.618, 0.666, 0.786, 0.886, 0.92, 1, 1.618, 3.618,
  -0.236, -0.382, -0.618,
])

/** Default extension signs agree with the supplied tool-settings screenshot. */
export const DEFAULT_FIB_OPTIONS: Readonly<FibOptions> = Object.freeze({
  scale: 'linear', stopRatio: 0.92, tp3Ratio: -0.236,
  tp4Ratio: -0.382, runnerRatio: -0.618,
})

export type FibStatus = 'watching' | 'entered' | 'managing' | 'runner'
  | 'stopped' | 'missed' | 'invalidated' | 'superseded'

export interface FibAnchor {
  /** Stable ordinal in the uninterrupted replay, even after discovery history rolls. */
  index: number
  time: number
  price: number
  confirmedAt: number
}

export interface FibEntry {
  ratio: number
  price: number
  /** Percentage of the quote-currency entry budget, not of base quantity. */
  weight: number
  /** The close of the candle containing the touch; never an exact fill time. */
  touchedAt: number | null
  filledAt: number | null
  status: 'pending' | 'filled' | 'missed' | 'cancelled'
}

export interface FibTarget {
  id: 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'runner'
  ratio: number
  price: number
  /** Percentage of the position filled before TP1. Runner only moves the stop. */
  exitPercent: number
  hitAt: number | null
}

export interface FibEvent {
  time: number
  kind: 'detected' | 'entry' | 'target' | 'stop' | 'ambiguous' | 'missed'
    | 'invalidated' | 'superseded' | 'orders-cancelled'
  detail: string
}

export interface FibSetup {
  id: string
  direction: FibDirection
  status: FibStatus
  start: FibAnchor
  end: FibAnchor
  /** First observable close after both the structure break and endpoint maturity. */
  detectedAt: number
  breakAt: number
  resolvedAt: number | null
  scale: FibScale
  stopRatio: FibStopRatio
  levels: { ratio: number; price: number }[]
  /** Beyond-origin references that are nonpositive or nonfinite on this grid. */
  unavailableReferenceRatios: number[]
  goldenPocket: { low: number; high: number }
  entries: FibEntry[]
  targets: FibTarget[]
  initialStop: number
  currentStop: number
  plannedAverage: number
  actualAverage: number | null
  remainingPercent: number
  events: FibEvent[]
}

export interface FibAnalysis {
  /** Latest plan, including a terminal plan for chart context. Check status before filtering. */
  setup: FibSetup | null
  setups: FibSetup[]
  structure: 'bullish' | 'bearish' | 'range' | 'insufficient'
  closedBars: number
  lastClosedAt: number | null
  sma200: number | null
  smaConfluence: 'aligned' | 'against' | 'unavailable' | null
  historyIssue: 'gap' | 'invalid' | null
  pendingDirection: FibDirection | null
  /** A restored checkpoint or an explicit loss of older lifecycle evidence. */
  continuity?: { state: 'restored' | 'reset'; detail: string; previousSetupId: string | null }
  /** Browser storage failed; in-memory lifecycle tracking still continues. */
  persistenceIssue?: 'unavailable'
}

export interface FibLiveContext {
  price: number
  ratio: number
  inGoldenPocket: boolean
  distanceToEntryPercent: number
  distanceToStopPercent: number
  active: boolean
}

const PIVOT_BARS = 3
export const FIB_DISCOVERY_BARS = 500
const ENTRY_RATIOS = [0.618, 0.786, 0.886] as const
const ENTRY_WEIGHTS = [20, 30, 50] as const

function validateOptions(options: FibOptions): void {
  if (options.scale !== 'linear' && options.scale !== 'log') {
    throw new TypeError('Fibonacci scale must be linear or log')
  }
  if (![0.92, 1.04, 1.14, 1.272].includes(options.stopRatio)) {
    throw new RangeError('Fibonacci stop must be 0.92, 1.04, 1.14, or 1.272')
  }
  if (options.tp3Ratio !== 0 && options.tp3Ratio !== -0.236) {
    throw new RangeError('TP3 must be 0 or -0.236')
  }
  if (!Number.isFinite(options.tp4Ratio) || options.tp4Ratio >= options.tp3Ratio
    || !Number.isFinite(options.runnerRatio) || options.runnerRatio >= options.tp4Ratio) {
    throw new RangeError('TP4 and runner must be finite extensions ordered after TP3')
  }
}

/** Ratio 0 is the impulse endpoint; ratio 1 is its origin in either direction. */
export function fibPrice(start: number, end: number, ratio: number, scale: FibScale = 'linear'): number {
  if (![start, end, ratio].every(Number.isFinite) || start <= 0 || end <= 0) {
    throw new RangeError('Fibonacci anchors must be positive and all inputs finite')
  }
  if (scale !== 'linear' && scale !== 'log') throw new TypeError('Fibonacci scale must be linear or log')
  return scale === 'log'
    ? Math.exp(Math.log(end) + ratio * (Math.log(start) - Math.log(end)))
    : end + ratio * (start - end)
}

export function isActiveFibSetup(setup: Pick<FibSetup, 'status'>): boolean {
  return ['watching', 'entered', 'managing', 'runner'].includes(setup.status)
}

/** Price context is deliberately separate: live prices cannot confirm or consume a plan. */
export function getFibLiveContext(setup: FibSetup | null, price: number): FibLiveContext | null {
  if (!setup || !Number.isFinite(price) || price <= 0) return null
  const { start, end, scale } = setup
  const ratio = scale === 'log'
    ? (Math.log(price) - Math.log(end.price)) / (Math.log(start.price) - Math.log(end.price))
    : (price - end.price) / (start.price - end.price)
  return {
    price, ratio,
    inGoldenPocket: price >= setup.goldenPocket.low && price <= setup.goldenPocket.high,
    distanceToEntryPercent: Math.abs(price - setup.entries[0].price) / price * 100,
    distanceToStopPercent: Math.abs(price - setup.currentStop) / price * 100,
    active: isActiveFibSetup(setup),
  }
}

function validBar(bar: FibBar): boolean {
  return [bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)
    && Number.isFinite(bar.volume) && bar.volume >= 0
    && Number.isSafeInteger(bar.openTime) && Number.isSafeInteger(bar.closeTime)
    && bar.closeTime >= bar.openTime
    && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close)
}


function pivotAt(bars: readonly FibBar[], index: number, kind: 'high' | 'low'): boolean {
  if (index < PIVOT_BARS || index + PIVOT_BARS >= bars.length) return false
  const price = bars[index][kind]
  for (let offset = -PIVOT_BARS; offset <= PIVOT_BARS; offset++) {
    if (offset === 0) continue
    if (kind === 'high' ? bars[index + offset].high >= price : bars[index + offset].low <= price) return false
  }
  return true
}

function anchorAt(bars: readonly FibBar[], index: number, kind: 'high' | 'low', confirmedAt: number, offset = 0): FibAnchor {
  return { index: index + offset, time: bars[index].openTime, price: bars[index][kind], confirmedAt }
}

function entryTouched(direction: FibDirection, bar: FibBar, price: number): boolean {
  // A resting limit also executes through a gap, conservatively priced at the limit.
  return direction === 'long' ? bar.low <= price : bar.high >= price
}

function targetTouched(direction: FibDirection, bar: FibBar, price: number): boolean {
  return direction === 'long' ? bar.high >= price : bar.low <= price
}

/** Quote allocation / base quantity: harmonic, quantity-weighted cost, not mean(ratios). */
function average(entries: readonly FibEntry[]): number {
  return entries.reduce((total, entry) => total + entry.weight, 0)
    / entries.reduce((total, entry) => total + entry.weight / entry.price, 0)
}

function event(setup: FibSetup, time: number, kind: FibEvent['kind'], detail: string): void {
  setup.events.push({ time, kind, detail })
}

function finish(setup: FibSetup, status: 'stopped' | 'missed' | 'invalidated' | 'superseded', time: number): void {
  setup.status = status
  setup.resolvedAt = time
  for (const entry of setup.entries) if (entry.status === 'pending') entry.status = 'cancelled'
  if (status === 'stopped') setup.remainingPercent = 0
}

interface Impulse {
  direction: FibDirection
  start: FibAnchor
  endIndex: number
  breakAt: number
  durableOrigin?: boolean
}

function originKey(direction: FibDirection, start: FibAnchor): string {
  return `${direction}:${start.time}`
}

function createSetup(impulse: Impulse, bars: readonly FibBar[], index: number, options: FibOptions, offset = 0): FibSetup | null {
  const time = bars[index].closeTime
  const endIndex = impulse.endIndex - offset
  const end = anchorAt(bars, endIndex, impulse.direction === 'long' ? 'high' : 'low',
    bars[endIndex + PIVOT_BARS].closeTime, offset)
  const price = (ratio: number) => fibPrice(impulse.start.price, end.price, ratio, options.scale)
  const entries: FibEntry[] = ENTRY_RATIOS.map((ratio, i) => ({
    ratio, price: price(ratio), weight: ENTRY_WEIGHTS[i], touchedAt: null, filledAt: null, status: 'pending',
  }))
  const targetRatios = [0.382, 0.236, options.tp3Ratio, options.tp4Ratio, options.runnerRatio]
  const targetIds: FibTarget['id'][] = ['tp1', 'tp2', 'tp3', 'tp4', 'runner']
  const targets = targetRatios.map((ratio, i): FibTarget => ({
    id: targetIds[i], ratio, price: price(ratio), exitPercent: [20, 20, 20, 30, 0][i], hitAt: null,
  }))
  const allLevels = [...new Set([...FIB_REFERENCE_RATIOS,
    options.stopRatio, ...targetRatios])].sort((a, b) => a - b).map((ratio) => ({ ratio, price: price(ratio) }))
  const usablePrice = (value: number) => Number.isFinite(value) && value > 0
  // Extreme linear ranges/extensions can produce impossible prices. Do not issue those plans.
  if (![...entries, ...targets].every((level) => usablePrice(level.price)) || !usablePrice(price(options.stopRatio))) return null
  const levels = allLevels.filter((level) => usablePrice(level.price))
  const unavailableReferenceRatios = allLevels.filter((level) => !usablePrice(level.price)).map((level) => level.ratio)
  const setup: FibSetup = {
    id: `${impulse.direction}:${impulse.start.time}:${end.time}:${impulse.breakAt}`,
    direction: impulse.direction, status: 'watching', start: { ...impulse.start }, end,
    detectedAt: time, breakAt: impulse.breakAt, resolvedAt: null,
    scale: options.scale, stopRatio: options.stopRatio, levels, unavailableReferenceRatios,
    goldenPocket: { low: Math.min(price(0.618), price(0.666)), high: Math.max(price(0.618), price(0.666)) },
    entries, targets, initialStop: price(options.stopRatio), currentStop: price(options.stopRatio),
    plannedAverage: average(entries), actualAverage: null, remainingPercent: 100, events: [],
  }
  event(setup, time, 'detected', 'Structure break and three closed right-side candles confirm the impulse endpoint.')
  for (let i = endIndex + 1; i <= index; i++) {
    for (const entry of setup.entries) {
      if (entry.touchedAt === null && entryTouched(setup.direction, bars[i], entry.price)) {
        entry.touchedAt = bars[i].closeTime
        entry.status = 'missed'
      }
    }
  }
  if (setup.entries.some((entry) => entry.status === 'missed')) {
    event(setup, time, 'missed', 'Entry pocket was touched before endpoint confirmation; no executable fills are credited.')
    finish(setup, 'missed', time)
  }
  return setup
}

/** Advance an existing resting plan using only the newly closed candle. */
function advanceSetup(setup: FibSetup, bar: FibBar): void {
  const time = bar.closeTime
  let enteredThisBar = false
  for (const entry of setup.entries) {
    if (entry.status !== 'pending' || !entryTouched(setup.direction, bar, entry.price)) continue
    entry.status = 'filled'
    entry.touchedAt = time
    entry.filledAt = time
    enteredThisBar = true
    event(setup, time, 'entry', `${entry.weight}% quote allocation filled at ${entry.ratio}.`)
  }
  if (enteredThisBar) {
    setup.actualAverage = average(setup.entries.filter((entry) => entry.status === 'filled'))
    setup.status = 'entered'
    if (targetTouched(setup.direction, bar, setup.end.price)) {
      event(setup, time, 'ambiguous', 'Entry and a new endpoint extreme share a candle; resting entry takes priority and anchors freeze.')
    }
  }
  if (setup.actualAverage === null) return

  // The previously placed stop wins whenever its candle also spans targets.
  if (entryTouched(setup.direction, bar, setup.currentStop)) {
    if (setup.direction === 'long' ? bar.open < setup.currentStop : bar.open > setup.currentStop) {
      event(setup, time, 'ambiguous', 'Candle opened beyond the stop; actual gap execution is unknown and may be worse than the displayed stop.')
    }
    if (setup.targets.some((target) => target.hitAt === null && targetTouched(setup.direction, bar, target.price))) {
      event(setup, time, 'ambiguous', 'Stop and target share an OHLC candle; stop is recorded first.')
    }
    event(setup, time, 'stop', 'Current stop reached; remaining position exited.')
    finish(setup, 'stopped', time)
    return
  }
  if (enteredThisBar) {
    if (setup.targets.some((target) => target.hitAt === null && targetTouched(setup.direction, bar, target.price))) {
      event(setup, time, 'ambiguous', 'Entry and target share an OHLC candle; targets require a later candle.')
    }
    return
  }

  for (let i = 0; i < setup.targets.length; i++) {
    const target = setup.targets[i]
    if (target.hitAt !== null || !targetTouched(setup.direction, bar, target.price)) continue
    target.hitAt = time
    setup.remainingPercent -= target.exitPercent
    setup.currentStop = i === 0 ? setup.actualAverage : setup.targets[i - 1].price
    setup.status = i >= 3 ? 'runner' : 'managing'
    event(setup, time, 'target', target.id === 'runner'
      ? 'Runner extension reached; stop moves to TP4 without another exit.'
      : `${target.id.toUpperCase()} reached; ${target.exitPercent}% of the filled position exited and stop advanced.`)
    if (i === 0) {
      const unfilled = setup.entries.filter((entry) => entry.status === 'pending')
      for (const entry of unfilled) entry.status = 'cancelled'
      if (unfilled.length) event(setup, time, 'orders-cancelled', 'Unfilled entry orders are cancelled after TP1.')
    }
    // If order is unknowable, assume the newly raised stop followed this target.
    if (entryTouched(setup.direction, bar, setup.currentStop)) {
      event(setup, time, 'ambiguous', 'Target and newly raised stop share an OHLC candle; conservative stop exit recorded.')
      event(setup, time, 'stop', 'Raised stop reached; remaining position exited.')
      finish(setup, 'stopped', time)
      return
    }
  }
}

/**
 * Serializable replay state. Discovery uses at most 500 candles; a plan's
 * lifecycle, frozen anchors and consumed origin are independent of that window.
 * Callers must clone a checkpoint before advancing it or exposing its analysis.
 */
export interface FibReplayCheckpoint {
  version: 1
  options: FibOptions
  history: FibBar[]
  startedAt: number | null
  offset: number
  setups: FibSetup[]
  consumedOrigins: string[]
  brokenHighs: number[]
  brokenLows: number[]
  high: FibAnchor | null
  low: FibAnchor | null
  pending: Impulse | null
  structure: FibAnalysis['structure']
  historyIssue: FibAnalysis['historyIssue']
}

export function createFibReplay(options: Partial<FibOptions> = {}): FibReplayCheckpoint {
  const settings = { ...DEFAULT_FIB_OPTIONS, ...options }
  validateOptions(settings)
  return {
    version: 1, options: settings, history: [], startedAt: null, offset: 0, setups: [],
    consumedOrigins: [], brokenHighs: [], brokenLows: [], high: null, low: null,
    pending: null, structure: 'insufficient', historyIssue: null,
  }
}

/** Mutates only the supplied private checkpoint, never a candle or prior result. */
export function advanceFibReplay(state: FibReplayCheckpoint, bar: FibBar): void {
  const last = state.history.at(-1)
  if (!bar.isClosed || !validBar(bar) || (last && bar.openTime !== last.closeTime + 1)) {
    const issue = bar.isClosed && !validBar(bar) ? 'invalid' : 'gap'
    Object.assign(state, createFibReplay(state.options), { historyIssue: issue })
    if (!bar.isClosed || !validBar(bar)) return
  }
  state.startedAt ??= bar.openTime
  state.history.push({
    openTime: bar.openTime, closeTime: bar.closeTime, open: bar.open, high: bar.high,
    low: bar.low, close: bar.close, volume: bar.volume, isClosed: bar.isClosed,
  })
  if (state.history.length > FIB_DISCOVERY_BARS) {
    state.history.shift()
    state.offset++
  }
  const closed = state.history
  const offset = state.offset
  const i = closed.length - 1
  const ordinal = i + offset
  const time = bar.closeTime
  const settings = state.options
  let { high, low, pending, structure } = state
  const current = state.setups.at(-1) ?? null
  // Old structure cannot discover new plans. An existing plan still advances.
  if (high && high.index < offset + PIVOT_BARS) high = null
  if (low && low.index < offset + PIVOT_BARS) low = null
  if (!high || !low) structure = 'insufficient'
  if (pending && ((!pending.durableOrigin && pending.start.index < offset + PIVOT_BARS)
    || pending.endIndex < offset + PIVOT_BARS)) pending = null
  const firstTime = closed[0].openTime
  const consumedOrigins = new Set(state.consumedOrigins.filter((key) => Number(key.split(':')[1]) >= firstTime))
  const brokenHighs = new Set(state.brokenHighs.filter((value) => value >= firstTime))
  const brokenLows = new Set(state.brokenLows.filter((value) => value >= firstTime))
  let resolvedThisBar = false
  if (current && isActiveFibSetup(current)) {
    advanceSetup(current, bar)
    if (current.actualAverage !== null || current.status === 'missed') {
      consumedOrigins.add(originKey(current.direction, current.start))
    }
    if (!isActiveFibSetup(current)) resolvedThisBar = true
    else if (current.status === 'watching'
      && (current.direction === 'long' ? bar.high > current.end.price : bar.low < current.end.price)) {
      pending = { direction: current.direction, start: current.start, endIndex: ordinal,
        breakAt: current.breakAt, durableOrigin: true }
      event(current, time, 'superseded', 'Unentered impulse extended; wait for its new endpoint to mature.')
      finish(current, 'superseded', time)
    }
  }

  if (pending) {
    if (pending.direction === 'long' ? bar.close < pending.start.price : bar.close > pending.start.price) pending = null
    else if (pending.direction === 'long'
      ? bar.high > closed[pending.endIndex - offset].high : bar.low < closed[pending.endIndex - offset].low) pending.endIndex = ordinal
  }

  const pivotIndex = i - PIVOT_BARS
  const isHigh = pivotAt(closed, pivotIndex, 'high')
  const isLow = pivotAt(closed, pivotIndex, 'low')
  if (isHigh && !isLow) {
    const candidate = anchorAt(closed, pivotIndex, 'high', time, offset)
    if (!high || (low && low.index > high.index
      ? candidate.price >= fibPrice(high.price, low.price, 0.5, settings.scale)
      : candidate.price > high.price)) high = candidate
  } else if (isLow && !isHigh) {
    const candidate = anchorAt(closed, pivotIndex, 'low', time, offset)
    if (!low || (high && high.index > low.index
      ? candidate.price <= fibPrice(low.price, high.price, 0.5, settings.scale)
      : candidate.price < low.price)) low = candidate
  }

  if (high && low && structure === 'insufficient') structure = 'range'
  let direction: FibDirection | null = null
  if (high && low && bar.close > high.price && !brokenHighs.has(high.time)) {
    direction = 'long'
    brokenHighs.add(high.time)
    structure = 'bullish'
  } else if (high && low && bar.close < low.price && !brokenLows.has(low.time)) {
    direction = 'short'
    brokenLows.add(low.time)
    structure = 'bearish'
  }

  const hasPosition = current && isActiveFibSetup(current) && current.actualAverage !== null
  if (direction && !hasPosition && !resolvedThisBar) {
    const start = direction === 'long' ? low! : high!
    if (!consumedOrigins.has(originKey(direction, start))) {
      if (current && isActiveFibSetup(current)) {
        event(current, time, 'superseded', 'A fresh significant structure break replaced this unentered plan.')
        finish(current, 'superseded', time)
      }
      let endIndex = start.index - offset + 1
      for (let j = endIndex + 1; j <= i; j++) {
        if (direction === 'long' ? closed[j].high > closed[endIndex].high : closed[j].low < closed[endIndex].low) endIndex = j
      }
      pending = { direction, start: { ...start }, endIndex: endIndex + offset, breakAt: time }
    }
  }

  if (pending && !hasPosition && pending.endIndex - offset <= pivotIndex
    && pivotAt(closed, pending.endIndex - offset, pending.direction === 'long' ? 'high' : 'low')
    && !pivotAt(closed, pending.endIndex - offset, pending.direction === 'long' ? 'low' : 'high')) {
    const created = createSetup(pending, closed, i, settings, offset)
    if (created) {
      state.setups.push(created)
      if (created.status === 'missed') consumedOrigins.add(originKey(created.direction, created.start))
    }
    pending = null
  }
  // Bound terminal chart context; the latest plan always survives for resolution context.
  state.setups = state.setups.filter((setup, index, setups) => setup.detectedAt >= firstTime || index === setups.length - 1)
  Object.assign(state, {
    high, low, pending, structure,
    consumedOrigins: [...consumedOrigins], brokenHighs: [...brokenHighs], brokenLows: [...brokenLows],
  })
}

/** Analysis is detached from mutable checkpoint state. */
export function summarizeFibReplay(state: FibReplayCheckpoint): FibAnalysis {
  const setups = structuredClone(state.setups)
  const setup = setups.at(-1) ?? null
  const closed = state.history
  const last = closed.at(-1)
  const sma200 = closed.length >= 200
    ? closed.slice(-200).reduce((sum, bar) => sum + bar.close, 0) / 200 : null
  const smaConfluence = !setup ? null : sma200 === null ? 'unavailable'
    : (setup.direction === 'long' ? last!.close > sma200 : last!.close < sma200) ? 'aligned' : 'against'
  return {
    setup, setups, structure: state.structure, closedBars: closed.length, lastClosedAt: last?.closeTime ?? null,
    sma200, smaConfluence, historyIssue: state.historyIssue, pendingDirection: state.pending?.direction ?? null,
  }
}

/**
 * Causal OHLC scenario replay. Discovery and SMA are bounded to 500 candles;
 * active plans continue until an actual lifecycle event, regardless of age.
 * Full supplied history is replayed so a fresh long-history run agrees with a
 * rolling checkpoint. Interior invalid/missing data starts a fresh suffix.
 */
export function analyzeFibonacci(bars: readonly FibBar[], options: Partial<FibOptions> = {}): FibAnalysis {
  const state = createFibReplay(options)
  let end = bars.length
  while (end > 0 && !bars[end - 1].isClosed) end--
  for (let i = 0; i < end; i++) advanceFibReplay(state, bars[i])
  return summarizeFibReplay(state)
}

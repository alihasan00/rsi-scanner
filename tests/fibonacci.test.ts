import { describe, expect, test } from 'bun:test'
import {
  analyzeFibonacci, DEFAULT_FIB_OPTIONS, fibPrice, FIB_REFERENCE_RATIOS,
  getFibLiveContext, isActiveFibSetup,
} from '../src/lib/fibonacci'
import type { FibBar, FibOptions, FibSetup } from '../src/lib/fibonacci'

const MINUTE = 60_000
const START = 1_700_000_000_000

function bar(index: number, low: number, high: number, close = (low + high) / 2, open = close): FibBar {
  return {
    openTime: START + index * MINUTE, closeTime: START + (index + 1) * MINUTE - 1,
    open, high, low, close, volume: 100, isClosed: true,
  }
}

/** A significant 100->150 swing, a 120 pullback, then a closed break to 190. */
function bullish(pullback = 120): FibBar[] {
  const ranges = [
    [116, 120], [112, 116], [108, 113], [100, 111],
    [112, 120], [118, 130], [126, 140], [136, 150],
    [134, 145], [133, 142], [132, 138], [pullback, 134],
    [133, 140], [136, 147], [140, 149], [147, 162, 160],
    [158, 174, 170], [170, 190, 186], [176, 188], [173, 184], [169, 181],
  ]
  return ranges.map(([low, high, close], i) => bar(i, low, high, close))
}

function mirror(bars: readonly FibBar[]): FibBar[] {
  return bars.map((b) => ({ ...b, open: 400 - b.open, close: 400 - b.close, high: 400 - b.low, low: 400 - b.high }))
}

function append(bars: FibBar[], low: number, high: number, close?: number, open?: number): void {
  bars.push(bar(bars.length, low, high, close, open))
}

function setup(bars: readonly FibBar[], options: Partial<FibOptions> = {}): FibSetup {
  const result = analyzeFibonacci(bars, options).setup
  expect(result).not.toBeNull()
  return result!
}

describe('Fibonacci geometry and configuration', () => {
  test('uses zero at the endpoint and one at the origin, mirrored in both directions', () => {
    expect(fibPrice(100, 200, 0)).toBe(200)
    expect(fibPrice(100, 200, 1)).toBe(100)
    expect(fibPrice(100, 200, 0.618)).toBeCloseTo(138.2)
    expect(fibPrice(200, 100, 0.618)).toBeCloseTo(161.8)
    expect(fibPrice(100, 200, -0.236)).toBeCloseTo(223.6)
    expect(fibPrice(200, 100, -0.236)).toBeCloseTo(76.4)
  })

  test('interpolates logarithmic prices rather than applying linear levels on a log axis', () => {
    expect(fibPrice(100, 400, 0.5, 'log')).toBeCloseTo(200)
    expect(fibPrice(400, 100, 0.5, 'log')).toBeCloseTo(200)
    expect(fibPrice(100, 400, -0.5, 'log')).toBeCloseTo(800)
    expect(fibPrice(100, 400, 1.5, 'log')).toBeCloseTo(50)
  })

  test('exports the screenshot grid and treats 1.618/3.618 as reference lines', () => {
    expect(FIB_REFERENCE_RATIOS).toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.666, 0.786, 0.886,
      0.92, 1, 1.618, 3.618, -0.236, -0.382, -0.618])
    const found = setup(bullish())
    expect(found.targets.map((target) => target.ratio)).toEqual([0.382, 0.236, -0.236, -0.382, -0.618])
    expect(found.levels.some((level) => level.ratio === 1.618)).toBe(true)
    expect(found.unavailableReferenceRatios).toEqual([3.618])
    expect(setup(bullish(), { scale: 'log' }).unavailableReferenceRatios).toEqual([])
  })

  test('honours every configured stop and correctly ordered alternate targets', () => {
    expect(DEFAULT_FIB_OPTIONS).toEqual({ scale: 'linear', stopRatio: 0.92, tp3Ratio: -0.236,
      tp4Ratio: -0.382, runnerRatio: -0.618 })
    for (const stopRatio of [0.92, 1.04, 1.14, 1.272] as const) {
      const found = setup(bullish(), { stopRatio, tp3Ratio: 0, tp4Ratio: -0.236, runnerRatio: -0.5 })
      expect(found.currentStop).toBeCloseTo(190 - 70 * stopRatio)
      expect(found.targets.map((target) => target.ratio)).toEqual([0.382, 0.236, 0, -0.236, -0.5])
    }
  })

  test.each([
    { scale: 'arithmetic' }, { stopRatio: 1 }, { stopRatio: Infinity }, { tp3Ratio: 0.236 },
    { tp4Ratio: NaN }, { tp4Ratio: -0.1 }, { runnerRatio: Infinity }, { runnerRatio: -0.3 },
  ])('rejects malformed options even with no history: %p', (options) => {
    expect(() => analyzeFibonacci([], options as Partial<FibOptions>)).toThrow()
  })

  test('rejects malformed geometry', () => {
    for (const value of [NaN, Infinity, 0, -1]) expect(() => fibPrice(value, 100, 0.5)).toThrow()
    expect(() => fibPrice(100, 200, Infinity)).toThrow()
    expect(() => fibPrice(100, 200, 0.5, 'other' as 'linear')).toThrow()
  })
})

describe('causal significant structure and endpoint maturity', () => {
  test.each([false, true])('requires a structural close and three closed right candles (short=%p)', (short) => {
    const bars = short ? mirror(bullish()) : bullish()
    expect(analyzeFibonacci(bars.slice(0, 15)).pendingDirection).toBeNull()
    expect(analyzeFibonacci(bars.slice(0, 16)).pendingDirection).toBe(short ? 'short' : 'long')
    expect(analyzeFibonacci(bars.slice(0, 20)).setup).toBeNull()
    const found = setup(bars)
    expect(found).toMatchObject({
      status: 'watching', direction: short ? 'short' : 'long',
      start: { index: 11, time: bars[11].openTime, price: short ? 280 : 120, confirmedAt: bars[14].closeTime },
      end: { index: 17, time: bars[17].openTime, price: short ? 210 : 190, confirmedAt: bars[20].closeTime },
      breakAt: bars[15].closeTime, detectedAt: bars[20].closeTime,
    })
  })

  test('a wick through structural resistance does not count as a closing break', () => {
    const bars = bullish()
    bars[15] = bar(15, 147, 162, 149)
    expect(analyzeFibonacci(bars.slice(0, 16)).pendingDirection).toBeNull()
    expect(setup(bars).breakAt).toBe(bars[16].closeTime)
  })

  test.each([false, true])('keeps shallow origins and replaces >=50%% pullbacks (short=%p)', (short) => {
    const transform = (bars: FibBar[]) => short ? mirror(bars) : bars
    expect(setup(transform(bullish(130))).start.index).toBe(3)
    expect(setup(transform(bullish(125))).start.index).toBe(11)
    expect(setup(transform(bullish(120))).start.index).toBe(11)
  })

  test('uses the selected scale for significance midpoint', () => {
    expect(setup(bullish(124), { scale: 'linear' }).start.index).toBe(11)
    expect(setup(bullish(124), { scale: 'log' }).start.index).toBe(3)
  })

  test('rejects a tied endpoint instead of treating a plateau as a confirmed pivot', () => {
    const bars = bullish()
    bars[18].high = 190
    expect(analyzeFibonacci(bars).setup).toBeNull()
  })

  test.each([false, true])('marks entry touches before detection missed without filling orders (short=%p)', (short) => {
    const bars = bullish()
    bars[18].low = 140
    const found = setup(short ? mirror(bars) : bars)
    expect(found.status).toBe('missed')
    expect(found.entries[0]).toMatchObject({ status: 'missed', touchedAt: bars[18].closeTime, filledAt: null })
    expect(found.entries.slice(1).map((entry) => entry.status)).toEqual(['cancelled', 'cancelled'])
    expect(found.actualAverage).toBeNull()
    expect(found.resolvedAt).toBe(found.detectedAt)
    expect(isActiveFibSetup(found)).toBe(false)
  })

  test('extends an untouched impulse, waits for fresh maturity, and keeps old anchors in history', () => {
    const bars = bullish()
    const first = setup(bars)
    append(bars, 182, 200, 197)
    const pending = analyzeFibonacci(bars)
    expect(pending.setup?.status).toBe('superseded')
    expect(pending.pendingDirection).toBe('long')
    expect(pending.setup?.end).toEqual(first.end)
    append(bars, 185, 198)
    append(bars, 180, 196)
    append(bars, 178, 194)
    const found = setup(bars)
    expect(found.status).toBe('watching')
    expect(found.end.price).toBe(200)
    expect(found.detectedAt).toBe(bars[24].closeTime)
    expect(analyzeFibonacci(bars).setups).toHaveLength(2)
  })
})

describe('entries, stops, and conservative OHLC ambiguity', () => {
  test.each([false, true])('calculates average from filled quote budgets, not ratios or all planned entries (short=%p)', (short) => {
    const bars = bullish()
    const transform = () => short ? mirror(bars) : bars
    const plan = setup(transform())
    const expectedPlan = 100 / plan.entries.reduce((sum, entry) => sum + entry.weight / entry.price, 0)
    expect(plan.plannedAverage).toBeCloseTo(expectedPlan, 10)
    expect(plan.actualAverage).toBeNull()
    append(bars, 146, 161, 150)
    const one = setup(transform())
    expect(one.actualAverage).toBeCloseTo(one.entries[0].price, 10)
    expect(one.entries.map((entry) => entry.status)).toEqual(['filled', 'pending', 'pending'])
    append(bars, 134, 150, 140)
    const two = setup(transform())
    expect(two.actualAverage).toBeCloseTo(50 / (20 / two.entries[0].price + 30 / two.entries[1].price), 10)
    expect(two.actualAverage).not.toBeCloseTo(two.plannedAverage, 3)
    expect(two.entries[1].filledAt).toBe(bars[22].closeTime)
  })

  test.each([false, true])('old stop wins a candle spanning all entries and targets (short=%p)', (short) => {
    const bars = bullish()
    append(bars, 115, 180, 118)
    const found = setup(short ? mirror(bars) : bars)
    expect(found.status).toBe('stopped')
    expect(found.entries.every((entry) => entry.status === 'filled')).toBe(true)
    expect(found.targets.every((target) => target.hitAt === null)).toBe(true)
    expect(found.events.some((event) => event.kind === 'ambiguous')).toBe(true)
    expect(found.remainingPercent).toBe(0)
  })

  test.each([false, true])('freezes anchors and suppresses targets on an entry candle (short=%p)', (short) => {
    const bars = bullish()
    append(bars, 145, 200, 185)
    const found = setup(short ? mirror(bars) : bars)
    expect(found.status).toBe('entered')
    expect(found.end.price).toBe(short ? 210 : 190)
    expect(found.targets.every((target) => target.hitAt === null)).toBe(true)
    expect(found.events.filter((event) => event.kind === 'ambiguous')).toHaveLength(2)
    expect(analyzeFibonacci(bars).pendingDirection).toBeNull()
  })

  test.each([false, true])('retains a configured wide stop when an entered position crosses origin (short=%p)', (short) => {
    const bars = bullish()
    append(bars, 146, 160)
    append(bars, 115, 130, 118)
    const transform = () => short ? mirror(bars) : bars
    const entered = setup(transform(), { stopRatio: 1.14 })
    expect(entered.status).toBe('entered')
    expect(entered.entries.every((entry) => entry.status === 'filled')).toBe(true)
    expect(entered.currentStop).toBeCloseTo(short ? 289.8 : 110.2)
    append(bars, 110, 125, 115)
    expect(setup(transform(), { stopRatio: 1.14 }).status).toBe('stopped')
  })

  test('exposes uncertainty when a candle gaps open beyond the configured stop', () => {
    const bars = bullish()
    append(bars, 146, 160)
    append(bars, 120, 124)
    const found = setup(bars)
    expect(found.status).toBe('stopped')
    expect(found.events.some((event) => event.detail.includes('gap execution'))).toBe(true)
  })

  test.each([false, true])('takes the conservative raised-stop result when target ordering is unknown (short=%p)', (short) => {
    const bars = bullish()
    append(bars, 145, 160)
    append(bars, 140, 180)
    const found = setup(short ? mirror(bars) : bars)
    expect(found.status).toBe('stopped')
    expect(found.targets.map((target) => target.hitAt !== null)).toEqual([true, false, false, false, false])
    expect(found.currentStop).toBeCloseTo(found.actualAverage!)
    expect(found.events.some((event) => event.detail.includes('newly raised stop'))).toBe(true)
  })

  test.each([false, true])('advances each stop, leaves 10%% running, and exits on the final stop (short=%p)', (short) => {
    const bars = bullish()
    const transform = () => short ? mirror(bars) : bars
    append(bars, 146, 160)
    append(bars, 127, 145)
    const position = setup(transform())
    expect(position.entries.every((entry) => entry.status === 'filled')).toBe(true)
    append(bars, 150, 165)
    const tp1 = setup(transform())
    expect(tp1.remainingPercent).toBe(80)
    expect(tp1.currentStop).toBeCloseTo(position.actualAverage!)
    append(bars, 164, 175)
    const tp2 = setup(transform())
    expect(tp2.remainingPercent).toBe(60)
    expect(tp2.currentStop).toBeCloseTo(tp2.targets[0].price)
    append(bars, 175, 207)
    const tp3 = setup(transform())
    expect(tp3.remainingPercent).toBe(40)
    expect(tp3.currentStop).toBeCloseTo(tp3.targets[1].price)
    append(bars, 207, 217)
    const tp4 = setup(transform())
    expect(tp4.status).toBe('runner')
    expect(tp4.remainingPercent).toBe(10)
    expect(tp4.currentStop).toBeCloseTo(tp4.targets[2].price)
    append(bars, 218, 234)
    const runner = setup(transform())
    expect(runner.status).toBe('runner')
    expect(runner.remainingPercent).toBe(10)
    expect(runner.currentStop).toBeCloseTo(runner.targets[3].price)
    expect(runner.targets[4].exitPercent).toBe(0)
    append(bars, 215, 220)
    const stopped = setup(transform())
    expect(stopped.status).toBe('stopped')
    expect(stopped.remainingPercent).toBe(0)
    expect(isActiveFibSetup(stopped)).toBe(false)
  })

  test('cancels unfilled entries at TP1 instead of reopening a managed position', () => {
    const bars = bullish()
    append(bars, 146, 160)
    append(bars, 150, 165)
    const target = setup(bars)
    expect(target.entries.map((entry) => entry.status)).toEqual(['filled', 'cancelled', 'cancelled'])
    const average = target.actualAverage
    append(bars, 130, 140)
    const stopped = setup(bars)
    expect(stopped.status).toBe('stopped')
    expect(stopped.actualAverage).toBe(average)
    expect(stopped.entries[1].filledAt).toBeNull()
  })

  test('never reuses a consumed origin merely because a new extreme matures', () => {
    const bars = bullish()
    bars[18].low = 140
    bars[19].low = 139
    bars[20].low = 138
    const first = setup(bars)
    expect(first.status).toBe('missed')
    // Outside candle has unknowable high/low order and cannot supply a new origin.
    append(bars, 137, 201, 198)
    append(bars, 190, 199)
    append(bars, 188, 198)
    append(bars, 186, 196)
    const found = analyzeFibonacci(bars)
    expect(found.setups).toHaveLength(1)
    expect(found.setup).toEqual(first)
    expect(found.pendingDirection).toBeNull()
  })

  test('allows another trade after a fresh significant origin and a new structural break', () => {
    const bars = bullish()
    bars[18].low = 140
    const missed = setup(bars)
    append(bars, 184, 201, 198)
    append(bars, 190, 199)
    append(bars, 188, 198)
    append(bars, 186, 196)
    const next = setup(bars)
    expect(analyzeFibonacci(bars).setups).toHaveLength(2)
    expect(missed.status).toBe('missed')
    expect(next.status).toBe('watching')
    expect(next.start).toMatchObject({ index: 18, price: 140 })
    expect(next.breakAt).toBe(bars[21].closeTime)
    expect(next.start.time).not.toBe(missed.start.time)
  })
})

describe('live isolation and incomplete history', () => {
  test('live ticks change context only, never pivots, entries, targets, or stops', () => {
    const bars = bullish()
    const analysis = analyzeFibonacci(bars)
    const before = structuredClone(analysis)
    for (const price of [1, 125, 145, 160, 200, 999]) {
      const preview = { ...bar(21, price, price), isClosed: false }
      expect(analyzeFibonacci([...bars, preview])).toEqual(analysis)
      const live = getFibLiveContext(analysis.setup, price)
      expect(live?.price).toBe(price)
      expect(live?.active).toBe(true)
    }
    expect(analysis).toEqual(before)
    const live = getFibLiveContext(analysis.setup, fibPrice(120, 190, 0.64))
    expect(live?.inGoldenPocket).toBe(true)
    expect(live?.ratio).toBeCloseTo(0.64)
    expect(getFibLiveContext(analysis.setup, NaN)).toBeNull()
    expect(getFibLiveContext(null, 123)).toBeNull()
  })

  test('does not let an unfinished confirming candle activate the setup', () => {
    const bars = bullish()
    bars[20].isClosed = false
    expect(analyzeFibonacci(bars).setup).toBeNull()
    expect(analyzeFibonacci(bars).closedBars).toBe(20)
  })

  test('uses only the contiguous suffix after a missing or unfinished interior candle', () => {
    const bars = bullish()
    append(bars, 146, 160)
    append(bars, 145, 160)
    const gap = analyzeFibonacci([...bars.slice(0, 21), bars[22]])
    expect(gap).toMatchObject({ setup: null, closedBars: 1, historyIssue: 'gap', sma200: null })
    bars[21].isClosed = false
    expect(analyzeFibonacci(bars)).toMatchObject({ setup: null, closedBars: 1, historyIssue: 'gap' })
  })

  test('malformed final candles clear active state instead of leaving stale opportunities', () => {
    const bars = bullish()
    append(bars, 146, 160)
    bars[21].low = NaN
    expect(analyzeFibonacci(bars)).toMatchObject({ setup: null, closedBars: 0, historyIssue: 'invalid' })
    bars[21] = { ...bars[0] }
    expect(analyzeFibonacci(bars)).toMatchObject({ setup: null, closedBars: 1, historyIssue: 'gap' })
  })

  test('bounds history and provides SMA200 only when its full closed history exists', () => {
    const bars = Array.from({ length: 600 }, (_, i) => bar(i, 90, 110, 100 + i / 10))
      .map((b) => ({ ...b, high: Math.max(b.close, b.high) + 1 }))
    expect(analyzeFibonacci(bars.slice(0, 199)).sma200).toBeNull()
    expect(analyzeFibonacci(bars.slice(0, 200)).sma200).toBeCloseTo(109.95)
    const result = analyzeFibonacci(bars)
    expect(result.closedBars).toBe(500)
    expect(result.sma200).toBeCloseTo(149.95)
    expect(result.lastClosedAt).toBe(bars[599].closeTime)
  })

  test('prefix replay never backdates detections or changes terminal outcomes', () => {
    const bars = bullish()
    append(bars, 146, 161)
    append(bars, 125, 180)
    append(bars, 190, 210)
    append(bars, 195, 209)
    append(bars, 193, 206)
    append(bars, 192, 205)
    const final = analyzeFibonacci(bars)
    for (let length = 0; length <= bars.length; length++) {
      const prefix = bars.slice(0, length)
      const found = analyzeFibonacci(prefix)
      expect(found.setups.map((entry) => entry.id)).toEqual(final.setups
        .filter((entry) => entry.detectedAt <= (prefix.at(-1)?.closeTime ?? 0)).map((entry) => entry.id))
      for (const entry of found.setups) {
        const terminal = final.setups.find((candidate) => candidate.id === entry.id)!
        expect([entry.start, entry.end, entry.detectedAt]).toEqual([terminal.start, terminal.end, terminal.detectedAt])
        if (!isActiveFibSetup(entry)) expect(entry).toEqual(terminal)
      }
    }
  })

  test('does not mutate bars or options, and accepts empty history', () => {
    const bars = bullish()
    const original = structuredClone(bars)
    bars.forEach(Object.freeze)
    Object.freeze(bars)
    expect(() => analyzeFibonacci(bars, Object.freeze({ scale: 'log' }))).not.toThrow()
    expect(bars).toEqual(original)
    expect(analyzeFibonacci([])).toMatchObject({ setup: null, setups: [], structure: 'insufficient', closedBars: 0 })
  })
})

import { describe, expect, test } from 'bun:test'
import {
  analyzeSupportResistance,
  buildSupportResistanceStructure,
  DEFAULT_SUPPORT_RESISTANCE_OPTIONS,
  selectNearestLevels,
  type PendingLevelBreak,
  type PriceBar,
  type SupportResistanceOptions,
} from '../src/lib/supportResistance'

const START = 1_700_000_000_000
const MINUTE = 60_000
const smallPivots = { leftBars: 1, rightBars: 1 }
const exact = { ...smallPivots, zoneTolerancePercent: 0, breakBufferPercent: 0 }

function makeBars(prices: number[]): PriceBar[] {
  return prices.map((price, index) => ({
    openTime: START + index * MINUTE,
    closeTime: START + (index + 1) * MINUTE - 1,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1,
    isClosed: true,
  }))
}

function horizontalLevels(): PriceBar[] {
  const bars = makeBars(Array.from({ length: 9 }, () => 100))
  bars[1].low = 80
  bars[3].low = 90
  bars[5].high = 120
  bars[7].high = 110
  return bars
}

function nextBar(bars: readonly PriceBar[], changes: Partial<PriceBar> = {}): PriceBar {
  const previous = bars[bars.length - 1]
  return {
    ...previous,
    openTime: previous.closeTime + 1,
    closeTime: previous.closeTime + MINUTE,
    ...changes,
  }
}

const level = (price: number, touches = 1) => ({ price, touches })
const pending = (kind: PendingLevelBreak['kind'], price: number, touches = 1) => ({ kind, price, touches })

describe('confirmed price swing structure', () => {
  test('defaults to strict 3/3 pivots, a 300-candle lookback, and 0.1% zone and break tolerances', () => {
    expect(DEFAULT_SUPPORT_RESISTANCE_OPTIONS).toEqual({
      leftBars: 3, rightBars: 3, lookbackBars: 300, zoneTolerancePercent: 0.1, breakBufferPercent: 0.1,
    })
  })

  test.each([
    [[10, 14, 11, 16, 12, 18, 13], 'uptrend'],
    [[20, 16, 19, 14, 18, 12, 17], 'downtrend'],
    [[15, 18, 12, 20, 10, 22, 11], 'sideways'],
    [[15, 18, 12, 18, 12, 18, 15], 'sideways'],
  ] as const)('classifies confirmed price swings %p as %p', (prices, expected) => {
    expect(analyzeSupportResistance(makeBars([...prices]), 15, smallPivots).trend).toBe(expected)
  })

  test('requires two confirmed highs and two confirmed lows to classify a trend', () => {
    expect(analyzeSupportResistance(makeBars([10, 15, 11, 16]), 16, smallPivots).trend).toBe('unknown')
    expect(analyzeSupportResistance([], 100)).toEqual({
      trend: 'unknown', support: null, resistance: null, pendingBreaks: [], closedBarCount: 0,
    })
  })

  test('waits for every right-side candle to close and checks every neighbor', () => {
    const bars = makeBars([110, 108, 105, 100, 104, 107, 110])
    expect(analyzeSupportResistance(bars.slice(0, 6), 110).support).toBeNull()
    expect(analyzeSupportResistance([...bars.slice(0, 6), { ...bars[6], isClosed: false }], 110).support)
      .toBeNull()
    expect(analyzeSupportResistance(bars, 110).support).toEqual(level(99))

    bars[0].low = 99
    expect(analyzeSupportResistance(bars, 110).support).toBeNull()
  })

  test('does not confirm an equal-height or equal-low plateau', () => {
    const bars = makeBars([100, 100, 100, 100, 100])
    expect(analyzeSupportResistance(bars, 100, smallPivots)).toEqual({
      trend: 'unknown', support: null, resistance: null, pendingBreaks: [], closedBarCount: 5,
    })
  })

  test('uses price extrema independently of RSI', () => {
    const bars = makeBars([100, 90, 100, 110, 100]).map((bar) => ({ ...bar, rsi: 50 }))
    expect(analyzeSupportResistance(bars, 100, smallPivots)).toMatchObject({
      support: level(89), resistance: level(111),
    })
  })

  test('exposes the closed-bar structure separately from live selection', () => {
    const bars = horizontalLevels()
    const structure = buildSupportResistanceStructure(bars, smallPivots)
    expect(structure).toEqual({
      trend: 'sideways',
      supports: [{ price: 80, touches: 1 }, { price: 90, touches: 1 }],
      resistances: [{ price: 110, touches: 1 }, { price: 120, touches: 1 }],
      closedBarCount: 9,
    })
    for (const price of [70, 85, 100, 115, 130]) {
      expect(selectNearestLevels(structure, price)).toEqual(analyzeSupportResistance(bars, price, smallPivots))
    }
  })
})

describe('zones and break buffers', () => {
  test('merges confirmed swings within the zone tolerance into one level with a mean price', () => {
    const bars = makeBars([100, 91, 100, 91, 100])
    bars[3].low = 90.5
    const wideZones = { ...smallPivots, zoneTolerancePercent: 1 }
    expect(analyzeSupportResistance(bars, 100, wideZones).support).toEqual(level(90.25, 2))
    expect(buildSupportResistanceStructure(bars, wideZones).supports).toEqual([{ price: 90.25, touches: 2 }])
  })

  test('keeps swings outside the tolerance as separate levels', () => {
    const bars = makeBars([100, 91, 100, 91, 100])
    bars[3].low = 90.5
    expect(buildSupportResistanceStructure(bars, smallPivots).supports)
      .toEqual([{ price: 90, touches: 1 }, { price: 90.5, touches: 1 }])
    expect(buildSupportResistanceStructure(bars, exact).supports)
      .toEqual([{ price: 90, touches: 1 }, { price: 90.5, touches: 1 }])
  })

  test('a close inside the break buffer keeps a crossed zone pending separately from the next level', () => {
    const bars = horizontalLevels()
    const shallow = [...bars, nextBar(bars, { open: 100, high: 101, low: 89, close: 89.95 })]
    expect(analyzeSupportResistance(shallow, 89.95, smallPivots)).toMatchObject({
      support: level(80), pendingBreaks: [pending('support', 90)],
    })
    expect(analyzeSupportResistance(shallow, 89.95, exact)).toMatchObject({
      support: level(80), pendingBreaks: [],
    })

    const shallowUp = [...bars, nextBar(bars, { open: 100, high: 111, low: 99, close: 110.05 })]
    expect(analyzeSupportResistance(shallowUp, 110.05, smallPivots)).toMatchObject({
      resistance: level(120), pendingBreaks: [pending('resistance', 110)],
    })
    expect(analyzeSupportResistance(shallowUp, 110.05, exact)).toMatchObject({
      resistance: level(120), pendingBreaks: [],
    })
  })
})

describe('nearest surviving support and resistance', () => {
  test('selects the closest valid level on each side of the current price', () => {
    expect(analyzeSupportResistance(horizontalLevels(), 100, smallPivots)).toEqual({
      trend: 'sideways', support: level(90), resistance: level(110), pendingBreaks: [], closedBarCount: 9,
    })
    expect(analyzeSupportResistance(horizontalLevels(), 95, smallPivots).support).toEqual(level(90))
    expect(analyzeSupportResistance(horizontalLevels(), 105, smallPivots).resistance).toEqual(level(110))
  })

  test('keeps an exact touch eligible without marking that zone as a pending breakout', () => {
    expect(analyzeSupportResistance(horizontalLevels(), 90, smallPivots)).toMatchObject({
      support: level(90), pendingBreaks: [],
    })
    expect(analyzeSupportResistance(horizontalLevels(), 110, smallPivots)).toMatchObject({
      resistance: level(110), pendingBreaks: [],
    })
  })

  test('shows resistance 110 above price 105 while the crossed resistance 100 is pending', () => {
    expect(selectNearestLevels({
      trend: 'sideways', supports: [level(90)], resistances: [level(100, 2), level(110)], closedBarCount: 9,
    }, 105)).toEqual({
      trend: 'sideways', support: level(90), resistance: level(110),
      pendingBreaks: [pending('resistance', 100, 2)], closedBarCount: 9,
    })
  })

  test('shows support 100 below price 105 while the crossed support 110 is pending', () => {
    expect(selectNearestLevels({
      trend: 'sideways', supports: [level(100), level(110, 2)], resistances: [level(120)], closedBarCount: 9,
    }, 105)).toEqual({
      trend: 'sideways', support: level(100), resistance: level(120),
      pendingBreaks: [pending('support', 110, 2)], closedBarCount: 9,
    })
  })

  test('keeps the next valid level separate from the nearest crossed zone on either side', () => {
    expect(analyzeSupportResistance(horizontalLevels(), 80.1, smallPivots)).toMatchObject({
      support: level(80), resistance: level(110), pendingBreaks: [pending('support', 90)],
    })
    expect(analyzeSupportResistance(horizontalLevels(), 119.9, smallPivots)).toMatchObject({
      support: level(90), resistance: level(120), pendingBreaks: [pending('resistance', 110)],
    })
  })

  test('returns no next level when price crosses them all and reports only the nearest crossed zone', () => {
    expect(analyzeSupportResistance(horizontalLevels(), 70, smallPivots)).toMatchObject({
      support: null, resistance: level(110), pendingBreaks: [pending('support', 80)],
    })
    expect(analyzeSupportResistance(horizontalLevels(), 130, smallPivots)).toMatchObject({
      support: level(90), resistance: null, pendingBreaks: [pending('resistance', 120)],
    })
  })

  test('a live recross clears pending status and restores the zone to nearest levels', () => {
    const structure = buildSupportResistanceStructure(horizontalLevels(), smallPivots)
    const original = structuredClone(structure)
    expect(selectNearestLevels(structure, 89).pendingBreaks).toEqual([pending('support', 90)])
    expect(selectNearestLevels(structure, 90)).toMatchObject({ support: level(90), pendingBreaks: [] })
    expect(selectNearestLevels(structure, 111).pendingBreaks).toEqual([pending('resistance', 110)])
    expect(selectNearestLevels(structure, 110)).toMatchObject({ resistance: level(110), pendingBreaks: [] })
    expect(structure).toEqual(original)
  })

  test('retires support only after a closed close below it without flipping its role', () => {
    const bars = horizontalLevels()
    const breakBar = nextBar(bars, { open: 100, high: 101, low: 85, close: 89 })
    expect(analyzeSupportResistance([...bars, { ...breakBar, isClosed: false }], 89, smallPivots))
      .toMatchObject({ support: level(80), pendingBreaks: [pending('support', 90)] })
    const afterBreak = [...bars, breakBar]
    expect(analyzeSupportResistance(afterBreak, 89, smallPivots))
      .toMatchObject({ support: level(80), resistance: level(110), pendingBreaks: [] })
    expect(analyzeSupportResistance(afterBreak, 100, smallPivots).support).toEqual(level(80))
    expect(analyzeSupportResistance(afterBreak, 85, smallPivots).resistance).toEqual(level(110))

    const returnBar = nextBar(afterBreak, { open: 100, high: 101, low: 99, close: 100 })
    // The fresh low at 85 can become support; the broken historical 90 stays retired.
    expect(analyzeSupportResistance([...afterBreak, returnBar], 100, smallPivots).support).toEqual(level(85))
  })

  test('retires resistance only after a closed close above it without flipping its role', () => {
    const bars = horizontalLevels()
    const breakBar = nextBar(bars, { open: 100, high: 115, low: 99, close: 111 })
    expect(analyzeSupportResistance([...bars, { ...breakBar, isClosed: false }], 111, smallPivots))
      .toMatchObject({ resistance: level(120), pendingBreaks: [pending('resistance', 110)] })
    expect(analyzeSupportResistance([...bars, breakBar], 111, smallPivots))
      .toMatchObject({ support: level(90), resistance: level(120), pendingBreaks: [] })
    expect(analyzeSupportResistance([...bars, breakBar], 100, smallPivots).resistance).toEqual(level(120))
    expect(analyzeSupportResistance([...bars, breakBar], 115, smallPivots).support).toEqual(level(90))
  })

  test('wick breaches and closes equal to a level preserve existing levels', () => {
    const bars = horizontalLevels()
    for (const close of [90, 100, 110]) {
      const touch = nextBar(bars, { high: 115, low: 85, close })
      expect(analyzeSupportResistance([...bars, touch], 100, smallPivots)).toMatchObject({
        support: level(90), resistance: level(110),
      })
    }
  })

  test('live wicks and closes cannot retire or establish levels or change trend', () => {
    const bars = horizontalLevels()
    const before = analyzeSupportResistance(bars, 100, smallPivots)
    for (const close of [50, 150]) {
      const live = nextBar(bars, { low: 40, high: 160, close, isClosed: false })
      expect(analyzeSupportResistance([...bars, live], 100, smallPivots)).toEqual(before)
    }
    expect(buildSupportResistanceStructure(bars, smallPivots))
      .toEqual(buildSupportResistanceStructure([...bars, nextBar(bars, { close: 50, isClosed: false })], smallPivots))
  })

  test('counts repeated confirmed swings at the level and resets after a break', () => {
    const bars = makeBars([100, 91, 100, 91, 100])
    expect(analyzeSupportResistance(bars, 100, smallPivots).support).toEqual(level(90, 2))
    const broken = [...bars, nextBar(bars, { open: 89, high: 90, low: 88, close: 89 })]
    const recovered = [...broken, nextBar(broken, { open: 100, high: 101, low: 99, close: 100 })]
    const freshPivot = [...recovered, nextBar(recovered, { open: 91, high: 92, low: 90, close: 91 })]
    const confirmed = [...freshPivot, nextBar(freshPivot, { open: 100, high: 101, low: 99, close: 100 })]
    expect(analyzeSupportResistance(confirmed, 100, smallPivots).support).toEqual(level(90))
  })

  test('never invents levels without confirmed swings', () => {
    expect(analyzeSupportResistance(makeBars([100, 101, 102, 103, 104]), 104, smallPivots))
      .toMatchObject({ support: null, resistance: null })
    expect(analyzeSupportResistance(makeBars([104, 103, 102, 101, 100]), 100, smallPivots))
      .toMatchObject({ support: null, resistance: null })
  })

  test('preserves exact small prices without rounding or merging distinct levels', () => {
    const factor = 1e-10
    const bars = horizontalLevels().map((bar) => ({
      ...bar, open: bar.open * factor, high: bar.high * factor,
      low: bar.low * factor, close: bar.close * factor,
    }))
    expect(analyzeSupportResistance(bars, 100 * factor, smallPivots)).toMatchObject({
      support: level(90 * factor), resistance: level(110 * factor),
    })
  })
})

describe('history boundaries and validation', () => {
  test('uses only the latest contiguous segment after a missing candle', () => {
    const bars = horizontalLevels()
    bars.splice(4, 1)
    expect(analyzeSupportResistance(bars, 100, smallPivots)).toEqual({
      trend: 'unknown', support: null, resistance: level(110), pendingBreaks: [], closedBarCount: 4,
    })
  })

  test.each([
    { low: 0 }, { close: NaN }, { high: Infinity }, { low: 101 }, { high: 99 },
    { volume: -1 }, { openTime: NaN }, { closeTime: -1 }, { isClosed: false },
  ])('does not bridge malformed or unfinished interior candle %p', (changes) => {
    const bars = horizontalLevels()
    bars[4] = { ...bars[4], ...changes }
    expect(analyzeSupportResistance(bars, 100, smallPivots)).toEqual({
      trend: 'unknown', support: null, resistance: level(110), pendingBreaks: [], closedBarCount: 4,
    })
  })

  test('does not bridge duplicate or out-of-order candle timestamps', () => {
    const bars = horizontalLevels()
    bars[4] = { ...bars[3] }
    expect(analyzeSupportResistance(bars, 100, smallPivots).closedBarCount).toBe(4)
    expect(analyzeSupportResistance(bars, 100, smallPivots).support).toBeNull()
  })

  test('a malformed most recent closed bar clears structure rather than returning stale levels', () => {
    const bars = horizontalLevels()
    bars[bars.length - 1].close = NaN
    expect(analyzeSupportResistance(bars, 100, smallPivots)).toEqual({
      trend: 'unknown', support: null, resistance: null, pendingBreaks: [], closedBarCount: 0,
    })
  })

  test('bounds the closed window and requires the full pivot window inside it', () => {
    const bars = horizontalLevels()
    expect(analyzeSupportResistance(bars, 100, { ...smallPivots, lookbackBars: 6 })).toEqual({
      trend: 'unknown', support: null, resistance: level(110), pendingBreaks: [], closedBarCount: 6,
    })
    const longHistory = makeBars(Array.from({ length: 350 }, () => 100))
    longHistory[10].low = 50
    expect(analyzeSupportResistance(longHistory, 100)).toEqual({
      trend: 'unknown', support: null, resistance: null, pendingBreaks: [], closedBarCount: 300,
    })
    expect(analyzeSupportResistance([...longHistory, nextBar(longHistory, { isClosed: false })], 100)
      .closedBarCount).toBe(300)
  })

  test.each([0, -1, NaN, Infinity])('returns no nearby levels for invalid current price %p', (price) => {
    expect(analyzeSupportResistance(horizontalLevels(), price, smallPivots)).toEqual({
      trend: 'sideways', support: null, resistance: null, pendingBreaks: [], closedBarCount: 9,
    })
  })

  test.each([
    { leftBars: 0 }, { rightBars: -1 }, { lookbackBars: 0 },
    { leftBars: 1.5 }, { rightBars: NaN }, { lookbackBars: Infinity },
    { zoneTolerancePercent: -0.1 }, { zoneTolerancePercent: 100 }, { zoneTolerancePercent: NaN },
    { breakBufferPercent: -1 }, { breakBufferPercent: Infinity },
  ] satisfies Partial<SupportResistanceOptions>[])('rejects invalid options %p', (options) => {
    expect(() => analyzeSupportResistance([], 100, options)).toThrow(RangeError)
  })

  test('does not modify frozen bars or options', () => {
    const bars = horizontalLevels()
    const original = structuredClone(bars)
    bars.forEach(Object.freeze)
    Object.freeze(bars)
    analyzeSupportResistance(bars, 100, Object.freeze({ ...smallPivots }))
    expect(bars).toEqual(original)
  })
})

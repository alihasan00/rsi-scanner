import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import {
  DEFAULT_DIVERGENCE_OPTIONS,
  findRsiDivergences,
  type DivergenceOptions,
} from '../src/lib/divergence'

const START = 1_700_000_000_000
const MINUTE = 60_000
const smallPivots = { leftBars: 1, rightBars: 1, minBars: 2, maxBars: 60 }

function makeBars(rsi: number[]): RsiBar[] {
  return rsi.map((value, index) => ({
    openTime: START + index * MINUTE,
    closeTime: START + (index + 1) * MINUTE - 1,
    open: 150,
    high: 200,
    low: 100,
    close: 150,
    volume: 1,
    rsi: value,
    isClosed: true,
  }))
}

function twoPivots(low: boolean, firstRsi: number, secondRsi: number, firstPrice: number, secondPrice: number) {
  const bars = makeBars(low
    ? [55, 45, firstRsi, 45, 55, 45, secondRsi, 45, 55]
    : [45, 55, firstRsi, 55, 45, 55, secondRsi, 55, 45])
  if (low) {
    bars[2].low = firstPrice
    bars[6].low = secondPrice
  } else {
    bars[2].high = firstPrice
    bars[6].high = secondPrice
  }
  return bars
}

function regularBullish() {
  return twoPivots(true, 20, 30, 90, 80)
}

function setPivotBodies(bars: RsiBar[], low: boolean, firstBody: number, secondBody: number) {
  bars[2].open = firstBody
  bars[2].close = firstBody + (low ? 15 : -15)
  bars[6].open = secondBody + (low ? 15 : -15)
  bars[6].close = secondBody
}

const lectureCases = [
  { kind: 'regular-bullish', low: true, firstRsi: 20, secondRsi: 30, firstPrice: 90, secondPrice: 80, firstBody: 120, secondBody: 110 },
  { kind: 'regular-bearish', low: false, firstRsi: 80, secondRsi: 70, firstPrice: 180, secondPrice: 190, firstBody: 160, secondBody: 170 },
  { kind: 'hidden-bullish', low: true, firstRsi: 30, secondRsi: 20, firstPrice: 80, secondPrice: 90, firstBody: 110, secondBody: 120 },
  { kind: 'hidden-bearish', low: false, firstRsi: 70, secondRsi: 80, firstPrice: 190, secondPrice: 180, firstBody: 170, secondBody: 160 },
] as const

function lectureBars(example: (typeof lectureCases)[number]) {
  const bars = twoPivots(example.low, example.firstRsi, example.secondRsi, example.firstPrice, example.secondPrice)
  bars[3].rsi = example.low ? 40 : 60
  bars[4].rsi = example.low ? 45 : 55
  bars[5].rsi = example.low ? 40 : 60
  setPivotBodies(bars, example.low, example.firstBody, example.secondBody)
  return bars
}

describe('findRsiDivergences definitions', () => {
  test('defaults to 5/5 confirmed pivots, 5–60 bars, regular divergence only', () => {
    expect(DEFAULT_DIVERGENCE_OPTIONS).toEqual({
      leftBars: 5, rightBars: 5, minBars: 5, maxBars: 60, includeHidden: false,
      requireBodyAgreement: false, requireSameRsiCycle: false,
    })
  })

  test('detects regular bullish price lower low / RSI higher low using the RSI pivot candle', () => {
    const bars = regularBullish()
    const signals = findRsiDivergences(bars, smallPivots)
    expect(signals).toEqual([{
      id: `regular-bullish:${bars[2].openTime}:${bars[6].openTime}`,
      kind: 'regular-bullish',
      start: { time: bars[2].openTime, price: 90, rsi: 20 },
      end: { time: bars[6].openTime, price: 80, rsi: 30 },
      confirmedAt: bars[7].closeTime,
    }])
  })

  test('detects regular bearish price higher high / RSI lower high', () => {
    const bars = twoPivots(false, 80, 70, 180, 190)
    expect(findRsiDivergences(bars, smallPivots).map((signal) => signal.kind))
      .toEqual(['regular-bearish'])
  })

  test('detects hidden bullish price higher low / RSI lower low only when enabled', () => {
    const bars = twoPivots(true, 30, 20, 80, 90)
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
    expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true }).map((signal) => signal.kind))
      .toEqual(['hidden-bullish'])
  })

  test('detects hidden bearish price lower high / RSI higher high only when enabled', () => {
    const bars = twoPivots(false, 70, 80, 190, 180)
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
    expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true }).map((signal) => signal.kind))
      .toEqual(['hidden-bearish'])
  })

  test.each([
    [true, 20, 30, 80, 90],
    [true, 30, 20, 90, 80],
    [false, 70, 80, 180, 190],
    [false, 80, 70, 190, 180],
  ])('same-direction price and RSI changes are not divergence (%p, %p → %p)', (low, rsi1, rsi2, price1, price2) => {
    const bars = twoPivots(low, rsi1, rsi2, price1, price2)
    expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true })).toEqual([])
  })

  test.each([
    [true, 20, 20, 90, 80],
    [true, 20, 30, 80, 80],
    [false, 80, 80, 180, 190],
    [false, 80, 70, 190, 190],
  ])('equal RSI or price endpoints are not divergence (%p, %p → %p)', (low, rsi1, rsi2, price1, price2) => {
    expect(findRsiDivergences(twoPivots(low, rsi1, rsi2, price1, price2), {
      ...smallPivots, includeHidden: true,
    })).toEqual([])
  })

  test('uses low/high on RSI pivots even when price extrema fall on other bars', () => {
    const bars = regularBullish()
    bars[1].low = 60
    bars[5].low = 50
    expect(findRsiDivergences(bars, smallPivots)[0].start.price).toBe(90)
    expect(findRsiDivergences(bars, smallPivots)[0].end.price).toBe(80)
  })
})

describe('optional lecture filters', () => {
  const filteredOptions = {
    ...smallPivots,
    includeHidden: true,
    requireBodyAgreement: true,
    requireSameRsiCycle: true,
  }

  for (const example of lectureCases) {
    test(`${example.kind}: accepts matching wick/body direction and a single RSI cycle`, () => {
      expect(findRsiDivergences(lectureBars(example), filteredOptions).map((signal) => signal.kind))
        .toEqual([example.kind])
    })

    test(`${example.kind}: rejects contradictory body direction and equal body edges`, () => {
      for (const secondBody of [
        example.firstBody - Math.sign(example.secondPrice - example.firstPrice) * 10,
        example.firstBody,
      ]) {
        const bars = lectureBars(example)
        setPivotBodies(bars, example.low, example.firstBody, secondBody)
        expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true })).toHaveLength(1)
        expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true, requireBodyAgreement: true }))
          .toEqual([])
      }
    })

    test(`${example.kind}: rejects a midline touch or crossing between the pivots`, () => {
      for (const middleRsi of [50, example.low ? 55 : 45]) {
        const bars = lectureBars(example)
        bars[4].rsi = middleRsi
        expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true })).toHaveLength(1)
        expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true, requireSameRsiCycle: true }))
          .toEqual([])
      }
    })

    test(`${example.kind}: rejects a pair on the wrong side of 50 even when no sample touches 50`, () => {
      const bars = lectureBars(example)
      // A bullish W above 50 or a bearish M below 50 is not one lecture cycle:
      // its RSI 50 target would sit on the wrong side of the pattern.
      for (const bar of bars) bar.rsi += example.low ? 35 : -35
      expect(findRsiDivergences(bars, { ...smallPivots, includeHidden: true })).toHaveLength(1)
      expect(findRsiDivergences(bars, filteredOptions)).toEqual([])
    })

    test(`${example.kind}: does not require RSI to reach 30 or 70`, () => {
      const bars = lectureBars(example)
      // Compress the series toward 50 so every sample stays within 44–56 while
      // the strict pivot structure and the pattern's side of 50 are preserved.
      for (const bar of bars) bar.rsi = 50 + (bar.rsi - 50) * 0.2
      expect(findRsiDivergences(bars, filteredOptions).map((signal) => signal.kind))
        .toEqual([example.kind])
    })
  }

  test('ignores RSI50 crossings in the outer pivot legs, including the confirmation candle', () => {
    const bars = lectureBars(lectureCases[0])
    bars[1].rsi = 70
    bars[7].rsi = 70
    const signals = findRsiDivergences(bars, filteredOptions)
    expect(signals).toHaveLength(1)
    expect(signals[0].confirmedAt).toBe(bars[7].closeTime)
  })

  test.each([
    [50, 60],
    [40, 50],
    [40, 60],
    [55, 60],
  ])('rejects bullish low pivots on 50, on opposite sides, or above 50 (%p → %p)', (firstRsi, secondRsi) => {
    const bars = makeBars([80, 75, firstRsi, 75, 80, 75, secondRsi, 75, 80])
    bars[2].low = 90
    bars[6].low = 80
    expect(findRsiDivergences(bars, smallPivots)).toHaveLength(1)
    expect(findRsiDivergences(bars, { ...smallPivots, requireSameRsiCycle: true })).toEqual([])
  })

  test.each([
    [50, 40],
    [60, 50],
    [60, 40],
    [45, 40],
  ])('rejects bearish high pivots on 50, on opposite sides, or below 50 (%p → %p)', (firstRsi, secondRsi) => {
    const bars = makeBars([20, 25, firstRsi, 25, 20, 25, secondRsi, 25, 20])
    bars[2].high = 180
    bars[6].high = 190
    expect(findRsiDivergences(bars, smallPivots)).toHaveLength(1)
    expect(findRsiDivergences(bars, { ...smallPivots, requireSameRsiCycle: true })).toEqual([])
  })

  test('explicitly disabled filters preserve the generic detector results', () => {
    const bars = regularBullish() // Equal bodies and a midline crossing are valid in generic mode.
    const unfiltered = findRsiDivergences(bars, smallPivots)
    expect(unfiltered).toHaveLength(1)
    expect(findRsiDivergences(bars, {
      ...smallPivots, requireBodyAgreement: false, requireSameRsiCycle: false,
    })).toEqual(unfiltered)
  })

  test('a rejected body pair still advances the consecutive low pivot', () => {
    const bars = makeBars([40, 10, 40, 30, 40, 20, 40])
    bars[1] = { ...bars[1], low: 90, open: 120, close: 130 }
    bars[3] = { ...bars[3], low: 80, open: 130, close: 140 }
    bars[5] = { ...bars[5], low: 70, open: 110, close: 120 }
    // 1→3 fails body agreement. 1→5 would pass, but 3→5 is the next valid pair to compare.
    expect(findRsiDivergences(bars, smallPivots)).toHaveLength(1)
    expect(findRsiDivergences(bars, filteredOptions)).toEqual([])
  })

  test('a rejected cycle pair still allows the following consecutive pair', () => {
    const bars = makeBars([45, 10, 55, 20, 45, 30, 45])
    bars[1].low = 90
    bars[3].low = 80
    bars[5].low = 70
    const signals = findRsiDivergences(bars, { ...smallPivots, requireSameRsiCycle: true })
    expect(signals).toHaveLength(1)
    expect(signals[0].start.time).toBe(bars[3].openTime)
    expect(signals[0].end.time).toBe(bars[5].openTime)
  })

  test('filtered signals remain causal and identical during prefix replay and future live updates', () => {
    const bars = lectureBars(lectureCases[0])
    const original = structuredClone(bars)
    bars.forEach(Object.freeze)
    Object.freeze(bars)
    const options = Object.freeze({ ...filteredOptions })
    const complete = findRsiDivergences(bars, options)
    expect(complete).toHaveLength(1)
    for (let length = 0; length <= bars.length; length++) {
      const prefix = bars.slice(0, length)
      expect(findRsiDivergences(prefix, options)).toEqual(
        complete.filter((signal) => signal.confirmedAt <= (prefix.at(-1)?.closeTime ?? 0)),
      )
    }
    const future = {
      ...bars[8], openTime: bars[8].closeTime + 1, closeTime: bars[8].closeTime + MINUTE,
      rsi: 0, low: 1, isClosed: false,
    }
    expect(findRsiDivergences([...bars, future], options)).toEqual(complete)
    expect(findRsiDivergences([...bars, { ...future, rsi: 100, isClosed: true }], options)).toEqual(complete)
    const awaitingConfirmation = structuredClone(original.slice(0, 8))
    awaitingConfirmation[7].isClosed = false
    expect(findRsiDivergences(awaitingConfirmation, options)).toEqual([])
    expect(bars).toEqual(original)
  })
})

describe('pivot confirmation and pairing', () => {
  test.each([
    [{ minBars: 4, maxBars: 4 }, 1],
    [{ minBars: 5, maxBars: 60 }, 0],
    [{ minBars: 1, maxBars: 3 }, 0],
  ])('applies inclusive direct pivot-distance bounds %p', (bounds, expected) => {
    expect(findRsiDivergences(regularBullish(), { ...smallPivots, ...bounds })).toHaveLength(expected)
  })

  test('checks every left/right neighbor with the default 5/5 window', () => {
    const bars = makeBars([
      60, 55, 50, 45, 40, 20, 40, 45, 50, 55, 60,
      55, 50, 45, 40, 30, 40, 45, 50, 55, 60,
    ])
    bars[5].low = 90
    bars[15].low = 80
    expect(findRsiDivergences(bars.slice(0, 20))).toEqual([])
    const signals = findRsiDivergences(bars)
    expect(signals).toHaveLength(1)
    expect(signals[0].end.time).toBe(bars[15].openTime)
    expect(signals[0].confirmedAt).toBe(bars[20].closeTime)
    bars[19].rsi = 29
    expect(findRsiDivergences(bars)).toEqual([])
  })

  test('does not skip an intervening same-kind pivot to obtain divergence', () => {
    const bars = makeBars([50, 10, 50, 30, 50, 20, 50])
    bars[1].low = 90
    bars[3].low = 80
    bars[5].low = 70
    const signals = findRsiDivergences(bars, smallPivots)
    expect(signals).toHaveLength(1)
    expect(signals[0].end.time).toBe(bars[3].openTime)
  })

  test('an intervening pivot still replaces the previous pivot when it is too close', () => {
    const bars = makeBars([50, 10, 50, 30, 50, 20, 50])
    bars[1].low = 90
    bars[3].low = 80
    bars[5].low = 70
    expect(findRsiDivergences(bars, { ...smallPivots, minBars: 3 })).toEqual([])
  })

  test.each([2, 5, 6, 7])('excludes equal RSI plateau at neighbor %p', (index) => {
    const bars = regularBullish()
    if (index === 2) bars[1].rsi = bars[2].rsi
    else if (index === 5) bars[5].rsi = bars[6].rsi
    else if (index === 6) bars[3].rsi = bars[2].rsi
    else bars[7].rsi = bars[6].rsi
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
  })

  test('an unfinished right-hand candle cannot confirm a pivot', () => {
    const bars = regularBullish().slice(0, 8)
    bars[7].isClosed = false
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
    bars[7].isClosed = true
    expect(findRsiDivergences(bars, smallPivots)).toHaveLength(1)
  })

  test('does not bridge an unfinished candle even if later candles are closed', () => {
    const bars = regularBullish()
    bars[4].isClosed = false
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
  })

  test('confirmed signals remain identical during prefix replay and future live updates', () => {
    const bars = regularBullish()
    const complete = findRsiDivergences(bars, smallPivots)
    for (let length = 0; length <= bars.length; length++) {
      const prefix = bars.slice(0, length)
      expect(findRsiDivergences(prefix, smallPivots)).toEqual(
        complete.filter((signal) => signal.confirmedAt <= (prefix.at(-1)?.closeTime ?? 0)),
      )
    }
    const future = { ...bars[8], openTime: bars[8].closeTime + 1, closeTime: bars[8].closeTime + MINUTE, isClosed: false }
    expect(findRsiDivergences([...bars, future], smallPivots)).toEqual(complete)
    expect(findRsiDivergences([...bars, { ...future, rsi: 0, low: 1 }], smallPivots)).toEqual(complete)
  })

  test('does not modify input bars or options', () => {
    const bars = regularBullish()
    const original = structuredClone(bars)
    bars.forEach(Object.freeze)
    Object.freeze(bars)
    const options = Object.freeze({ ...smallPivots })
    findRsiDivergences(bars, options)
    expect(bars).toEqual(original)
  })
})

describe('invalid input and segment boundaries', () => {
  test.each([
    { rsi: NaN }, { rsi: Infinity }, { rsi: -1 }, { rsi: 101 },
    { open: NaN }, { high: Infinity }, { low: 0 }, { close: NaN },
    { low: 160 }, { high: 140 }, { volume: -1 }, { volume: NaN },
    { openTime: NaN }, { closeTime: Infinity }, { openTime: -1 },
    { closeTime: START },
  ])('malformed bar %p prevents comparisons across its position', (changes) => {
    const bars = regularBullish()
    bars[4] = { ...bars[4], ...changes }
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
  })

  test('does not bridge a missing timestamp interval', () => {
    const bars = regularBullish()
    bars.splice(4, 1)
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
  })

  test('does not bridge duplicate or out-of-order candles', () => {
    const bars = regularBullish()
    bars[4] = { ...bars[3] }
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
  })

  test('can find a fresh signal in a contiguous segment after a gap', () => {
    const bars = regularBullish()
    const offset = bars.length * MINUTE + 5 * MINUTE
    const secondSegment = bars.map((bar) => ({ ...bar, openTime: bar.openTime + offset, closeTime: bar.closeTime + offset }))
    const signals = findRsiDivergences([...bars, ...secondSegment], smallPivots)
    expect(signals).toHaveLength(2)
    expect(signals[1].start.time).toBe(secondSegment[2].openTime)
  })

  test('requires the complete left window after a segment boundary', () => {
    const bars = regularBullish()
    bars[1].isClosed = false
    expect(findRsiDivergences(bars, smallPivots)).toEqual([])
  })

  test('accepts an empty or too-short history', () => {
    expect(findRsiDivergences([])).toEqual([])
    expect(findRsiDivergences(makeBars([50, 20, 50]))).toEqual([])
  })

  test.each([
    { leftBars: 0 }, { rightBars: -1 }, { leftBars: 1.5 },
    { minBars: NaN }, { maxBars: Infinity }, { minBars: 7, maxBars: 6 },
  ] satisfies Partial<DivergenceOptions>[])('rejects invalid options %p', (options) => {
    expect(() => findRsiDivergences([], options)).toThrow(RangeError)
  })

  test.each(['includeHidden', 'requireBodyAgreement', 'requireSameRsiCycle'] as const)(
    'rejects a non-boolean %p option', (name) => {
      for (const value of [undefined, null, 0, 1, 'true']) {
        const options = { [name]: value } as Partial<DivergenceOptions>
        expect(() => findRsiDivergences([], options)).toThrow(`${name} must be a boolean`)
      }
    },
  )
})

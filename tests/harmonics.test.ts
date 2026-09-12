import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import {
  analyzeHarmonics, getHarmonicLiveContext, getHarmonicTargets, HARMONIC_C_RANGE, HARMONIC_RATIOS,
  HARMONIC_TARGET_RATIOS, narrowButterflyZone,
} from '../src/lib/harmonics'
import type { HarmonicKind, HarmonicSetup } from '../src/lib/harmonics'

const IDEAL_B: Record<HarmonicKind, number> = { gartley: 0.618, bat: 0.5, butterfly: 0.786 }

function bar(index: number, price: number, patch: Partial<RsiBar> = {}): RsiBar {
  return {
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: price, high: price, low: price, close: price, volume: 10, rsi: 50, isClosed: true, ...patch,
  }
}

/** Strict pivots X=100 at 3, A=200 at 7, B at 11, C at 15; C matures at 18. */
function pattern(kind: HarmonicKind = 'gartley', bRatio = IDEAL_B[kind], cRatio = 0.618): RsiBar[] {
  const b = 200 - 100 * bRatio
  const c = b + (200 - b) * cRatio
  const anchors = [[0, 120], [3, 100], [7, 200], [11, b], [15, c], [18, c - (c - b) * 3 / 8]]
  return Array.from({ length: 19 }, (_, index) => {
    const right = anchors.findIndex(([time]) => time >= index)
    const [endIndex, endPrice] = anchors[right]
    if (endIndex === index) return bar(index, endPrice)
    const [startIndex, startPrice] = anchors[right - 1]
    return bar(index, startPrice + (endPrice - startPrice) * (index - startIndex) / (endIndex - startIndex))
  })
}

function mirror(bars: readonly RsiBar[]): RsiBar[] {
  return bars.map((candle) => ({
    ...candle, open: 400 - candle.open, high: 400 - candle.low,
    low: 400 - candle.high, close: 400 - candle.close,
  }))
}

function find(bars: readonly RsiBar[], kind: HarmonicKind = 'gartley'): HarmonicSetup {
  const setup = analyzeHarmonics(bars).setups.find((candidate) => candidate.kind === kind)
  if (!setup) throw new Error(`Fixture should produce ${kind}`)
  return setup
}

function append(bars: RsiBar[], low: number, high = low, close = (low + high) / 2): void {
  bars.push(bar(bars.length, close, { low, high }))
}

describe('lecture harmonic geometry', () => {
  test.each(['gartley', 'bat', 'butterfly'] as const)('detects %s and its bearish mirror with linear ratio bands', (kind) => {
    const bars = pattern(kind)
    const bullish = find(bars, kind)
    const bearish = find(mirror(bars), kind)
    const [near, far] = HARMONIC_RATIOS[kind].d
    expect(bullish).toMatchObject({ kind, direction: 'bullish', stage: 'forming', status: 'active', d: null, endedAt: null })
    expect(bullish.x).toEqual({ index: 3, time: bars[3].openTime, price: 100 })
    expect(bullish.a.price).toBe(200)
    expect(bullish.bRatio).toBeCloseTo(IDEAL_B[kind], 12)
    expect(bullish.cRatio).toBeCloseTo(0.618, 12)
    expect(bullish.baseZone.low).toBeCloseTo(200 - far * 100, 12)
    expect(bullish.baseZone.high).toBeCloseTo(200 - near * 100, 12)
    expect(bullish.cInvalidation).toBeCloseTo(bullish.b.price + (200 - bullish.b.price) * 0.974, 12)
    expect(bullish.stopReference).toBeCloseTo(kind === 'butterfly' ? bullish.zone.low : 100, 12)
    expect(bearish).toMatchObject({ kind, direction: 'bearish', stage: 'forming', status: 'active', d: null })
    expect(bearish.bRatio).toBeCloseTo(bullish.bRatio, 12)
    expect(bearish.cRatio).toBeCloseTo(bullish.cRatio, 12)
    expect(bearish.zone.low).toBeCloseTo(400 - bullish.zone.high, 12)
    expect(bearish.zone.high).toBeCloseTo(400 - bullish.zone.low, 12)
    expect(bearish.stopReference).toBeCloseTo(400 - bullish.stopReference, 12)
    expect(bearish.confirmedAt).toBe(bars[18].closeTime)
  })

  test.each(['gartley', 'bat', 'butterfly'] as const)('%s uses inclusive saved-template B boundaries and rejects prices just outside', (kind) => {
    const range = HARMONIC_RATIOS[kind].b
    for (const ratio of range) expect(find(pattern(kind, ratio), kind).bRatio).toBeCloseTo(ratio, 12)
    for (const ratio of [range[0] - 1e-7, range[1] + 1e-7]) {
      expect(analyzeHarmonics(pattern(kind, ratio)).setups.some((setup) => setup.kind === kind)).toBe(false)
    }
  })

  test('C boundaries are inclusive, and out-of-range C is rejected for every family', () => {
    for (const kind of ['gartley', 'bat', 'butterfly'] as const) {
      for (const ratio of HARMONIC_C_RANGE) {
        const bars = pattern(kind, IDEAL_B[kind], ratio)
        expect(find(bars, kind).cRatio).toBeCloseTo(ratio, 12)
        expect(find(bars, kind).status).toBe('active')
        expect(find(mirror(bars), kind).status).toBe('active')
      }
      for (const ratio of [0.343 - 1e-7, 0.974 + 1e-7]) expect(analyzeHarmonics(pattern(kind, IDEAL_B[kind], ratio)).setups).toEqual([])
    }
  })

  test('uses wick anchors instead of candle closes', () => {
    const bars = pattern()
    bars[3] = { ...bars[3], open: 110, close: 112, high: 113 }
    bars[7] = { ...bars[7], open: 190, close: 191, low: 188 }
    bars[11] = { ...bars[11], open: 143, close: 144, high: 145 }
    bars[15] = { ...bars[15], open: 170, close: 171, low: 169 }
    const setup = find(bars)
    expect([setup.x.price, setup.a.price, setup.b.price, setup.c.price]).toEqual([100, 200, 138.2, 176.3924])
    expect(setup.bRatio).toBeCloseTo(0.618)
  })

  test('flat ties and a dual high/low pivot cannot supply ordered anchors', () => {
    const tied = pattern()
    tied[8] = { ...tied[8], high: 200 }
    expect(analyzeHarmonics(tied).setups).toEqual([])
    const outside = pattern()
    outside[7] = { ...outside[7], low: 50 }
    expect(analyzeHarmonics(outside).setups).toEqual([])
    expect(analyzeHarmonics(Array.from({ length: 50 }, (_, index) => bar(index, 100))).setups).toEqual([])
  })

  test('does not project nonpositive Butterfly prices', () => {
    const bars = pattern('butterfly').map((candle) => ({
      ...candle, open: candle.open - 90, high: candle.high - 90,
      low: candle.low - 90, close: candle.close - 90,
    }))
    expect(analyzeHarmonics(bars).setups).toEqual([])
  })

  test('Butterfly BC confluence narrows only the overlapping D band and adjusts its stop reference', () => {
    const setup = find(pattern('butterfly'), 'butterfly')
    expect(setup.zoneNarrowed).toBe(true)
    expect(setup.zone.low).toBeCloseTo(setup.c.price - (setup.c.price - setup.b.price) * 2.8798, 12)
    expect(setup.zone.high).toBe(setup.baseZone.high)
    expect(setup.stopReference).toBe(setup.zone.low)
    const broad = find(pattern('butterfly', 0.786, 0.974), 'butterfly')
    expect(broad.zoneNarrowed).toBe(false)
    expect(broad.zone).toEqual(broad.baseZone)
    const baseZone = { low: 10, high: 20 }
    expect(narrowButterflyZone(baseZone, 100, 110)).toEqual({ zone: baseZone, zoneNarrowed: false })
    expect(narrowButterflyZone(baseZone, 1, 2)).toEqual({ zone: baseZone, zoneNarrowed: false })
  })

  test.each(['gartley', 'bat', 'butterfly'] as const)('%s target template projects from D toward the correct anchor and mirrors', (kind) => {
    const bullish = find(pattern(kind), kind)
    const bearish = find(mirror(pattern(kind)), kind)
    const targets = getHarmonicTargets(bullish)
    const opposite = getHarmonicTargets(bearish)
    const d = (bullish.zone.low + bullish.zone.high) / 2
    const anchor = kind === 'butterfly' ? bullish.c.price : bullish.a.price
    expect(targets.map((target) => target.ratio)).toEqual([...HARMONIC_TARGET_RATIOS[kind]])
    targets.forEach((target, index) => {
      expect(target.price).toBeCloseTo(d + target.ratio * (anchor - d), 12)
      expect(target.price).toBeGreaterThan(d)
      expect(opposite[index].price).toBeCloseTo(400 - target.price, 12)
    })
    const actualD = { index: 19, time: 19 * 60_000, price: bullish.zone.high - 1 }
    const actual = getHarmonicTargets({ ...bullish, d: actualD })
    expect(actual[0].price).toBeCloseTo(actualD.price + actual[0].ratio * (anchor - actualD.price), 12)
    expect(actual[0].price).not.toBeCloseTo(targets[0].price, 6)
    const before = structuredClone(bullish)
    getHarmonicTargets(bullish)
    expect(bullish).toEqual(before)
  })

  test('target projections omit nonpositive prices beyond a bearish anchor', () => {
    const setup = find(mirror(pattern('bat')), 'bat')
    const shifted = {
      ...setup, a: { ...setup.a, price: 1 },
      d: { index: 19, time: 19 * 60_000, price: 100 },
    }
    expect(getHarmonicTargets(shifted).map((target) => target.ratio)).toEqual([0.382, 0.618, 0.886])
  })
})

describe('confirmation and harmonic lifecycle', () => {
  test('C needs three closed right-hand bars and cannot use a provisional confirmer', () => {
    const bars = pattern()
    expect(analyzeHarmonics(bars.slice(0, 18)).setups).toEqual([])
    expect(analyzeHarmonics([...bars.slice(0, 18), { ...bars[18], isClosed: false }]).setups).toEqual([])
    expect(find(bars).confirmedAt).toBe(bars[18].closeTime)
  })

  test.each([false, true])('only a closed cross of B advances the forming stage (bearish=%p)', (bearish) => {
    const bars = pattern()
    const transform = () => bearish ? mirror(bars) : bars
    append(bars, 135, 150, 140)
    expect(find(transform()).stage).toBe('forming')
    append(bars, 135, 140, 138.2)
    expect(find(transform()).stage).toBe('forming')
    append(bars, 133, 138, 136)
    expect(find(transform()).stage).toBe('approaching')
    expect(find(transform()).d).toBeNull()
  })

  test.each([false, true])('D is first observed postconfirmation touch, without future pivot confirmation (bearish=%p)', (bearish) => {
    const bars = pattern()
    append(bars, 124, 139, 135)
    const transform = () => bearish ? mirror(bars) : bars
    const setup = find(transform())
    expect(setup).toMatchObject({ stage: 'zone', status: 'active' })
    expect(setup.d).toEqual({ index: 19, time: bars[19].openTime, price: bearish ? 276 : 124 })
    append(bars, 120, 130, 125)
    expect(find(transform()).d).toEqual(setup.d)
    append(bars, 125, 135, 130)
    expect(find(transform()).status).toBe('active')
    append(bars, 140, 145, 142)
    expect(find(transform())).toMatchObject({ stage: 'zone', status: 'completed', endedAt: bars[22].closeTime, d: setup.d })
  })

  test.each([16, 17, 18])('contact on preconfirmation bar %i is missed and never backdated', (index) => {
    const bars = pattern()
    bars[index] = { ...bars[index], low: 124 }
    const setup = find(bars)
    expect(setup).toMatchObject({ status: 'missed', d: null, endedAt: bars[18].closeTime })
    append(bars, 125, 130)
    expect(find(bars)).toEqual(setup)
  })

  test.each([false, true])('same-candle C invalidation wins contact and far-D breaches invalidate (bearish=%p)', (bearish) => {
    const bars = pattern()
    const original = find(bars)
    append(bars, 120, original.cInvalidation + 0.01, 140)
    const invalidC = find(bearish ? mirror(bars) : bars)
    expect(invalidC).toMatchObject({ status: 'invalidated', d: null, endedAt: bars[19].closeTime })
    const beyond = pattern()
    append(beyond, original.zone.low - 0.01, 135, 125)
    expect(find(bearish ? mirror(beyond) : beyond)).toMatchObject({ status: 'invalidated', d: null })
  })

  test('C outer boundary allows equality but invalidates a wick before B is crossed', () => {
    const bars = pattern()
    const setup = find(bars)
    append(bars, 165, setup.cInvalidation, 170)
    expect(find(bars)).toMatchObject({ status: 'active', stage: 'forming' })
    append(bars, 166, setup.cInvalidation + 0.001, 171)
    expect(find(bars)).toMatchObject({ status: 'invalidated', stage: 'forming', d: null })
  })

  test('D far edge is included, while gap jumps beyond it cannot be a touch', () => {
    const bars = pattern()
    const setup = find(bars)
    append(bars, setup.zone.low, setup.zone.high)
    expect(find(bars)).toMatchObject({ status: 'active', stage: 'zone' })
    const gap = pattern()
    append(gap, setup.zone.low - 2, setup.zone.low - 1)
    expect(find(gap)).toMatchObject({ status: 'invalidated', d: null })
  })

  test('unfilled opportunities expire 60 closed bars after C and cannot reactivate', () => {
    const bars = pattern()
    while (bars.length <= 74) append(bars, 150)
    expect(find(bars).status).toBe('active')
    append(bars, 150)
    const expired = find(bars)
    expect(expired).toMatchObject({ status: 'expired', endedAt: bars[75].closeTime })
    append(bars, 124)
    expect(find(bars)).toEqual(expired)
  })

  test('prefix replay freezes anchors, detection time, touches, and terminal outcomes', () => {
    const bars = pattern()
    append(bars, 135, 139, 136)
    append(bars, 124, 137, 130)
    append(bars, 120, 135)
    append(bars, 145, 150)
    append(bars, 155, 160)
    const final = analyzeHarmonics(bars)
    for (let length = 0; length <= bars.length; length++) {
      const prefix = bars.slice(0, length)
      const found = analyzeHarmonics(prefix)
      expect(found.setups.map((setup) => setup.id)).toEqual(final.setups
        .filter((setup) => setup.confirmedAt <= (prefix.at(-1)?.closeTime ?? -1)).map((setup) => setup.id))
      for (const setup of found.setups) {
        const finished = final.setups.find((candidate) => candidate.id === setup.id)!
        expect([setup.x, setup.a, setup.b, setup.c, setup.confirmedAt])
          .toEqual([finished.x, finished.a, finished.b, finished.c, finished.confirmedAt])
        if (setup.d) expect(setup.d).toEqual(finished.d)
        if (setup.status !== 'active') expect(setup).toEqual(finished)
      }
    }
  })
})

describe('history integrity and live context', () => {
  test('live ticks neither form pivots nor change stage, touches, or invalidation', () => {
    const bars = pattern()
    const confirmed = analyzeHarmonics(bars)
    const original = structuredClone(confirmed)
    for (const price of [1, 124, 150, 300, NaN, Infinity]) {
      expect(analyzeHarmonics([...bars, bar(19, price, { isClosed: false })])).toEqual(confirmed)
    }
    expect(confirmed).toEqual(original)
  })

  test.each([false, true])('provisional in-zone/distance/invalidation is separate from closed analysis (bearish=%p)', (bearish) => {
    const setup = find(bearish ? mirror(pattern()) : pattern())
    const before = structuredClone(setup)
    const { low, high } = setup.zone
    for (const price of [low, high, (low + high) / 2]) {
      expect(getHarmonicLiveContext(setup, price)).toEqual({ inZone: true, distancePercent: 0, invalidated: false })
    }
    const approach = bearish ? low - 1 : high + 1
    expect(getHarmonicLiveContext(setup, approach)).toEqual({ inZone: false, distancePercent: 1 / approach * 100, invalidated: false })
    const beyond = bearish ? high + 0.01 : low - 0.01
    expect(getHarmonicLiveContext(setup, beyond)).toMatchObject({ inZone: false, invalidated: true })
    const outsideC = setup.cInvalidation + (bearish ? -0.01 : 0.01)
    expect(getHarmonicLiveContext(setup, outsideC)).toMatchObject({ inZone: false, invalidated: true })
    for (const price of [0, -1, NaN, Infinity]) {
      expect(getHarmonicLiveContext(setup, price)).toEqual({ inZone: false, invalidated: true, distancePercent: Infinity })
    }
    expect(setup).toEqual(before)
  })

  test('missing, provisional, duplicated, or changed-duration interior candles reset the suffix', () => {
    const bars = pattern()
    expect(analyzeHarmonics(bars.filter((_, index) => index !== 11))).toEqual({ setups: [], closedBarCount: 7 })
    expect(analyzeHarmonics(bars.map((candle, index) => index === 11 ? { ...candle, isClosed: false } : candle)))
      .toEqual({ setups: [], closedBarCount: 7 })
    expect(analyzeHarmonics([...bars.slice(0, 12), bars[11], ...bars.slice(12)]).setups).toEqual([])
    const changed = bars.map((candle, index) => index === 11 ? { ...candle, closeTime: candle.closeTime - 1 } : candle)
    expect(analyzeHarmonics(changed)).toEqual({ setups: [], closedBarCount: 7 })
  })

  test.each([false, true])('a provisional wick violation remains visible after price recedes (bearish=%p)', (bearish) => {
    const setup = find(bearish ? mirror(pattern()) : pattern())
    const price = (setup.zone.low + setup.zone.high) / 2
    const high = bearish ? setup.zone.high + 1 : setup.cInvalidation + 1
    const low = bearish ? setup.cInvalidation - 1 : setup.zone.low - 1
    const before = structuredClone(setup)
    expect(getHarmonicLiveContext(setup, price, { high, low: price, isClosed: false }))
      .toMatchObject({ inZone: false, invalidated: true })
    expect(getHarmonicLiveContext(setup, price, { high: price, low, isClosed: false }))
      .toMatchObject({ inZone: false, invalidated: true })
    expect(getHarmonicLiveContext(setup, price, { high, low, isClosed: true }))
      .toMatchObject({ inZone: true, invalidated: false })
    expect(getHarmonicLiveContext(setup, price, { high: NaN, low: price, isClosed: false }))
      .toMatchObject({ inZone: false, invalidated: true })
    expect(getHarmonicLiveContext(setup, price, { high: price, low: price, isClosed: false }))
      .toMatchObject({ inZone: true, invalidated: false })
    expect(setup).toEqual(before)
  })

  test.each([
    { low: NaN }, { close: 0 }, { volume: -1 }, { low: 200 }, { high: 1 }, { openTime: -1 }, { closeTime: 0 },
  ])('malformed final closed bar clears stale signals (%p)', (patch) => {
    const bars = pattern()
    bars[18] = { ...bars[18], ...patch }
    expect(analyzeHarmonics(bars)).toEqual({ setups: [], closedBarCount: 0 })
  })

  test('history is bounded, input is immutable, and a new suffix can form its own pattern', () => {
    const bars = pattern()
    const copy = structuredClone(bars)
    bars.forEach(Object.freeze)
    Object.freeze(bars)
    expect(() => analyzeHarmonics(bars)).not.toThrow()
    expect(bars).toEqual(copy)
    expect(analyzeHarmonics([])).toEqual({ setups: [], closedBarCount: 0 })
    expect(analyzeHarmonics(Array.from({ length: 620 }, (_, index) => bar(index, 100))).closedBarCount).toBe(500)
    const resumed = pattern().map((candle) => ({ ...candle, openTime: candle.openTime + 100 * 60_000, closeTime: candle.closeTime + 100 * 60_000 }))
    expect(find([...bars, ...resumed]).x.time).toBe(resumed[3].openTime)
    expect(analyzeHarmonics([...bars, ...resumed]).closedBarCount).toBe(19)
  })
})

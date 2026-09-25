import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import {
  advanceHarmonicReplay, analyzeHarmonics, createHarmonicReplay, summarizeHarmonicReplay, getHarmonicLiveContext, getHarmonicTargets, HARMONIC_C_RANGE, HARMONIC_RATIOS,
  HARMONIC_TARGET_RATIOS, HARMONIC_TOUCH_RECENCY_BARS, narrowButterflyZone,
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

  test('B is the deepest retracement before C even when a smaller pullback formed first (L18 chronology)', () => {
    // X=100 (3), A=200 (7), shallow pullback to 170 (10) with a bounce to 185 (13), true B=138.2 (17), C (21), confirmed at 24.
    const c = 138.2 + (200 - 138.2) * 0.618
    const anchors: [number, number][] = [[0, 120], [3, 100], [7, 200], [10, 170], [13, 185], [17, 138.2], [21, c], [24, c - 10]]
    const bars = Array.from({ length: 25 }, (_, index) => {
      const right = anchors.findIndex(([time]) => time >= index)
      const [endIndex, endPrice] = anchors[right]
      if (endIndex === index) return bar(index, endPrice)
      const [startIndex, startPrice] = anchors[right - 1]
      return bar(index, startPrice + (endPrice - startPrice) * (index - startIndex) / (endIndex - startIndex))
    })
    const setups = analyzeHarmonics(bars).setups
    expect(setups.map((setup) => [setup.kind, setup.x.index, setup.a.index, setup.b.index, setup.c.index]))
      .toEqual([['gartley', 3, 7, 17, 21]])
    expect(setups[0].bRatio).toBeCloseTo(0.618, 12)
    expect(setups[0].status).toBe('active')
  })

  test('X is the extreme before A and A the extreme of the window; a higher high after A means no harmonic', () => {
    const bars = pattern()
    bars[5] = { ...bars[5], high: 201, open: 199, close: 199 }
    expect(find(bars).a).toEqual({ index: 5, time: bars[5].openTime, price: 201 })
    const deeper = pattern()
    deeper[1] = { ...deeper[1], low: 90, open: 95, close: 95 }
    expect(analyzeHarmonics(deeper).setups).toEqual([])
    const higherHigh = pattern()
    higherHigh[15] = { ...higherHigh[15], high: 200.5, open: 199, close: 199 }
    expect(analyzeHarmonics(higherHigh).setups).toEqual([])
  })

  test('several dominant X can validate one A-B-C at different families, nearest first', () => {
    // Bat X=100 (3) and a nearer Butterfly X=~137 (11) share A=200 (15), B=150 (19), C=~181 (23).
    const anchors: [number, number][] = [[0, 130], [3, 100], [7, 160], [11, 200 - 50 / 0.786], [15, 200], [19, 150], [23, 150 + 50 * 0.618], [26, 170]]
    const bars = Array.from({ length: 27 }, (_, index) => {
      const right = anchors.findIndex(([time]) => time >= index)
      const [endIndex, endPrice] = anchors[right]
      if (endIndex === index) return bar(index, endPrice)
      const [startIndex, startPrice] = anchors[right - 1]
      return bar(index, startPrice + (endPrice - startPrice) * (index - startIndex) / (endIndex - startIndex))
    })
    const setups = analyzeHarmonics(bars).setups.filter((setup) => setup.status === 'active')
    expect(setups.map((setup) => [setup.kind, setup.x.index])).toEqual([['butterfly', 11], ['bat', 3]])
    expect(setups[1].bRatio).toBeCloseTo(0.5, 12)
    expect(setups[0].bRatio).toBeCloseTo(0.786, 12)
  })

  test('a later higher C inside the band supersedes the earlier drawing of the same X-A family', () => {
    const bars = pattern()
    const first = find(bars)
    append(bars, 150, 155, 152)
    append(bars, 178, 182, 180)
    append(bars, 160, 165, 162)
    append(bars, 150, 156, 153)
    append(bars, 150, 156, 153)
    const setups = analyzeHarmonics(bars).setups
    expect(setups.map((setup) => setup.status)).toEqual(['superseded', 'active'])
    expect(setups[0].id).toBe(first.id)
    expect(setups[0].endedAt).toBe(setups[1].confirmedAt)
    expect(setups[1]).toMatchObject({ kind: 'gartley', x: first.x, a: first.a, b: first.b })
    expect(setups[1].c.price).toBe(182)
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

  test.each([16, 17, 18])('contact on confirmation-window bar %i is reported as the observed D, not hidden', (index) => {
    const bars = pattern()
    bars[index] = { ...bars[index], low: 124, close: 130, open: 132, high: 134 }
    for (let later = index + 1; later <= 18; later++) bars[later] = bar(later, 132, { low: 130, high: 134 })
    const setup = find(bars)
    expect(setup).toMatchObject({ status: 'active', stage: 'zone', confirmedAt: bars[18].closeTime })
    expect(setup.d).toEqual({ index, time: bars[index].openTime, price: 124 })
    append(bars, 125, 130)
    expect(find(bars).d).toEqual(setup.d)
  })

  test('a touch that instantly reaches the first target inside the confirmation window is not a fresh setup', () => {
    const bars = pattern()
    bars[16] = { ...bars[16], low: 124 }
    expect(analyzeHarmonics(bars).setups).toEqual([])
  })

  test.each([false, true])('same-candle C invalidation wins contact and a wick beyond X invalidates (bearish=%p)', (bearish) => {
    const bars = pattern()
    const original = find(bars)
    append(bars, 120, original.cInvalidation + 0.01, 140)
    const invalidC = find(bearish ? mirror(bars) : bars)
    expect(invalidC).toMatchObject({ status: 'invalidated', d: null, endedAt: bars[19].closeTime })
    const beyond = pattern()
    append(beyond, original.stopReference - 0.01, 135, 125)
    expect(find(bearish ? mirror(beyond) : beyond)).toMatchObject({ status: 'invalidated', d: null })
  })

  test.each(['gartley', 'bat'] as const)('%s survives a wick past the far edge of D until X is breached (L18 stop, L16 pocket)', (kind) => {
    const bars = pattern(kind)
    const setup = find(bars, kind)
    expect(setup.stopReference).toBe(100)
    append(bars, setup.zone.low - 0.5, setup.zone.high - 1, setup.zone.high - 2)
    const touched = find(bars, kind)
    expect(touched).toMatchObject({ status: 'active', stage: 'zone' })
    expect(touched.d?.price).toBeCloseTo(setup.zone.low, 12)
    append(bars, 100.5, setup.zone.low, setup.zone.low)
    expect(find(bars, kind).status).toBe('active')
    append(bars, 99.99, setup.zone.low, setup.zone.low)
    expect(find(bars, kind)).toMatchObject({ status: 'invalidated', endedAt: bars.at(-1)!.closeTime })
  })

  test('a Butterfly stop sits at the far edge of its established D range', () => {
    const bars = pattern('butterfly')
    const setup = find(bars, 'butterfly')
    append(bars, setup.zone.low - 0.01, setup.zone.high, setup.zone.high)
    expect(find(bars, 'butterfly')).toMatchObject({ status: 'invalidated', d: null })
  })

  test('C outer boundary allows equality but invalidates a wick before B is crossed', () => {
    const bars = pattern()
    const setup = find(bars)
    append(bars, 165, setup.cInvalidation, 170)
    expect(find(bars)).toMatchObject({ status: 'active', stage: 'forming' })
    append(bars, 166, setup.cInvalidation + 0.001, 171)
    expect(find(bars)).toMatchObject({ status: 'invalidated', stage: 'forming', d: null })
  })

  test('D far edge is included, while a gap between D and X is neither a touch nor a stop', () => {
    const bars = pattern()
    const setup = find(bars)
    append(bars, setup.zone.low, setup.zone.high)
    expect(find(bars)).toMatchObject({ status: 'active', stage: 'zone' })
    const gap = pattern()
    append(gap, setup.zone.low - 2, setup.zone.low - 1)
    expect(find(gap)).toMatchObject({ status: 'active', stage: 'approaching', d: null })
    append(gap, 98, 99)
    expect(find(gap)).toMatchObject({ status: 'invalidated', d: null })
  })

  test('a touched zone stays active while price holds D, completes at the first target, or goes stale after leaving', () => {
    const bars = pattern()
    append(bars, 124, 130)
    const setup = find(bars)
    const [first] = getHarmonicTargets(setup)
    for (let count = 0; count < HARMONIC_TOUCH_RECENCY_BARS + 3; count++) append(bars, 120, 128)
    expect(find(bars)).toMatchObject({ status: 'active', stage: 'zone', d: setup.d, lastTouchIndex: bars.length - 1 })
    const target = structuredClone(bars)
    append(target, 135, first.price)
    expect(find(target)).toMatchObject({ status: 'completed', endedAt: target.at(-1)!.closeTime })
    const stale = structuredClone(bars)
    for (let count = 0; count < HARMONIC_TOUCH_RECENCY_BARS - 1; count++) append(stale, 132, 136)
    expect(find(stale).status).toBe('active')
    append(stale, 132, 136)
    expect(find(stale)).toMatchObject({ status: 'expired', endedAt: stale.at(-1)!.closeTime })
    const rally = structuredClone(bars)
    append(rally, 132, setup.cInvalidation + 5, first.price - 1)
    expect(find(rally).status).toBe('completed')
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
    const pocket = bearish ? high + 0.01 : low - 0.01
    expect(getHarmonicLiveContext(setup, pocket)).toMatchObject({ inZone: false, invalidated: false })
    const beyond = setup.stopReference + (bearish ? 0.01 : -0.01)
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
    expect(analyzeHarmonics(bars.filter((_, index) => index !== 11))).toMatchObject({ setups: [], closedBarCount: 7, historyIssue: 'gap' })
    expect(analyzeHarmonics(bars.map((candle, index) => index === 11 ? { ...candle, isClosed: false } : candle)))
      .toMatchObject({ setups: [], closedBarCount: 7, historyIssue: 'gap' })
    expect(analyzeHarmonics([...bars.slice(0, 12), bars[11], ...bars.slice(12)]).setups).toEqual([])
    const changed = bars.map((candle, index) => index === 11 ? { ...candle, closeTime: candle.closeTime - 1 } : candle)
    expect(analyzeHarmonics(changed)).toMatchObject({ setups: [], closedBarCount: 7, historyIssue: 'gap' })
  })

  test.each([false, true])('a provisional wick violation remains visible after price recedes (bearish=%p)', (bearish) => {
    const setup = find(bearish ? mirror(pattern()) : pattern())
    const price = (setup.zone.low + setup.zone.high) / 2
    const high = bearish ? setup.stopReference + 1 : setup.cInvalidation + 1
    const low = bearish ? setup.cInvalidation - 1 : setup.stopReference - 1
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
    expect(analyzeHarmonics(bars)).toEqual({ setups: [], closedBarCount: 0, historyIssue: 'invalid' })
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


describe('durable chronological harmonics', () => {
  test.each([false, true])('active setup survives candle 501 and completes after its anchors roll out (bearish=%p)', (bearish) => {
    const bars = pattern()
    while (bars.length < 800) append(bars, 118, 122, 120)
    const stream = bearish ? mirror(bars) : bars
    const before = find(stream.slice(0, 20))
    for (const length of [499, 500, 501, 506, 800]) {
      const current = find(stream.slice(0, length))
      expect(current).toMatchObject({ id: before.id, status: 'active', x: before.x, a: before.a, b: before.b, c: before.c, d: before.d })
      expect(current.lastTouchIndex).toBe(length - 1)
      expect(getHarmonicTargets(current)).toEqual(getHarmonicTargets(before))
    }
    append(bars, 135, 145, 140)
    const ended = find(bearish ? mirror(bars) : bars)
    expect(ended).toMatchObject({ status: 'completed', endedAt: bars.at(-1)!.closeTime, d: before.d })
    expect(analyzeHarmonics(bearish ? mirror(bars) : bars).closedBarCount).toBe(500)
  })

  test.each(['stop', 'stale'] as const)('retained setup eventually ends by %s', (reason) => {
    const bars = pattern()
    while (bars.length < 710) append(bars, 118, 122, 120)
    if (reason === 'stop') append(bars, 99, 110, 105)
    else for (let i = 0; i < 12; i++) append(bars, 130, 134, 132)
    expect(find(bars)).toMatchObject({ status: reason === 'stop' ? 'invalidated' : 'expired', endedAt: bars.at(-1)!.closeTime })
  })

  test.each([false, true])('D pivot requires three closed right candles and preserves contact and targets (bearish=%p)', (bearish) => {
    const bars = pattern()
    append(bars, 124, 130, 127)
    append(bars, 118, 126, 122)
    append(bars, 121, 130, 125)
    append(bars, 123, 131, 127)
    const transform = () => bearish ? mirror(bars) : bars
    const touched = find(transform())
    const targets = getHarmonicTargets(touched)
    expect(touched.confirmedD).toBeNull()
    append(bars, 125, 134, 130)
    const live = transform().map((candle, i) => i === bars.length - 1 ? { ...candle, isClosed: false } : candle)
    expect(find(live).confirmedD).toBeNull()
    const confirmed = find(transform())
    expect(confirmed.confirmedD).toEqual({ index: 20, time: bars[20].openTime, price: bearish ? 282 : 118 })
    expect(confirmed.dConfirmedAt).toBe(bars[23].closeTime)
    expect(confirmed.d).toEqual(touched.d)
    expect(getHarmonicTargets(confirmed)).toEqual(targets)
    append(bars, 119, 128, 124)
    append(bars, 115, 124, 120)
    append(bars, 118, 128, 124)
    append(bars, 120, 130, 125)
    append(bars, 122, 132, 127)
    expect(find(transform()).confirmedD).toEqual(confirmed.confirmedD)
    expect(find(transform()).dConfirmedAt).toBe(confirmed.dConfirmedAt)
  })

  test('the contact candle itself can become D, and confirmation is available on the completion bar', () => {
    const bars = pattern()
    append(bars, 118, 125, 122)
    append(bars, 122, 131, 128)
    append(bars, 125, 133, 129)
    append(bars, 127, 140, 134)
    const setup = find(bars)
    expect(setup).toMatchObject({ status: 'completed', dConfirmedAt: bars[22].closeTime,
      confirmedD: { index: 19, time: bars[19].openTime, price: 118 } })
    expect(setup.confirmedD).toEqual(setup.d)
  })

  test('a pivot confirmed after the setup ends cannot add retrospective confirmation', () => {
    const bars = pattern()
    append(bars, 118, 125, 122)
    append(bars, 124, 145, 140)
    append(bars, 130, 145, 138)
    append(bars, 132, 148, 140)
    expect(find(bars)).toMatchObject({ status: 'completed', confirmedD: null, dConfirmedAt: null })
  })

  test.each(['tie', 'below-zone', 'outside'] as const)('rejects a %s D pivot', (reason) => {
    const bars = pattern()
    append(bars, 124, 130, 127)
    if (reason === 'outside') for (let i = 0; i < 3; i++) append(bars, 124, 130, 127)
    const low = reason === 'below-zone' ? 110 : 118
    append(bars, low, reason === 'outside' ? 136 : 126, 122)
    append(bars, reason === 'tie' ? low : 122, 130, 126)
    append(bars, 123, 131, 127)
    append(bars, 125, 134, 130)
    expect(find(bars).confirmedD).toBeNull()
  })


  test('a later strict pivot may revisit an equal CD extreme outside its three-bar neighborhood', () => {
    const bars = pattern()
    append(bars, 118, 125, 122)
    append(bars, 118, 126, 122)
    append(bars, 122, 130, 126)
    append(bars, 123, 131, 127)
    append(bars, 124, 132, 128)
    expect(find(bars).confirmedD).toBeNull()
    append(bars, 118, 126, 122)
    append(bars, 121, 130, 125)
    append(bars, 123, 132, 127)
    append(bars, 125, 134, 130)
    expect(find(bars)).toMatchObject({ d: { index: 19, price: 118 },
      confirmedD: { index: 24, price: 118 }, dConfirmedAt: bars[27].closeTime })
  })

  test('a later higher local low is not the terminal CD extreme', () => {
    const bars = pattern()
    append(bars, 110, 112, 111)
    append(bars, 120, 127, 124)
    append(bars, 125, 130, 127)
    append(bars, 126, 131, 128)
    append(bars, 122, 128, 125)
    append(bars, 125, 131, 128)
    append(bars, 126, 132, 129)
    append(bars, 127, 133, 130)
    expect(find(bars)).toMatchObject({ status: 'active', confirmedD: null })
  })

  test('stream summaries are immutable snapshots and agree with full-history replay', () => {
    const bars = pattern()
    while (bars.length < 650) append(bars, 118, 122, 120)
    const state = createHarmonicReplay()
    for (const candle of bars.slice(0, 20)) advanceHarmonicReplay(state, candle)
    const first = summarizeHarmonicReplay(state)
    const copy = structuredClone(first)
    for (const candle of bars.slice(20)) advanceHarmonicReplay(state, candle)
    expect(first).toEqual(copy)
    expect(summarizeHarmonicReplay(state)).toEqual(analyzeHarmonics(bars))
    expect(state.history).toHaveLength(500)
    expect(state.kinds).toHaveLength(500)
    expect(state.offset).toBe(150)
  })

  test('discovery after rollover uses absolute ordinals and finished outcomes stay bounded', () => {
    const state = createHarmonicReplay()
    for (let i = 0; i < 600; i++) advanceHarmonicReplay(state, bar(i, 120))
    const fixture = pattern()
    let index = 600
    for (const candle of fixture) {
      advanceHarmonicReplay(state, { ...candle, openTime: index * 60_000, closeTime: ++index * 60_000 - 1 })
    }
    expect(summarizeHarmonicReplay(state).setups[0].x.index).toBe(603)
    expect(summarizeHarmonicReplay(state).setups[0].c.index).toBe(615)
    for (let count = 0; count < 520; count++) {
      for (const candle of fixture) {
        advanceHarmonicReplay(state, { ...candle, openTime: index * 60_000, closeTime: ++index * 60_000 - 1 })
      }
      advanceHarmonicReplay(state, bar(index++, 124))
      advanceHarmonicReplay(state, bar(index++, 150))
    }
    expect(state.setups.filter((setup) => setup.status !== 'active')).toHaveLength(500)
    expect(state.history).toHaveLength(500)
    expect(Object.keys(state.dExtremes).length).toBe(state.setups.filter((setup) => setup.status === 'active' && !setup.confirmedD).length)
  })


  test('an old setup ending after 500 newer outcomes remains observable on its ending bar', () => {
    const bars = pattern()
    append(bars, 118, 122, 120)
    const state = createHarmonicReplay()
    for (const candle of bars) advanceHarmonicReplay(state, candle)
    const originalId = state.setups[0].id
    let index = bars.length
    for (let count = 0; count < 510; count++) {
      for (const candle of pattern()) {
        const price = 118 + (candle.close - 100) * 0.1
        advanceHarmonicReplay(state, bar(index++, price))
      }
      advanceHarmonicReplay(state, bar(index++, 120))
      advanceHarmonicReplay(state, bar(index++, 126))
    }
    expect(state.setups.filter((setup) => setup.status !== 'active')).toHaveLength(500)
    expect(state.setups.find((setup) => setup.id === originalId)?.status).toBe('active')
    const final = bar(index, 140)
    advanceHarmonicReplay(state, final)
    expect(summarizeHarmonicReplay(state).setups.find((setup) => setup.id === originalId))
      .toMatchObject({ status: 'completed', endedAt: final.closeTime })
  })

  test('proportional expiry is an opt-in research profile', () => {
    const bars = pattern()
    while (bars.length <= 29) append(bars, 150)
    expect(analyzeHarmonics(bars).setups[0].status).toBe('active')
    expect(analyzeHarmonics(bars, { expiryMode: 'proportional' }).setups[0])
      .toMatchObject({ status: 'expired', endedAt: bars[29].closeTime })
    const touched = pattern()
    append(touched, 118, 124, 120)
    for (let i = 0; i < 8; i++) append(touched, 130, 134, 132)
    expect(analyzeHarmonics(touched).setups[0].status).toBe('active')
    expect(analyzeHarmonics(touched, { expiryMode: 'proportional' }).setups[0].status).toBe('expired')
    expect(() => createHarmonicReplay({ expiryMode: 'unknown' as 'fixed' })).toThrow()
  })
})

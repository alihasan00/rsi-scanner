import { describe, expect, test } from 'bun:test'
import type { HarmonicSetup } from '../src/lib/harmonics'
import { getBatGeometryDiagnostics, getHarmonicQuality } from '../src/lib/harmonicQuality'
import { HARMONIC_RATIOS } from '../src/lib/harmonics'

function bat(): HarmonicSetup {
  return {
    id: 'bat', kind: 'bat', direction: 'bullish', stage: 'zone', status: 'active',
    x: { price: 100, index: 0, time: 0 }, a: { price: 200, index: 1, time: 1 },
    b: { price: 155, index: 2, time: 2 }, c: { price: 184.4, index: 3, time: 3 },
    d: { price: 111.4, index: 4, time: 4 }, confirmedD: null, dConfirmedAt: null, lastTouchIndex: 4,
    baseZone: { low: 102.6, high: 120.3 }, zone: { low: 102.6, high: 120.3 }, zoneNarrowed: false,
    bRatio: 0.45, cRatio: 29.4 / 45, dRatioRange: [0.797, 0.974], cInvalidation: 198.83,
    stopReference: 100, confirmedAt: 3, endedAt: null,
  }
}

describe('optional Bat geometry measurements', () => {
  test('calculates stricter ratios from observed points without changing the lecture setup', () => {
    const setup = bat()
    const before = structuredClone(setup)
    const result = getBatGeometryDiagnostics(setup)
    expect(result.passes).toBe(true)
    expect(result.checks[0].value).toBeCloseTo(0.45)
    expect(result.checks[1].value).toBeCloseTo(29.4 / 45)
    expect(result.checks[2].value).toBeCloseTo(73 / 29.4)
    expect(result.checks[3].value).toBeCloseTo(0.886)
    expect(setup).toEqual(before)
  })

  test('missing D stays unavailable instead of using the projected midpoint', () => {
    const result = getBatGeometryDiagnostics({ ...bat(), d: null })
    expect(result.passes).toBeNull()
    expect(result.checks.map((check) => check.passed)).toEqual([true, true, null, null])
  })

  test('flags a broad-template ratio outside the strict profile without invalidating the setup', () => {
    const setup = { ...bat(), b: { price: 146, index: 2, time: 2 } }
    expect(getBatGeometryDiagnostics(setup).checks[0].passed).toBe(false)
    expect(getBatGeometryDiagnostics(setup).passes).toBe(false)
    expect(setup.status).toBe('active')
  })

  test('mirrored bearish prices and uniform scaling have identical ratios', () => {
    const setup = bat()
    const mirrored = { ...setup, direction: 'bearish' as const }
    for (const key of ['x', 'a', 'b', 'c', 'd'] as const) mirrored[key] = { ...setup[key]!, price: (300 - setup[key]!.price) * 100 }
    const checks = getBatGeometryDiagnostics(mirrored).checks
    const expected = getBatGeometryDiagnostics(setup).checks
    for (let index = 0; index < checks.length; index++) expect(checks[index].value).toBeCloseTo(expected[index].value!)
    expect(getBatGeometryDiagnostics(mirrored).passes).toBe(true)
  })

  test('other patterns and degenerate legs cannot pass', () => {
    expect(getBatGeometryDiagnostics({ ...bat(), kind: 'gartley' })).toMatchObject({ applicable: false, checks: [], passes: null })
    expect(getBatGeometryDiagnostics({ ...bat(), b: bat().a }).passes).toBeNull()
    expect(() => getBatGeometryDiagnostics(bat(), -0.01)).toThrow()
  })
})

describe('explainable harmonic ratio fit', () => {
  function geometry(kind: HarmonicSetup['kind'], bRatio: number, cRatio = 0.618): HarmonicSetup {
    const setup = bat()
    const bPrice = 200 - 100 * bRatio
    return {
      ...setup, kind,
      b: { ...setup.b, price: bPrice }, c: { ...setup.c, price: bPrice + (200 - bPrice) * cRatio },
      bRatio, cRatio, d: null, confirmedD: null, dConfirmedAt: null, lastTouchIndex: null,
      dRatioRange: HARMONIC_RATIOS[kind].d,
      baseZone: { low: 200 - 100 * HARMONIC_RATIOS[kind].d[1], high: 200 - 100 * HARMONIC_RATIOS[kind].d[0] },
    }
  }

  test.each([['gartley', 0.618], ['bat', 0.382], ['bat', 0.45], ['bat', 0.5], ['butterfly', 0.786]] as const)(
    '%s gives full credit to its ideal B band (%p)', (kind, ratio) => {
      const result = getHarmonicQuality(geometry(kind, ratio))
      expect(result.score).toBe(100)
      expect(result.phase).toBe('projected')
      expect(result.dConfluenceScore).toBeNull()
    },
  )

  test('uses linear edge distance and a hand-calculated mean, not a rounded pass/fail', () => {
    const halfway = (0.618 + 0.556) / 2
    const result = getHarmonicQuality(geometry('gartley', halfway))
    expect(result.components[0].score).toBeCloseTo(50, 10)
    expect(result.components[1].score).toBe(100)
    expect(result.score).toBeCloseTo(75, 10)
    expect(getHarmonicQuality(geometry('gartley', 0.556)).score).toBeCloseTo(50, 10)
    expect(getHarmonicQuality(geometry('gartley', 0.618, 0.974)).score).toBeCloseTo(50, 10)
    expect(getHarmonicQuality(geometry('gartley', 0.556, 0.974)).score).toBeCloseTo(0, 10)
  })

  test.each([0.382, 0.5, 0.886])('C ideal range has equal credit, including %p', (ratio) => {
    expect(getHarmonicQuality(geometry('gartley', 0.618, ratio)).score).toBe(100)
  })

  test('scores point measurements instead of stale cached ratios', () => {
    const setup = geometry('gartley', 0.618)
    setup.bRatio = 0
    setup.cRatio = 0
    expect(getHarmonicQuality(setup).score).toBe(100)
    setup.b.price = 144.4
    expect(getHarmonicQuality(setup).components[0].score).toBeCloseTo(0)
  })

  test('D contact never supplies a confirmed-pivot score or changes ranking', () => {
    const setup = bat()
    const before = structuredClone(setup)
    const atTouch = getHarmonicQuality(setup)
    expect(atTouch.dConfluenceScore).toBeNull()
    expect(atTouch.components.at(-1)?.value).toBeNull()
    const confirmed = { ...setup, confirmedD: setup.d, dConfirmedAt: 7 }
    const atConfirmation = getHarmonicQuality(confirmed, 7)
    expect(atConfirmation.dConfluenceScore).toBe(100)
    expect(atConfirmation.phase).toBe('observed')
    expect(atConfirmation.score).toBe(atTouch.score)
    expect(getHarmonicQuality(confirmed, 6).dConfluenceScore).toBeNull()
    expect(setup).toEqual(before)
  })

  test('PRZ agreement reports actual projected overlap without inventing Gartley data', () => {
    const setup = bat()
    const result = getHarmonicQuality(setup)
    // BC projection: 184.4 - 29.4 * [1.618, 2.618] = [107.4308, 136.8308].
    // XA zone [102.6,120.3] overlaps by 12.8692 of 17.7.
    expect(result.components[2].value).toBeCloseTo(12.8692 / 17.7, 8)
    expect(result.score).toBe(100)
    expect(getHarmonicQuality(geometry('gartley', 0.618)).components[2]).toMatchObject({ value: null, score: null })
    const disjoint = { ...setup, baseZone: { low: 20, high: 30 } }
    expect(getHarmonicQuality(disjoint).components[2].value).toBe(0)
    expect(getHarmonicQuality(disjoint).score).toBe(result.score)
    expect(getHarmonicQuality({ ...setup, baseZone: { low: 120.3, high: 120.3 } }).components[2].value).toBeNull()
  })

  test('bullish/bearish mirroring and scaling preserve every dimensionless measurement', () => {
    const setup = { ...bat(), confirmedD: bat().d, dConfirmedAt: 7 }
    const mirrored = structuredClone(setup)
    mirrored.direction = 'bearish'
    for (const key of ['x', 'a', 'b', 'c', 'd', 'confirmedD'] as const) {
      mirrored[key] = { ...setup[key]!, price: (300 - setup[key]!.price) * 100 }
    }
    mirrored.baseZone = { low: (300 - setup.baseZone.high) * 100, high: (300 - setup.baseZone.low) * 100 }
    const first = getHarmonicQuality(setup, 7)
    const second = getHarmonicQuality(mirrored, 7)
    expect(first.score).toBeCloseTo(second.score)
    expect(first.dConfluenceScore).toBeCloseTo(second.dConfluenceScore!)
    for (let index = 0; index < first.components.length; index++) {
      expect(first.components[index].value).toBeCloseTo(second.components[index].value!, 9)
    }
    expect(first.durations).toEqual(second.durations)
  })

  test('time diagnostics use closed observation time and only completed legs for balance', () => {
    const setup = geometry('bat', 0.45)
    expect(getHarmonicQuality(setup).ageInLegs).toBeNull()
    expect(getHarmonicQuality(setup, 6).durations).toEqual({ xa: 1, ab: 1, bc: 1, cd: null, elapsedCd: 3 })
    expect(getHarmonicQuality(setup, 6).ageInLegs).toBe(3)
    const touched = { ...setup, d: { index: 9, time: 9, price: 111.4 } }
    expect(getHarmonicQuality(touched, 8).durations.cd).toBeNull()
    expect(getHarmonicQuality(touched, 9).durationAsymmetry).toBe(0)
    const confirmed = { ...touched, confirmedD: touched.d, dConfirmedAt: 12 }
    expect(getHarmonicQuality(confirmed, 12).durationAsymmetry).toBe(500)
    expect(getHarmonicQuality({ ...confirmed, endedAt: 12 }, 20).durations.elapsedCd).toBe(9)
  })

  test('invalid observation times cannot reveal future diagnostics', () => {
    const setup = { ...bat(), confirmedD: bat().d, dConfirmedAt: 7 }
    for (const observedAt of [NaN, Infinity, -1, 1.5, setup.confirmedAt - 1]) {
      expect(() => getHarmonicQuality(setup, observedAt)).toThrow(RangeError)
    }
  })

  test('degenerate legs remain unavailable and cannot create nonfinite scores', () => {
    const setup = { ...bat(), a: bat().x, d: null }
    const result = getHarmonicQuality(setup)
    expect(result.score).toBe(0)
    expect(result.components[0].value).toBeNull()
    expect(result.durationAsymmetry).toBeNull()
    expect(result.ageInLegs).toBeNull()
  })
})

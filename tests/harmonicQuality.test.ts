import { describe, expect, test } from 'bun:test'
import type { HarmonicSetup } from '../src/lib/harmonics'
import { getBatGeometryDiagnostics } from '../src/lib/harmonicQuality'

function bat(): HarmonicSetup {
  return {
    id: 'bat', kind: 'bat', direction: 'bullish', stage: 'zone', status: 'active',
    x: { price: 100, index: 0, time: 0 }, a: { price: 200, index: 1, time: 1 },
    b: { price: 155, index: 2, time: 2 }, c: { price: 184.4, index: 3, time: 3 },
    d: { price: 111.4, index: 4, time: 4 }, lastTouchIndex: 4,
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

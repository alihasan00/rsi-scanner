import type { HarmonicSetup } from './harmonics'

export interface BatGeometryCheck {
  name: 'AB / XA' | 'BC / AB' | 'CD / BC' | 'AD / XA'
  value: number | null
  range: readonly [number, number]
  passed: boolean | null
}

export interface BatGeometryDiagnostics {
  profile: 'Strict Bat research profile'
  applicable: boolean
  checks: BatGeometryCheck[]
  /** null means an observed D point is still missing or the pattern is not a Bat. */
  passes: boolean | null
}

/**
 * Optional measurements of the observed points; never changes lecture templates.
 * AD/XA accepts 0.886 ± the explicit absolute ratio tolerance (default 0.02).
 * D is a confirmed candle's zone touch, not an assumed terminal price pivot.
 */
export function getBatGeometryDiagnostics(setup: HarmonicSetup, dRatioTolerance = 0.02): BatGeometryDiagnostics {
  if (!Number.isFinite(dRatioTolerance) || dRatioTolerance < 0 || dRatioTolerance >= 0.886) {
    throw new RangeError('Bat D ratio tolerance must be finite and between zero and 0.886')
  }
  if (setup.kind !== 'bat') return { profile: 'Strict Bat research profile', applicable: false, checks: [], passes: null }
  const xa = Math.abs(setup.a.price - setup.x.price)
  const ab = Math.abs(setup.a.price - setup.b.price)
  const bc = Math.abs(setup.c.price - setup.b.price)
  const ratio = (numerator: number, denominator: number) => denominator > 0 && Number.isFinite(numerator) && Number.isFinite(denominator) ? numerator / denominator : null
  const check = (name: BatGeometryCheck['name'], value: number | null, range: readonly [number, number]): BatGeometryCheck => ({
    name, value, range, passed: value === null ? null : value >= range[0] - Number.EPSILON * 16 && value <= range[1] + Number.EPSILON * 16,
  })
  const checks = [
    check('AB / XA', ratio(ab, xa), [0.382, 0.5]),
    check('BC / AB', ratio(bc, ab), [0.382, 0.886]),
    check('CD / BC', setup.d ? ratio(Math.abs(setup.c.price - setup.d.price), bc) : null, [1.618, 2.618]),
    check('AD / XA', setup.d ? ratio(Math.abs(setup.a.price - setup.d.price), xa) : null, [0.886 - dRatioTolerance, 0.886 + dRatioTolerance]),
  ]
  return {
    profile: 'Strict Bat research profile', applicable: true, checks,
    passes: checks.some((item) => item.passed === null) ? null : checks.every((item) => item.passed),
  }
}

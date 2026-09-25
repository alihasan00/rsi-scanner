import type { HarmonicSetup } from './harmonics'
import { HARMONIC_BUTTERFLY_BC_RANGE, HARMONIC_C_RANGE, HARMONIC_RATIOS } from './harmonics'

/** Independent diagnostics derived from the documented lecture ideals, not the imported Pine scoring formula. */
export const HARMONIC_IDEAL_RATIOS = {
  gartley: { b: [0.618, 0.618], d: [0.786, 0.786] },
  bat: { b: [0.382, 0.5], d: [0.886, 0.886] },
  butterfly: { b: [0.786, 0.786], d: [1.272, 1.618] },
} as const
const IDEAL_C = [0.382, 0.886] as const

export interface HarmonicQualityComponent {
  name: string
  value: number | null
  score: number | null
  detail: string
}

export interface HarmonicQuality {
  /** B/C ratio fit only. Stable across touch and pivot confirmation; never a probability. */
  score: number
  components: HarmonicQualityComponent[]
  phase: 'projected' | 'observed'
  /** Confirmed D's AD/XA fit; never substitutes the first touch or projected midpoint. */
  dConfluenceScore: number | null
  durations: { xa: number; ab: number; bc: number; cd: number | null; elapsedCd: number | null }
  /** Largest deviation from the mean of the other leg durations, in percent. */
  durationAsymmetry: number | null
  ageInLegs: number | null
}

const finiteRatio = (numerator: number, denominator: number): number | null => {
  const value = numerator / denominator
  return denominator > 0 && Number.isFinite(value) ? value : null
}

/** Full credit throughout an ideal range; linear falloff to zero at each accepted edge. */
function ratioFit(value: number | null, ideal: readonly [number, number], accepted: readonly [number, number]): number | null {
  if (value === null) return null
  const epsilon = Number.EPSILON * 16
  if (value >= ideal[0] - epsilon && value <= ideal[1] + epsilon) return 100
  const distance = value < ideal[0] ? ideal[0] - value : value - ideal[1]
  const allowance = value < ideal[0] ? ideal[0] - accepted[0] : accepted[1] - ideal[1]
  return Math.max(0, Math.min(100, 100 * (1 - distance / allowance)))
}

/**
 * Explainable, price-scale-invariant geometry measurements. Only B and C enter
 * the sortable score, so missing D and missing family-specific BC definitions
 * cannot inflate it. Agreement/confirmed-D fit and time balance remain separate
 * diagnostics. No measurements change scanner eligibility or target references.
 * observedAt, when supplied, is a closed-candle timestamp, never a wall clock.
 */
export function getHarmonicQuality(setup: HarmonicSetup, observedAt?: number): HarmonicQuality {
  if (observedAt !== undefined && (!Number.isSafeInteger(observedAt) || observedAt < setup.confirmedAt)) {
    throw new RangeError('Quality observation time must be a valid timestamp at or after C confirmation')
  }
  const xa = Math.abs(setup.a.price - setup.x.price)
  const ab = Math.abs(setup.a.price - setup.b.price)
  const bc = Math.abs(setup.c.price - setup.b.price)
  const bRatio = finiteRatio(ab, xa)
  const cRatio = finiteRatio(bc, ab)
  const ideal = HARMONIC_IDEAL_RATIOS[setup.kind]
  const bFit = ratioFit(bRatio, ideal.b, HARMONIC_RATIOS[setup.kind].b)
  const cFit = ratioFit(cRatio, IDEAL_C, HARMONIC_C_RANGE)
  const asOf = observedAt === undefined ? null : Math.min(observedAt, setup.endedAt ?? observedAt)
  const confirmedD = setup.confirmedD && setup.dConfirmedAt != null
    && (asOf === null || setup.dConfirmedAt <= asOf) ? setup.confirmedD : null
  const dRatio = confirmedD ? finiteRatio(Math.abs(setup.a.price - confirmedD.price), xa) : null
  const dFit = ratioFit(dRatio, ideal.d, HARMONIC_RATIOS[setup.kind].d)

  // These two BC definitions already exist in our documented profiles. No
  // Gartley BC band is inferred from unavailable imported Pine libraries.
  const bcRange = setup.kind === 'bat' ? [1.618, 2.618] as const
    : setup.kind === 'butterfly' ? HARMONIC_BUTTERFLY_BC_RANGE : null
  let overlap: number | null = null
  if (bcRange && bc > 0) {
    const first = setup.c.price - (setup.c.price - setup.b.price) * bcRange[0]
    const second = setup.c.price - (setup.c.price - setup.b.price) * bcRange[1]
    const width = setup.baseZone.high - setup.baseZone.low
    const common = Math.max(0, Math.min(setup.baseZone.high, Math.max(first, second))
      - Math.max(setup.baseZone.low, Math.min(first, second)))
    overlap = finiteRatio(common, width)
  }

  const durations = {
    xa: setup.a.index - setup.x.index,
    ab: setup.b.index - setup.a.index,
    bc: setup.c.index - setup.b.index,
    cd: confirmedD ? confirmedD.index - setup.c.index : null,
    elapsedCd: null as number | null,
  }
  const interval = finiteRatio(setup.a.time - setup.x.time, durations.xa)
  const observedTouch = setup.d && (asOf === null || (interval !== null && interval > 0
    && Math.max(setup.confirmedAt, setup.d.time + interval - 1) <= asOf)) ? setup.d : null
  if (durations.cd === null && observedTouch) durations.cd = observedTouch.index - setup.c.index
  if (asOf !== null && interval !== null && interval > 0 && asOf >= setup.c.time) {
    durations.elapsedCd = Math.floor((asOf - setup.c.time) / interval)
  }
  // Until a D pivot confirms, CD is unfinished even if price has touched D.
  const legs = [durations.xa, durations.ab, durations.bc, ...(confirmedD && durations.cd !== null ? [durations.cd] : [])]
  const validDurations = legs.every((duration) => Number.isSafeInteger(duration) && duration > 0)
  const sum = legs.reduce((total, duration) => total + duration, 0)
  const durationAsymmetry = validDurations
    ? 100 * Math.max(...legs.map((duration) => Math.abs(duration / ((sum - duration) / (legs.length - 1)) - 1))) : null
  const averageXabcLeg = (durations.xa + durations.ab + durations.bc) / 3
  return {
    score: bFit === null || cFit === null ? 0 : (bFit + cFit) / 2,
    phase: confirmedD ? 'observed' : 'projected',
    dConfluenceScore: dFit,
    components: [
      { name: 'AB / XA', value: bRatio, score: bFit,
        detail: `Ideal ${ideal.b[0] === ideal.b[1] ? ideal.b[0] : ideal.b.join('–')}; half of the ratio-fit score.` },
      { name: 'BC / AB', value: cRatio, score: cFit,
        detail: 'Ideal 0.382–0.886; half of the ratio-fit score. All values inside the ideal band receive full credit.' },
      { name: 'BC / XA zone agreement', value: overlap, score: overlap === null ? null : overlap * 100,
        detail: bcRange ? `Fraction of the original XA zone overlapped by the ${bcRange.join('–')} BC projection. Separate ${setup.kind === 'bat' ? 'strict Bat research' : 'lecture Butterfly'} context; not part of the score.`
          : 'Unavailable: no Gartley BC template is defined in our supplied sources. Not part of the score.' },
      { name: 'Confirmed AD / XA', value: dRatio, score: dFit,
        detail: confirmedD ? 'Uses the separately confirmed D pivot. Not part of the ratio-fit score and does not move first-touch targets.'
          : 'Awaiting a confirmed D pivot. A zone touch alone cannot supply this measurement.' },
    ],
    durations, durationAsymmetry,
    ageInLegs: durations.elapsedCd === null || !validDurations ? null : durations.elapsedCd / averageXabcLeg,
  }
}

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

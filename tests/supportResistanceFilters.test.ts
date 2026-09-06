import { describe, expect, test } from 'bun:test'
import {
  hasActiveFilters,
  levelDistancePercent,
  matchesFilters,
  nearestDistancePercent,
  sortRows,
  type SupportResistanceRow,
} from '../src/lib/supportResistanceFilters'
import { DEFAULT_SUPPORT_RESISTANCE_FILTERS, restoreSupportResistanceFilters } from '../src/store/scannerStore'
import { EMPTY_SUPPORT_RESISTANCE, type SupportResistanceSnapshot } from '../src/store/supportResistanceStore'
import type { SupportResistanceFilters } from '../src/types'

const level = (price: number, touches = 1) => ({ price, touches })

function snapshot(overrides: Partial<SupportResistanceSnapshot>): SupportResistanceSnapshot {
  return {
    trend: 'sideways', support: level(99), resistance: level(101), pendingBreaks: [], closedBarCount: 50,
    price: 100, hasData: true, ...overrides,
  }
}

const filters = (overrides: Partial<SupportResistanceFilters>): SupportResistanceFilters => (
  { ...DEFAULT_SUPPORT_RESISTANCE_FILTERS, ...overrides }
)

describe('distances', () => {
  test('measures unsigned percent distance from the live price', () => {
    expect(levelDistancePercent(level(99), 100)).toBeCloseTo(1)
    expect(levelDistancePercent(level(102), 100)).toBeCloseTo(2)
    expect(levelDistancePercent(null, 100)).toBeNull()
    expect(levelDistancePercent(level(99), 0)).toBeNull()
  })

  test('nearest distance picks the closer side and tolerates a missing side', () => {
    expect(nearestDistancePercent(snapshot({ support: level(97), resistance: level(101) }))).toBeCloseTo(1)
    expect(nearestDistancePercent(snapshot({ support: null, resistance: level(103) }))).toBeCloseTo(3)
    expect(nearestDistancePercent(snapshot({ support: null, resistance: null }))).toBeNull()
  })

  test('a crossed level does not replace the distance to the nearest eligible level', () => {
    expect(nearestDistancePercent(snapshot({
      support: level(95), resistance: level(110),
      pendingBreaks: [{ kind: 'resistance', ...level(99.9) }],
    }))).toBeCloseTo(5)
    expect(nearestDistancePercent(snapshot({
      support: null, resistance: null,
      pendingBreaks: [{ kind: 'resistance', ...level(99.9) }],
    }))).toBeNull()
  })
})

describe('matchesFilters', () => {
  test('default filters are inactive and keep every pair, including loading ones', () => {
    expect(hasActiveFilters(DEFAULT_SUPPORT_RESISTANCE_FILTERS)).toBe(false)
    expect(matchesFilters(EMPTY_SUPPORT_RESISTANCE, DEFAULT_SUPPORT_RESISTANCE_FILTERS)).toBe(true)
  })

  test('any active filter excludes pairs that have not loaded', () => {
    for (const active of [
      filters({ side: 'support' }), filters({ maxDistancePercent: 5 }), filters({ trend: 'uptrend' }),
      filters({ minTouches: 2 }), filters({ breakFilter: 'breakouts' }),
      filters({ breakFilter: 'breakdowns' }), filters({ breakFilter: 'either' }),
    ]) {
      expect(hasActiveFilters(active)).toBe(true)
      expect(matchesFilters(EMPTY_SUPPORT_RESISTANCE, active)).toBe(false)
    }
  })

  test('distance applies to the chosen side', () => {
    const near = snapshot({ support: level(99.8), resistance: level(103) })
    expect(matchesFilters(near, filters({ maxDistancePercent: 0.5 }))).toBe(true)
    expect(matchesFilters(near, filters({ maxDistancePercent: 0.5, side: 'support' }))).toBe(true)
    expect(matchesFilters(near, filters({ maxDistancePercent: 0.5, side: 'resistance' }))).toBe(false)
    expect(matchesFilters(near, filters({ maxDistancePercent: 0.1 }))).toBe(false)
  })

  test('a chosen side with no level never matches level conditions', () => {
    const noResistance = snapshot({ resistance: null })
    expect(matchesFilters(noResistance, filters({ side: 'resistance' }))).toBe(false)
    expect(matchesFilters(noResistance, filters({ side: 'support' }))).toBe(true)
  })

  test('touches and distance must hold on the same nearest level', () => {
    const mixed = snapshot({ support: level(99.9, 1), resistance: level(101, 3) })
    expect(matchesFilters(mixed, filters({ minTouches: 3 }))).toBe(true)
    expect(matchesFilters(mixed, filters({ minTouches: 3, maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(mixed, filters({ breakFilter: 'either' }))).toBe(false)
  })

  test('pending mode applies side, touches, and distance to the same crossed zone', () => {
    const mixed = snapshot({
      support: level(99.95, 5), resistance: level(101, 5),
      pendingBreaks: [
        { kind: 'resistance', ...level(99.9, 1) },
        { kind: 'support', ...level(102, 3) },
      ],
    })
    const pending = (overrides: Partial<SupportResistanceFilters> = {}) => filters({
      breakFilter: 'either', ...overrides,
    })
    expect(matchesFilters(mixed, pending())).toBe(true)
    expect(matchesFilters(mixed, pending({ minTouches: 3 }))).toBe(true)
    expect(matchesFilters(mixed, pending({ minTouches: 5 }))).toBe(false)
    expect(matchesFilters(mixed, pending({ maxDistancePercent: 0.5 }))).toBe(true)
    expect(matchesFilters(mixed, pending({ minTouches: 3, maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(mixed, pending({ side: 'resistance', maxDistancePercent: 0.5 }))).toBe(true)
    expect(matchesFilters(mixed, pending({ side: 'support', maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(mixed, pending({ trend: 'uptrend' }))).toBe(false)
  })

  test('a nearby, well-tested support breakdown cannot pass the breakout filter', () => {
    const breakdown = snapshot({
      support: level(99.95, 5), resistance: level(100.2, 5),
      pendingBreaks: [{ kind: 'support', ...level(100.1, 5) }],
    })
    const conditions = { maxDistancePercent: 0.5, minTouches: 3 }
    expect(matchesFilters(breakdown, filters({ ...conditions, breakFilter: 'breakouts' }))).toBe(false)
    expect(matchesFilters(breakdown, filters({ ...conditions, breakFilter: 'breakdowns' }))).toBe(true)
    expect(matchesFilters(breakdown, filters({ ...conditions, breakFilter: 'either' }))).toBe(true)
  })

  test('a nearby, well-tested resistance breakout cannot pass the breakdown filter', () => {
    const breakout = snapshot({
      support: level(99.95, 5), resistance: level(100.2, 5),
      pendingBreaks: [{ kind: 'resistance', ...level(99.9, 5) }],
    })
    const conditions = { maxDistancePercent: 0.5, minTouches: 3 }
    expect(matchesFilters(breakout, filters({ ...conditions, breakFilter: 'breakdowns' }))).toBe(false)
    expect(matchesFilters(breakout, filters({ ...conditions, breakFilter: 'breakouts' }))).toBe(true)
    expect(matchesFilters(breakout, filters({ ...conditions, breakFilter: 'either' }))).toBe(true)
  })

  test('direction, side, distance, touches, and trend must agree for a crossed zone', () => {
    const mixed = snapshot({
      trend: 'uptrend',
      support: level(99.95, 5), resistance: level(100.2, 5),
      pendingBreaks: [
        { kind: 'resistance', ...level(99.9, 1) },
        { kind: 'support', ...level(102, 3) },
      ],
    })
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakouts', maxDistancePercent: 0.5 }))).toBe(true)
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakouts', minTouches: 3 }))).toBe(false)
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakouts', side: 'support' }))).toBe(false)
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakouts', trend: 'downtrend' }))).toBe(false)
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakdowns', minTouches: 3 }))).toBe(true)
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakdowns', maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakdowns', side: 'resistance' }))).toBe(false)
    expect(matchesFilters(mixed, filters({ breakFilter: 'breakdowns', trend: 'downtrend' }))).toBe(false)
    expect(matchesFilters(mixed, filters({ breakFilter: 'either', minTouches: 3, maxDistancePercent: 0.5 }))).toBe(false)
  })

  test('pending breakouts remain filterable when no next resistance exists', () => {
    const crossed = snapshot({
      resistance: null,
      pendingBreaks: [{ kind: 'resistance', ...level(99.9, 2) }],
    })
    expect(matchesFilters(crossed, filters({ side: 'resistance' }))).toBe(false)
    expect(matchesFilters(crossed, filters({ side: 'resistance', breakFilter: 'breakouts' }))).toBe(true)
    expect(matchesFilters(crossed, filters({ side: 'support', breakFilter: 'breakouts' }))).toBe(false)
    expect(matchesFilters(crossed, filters({ breakFilter: 'breakdowns' }))).toBe(false)
    expect(matchesFilters(crossed, filters({ breakFilter: 'either' }))).toBe(true)
    expect(matchesFilters(crossed, filters({ maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(crossed, filters({ maxDistancePercent: 0.5, breakFilter: 'breakouts' }))).toBe(true)
  })

  test('pending breakdowns remain filterable when no next support exists', () => {
    const crossed = snapshot({
      support: null,
      pendingBreaks: [{ kind: 'support', ...level(100.1, 2) }],
    })
    expect(matchesFilters(crossed, filters({ side: 'support' }))).toBe(false)
    expect(matchesFilters(crossed, filters({ side: 'support', breakFilter: 'breakdowns' }))).toBe(true)
    expect(matchesFilters(crossed, filters({ side: 'resistance', breakFilter: 'breakdowns' }))).toBe(false)
    expect(matchesFilters(crossed, filters({ breakFilter: 'breakouts' }))).toBe(false)
    expect(matchesFilters(crossed, filters({ breakFilter: 'either' }))).toBe(true)
    expect(matchesFilters(crossed, filters({ maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(crossed, filters({ maxDistancePercent: 0.5, breakFilter: 'breakdowns' }))).toBe(true)
  })

  test('trend filters combine with level filters', () => {
    const up = snapshot({ trend: 'uptrend' })
    expect(matchesFilters(up, filters({ trend: 'uptrend' }))).toBe(true)
    expect(matchesFilters(up, filters({ trend: 'downtrend' }))).toBe(false)
    expect(matchesFilters(up, filters({ trend: 'uptrend', maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(up, filters({ trend: 'uptrend', maxDistancePercent: 2 }))).toBe(true)
  })
})

describe('sortRows', () => {
  const rows: SupportResistanceRow[] = [
    { symbol: 'AAA', snapshot: snapshot({ support: level(95), resistance: level(101) }) },
    { symbol: 'BBB', snapshot: EMPTY_SUPPORT_RESISTANCE },
    { symbol: 'CCC', snapshot: snapshot({ support: level(99.5), resistance: level(110) }) },
    { symbol: 'DDD', snapshot: snapshot({ support: null, resistance: level(100.2) }) },
  ]
  const order = (sorted: SupportResistanceRow[]) => sorted.map((row) => row.symbol)

  test('list order keeps the configured sequence and returns a copy', () => {
    const sorted = sortRows(rows, 'symbol')
    expect(order(sorted)).toEqual(['AAA', 'BBB', 'CCC', 'DDD'])
    expect(sorted).not.toBe(rows)
  })

  test('distance sorts ascend with missing values last and stable ties', () => {
    expect(order(sortRows(rows, 'nearest'))).toEqual(['DDD', 'CCC', 'AAA', 'BBB'])
    expect(order(sortRows(rows, 'support'))).toEqual(['CCC', 'AAA', 'BBB', 'DDD'])
    expect(order(sortRows(rows, 'resistance'))).toEqual(['DDD', 'AAA', 'CCC', 'BBB'])
  })

  test('ranking follows main level columns even when a pending breakout is closer', () => {
    const pendingRows: SupportResistanceRow[] = [
      { symbol: 'CROSSED', snapshot: snapshot({
        support: level(95), resistance: level(110),
        pendingBreaks: [{ kind: 'resistance', ...level(99.99) }],
      }) },
      { symbol: 'NEAREST', snapshot: snapshot({}) },
      { symbol: 'NO_NEXT', snapshot: snapshot({
        support: null, resistance: null,
        pendingBreaks: [{ kind: 'resistance', ...level(99.999) }],
      }) },
    ]
    for (const sort of ['nearest', 'support', 'resistance'] as const) {
      expect(order(sortRows(pendingRows, sort))).toEqual(['NEAREST', 'CROSSED', 'NO_NEXT'])
    }
  })
})

describe('saved support/resistance filters', () => {
  test('restores defaults when no saved break filter is enabled', () => {
    expect(restoreSupportResistanceFilters({ testingOnly: false })).toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
    expect(restoreSupportResistanceFilters({ pendingBreakoutsOnly: false })).toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
    expect(restoreSupportResistanceFilters()).toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
  })

  test('migrates both legacy filters according to the saved side and retains other choices', () => {
    for (const legacyKey of ['testingOnly', 'pendingBreakoutsOnly'] as const) {
      for (const [side, breakFilter] of [
        ['support', 'breakdowns'], ['resistance', 'breakouts'], ['any', 'either'],
      ] as const) {
        const restored = restoreSupportResistanceFilters({
          [legacyKey]: true, side, minTouches: 3, maxDistancePercent: 0.5, trend: 'uptrend',
        })
        expect(restored).toEqual(filters({ side, breakFilter, minTouches: 3, maxDistancePercent: 0.5, trend: 'uptrend' }))
        expect(restored).not.toHaveProperty('testingOnly')
        expect(restored).not.toHaveProperty('pendingBreakoutsOnly')
      }
      expect(restoreSupportResistanceFilters({ [legacyKey]: true })).toEqual(filters({ breakFilter: 'either' }))
    }
  })

  test('pendingBreakoutsOnly takes priority over the earlier testingOnly preference', () => {
    const restored = restoreSupportResistanceFilters({ testingOnly: true, pendingBreakoutsOnly: false })
    expect(restored).toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
    expect(restored).not.toHaveProperty('testingOnly')
    expect(restored).not.toHaveProperty('pendingBreakoutsOnly')
    expect(restoreSupportResistanceFilters({ testingOnly: false, pendingBreakoutsOnly: true, side: 'support' }))
      .toEqual(filters({ breakFilter: 'breakdowns', side: 'support' }))
  })

  test('an explicit valid direction takes priority over both legacy preferences', () => {
    for (const breakFilter of ['all', 'breakouts', 'breakdowns', 'either'] as const) {
      const restored = restoreSupportResistanceFilters({
        breakFilter, testingOnly: true, pendingBreakoutsOnly: true, side: 'support',
      })
      expect(restored).toEqual(filters({ breakFilter, side: 'support' }))
      expect(restored).not.toHaveProperty('testingOnly')
      expect(restored).not.toHaveProperty('pendingBreakoutsOnly')
    }
  })

  test('an invalid saved direction falls back to a legacy preference or the default', () => {
    const breakFilter = 'invalid' as SupportResistanceFilters['breakFilter']
    expect(restoreSupportResistanceFilters({ breakFilter })).toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
    expect(restoreSupportResistanceFilters({ breakFilter, testingOnly: true, side: 'support' }))
      .toEqual(filters({ breakFilter: 'breakdowns', side: 'support' }))
    expect(restoreSupportResistanceFilters({ breakFilter, pendingBreakoutsOnly: true, side: 'resistance' }))
      .toEqual(filters({ breakFilter: 'breakouts', side: 'resistance' }))
    expect(restoreSupportResistanceFilters({ breakFilter, testingOnly: true, pendingBreakoutsOnly: false }))
      .toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
  })
})

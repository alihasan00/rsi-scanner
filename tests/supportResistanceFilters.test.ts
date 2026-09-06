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
    trend: 'sideways', support: level(99), resistance: level(101), pendingBreakouts: [], closedBarCount: 50,
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
      pendingBreakouts: [{ kind: 'resistance', ...level(99.9) }],
    }))).toBeCloseTo(5)
    expect(nearestDistancePercent(snapshot({
      support: null, resistance: null,
      pendingBreakouts: [{ kind: 'resistance', ...level(99.9) }],
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
      filters({ minTouches: 2 }), filters({ pendingBreakoutsOnly: true }),
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
    expect(matchesFilters(mixed, filters({ pendingBreakoutsOnly: true }))).toBe(false)
  })

  test('pending mode applies side, touches, and distance to the same crossed zone', () => {
    const mixed = snapshot({
      support: level(99.95, 5), resistance: level(101, 5),
      pendingBreakouts: [
        { kind: 'resistance', ...level(99.9, 1) },
        { kind: 'support', ...level(102, 3) },
      ],
    })
    const pending = (overrides: Partial<SupportResistanceFilters> = {}) => filters({
      pendingBreakoutsOnly: true, ...overrides,
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

  test('pending breakouts remain filterable when no next resistance exists', () => {
    const crossed = snapshot({
      resistance: null,
      pendingBreakouts: [{ kind: 'resistance', ...level(99.9, 2) }],
    })
    expect(matchesFilters(crossed, filters({ side: 'resistance' }))).toBe(false)
    expect(matchesFilters(crossed, filters({ side: 'resistance', pendingBreakoutsOnly: true }))).toBe(true)
    expect(matchesFilters(crossed, filters({ side: 'support', pendingBreakoutsOnly: true }))).toBe(false)
    expect(matchesFilters(crossed, filters({ maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(crossed, filters({ maxDistancePercent: 0.5, pendingBreakoutsOnly: true }))).toBe(true)
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
        pendingBreakouts: [{ kind: 'resistance', ...level(99.99) }],
      }) },
      { symbol: 'NEAREST', snapshot: snapshot({}) },
      { symbol: 'NO_NEXT', snapshot: snapshot({
        support: null, resistance: null,
        pendingBreakouts: [{ kind: 'resistance', ...level(99.999) }],
      }) },
    ]
    for (const sort of ['nearest', 'support', 'resistance'] as const) {
      expect(order(sortRows(pendingRows, sort))).toEqual(['NEAREST', 'CROSSED', 'NO_NEXT'])
    }
  })
})

describe('saved support/resistance filters', () => {
  test('migrates Testing only while retaining other saved filter choices', () => {
    expect(restoreSupportResistanceFilters({ testingOnly: true, side: 'resistance', minTouches: 3 }))
      .toEqual(filters({ pendingBreakoutsOnly: true, side: 'resistance', minTouches: 3 }))
    expect(restoreSupportResistanceFilters({ testingOnly: false })).toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
    expect(restoreSupportResistanceFilters()).toEqual(DEFAULT_SUPPORT_RESISTANCE_FILTERS)
  })

  test('the new preference takes priority over the legacy value and drops the old key', () => {
    const restored = restoreSupportResistanceFilters({ testingOnly: true, pendingBreakoutsOnly: false })
    expect(restored.pendingBreakoutsOnly).toBe(false)
    expect(restored).not.toHaveProperty('testingOnly')
  })
})

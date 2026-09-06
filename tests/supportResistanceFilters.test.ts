import { describe, expect, test } from 'bun:test'
import {
  hasActiveFilters,
  levelDistancePercent,
  matchesFilters,
  nearestDistancePercent,
  sortRows,
  type SupportResistanceRow,
} from '../src/lib/supportResistanceFilters'
import { DEFAULT_SUPPORT_RESISTANCE_FILTERS } from '../src/store/scannerStore'
import { EMPTY_SUPPORT_RESISTANCE, type SupportResistanceSnapshot } from '../src/store/supportResistanceStore'
import type { SupportResistanceFilters } from '../src/types'

const level = (price: number, touches = 1, testing = false) => ({ price, touches, testing })

function snapshot(overrides: Partial<SupportResistanceSnapshot>): SupportResistanceSnapshot {
  return {
    trend: 'sideways', support: level(99), resistance: level(101), closedBarCount: 50,
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
})

describe('matchesFilters', () => {
  test('default filters are inactive and keep every pair, including loading ones', () => {
    expect(hasActiveFilters(DEFAULT_SUPPORT_RESISTANCE_FILTERS)).toBe(false)
    expect(matchesFilters(EMPTY_SUPPORT_RESISTANCE, DEFAULT_SUPPORT_RESISTANCE_FILTERS)).toBe(true)
  })

  test('any active filter excludes pairs that have not loaded', () => {
    for (const active of [
      filters({ side: 'support' }), filters({ maxDistancePercent: 5 }), filters({ trend: 'uptrend' }),
      filters({ minTouches: 2 }), filters({ testingOnly: true }),
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

  test('touches and testing must hold on the same level as the distance', () => {
    const mixed = snapshot({ support: level(99.9, 1, true), resistance: level(101, 3, false) })
    expect(matchesFilters(mixed, filters({ minTouches: 3 }))).toBe(true)
    expect(matchesFilters(mixed, filters({ testingOnly: true }))).toBe(true)
    expect(matchesFilters(mixed, filters({ minTouches: 3, testingOnly: true }))).toBe(false)
    expect(matchesFilters(mixed, filters({ minTouches: 3, maxDistancePercent: 0.5 }))).toBe(false)
    expect(matchesFilters(mixed, filters({ testingOnly: true, maxDistancePercent: 0.5 }))).toBe(true)
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
})

import type { SupportResistanceSnapshot } from '../store/supportResistanceStore'
import type { SupportResistanceFilters, SupportResistanceSort } from '../types'
import type { SupportResistanceLevel } from './supportResistance'

export interface SupportResistanceRow {
  symbol: string
  snapshot: SupportResistanceSnapshot
}

/** Unsigned percent distance between a level and the live price, or null. */
export function levelDistancePercent(level: SupportResistanceLevel | null, price: number): number | null {
  if (!level || !Number.isFinite(price) || price <= 0) return null
  return Math.abs((level.price - price) / price) * 100
}

/** Distance to the nearer support/resistance; pending breaks are separate. */
export function nearestDistancePercent(snapshot: SupportResistanceSnapshot): number | null {
  const support = levelDistancePercent(snapshot.support, snapshot.price)
  const resistance = levelDistancePercent(snapshot.resistance, snapshot.price)
  if (support === null) return resistance
  if (resistance === null) return support
  return Math.min(support, resistance)
}

export function hasActiveFilters(filters: SupportResistanceFilters): boolean {
  return filters.side !== 'any'
    || filters.maxDistancePercent !== null
    || filters.trend !== 'any'
    || filters.minTouches > 1
    || filters.breakFilter !== 'all'
}

function levelsForFilters(
  snapshot: SupportResistanceSnapshot,
  { side, breakFilter }: SupportResistanceFilters,
): readonly SupportResistanceLevel[] {
  if (breakFilter !== 'all') {
    return snapshot.pendingBreaks.filter((level) => (
      (side === 'any' || level.kind === side)
      && (breakFilter === 'either'
        || (breakFilter === 'breakouts' && level.kind === 'resistance')
        || (breakFilter === 'breakdowns' && level.kind === 'support'))
    ))
  }
  const levels = side === 'support' ? [snapshot.support]
    : side === 'resistance' ? [snapshot.resistance]
      : [snapshot.support, snapshot.resistance]
  return levels.filter((level): level is SupportResistanceLevel => level !== null)
}

/**
 * A pair passes when at least one level on the chosen side satisfies every
 * level condition together. Pending-break modes evaluate the matching crossed zones
 * instead of the nearest support/resistance. Loading pairs pass only when no
 * filter is active.
 */
export function matchesFilters(snapshot: SupportResistanceSnapshot, filters: SupportResistanceFilters): boolean {
  if (!hasActiveFilters(filters)) return true
  if (!snapshot.hasData) return false
  if (filters.trend !== 'any' && snapshot.trend !== filters.trend) return false

  const needsLevel = filters.side !== 'any'
    || filters.maxDistancePercent !== null
    || filters.minTouches > 1
    || filters.breakFilter !== 'all'
  if (!needsLevel) return true

  return levelsForFilters(snapshot, filters).some((level) => {
    if (level.touches < filters.minTouches) return false
    if (filters.maxDistancePercent !== null) {
      const distance = levelDistancePercent(level, snapshot.price)
      if (distance === null || distance > filters.maxDistancePercent) return false
    }
    return true
  })
}

function sortDistance(row: SupportResistanceRow, sort: SupportResistanceSort): number | null {
  if (!row.snapshot.hasData) return null
  if (sort === 'support') return levelDistancePercent(row.snapshot.support, row.snapshot.price)
  if (sort === 'resistance') return levelDistancePercent(row.snapshot.resistance, row.snapshot.price)
  return nearestDistancePercent(row.snapshot)
}

/** Stable sort. Symbol order is the configured list order; distances ascend with missing values last. */
export function sortRows(rows: readonly SupportResistanceRow[], sort: SupportResistanceSort): SupportResistanceRow[] {
  if (sort === 'symbol') return [...rows]
  return rows
    .map((row, index) => ({ row, index, distance: sortDistance(row, sort) }))
    .sort((a, b) => {
      if (a.distance === null && b.distance === null) return a.index - b.index
      if (a.distance === null) return 1
      if (b.distance === null) return -1
      return a.distance - b.distance || a.index - b.index
    })
    .map((entry) => entry.row)
}

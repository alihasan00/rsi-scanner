import type { WatchlistRow, WatchlistSource, WatchlistStatus } from './watchlist'
import { sortWatchlistRows } from './watchlist'

export interface WatchlistInstrumentFilters {
  search?: string
  starredOnly?: boolean
  starredSymbols?: ReadonlySet<string>
  direction?: 'all' | WatchlistRow['direction']
  source?: 'all' | WatchlistSource
  status?: 'all' | WatchlistStatus
}

export interface WatchlistInstrument {
  id: string
  symbol: WatchlistRow['symbol']
  market: WatchlistRow['market']
  timeframe: WatchlistRow['timeframe']
  /** A single ranked setup supplies all summary geometry and its status. */
  lead: WatchlistRow
  /** Ranked setups matching the current setup filters. */
  setups: WatchlistRow[]
  /** Every underlying setup, including those hidden by setup filters. */
  allSetups: WatchlistRow[]
  direction: WatchlistRow['direction'] | 'mixed'
  sources: WatchlistSource[]
  /** This is the lead setup's status, not an aggregate trade confirmation. */
  status: WatchlistStatus
  /** Kept visible even when a filter hides an opposing setup. */
  hasMixedDirections: boolean
}

const SOURCE_ORDER: WatchlistSource[] = ['fib', 'harmonic', 'retest', 'trend', 'strategy']
const normalizeSearch = (value: string) => value.toUpperCase().replace(/[\s/_-]/g, '')
const validTimestamp = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0

/** A timer must age out a cached quote even when the feed stops emitting. */
export function getWatchlistDisplayStatus(row: WatchlistRow, now: number): WatchlistStatus {
  return row.status === 'delayed' || !validTimestamp(now) || !validTimestamp(row.updatedAt)
    || row.updatedAt > now + 5_000 || now - row.updatedAt > (row.reference?.maxAgeMs ?? 60_000) ? 'delayed' : row.status
}

function matchesSetup(row: WatchlistRow, filters: WatchlistInstrumentFilters): boolean {
  return (!filters.direction || filters.direction === 'all' || row.direction === filters.direction)
    && (!filters.source || filters.source === 'all' || row.source === filters.source)
    && (!filters.status || filters.status === 'all' || row.status === filters.status)
}

function receiptOrder(row: WatchlistRow): number {
  return validTimestamp(row.updatedAt) ? row.updatedAt : -1
}

/**
 * One instrument per market and timeframe. Filter setups before choosing the
 * lead so its direction, status, zone, stop and target always describe one match.
 * Other setups remain available for inspection without manufacturing confluence.
 */
export function groupWatchlistInstruments(
  rows: readonly WatchlistRow[],
  now: number,
  filters: WatchlistInstrumentFilters = {},
): WatchlistInstrument[] {
  const query = normalizeSearch(filters.search ?? '')
  const groups = new Map<string, Map<string, WatchlistRow>>()
  const currentRows = rows.map((row) => {
    const status = getWatchlistDisplayStatus(row, now)
    return status === row.status ? row : { ...row, status }
  })

  for (const row of sortWatchlistRows(currentRows)) {
    if ((query && !normalizeSearch(row.symbol).includes(query))
      || (filters.starredOnly && !filters.starredSymbols?.has(row.symbol))) continue
    const id = `${row.market}:${row.timeframe}:${row.symbol}`
    let setups = groups.get(id)
    if (!setups) {
      setups = new Map()
      groups.set(id, setups)
    }
    const previous = setups.get(row.id)
    // Repeated receipts for the same setup are not separate observations. A
    // newer blocked snapshot must also replace an older confirmed snapshot.
    if (!previous || receiptOrder(row) > receiptOrder(previous)
      || (receiptOrder(row) === receiptOrder(previous) && (row.asOf ?? -1) > (previous.asOf ?? -1))) setups.set(row.id, row)
  }

  const byLead = new Map<WatchlistRow, WatchlistInstrument>()
  for (const [id, groupedSetups] of groups) {
    const allSetups = sortWatchlistRows([...groupedSetups.values()])
    const setups = allSetups.filter((row) => matchesSetup(row, filters))
    const lead = setups[0]
    if (!lead) continue
    const directions = new Set(setups.map((row) => row.direction))
    byLead.set(lead, {
      id, symbol: lead.symbol, market: lead.market, timeframe: lead.timeframe,
      lead, setups, allSetups, status: lead.status,
      direction: directions.size > 1 ? 'mixed' : lead.direction,
      sources: SOURCE_ORDER.filter((source) => setups.some((row) => row.source === source)),
      hasMixedDirections: new Set(allSetups.map((row) => row.direction)).size > 1,
    })
  }
  // Identity also breaks a full ranking tie across markets/timeframes, even if
  // callers provide setup IDs that are only unique inside their instrument.
  const leads = [...byLead.values()].sort((a, b) => a.id.localeCompare(b.id)).map((instrument) => instrument.lead)
  return sortWatchlistRows(leads).map((lead) => byLead.get(lead)!)
}

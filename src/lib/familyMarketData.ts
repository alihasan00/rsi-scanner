import type { CoinFamily, CoinFamilyMember } from './coinFamilies'
import { FAMILY_SYMBOLS } from './coinFamilies'
import { MARKETS } from './markets'

export const FAMILY_POLL_INTERVAL_MS = 30_000
export const FAMILY_STALE_AFTER_MS = 90_000
export const FAMILY_MAX_BACKOFF_MS = 120_000
export const FAMILY_REQUEST_TIMEOUT_MS = 15_000
const MAX_FUTURE_CLOCK_SKEW_MS = 5_000

export interface FamilyMarketQuote {
  symbol: string
  price: number
  changePercent: number
  quoteVolume: number
  high: number
  low: number
  closeTime: number
}

export interface FamilyMemberRow extends CoinFamilyMember {
  quote: FamilyMarketQuote | null
  isStale: boolean
  leaderGap: number | null
  anchorGap: number | null
  isGapWatch: boolean
}

export interface FamilySummary {
  family: CoinFamily
  members: FamilyMemberRow[]
  leader: FamilyMemberRow | null
  anchor: FamilyMemberRow | null
  averageChange: number | null
  positiveCount: number
  availableCount: number
  totalCount: number
  totalQuoteVolume: number
  gapWatchCount: number
}

export interface FamilyMover {
  quote: FamilyMarketQuote
  families: CoinFamily[]
}

/** Rank the whole universe once per coin, regardless of overlapping families. */
export function getFamilyBestMovers(summaries: readonly FamilySummary[]): FamilyMover[] {
  const movers = new Map<string, FamilyMover>()
  for (const summary of summaries) {
    for (const { quote, isStale } of summary.members) {
      if (!quote || isStale || quote.quoteVolume <= 0 || quote.changePercent <= 0) continue
      const existing = movers.get(quote.symbol)
      if (existing) existing.families.push(summary.family)
      else movers.set(quote.symbol, { quote, families: [summary.family] })
    }
  }
  return [...movers.values()]
    .sort((a, b) => b.quote.changePercent - a.quote.changePercent || a.quote.symbol.localeCompare(b.quote.symbol))
    .slice(0, 5)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** Bad or missing members are omitted without discarding the other tickers. */
export function parseFamilyMarketData(
  raw: unknown,
  requestedSymbols: readonly string[] = FAMILY_SYMBOLS,
): ReadonlyMap<string, FamilyMarketQuote> {
  if (!Array.isArray(raw)) throw new Error('Invalid Binance 24h ticker response')
  const requested = new Set(requestedSymbols)
  const quotes = new Map<string, FamilyMarketQuote>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || typeof entry.symbol !== 'string' || !requested.has(entry.symbol)) continue
    const price = finiteNumber(entry.lastPrice)
    const changePercent = finiteNumber(entry.priceChangePercent)
    const quoteVolume = finiteNumber(entry.quoteVolume)
    const high = finiteNumber(entry.highPrice)
    const low = finiteNumber(entry.lowPrice)
    const closeTime = finiteNumber(entry.closeTime)
    if (price === null || price <= 0 || changePercent === null || changePercent < -100
      || quoteVolume === null || quoteVolume < 0 || high === null || low === null
      || low <= 0 || high < low || price > high || price < low
      || closeTime === null || closeTime <= 0 || !Number.isSafeInteger(closeTime)) continue
    const previous = quotes.get(entry.symbol)
    if (previous && previous.closeTime >= closeTime) continue
    quotes.set(entry.symbol, { symbol: entry.symbol, price, changePercent, quoteVolume, high, low, closeTime })
  }
  return quotes
}

export async function fetchFamilyMarketData(
  symbols: readonly string[] = FAMILY_SYMBOLS,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ReadonlyMap<string, FamilyMarketQuote>> {
  signal?.throwIfAborted()
  const requestedSymbols = [...new Set(symbols)]
  if (requestedSymbols.length === 0) return new Map()
  const endpoint = `${MARKETS.spot.restBase}/ticker/24hr`
  const params = new URLSearchParams({ symbols: JSON.stringify(requestedSymbols) })
  let response = await fetcher(`${endpoint}?${params}`, { signal })
  signal?.throwIfAborted()
  if (!response.ok) {
    // One delisted symbol makes Binance reject the entire symbols batch. Only
    // that specific error allows a bulk fallback; rate-limit and network errors
    // must back off instead. The parser still limits results to our watchlist.
    let invalidSymbol = false
    try {
      const failure: unknown = await response.json()
      invalidSymbol = !!failure && typeof failure === 'object' && 'code' in failure && failure.code === -1121
    } catch { /* Preserve the original HTTP error when its body is not JSON. */ }
    signal?.throwIfAborted()
    if (invalidSymbol) response = await fetcher(endpoint, { signal })
    signal?.throwIfAborted()
    if (!response.ok) throw new Error(`Binance 24h prices unavailable (HTTP ${response.status})`)
  }
  const raw: unknown = await response.json()
  signal?.throwIfAborted()
  const quotes = parseFamilyMarketData(raw, requestedSymbols)
  if (quotes.size === 0) throw new Error('No usable Binance 24h prices returned')
  return quotes
}

export function isFamilyQuoteStale(quote: FamilyMarketQuote, now: number): boolean {
  return !Number.isFinite(now) || !Number.isFinite(quote.closeTime)
    || now - quote.closeTime >= FAMILY_STALE_AFTER_MS
    || quote.closeTime - now > MAX_FUTURE_CLOCK_SKEW_MS
}

export function familyRetryDelay(failureCount: number): number {
  return Math.min(FAMILY_MAX_BACKOFF_MS, FAMILY_POLL_INTERVAL_MS * 2 ** Math.max(0, failureCount - 1))
}

/** All changes are rolling 24h percentages; gaps are percentage points. */
export function computeFamilyRows(
  family: CoinFamily,
  quotes: ReadonlyMap<string, FamilyMarketQuote>,
  now: number,
  options: { forceStale?: boolean } = {},
): FamilySummary {
  const members: FamilyMemberRow[] = family.members.map((member) => {
    const quote = quotes.get(member.symbol) ?? null
    return {
      ...member, quote,
      isStale: quote !== null && (!!options.forceStale || isFamilyQuoteStale(quote, now)),
      leaderGap: null, anchorGap: null, isGapWatch: false,
    }
  })
  const available = members.filter((row) => row.quote !== null && !row.isStale && row.quote.quoteVolume > 0)
  const ranked = [...available].sort((left, right) =>
    right.quote!.changePercent - left.quote!.changePercent || left.symbol.localeCompare(right.symbol),
  )
  const leader = ranked[0] ?? null
  const anchor = available.find(({ symbol }) => symbol === family.anchorSymbol) ?? null
  for (const row of available) {
    row.leaderGap = leader ? leader.quote!.changePercent - row.quote!.changePercent : null
    row.anchorGap = anchor ? anchor.quote!.changePercent - row.quote!.changePercent : null
    row.isGapWatch = family.kind !== 'other' && family.anchorSymbol !== null
      && leader !== null && leader.quote!.changePercent >= 3 && (row.leaderGap ?? 0) >= 2
  }
  return {
    family, members, leader, anchor,
    averageChange: available.length
      ? available.reduce((total, row) => total + row.quote!.changePercent, 0) / available.length
      : null,
    positiveCount: available.filter((row) => row.quote!.changePercent > 0).length,
    availableCount: available.length,
    totalCount: members.length,
    totalQuoteVolume: available.reduce((total, row) => total + row.quote!.quoteVolume, 0),
    gapWatchCount: members.filter(({ isGapWatch }) => isGapWatch).length,
  }
}

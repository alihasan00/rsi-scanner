import { describe, expect, test } from 'bun:test'
import { COIN_FAMILIES, FAMILY_SYMBOLS } from '../src/lib/coinFamilies'
import type { CoinFamily } from '../src/lib/coinFamilies'
import { computeFamilyRows, FAMILY_STALE_AFTER_MS, familyRetryDelay, getFamilyBestMovers, isFamilyQuoteStale } from '../src/lib/familyMarketData'
import type { FamilyMarketQuote } from '../src/lib/familyMarketData'
import { SYMBOLS } from '../src/lib/symbols'

const NOW = 1_790_000_000_000
const family: CoinFamily = {
  id: 'test', name: 'Test', kind: 'ecosystem', anchorSymbol: 'ETHUSDT', description: 'Test ecosystem', color: '#ffffff',
  members: [
    { symbol: 'ETHUSDT', name: 'Ethereum', relationship: 'Anchor' },
    { symbol: 'AAVEUSDT', name: 'Aave', relationship: 'Lending' },
    { symbol: 'UNIUSDT', name: 'Uniswap', relationship: 'Exchange' },
  ],
}

function quote(symbol: string, changePercent: number, patch: Partial<FamilyMarketQuote> = {}): FamilyMarketQuote {
  return { symbol, price: 100, changePercent, quoteVolume: 1_000, high: 110, low: 90, closeTime: NOW, ...patch }
}
const quotes = (...entries: FamilyMarketQuote[]) => new Map(entries.map((entry) => [entry.symbol, entry]))

describe('best movers at a glance', () => {
  test('ranks positive movers once per coin while retaining all their family links', () => {
    const data = quotes(quote('ETHUSDT', 3), quote('AAVEUSDT', 8), quote('UNIUSDT', 8))
    const secondFamily: CoinFamily = { ...family, id: 'second', name: 'Second family', members: family.members.slice(1) }
    const movers = getFamilyBestMovers([computeFamilyRows(family, data, NOW), computeFamilyRows(secondFamily, data, NOW)])
    expect(movers.map(({ quote }) => quote.symbol)).toEqual(['AAVEUSDT', 'UNIUSDT', 'ETHUSDT'])
    expect(movers[0].families.map(({ id }) => id)).toEqual(['test', 'second'])
  })

  test('caps the quick look at five distinct gainers in descending order', () => {
    const symbols = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((name) => `${name}USDT`)
    const largeFamily = { ...family, members: symbols.map((symbol) => ({ symbol, name: symbol, relationship: 'Test' })) }
    const data = quotes(...symbols.map((symbol, index) => quote(symbol, index + 1)))
    expect(getFamilyBestMovers([computeFamilyRows(largeFamily, data, NOW)]).map(({ quote }) => quote.changePercent)).toEqual([6, 5, 4, 3, 2])
  })

  test('does not present stale or nontrading coins as top gainers', () => {
    const data = quotes(quote('ETHUSDT', 90, { closeTime: NOW - FAMILY_STALE_AFTER_MS }), quote('AAVEUSDT', 80, { quoteVolume: 0 }), quote('UNIUSDT', 2))
    expect(getFamilyBestMovers([computeFamilyRows(family, data, NOW)]).map(({ quote }) => quote.symbol)).toEqual(['UNIUSDT'])
    expect(getFamilyBestMovers([computeFamilyRows(family, data, NOW, { forceStale: true })])).toEqual([])
  })

  test('flat and falling markets have no gainers; unclassified gains still appear', () => {
    expect(getFamilyBestMovers([computeFamilyRows(family, quotes(quote('ETHUSDT', 0), quote('AAVEUSDT', -1)), NOW)])).toEqual([])
    const other: CoinFamily = { ...family, id: 'other', kind: 'other', anchorSymbol: null }
    expect(getFamilyBestMovers([computeFamilyRows(other, quotes(quote('UNIUSDT', 4)), NOW)])[0].families[0].id).toBe('other')
  })
})

describe('curated coin families', () => {
  test('every scanner symbol is discoverable and every family uses supported pairs', () => {
    expect(new Set(FAMILY_SYMBOLS)).toEqual(new Set(SYMBOLS))
    expect(FAMILY_SYMBOLS.length).toBe(SYMBOLS.length)
    expect(new Set(COIN_FAMILIES.map(({ id }) => id)).size).toBe(COIN_FAMILIES.length)
    for (const entry of COIN_FAMILIES) {
      expect(new Set(entry.members.map(({ symbol }) => symbol)).size).toBe(entry.members.length)
      expect(entry.members.length).toBeGreaterThan(0)
      for (const member of entry.members) {
        expect(SYMBOLS).toContain(member.symbol)
        expect(member.name).not.toBe('')
        expect(member.relationship).not.toBe('')
      }
      if (entry.anchorSymbol) expect(entry.members.some(({ symbol }) => symbol === entry.anchorSymbol)).toBe(true)
    }
  })

  test('separates technical ecosystems from sectors and unclassified assets', () => {
    const bitcoin = COIN_FAMILIES.find(({ id }) => id === 'bitcoin')!
    expect(bitcoin.members.map(({ symbol }) => symbol)).toEqual(['BTCUSDT', 'STXUSDT', 'SOLVUSDT'])
    expect(COIN_FAMILIES.find(({ id }) => id === 'payments')?.kind).toBe('sector')
    expect(COIN_FAMILIES.find(({ id }) => id === 'memes')?.kind).toBe('meme')
    expect(COIN_FAMILIES.find(({ id }) => id === 'base')?.anchorSymbol).toBe('ETHUSDT')
    const other = COIN_FAMILIES.find(({ kind }) => kind === 'other')!
    expect(other.anchorSymbol).toBeNull()
    for (const member of other.members) {
      expect(COIN_FAMILIES.filter((entry) => entry.members.some(({ symbol }) => symbol === member.symbol))).toHaveLength(1)
    }
  })
})

describe('family rolling 24h comparisons', () => {
  test('computes equal-weight movement, breadth, volume and percentage-point gaps', () => {
    const result = computeFamilyRows(family, quotes(quote('ETHUSDT', 5), quote('AAVEUSDT', 9), quote('UNIUSDT', -2)), NOW)
    expect(result.averageChange).toBe(4)
    expect(result.positiveCount).toBe(2)
    expect(result.availableCount).toBe(3)
    expect(result.totalCount).toBe(3)
    expect(result.totalQuoteVolume).toBe(3_000)
    expect(result.leader?.symbol).toBe('AAVEUSDT')
    expect(result.anchor?.symbol).toBe('ETHUSDT')
    expect(result.members.find(({ symbol }) => symbol === 'UNIUSDT')).toMatchObject({ leaderGap: 11, anchorGap: 7, isGapWatch: true })
    expect(result.members.find(({ symbol }) => symbol === 'AAVEUSDT')).toMatchObject({ leaderGap: 0, anchorGap: -4, isGapWatch: false })
    expect(result.gapWatchCount).toBe(2)
  })

  test('all-red markets have a strongest member but no pump or gap-watch signal', () => {
    const result = computeFamilyRows(family, quotes(quote('ETHUSDT', -5), quote('AAVEUSDT', -1), quote('UNIUSDT', -8)), NOW)
    expect(result.leader?.symbol).toBe('AAVEUSDT')
    expect(result.averageChange).toBeCloseTo(-14 / 3)
    expect(result.positiveCount).toBe(0)
    expect(result.gapWatchCount).toBe(0)
  })

  test('zero percentage changes are available and neutral, not missing', () => {
    const result = computeFamilyRows(family, quotes(quote('ETHUSDT', 0), quote('AAVEUSDT', 0)), NOW)
    expect(result.averageChange).toBe(0)
    expect(result.availableCount).toBe(2)
    expect(result.positiveCount).toBe(0)
    expect(result.gapWatchCount).toBe(0)
    expect(result.members[0].anchorGap).toBe(0)
  })

  test('ties always use symbol order, regardless of membership or response order', () => {
    const data = quotes(quote('UNIUSDT', 5), quote('ETHUSDT', 5), quote('AAVEUSDT', 5))
    expect(computeFamilyRows(family, data, NOW).leader?.symbol).toBe('AAVEUSDT')
    expect(computeFamilyRows({ ...family, members: [...family.members].reverse() }, data, NOW).leader?.symbol).toBe('AAVEUSDT')
  })

  test('missing quotes stay visible without affecting denominators or manufacturing anchor gaps', () => {
    const result = computeFamilyRows(family, quotes(quote('AAVEUSDT', 7), quote('UNIUSDT', 2)), NOW)
    expect(result.averageChange).toBe(4.5)
    expect(result.availableCount).toBe(2)
    expect(result.anchor).toBeNull()
    expect(result.members[0]).toMatchObject({ quote: null, isStale: false, leaderGap: null, anchorGap: null, isGapWatch: false })
    expect(result.members[2]).toMatchObject({ leaderGap: 5, anchorGap: null, isGapWatch: true })
  })

  test('empty coverage returns unknown averages and leaders, not zero returns', () => {
    const result = computeFamilyRows(family, new Map(), NOW)
    expect(result.averageChange).toBeNull()
    expect(result.leader).toBeNull()
    expect(result.anchor).toBeNull()
    expect(result.availableCount).toBe(0)
    expect(result.gapWatchCount).toBe(0)
  })

  test('stale leaders and stale laggards are excluded from aggregates and opportunities', () => {
    const result = computeFamilyRows(family, quotes(
      quote('ETHUSDT', 20, { closeTime: NOW - FAMILY_STALE_AFTER_MS }),
      quote('AAVEUSDT', 4),
      quote('UNIUSDT', 0, { closeTime: NOW - FAMILY_STALE_AFTER_MS - 1 }),
    ), NOW)
    expect(result.averageChange).toBe(4)
    expect(result.availableCount).toBe(1)
    expect(result.leader?.symbol).toBe('AAVEUSDT')
    expect(result.gapWatchCount).toBe(0)
    expect(result.members[0]).toMatchObject({ isStale: true, leaderGap: null, isGapWatch: false })
  })

  test('an error override preserves quotes but excludes every signal and live aggregate', () => {
    const result = computeFamilyRows(family, quotes(quote('ETHUSDT', 8), quote('AAVEUSDT', 0)), NOW, { forceStale: true })
    expect(result.members[0].quote?.price).toBe(100)
    expect(result.members[0].isStale).toBe(true)
    expect(result.averageChange).toBeNull()
    expect(result.gapWatchCount).toBe(0)
  })

  test('zero-volume outliers cannot lead or become gap-watch candidates', () => {
    const result = computeFamilyRows(family, quotes(
      quote('ETHUSDT', 5), quote('AAVEUSDT', 100, { quoteVolume: 0 }), quote('UNIUSDT', 0, { quoteVolume: 0 }),
    ), NOW)
    expect(result.leader?.symbol).toBe('ETHUSDT')
    expect(result.availableCount).toBe(1)
    expect(result.averageChange).toBe(5)
    expect(result.gapWatchCount).toBe(0)
  })

  test('a 3% leader and 2pp gap qualify, smaller leaders or gaps do not', () => {
    const atThreshold = computeFamilyRows(family, quotes(quote('ETHUSDT', 3), quote('AAVEUSDT', 1), quote('UNIUSDT', 1.01)), NOW)
    expect(atThreshold.members[1].isGapWatch).toBe(true)
    expect(atThreshold.members[2].isGapWatch).toBe(false)
    const smallLeader = computeFamilyRows(family, quotes(quote('ETHUSDT', 2.99), quote('AAVEUSDT', -5)), NOW)
    expect(smallLeader.gapWatchCount).toBe(0)
  })

  test('Other assets never imply a rotation opportunity', () => {
    const result = computeFamilyRows({ ...family, kind: 'other', anchorSymbol: null }, quotes(quote('ETHUSDT', 20), quote('AAVEUSDT', 0)), NOW)
    expect(result.gapWatchCount).toBe(0)
    expect(result.anchor).toBeNull()
  })

  test('allows small clock skew, rejects future outliers and marks the exact stale boundary', () => {
    expect(isFamilyQuoteStale(quote('ETHUSDT', 0, { closeTime: NOW + 5_000 }), NOW)).toBe(false)
    expect(isFamilyQuoteStale(quote('ETHUSDT', 0, { closeTime: NOW + 5_001 }), NOW)).toBe(true)
    expect(isFamilyQuoteStale(quote('ETHUSDT', 0, { closeTime: NOW - FAMILY_STALE_AFTER_MS + 1 }), NOW)).toBe(false)
    expect(isFamilyQuoteStale(quote('ETHUSDT', 0, { closeTime: NOW - FAMILY_STALE_AFTER_MS }), NOW)).toBe(true)
  })

  test('retries progressively and caps request pressure during outages', () => {
    expect([0, 1, 2, 3, 4, 20].map(familyRetryDelay)).toEqual([30_000, 30_000, 60_000, 120_000, 120_000, 120_000])
  })
})

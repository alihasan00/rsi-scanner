import { describe, expect, test } from 'bun:test'
import type { WatchlistRow } from '../src/lib/watchlist'
import { getWatchlistDisplayStatus, groupWatchlistInstruments } from '../src/lib/watchlistInstruments'

const NOW = Date.parse('2026-09-28T00:00:00Z')

function setup(id: string, patch: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
    id, symbol: 'BTCUSDT', market: 'spot', timeframe: '1h', source: 'fib', name: 'Golden pocket',
    direction: 'bullish', status: 'approaching', price: 103, zone: { low: 100, high: 102 },
    stop: 98, target: 115, riskReward: 2.4, distancePercent: 0.97, distanceAtr: 0.5,
    confirmedAt: null, asOf: NOW - 1_000, updatedAt: NOW,
    reason: 'Near the zone', next: 'Wait for a zone test', cautions: [], evidence: [],
    families: ['location'], conflict: false, ...patch,
  }
}

describe('watchlist instrument grouping', () => {
  test('combines detector setups for one instrument and keeps a coherent ranked lead', () => {
    const fib = setup('fib')
    const harmonic = setup('harmonic', { source: 'harmonic', status: 'confirmed', confirmedAt: NOW - 5_000,
      zone: { low: 101, high: 103 }, stop: 99, target: 120, riskReward: 4.25 })
    const retest = setup('retest', { source: 'retest', status: 'testing' })
    const rows = [fib, retest, harmonic]
    const before = structuredClone(rows)
    const instruments = groupWatchlistInstruments(rows, NOW)

    expect(instruments).toHaveLength(1)
    const instrument = instruments[0]
    expect(instrument).toMatchObject({ id: 'spot:1h:BTCUSDT', status: 'confirmed', direction: 'bullish', hasMixedDirections: false })
    expect(instrument.lead).toBe(harmonic)
    expect(instrument.setups.map((row) => row.id)).toEqual(['harmonic', 'retest', 'fib'])
    expect(instrument.allSetups).toEqual(instrument.setups)
    expect(instrument.sources).toEqual(['fib', 'harmonic', 'retest'])
    expect(rows).toEqual(before)
  })

  test('keeps markets and timeframes separate and counts repeated setup receipts once', () => {
    const rows = [setup('same-id'), setup('same-id'), setup('same-id', { market: 'tradfi' }), setup('same-id', { timeframe: '4h' })]
    const instruments = groupWatchlistInstruments(rows, NOW)
    expect(instruments).toHaveLength(3)
    expect(new Set(instruments.map((item) => item.id)).size).toBe(3)
    expect(instruments.every((item) => item.allSetups.length === 1)).toBe(true)
    expect(groupWatchlistInstruments([...rows].reverse(), NOW)).toEqual(instruments)
  })

  test('newer repeated setup state replaces an older confirmation before filtering', () => {
    const earlier = setup('same-id', { status: 'confirmed', updatedAt: NOW - 10_000 })
    const later = setup('same-id', { status: 'blocked', updatedAt: NOW - 1_000 })
    for (const rows of [[earlier, later], [later, earlier]]) {
      const [instrument] = groupWatchlistInstruments(rows, NOW)
      expect(instrument.lead).toBe(later)
      expect(instrument.allSetups).toHaveLength(1)
      expect(groupWatchlistInstruments(rows, NOW, { status: 'confirmed' })).toEqual([])
    }
  })

  test('direction, source and status must match the same setup before it becomes the lead', () => {
    const fib = setup('fib', { status: 'confirmed' })
    const harmonic = setup('harmonic', { source: 'harmonic', direction: 'bearish', status: 'testing',
      zone: { low: 105, high: 106 }, stop: 108, target: 97 })
    const rows = [fib, harmonic]

    expect(groupWatchlistInstruments(rows, NOW, { source: 'harmonic', direction: 'bullish' })).toEqual([])
    expect(groupWatchlistInstruments(rows, NOW, { source: 'harmonic', status: 'confirmed' })).toEqual([])
    const [instrument] = groupWatchlistInstruments(rows, NOW, { source: 'harmonic', direction: 'bearish', status: 'testing' })
    expect(instrument.lead).toBe(harmonic)
    expect(instrument.setups).toEqual([harmonic])
    expect(instrument.allSetups).toEqual([fib, harmonic])
    expect(instrument.sources).toEqual(['harmonic'])
    expect(instrument.direction).toBe('bearish')
    expect(instrument.hasMixedDirections).toBe(true)
  })

  test('exposes mixed directions without inventing confirmation or changing either plan', () => {
    const bullish = setup('fib', { status: 'confirmed' })
    const bearish = setup('harmonic', { source: 'harmonic', direction: 'bearish', status: 'waiting' })
    const [instrument] = groupWatchlistInstruments([bullish, bearish], NOW)
    expect(instrument.direction).toBe('mixed')
    expect(instrument.hasMixedDirections).toBe(true)
    expect(instrument.status).toBe('confirmed')
    expect(instrument.lead).toBe(bullish)
    expect(instrument.allSetups).toEqual([bullish, bearish])
    const [filtered] = groupWatchlistInstruments([bullish, bearish], NOW, { direction: 'bullish' })
    expect(filtered.direction).toBe('bullish')
    expect(filtered.hasMixedDirections).toBe(true)
  })

  test('normalizes pair search and applies saved-pair filtering at instrument scope', () => {
    const rows = [setup('btc-fib'), setup('btc-harmonic', { source: 'harmonic' }), setup('eth', { symbol: 'ETHUSDT' })]
    expect(groupWatchlistInstruments(rows, NOW, { search: 'btc / usdt' }).map((item) => item.symbol)).toEqual(['BTCUSDT'])
    expect(groupWatchlistInstruments(rows, NOW, { starredOnly: true, starredSymbols: new Set(['ETHUSDT']) })
      .map((item) => item.symbol)).toEqual(['ETHUSDT'])
    expect(groupWatchlistInstruments(rows, NOW, { starredOnly: true })).toEqual([])
  })

  test('ages stale confirmations out before ranking and applying status filters', () => {
    const stale = setup('stale-confirmed', { status: 'confirmed', updatedAt: NOW - 60_001 })
    const fresh = setup('fresh-testing', { source: 'harmonic', status: 'testing' })
    const rows = [stale, fresh]
    const [instrument] = groupWatchlistInstruments(rows, NOW)
    expect(instrument.lead).toBe(fresh)
    expect(instrument.allSetups.map((row) => row.status)).toEqual(['testing', 'delayed'])
    expect(groupWatchlistInstruments(rows, NOW, { status: 'confirmed' })).toEqual([])
    const [delayed] = groupWatchlistInstruments(rows, NOW, { status: 'delayed' })
    expect(delayed.lead.id).toBe(stale.id)
    expect(delayed.status).toBe('delayed')
    expect(stale.status).toBe('confirmed')
  })

  test('all-delayed instruments remain inspectable with no fresh status', () => {
    const rows = [setup('old-fib', { updatedAt: null }), setup('old-harmonic', { source: 'harmonic', status: 'delayed' })]
    const [instrument] = groupWatchlistInstruments(rows, NOW)
    expect(instrument.status).toBe('delayed')
    expect(instrument.setups.every((row) => row.status === 'delayed')).toBe(true)
    expect(instrument.allSetups).toHaveLength(2)
  })

  test('preserves ranked instrument and setup order across differently ordered input', () => {
    const rows = [
      setup('btc-fib', { status: 'testing' }),
      setup('btc-harmonic', { source: 'harmonic', status: 'confirmed', confirmedAt: NOW - 5_000 }),
      setup('eth', { symbol: 'ETHUSDT', status: 'confirmed', confirmedAt: NOW - 1_000 }),
      setup('sol', { symbol: 'SOLUSDT', status: 'approaching' }),
      setup('ada', { symbol: 'ADAUSDT', status: 'approaching' }),
    ]
    const instruments = groupWatchlistInstruments(rows, NOW)
    expect(instruments.map((item) => item.symbol)).toEqual(['ETHUSDT', 'BTCUSDT', 'ADAUSDT', 'SOLUSDT'])
    expect(groupWatchlistInstruments([...rows].reverse(), NOW)).toEqual(instruments)
    expect(instruments.find((item) => item.symbol === 'BTCUSDT')?.setups.map((row) => row.id)).toEqual(['btc-harmonic', 'btc-fib'])
  })
})

describe('watchlist display freshness', () => {
  test.each([null, NaN, Infinity, -1, NOW + 5_001, NOW - 60_001])('invalid or aged receipt %s is delayed', (updatedAt) => {
    expect(getWatchlistDisplayStatus(setup('fib', { status: 'confirmed', updatedAt }), NOW)).toBe('delayed')
  })

  test('preserves the receipt boundary, clock tolerance and detector-delayed state', () => {
    expect(getWatchlistDisplayStatus(setup('fib', { updatedAt: NOW - 60_000 }), NOW)).toBe('approaching')
    expect(getWatchlistDisplayStatus(setup('fib', { updatedAt: NOW + 5_000 }), NOW)).toBe('approaching')
    expect(getWatchlistDisplayStatus(setup('fib', { status: 'delayed', updatedAt: NOW }), NOW)).toBe('delayed')
    expect(getWatchlistDisplayStatus(setup('fib'), NaN)).toBe('delayed')
  })
})

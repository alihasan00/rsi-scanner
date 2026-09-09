import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SCREENER_PREFERENCES,
  readScreenerPreferencesFromSearch,
  restoreScreenerPreferences,
  writeScreenerPreferencesToSearch,
} from '../src/lib/screenerPreferences'
import type { ScreenerPreferences } from '../src/lib/screenerPreferences'

const SELECTED: ScreenerPreferences = {
  market: 'tradfi',
  search: 'BTC / USDT',
  signal: 'divergence',
  divergenceRecency: 'any',
  rsiState: 'either',
  starredOnly: true,
  sort: 'signals',
  timeframe: '4h',
  cardDensity: 'compact',
}

describe('stored screener preferences', () => {
  test.each([undefined, null, false, 42, 'divergence', [], [SELECTED]].map((input) => ({ input })))(
    'rejects a malformed preference container ($input)', ({ input }) => {
      expect(restoreScreenerPreferences(input)).toEqual(DEFAULT_SCREENER_PREFERENCES)
    },
  )

  test('restores valid fields independently while discarding obsolete or malformed fields', () => {
    const saved = {
      search: ' eth/usdt ', signal: 'tug-of-war', divergenceRecency: '5',
      starredOnly: 'false', sort: 'rsi-high', timeframe: '2h', cardDensity: 'dense',
      direction: 'bearish', unknown: 'ignored',
    }
    const before = structuredClone(saved)
    expect(restoreScreenerPreferences(Object.freeze(saved))).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, search: ' eth/usdt ', sort: 'rsi-high', timeframe: '2h',
    })
    expect(saved).toEqual(before)
    expect(restoreScreenerPreferences({ ...SELECTED, signal: 'confirmed' })).toEqual({ ...SELECTED, signal: 'all' })
  })

  test('does not coerce invalid field types or similarly named values', () => {
    expect(restoreScreenerPreferences({
      market: 'TradFi',
      search: 123, signal: 'Divergence', divergenceRecency: NaN, starredOnly: 1,
      sort: ['signals'], timeframe: '4H', cardDensity: { value: 'compact' },
    })).toEqual(DEFAULT_SCREENER_PREFERENCES)
    expect(restoreScreenerPreferences({
      market: ['tradfi'],
      search: null, signal: false, divergenceRecency: 14, starredOnly: '1',
      sort: 'price', timeframe: '12h', cardDensity: 'small',
    })).toEqual(DEFAULT_SCREENER_PREFERENCES)
  })

  test.each([undefined, null, 'Overbought', 'extreme', 70, ['oversold']].map((rsiState) => ({ rsiState })))(
    'missing or invalid saved RSI state $rsiState preserves other preferences', ({ rsiState }) => {
      expect(restoreScreenerPreferences({ ...SELECTED, rsiState })).toEqual({ ...SELECTED, rsiState: 'all' })
    },
  )

  test('returns fresh values without sharing mutable defaults or the input object', () => {
    const restored = restoreScreenerPreferences(SELECTED)
    expect(restored).toEqual(SELECTED)
    expect(restored).not.toBe(SELECTED)
    const defaults = restoreScreenerPreferences({})
    defaults.search = 'changed'
    expect(restoreScreenerPreferences({})).toEqual(DEFAULT_SCREENER_PREFERENCES)
    expect(DEFAULT_SCREENER_PREFERENCES.search).toBe('')
  })
})

describe('screener URL preferences', () => {
  test.each(['', '?', '?utm_source=friend', '?direction=bullish', '?other=1&other=2'])('ignores searches without recognized keys (%s)', (search) => {
    expect(readScreenerPreferencesFromSearch(search)).toBeNull()
  })

  test.each(['market', 'q', 'indicator', 'candles', 'rsi', 'starred', 'sort', 'timeframe', 'density'])('recognizes even an empty %s parameter as a complete default view', (key) => {
    expect(readScreenerPreferencesFromSearch(`?${key}=`)).toEqual(DEFAULT_SCREENER_PREFERENCES)
  })

  test('omitted URL fields use defaults instead of inheriting other saved filters', () => {
    expect(readScreenerPreferencesFromSearch('?timeframe=1h')).toEqual({ ...DEFAULT_SCREENER_PREFERENCES, timeframe: '1h' })
    expect(readScreenerPreferencesFromSearch('?indicator=divergence')).toEqual({ ...DEFAULT_SCREENER_PREFERENCES, signal: 'divergence' })
    expect(readScreenerPreferencesFromSearch('?q=&timeframe=15m')).toEqual(DEFAULT_SCREENER_PREFERENCES)
  })

  test('market-only URLs define a complete view, with Spot as the missing or invalid default', () => {
    expect(DEFAULT_SCREENER_PREFERENCES.market).toBe('spot')
    expect(readScreenerPreferencesFromSearch('?market=tradfi')).toEqual({ ...DEFAULT_SCREENER_PREFERENCES, market: 'tradfi' })
    expect(readScreenerPreferencesFromSearch('?market=spot')).toEqual(DEFAULT_SCREENER_PREFERENCES)
    expect(readScreenerPreferencesFromSearch('?market=futures')).toEqual(DEFAULT_SCREENER_PREFERENCES)
    expect(restoreScreenerPreferences({ search: 'BTC' }).market).toBe('spot')
  })

  test.each(['tug-of-war', 'confirmed', 'bullish', 'DIVERGENCE'])('does not restore obsolete or unsupported indicator %s', (indicator) => {
    expect(readScreenerPreferencesFromSearch(`?indicator=${indicator}&timeframe=4h`)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, timeframe: '4h',
    })
  })

  test.each(['0', '14', '03', '3.0', '-1', 'Infinity', 'ALL'])('rejects invalid candle-window spelling %s', (candles) => {
    expect(readScreenerPreferencesFromSearch(`?candles=${candles}`)).toEqual(DEFAULT_SCREENER_PREFERENCES)
  })

  test.each(['Overbought', 'extreme', '70', 'oversold,overbought', 'null'])('rejects unsupported RSI state %s', (rsi) => {
    expect(readScreenerPreferencesFromSearch(`?rsi=${rsi}`)).toEqual(DEFAULT_SCREENER_PREFERENCES)
  })

  test('validates boolean, timeframe, density, and sort URL values independently', () => {
    expect(readScreenerPreferencesFromSearch('?starred=1&sort=rsi-low&timeframe=8h&density=compact')).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, starredOnly: true, sort: 'rsi-low', timeframe: '8h', cardDensity: 'compact',
    })
    for (const starred of ['0', 'true', 'false', '2', 'yes']) {
      expect(readScreenerPreferencesFromSearch(`?starred=${starred}&sort=price&timeframe=12h&density=dense`)).toEqual(DEFAULT_SCREENER_PREFERENCES)
    }
  })

  test('first duplicate values win consistently, including when the first value is invalid', () => {
    expect(readScreenerPreferencesFromSearch('?market=tradfi&market=spot&q=ETH&q=BTC&indicator=divergence&indicator=all&candles=5&candles=1&rsi=oversold&rsi=overbought&starred=0&starred=1&sort=change&sort=signals&timeframe=1h&timeframe=4h&density=compact&density=comfortable')).toEqual({
      market: 'tradfi',
      search: 'ETH', signal: 'divergence', divergenceRecency: 5, rsiState: 'oversold', starredOnly: false,
      sort: 'change', timeframe: '1h', cardDensity: 'compact',
    })
    expect(readScreenerPreferencesFromSearch('?market=futures&market=tradfi&indicator=confirmed&indicator=divergence&rsi=extreme&rsi=either&timeframe=12h&timeframe=4h')).toEqual(DEFAULT_SCREENER_PREFERENCES)
  })
})

describe('canonical screener URL writing', () => {
  test('default values still have a timeframe anchor and restore a deterministic complete view', () => {
    const search = writeScreenerPreferencesToSearch('', { ...DEFAULT_SCREENER_PREFERENCES })
    expect(search).toBe('?timeframe=15m')
    expect(readScreenerPreferencesFromSearch(search)).toEqual(DEFAULT_SCREENER_PREFERENCES)
    expect(writeScreenerPreferencesToSearch('?q=BTC&indicator=divergence&candles=5&rsi=overbought&starred=1&sort=signals&timeframe=4h&density=compact', { ...DEFAULT_SCREENER_PREFERENCES })).toBe(search)
  })

  test('retains unrelated parameters and their duplicates while replacing all owned duplicates', () => {
    const input = '?campaign=a&campaign=b&market=spot&market=invalid&q=old&q=older&indicator=confirmed&indicator=all&candles=14&candles=1&rsi=old&rsi=oversold&starred=0&starred=0&sort=symbol&sort=change&timeframe=1m&timeframe=1w&density=dense&density=comfortable&note=a%26b'
    const search = writeScreenerPreferencesToSearch(input, SELECTED)
    const params = new URLSearchParams(search)
    expect(params.getAll('campaign')).toEqual(['a', 'b'])
    expect(params.get('note')).toBe('a&b')
    for (const key of ['market', 'q', 'indicator', 'candles', 'rsi', 'starred', 'sort', 'timeframe', 'density']) {
      expect(params.getAll(key)).toHaveLength(1)
    }
    expect(readScreenerPreferencesFromSearch(search)).toEqual(SELECTED)
    expect(writeScreenerPreferencesToSearch(search, SELECTED)).toBe(search)
    const defaults = new URLSearchParams(writeScreenerPreferencesToSearch(search, { ...DEFAULT_SCREENER_PREFERENCES }))
    expect([...defaults.entries()]).toEqual([['campaign', 'a'], ['campaign', 'b'], ['note', 'a&b'], ['timeframe', '15m']])
  })

  test.each(['', 'BTCUSDT', ' eth / usdt ', 'سکرینر 🚀', 'A+B & C? 50% / #'])('round trips search text exactly (%s)', (search) => {
    const prefs = { ...SELECTED, search }
    const url = writeScreenerPreferencesToSearch('', prefs)
    expect(readScreenerPreferencesFromSearch(url)).toEqual(prefs)
    expect(new URLSearchParams(url).has('q')).toBe(search !== '')
  })

  test('round trips every supported setting value through stored and URL validation', () => {
    const choices: { [Key in keyof ScreenerPreferences]: readonly ScreenerPreferences[Key][] } = {
      market: ['spot', 'tradfi'],
      search: ['', 'SOL / USDT'],
      signal: ['all', 'divergence'],
      divergenceRecency: [1, 3, 5, 'any'],
      rsiState: ['all', 'overbought', 'oversold', 'either', 'neutral'],
      starredOnly: [false, true],
      sort: ['watchlist', 'signals', 'change', 'rsi-low', 'rsi-high', 'symbol'],
      timeframe: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '3d', '1w'],
      cardDensity: ['comfortable', 'compact'],
    }
    for (const [key, values] of Object.entries(choices)) {
      for (const value of values) {
        const prefs = { ...SELECTED, [key]: value }
        expect(restoreScreenerPreferences(prefs)).toEqual(prefs)
        expect(readScreenerPreferencesFromSearch(writeScreenerPreferencesToSearch('', prefs))).toEqual(prefs)
      }
    }
  })

  test('validates runtime inputs before writing and does not mutate the preference object', () => {
    const prefs = Object.freeze({ ...SELECTED })
    expect(readScreenerPreferencesFromSearch(writeScreenerPreferencesToSearch('?other=kept', prefs))).toEqual(SELECTED)
    expect(prefs).toEqual(SELECTED)
    const invalid = { signal: 'tug-of-war', timeframe: '12h', starredOnly: '1' } as unknown as ScreenerPreferences
    expect(writeScreenerPreferencesToSearch('', invalid)).toBe('?timeframe=15m')
  })
})

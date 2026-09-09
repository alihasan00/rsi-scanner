import { afterEach, describe, expect, test } from 'bun:test'
import type { StateStorage } from 'zustand/middleware'
import { DEFAULT_SCREENER_PREFERENCES } from '../src/lib/screenerPreferences'
import type { ScreenerPreferences } from '../src/lib/screenerPreferences'
import { startScreenerPreferenceSync } from '../src/lib/screenerPreferenceSync'
import { createScannerStore } from '../src/store/scannerStore'
import {
  getSymbolSnapshot, getSymbolStoreVersion, resetSymbolData, setSymbolSnapshot,
} from '../src/store/dataStore'
import {
  getFeedStatus, getFeedStatusVersion, resetFeedStatus, setFeedStatus,
} from '../src/store/feedStatusStore'
import type { SymbolSnapshot } from '../src/types'

const STORAGE_KEY = 'rsi-scanner-preferences'
const DEFAULT_FILTERS = {
  search: '', signal: 'all', divergenceRecency: 3, starredOnly: false, sort: 'watchlist',
}
const SELECTED: ScreenerPreferences = {
  search: 'ETH / USDT', signal: 'divergence', divergenceRecency: 'any',
  starredOnly: true, sort: 'signals', timeframe: '4h', cardDensity: 'compact',
}
const cleanups: Array<() => void> = []

function memoryStorage(saved?: unknown) {
  const values = new Map<string, string>()
  if (saved !== undefined) values.set(STORAGE_KEY, JSON.stringify({ state: saved, version: 0 }))
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => { values.set(name, value) },
    removeItem: (name) => { values.delete(name) },
  }
  return { storage, values }
}

function fakeBrowser(initialUrl = '/screener', initialState: unknown = { route: 'screener' }) {
  const location = { pathname: '', search: '', hash: '' }
  const listeners = new Set<() => void>()
  const replacements: Array<{ url: string; state: unknown }> = []
  const failures = { replace: false }
  const updateLocation = (url: string) => {
    const parsed = new URL(url, 'https://screener.example')
    location.pathname = parsed.pathname
    location.search = parsed.search
    location.hash = parsed.hash
  }
  updateLocation(initialUrl)
  const history = {
    state: initialState,
    replaceState(state: unknown, _unused: string, url?: string | URL | null) {
      if (failures.replace) throw new Error('History writes unavailable')
      const target = String(url ?? `${location.pathname}${location.search}${location.hash}`)
      updateLocation(target)
      history.state = state
      replacements.push({ url: target, state })
    },
  }
  return {
    location, history, replacements, failures,
    addEventListener(type: string, callback: () => void) {
      if (type === 'popstate') listeners.add(callback)
    },
    removeEventListener(type: string, callback: () => void) {
      if (type === 'popstate') listeners.delete(callback)
    },
    navigate(url: string, state: unknown = history.state) {
      updateLocation(url)
      history.state = state
      for (const callback of [...listeners]) callback()
    },
    listenerCount: () => listeners.size,
  }
}

function preferences(store: ReturnType<typeof createScannerStore>): ScreenerPreferences {
  const state = store.getState()
  return { ...state.screenerFilters, timeframe: state.timeframe, cardDensity: state.cardDensity }
}

function loadedSnapshot(): SymbolSnapshot {
  return {
    price: 105, volume: 10, series: [55],
    bars: [{
      openTime: 0, closeTime: 899_999, open: 100, high: 110, low: 90,
      close: 105, volume: 10, rsi: 55, isClosed: true,
    }],
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  resetSymbolData()
  resetFeedStatus()
})

describe('screener store persistence', () => {
  test('a new store restores filters and existing display and personal preferences', () => {
    const { storage } = memoryStorage()
    const first = createScannerStore(storage)
    first.getState().applyScreenerPreferences(SELECTED)
    first.getState().toggleStarredSymbol('ETHUSDT')
    first.getState().toggleStarredTimeframe('3m')
    first.getState().setCellSize(160)
    first.getState().updateSettings({ requireBodyAgreement: false, showHiddenDivergences: true })
    first.getState().updateSupportResistanceFilters({ side: 'support', minTouches: 3 })
    first.getState().openSettings()
    first.getState().selectSymbol('ETHUSDT')

    const reloaded = createScannerStore(storage)

    expect(preferences(reloaded)).toEqual(SELECTED)
    expect(reloaded.getState().starredSymbols).toEqual(['ETHUSDT'])
    expect(reloaded.getState().starredTimeframes).toContain('3m')
    expect(reloaded.getState().cellSize).toBe(160)
    expect(reloaded.getState().settings).toMatchObject({ requireBodyAgreement: false, showHiddenDivergences: true })
    expect(reloaded.getState().supportResistanceFilters).toMatchObject({ side: 'support', minTouches: 3 })
    expect(reloaded.getState().settingsOpen).toBe(false)
    expect(reloaded.getState().selectedSymbol).toBeNull()
  })

  test('invalid saved filters fall back independently without discarding valid fields or prior preferences', () => {
    const { storage } = memoryStorage({
      screenerFilters: {
        search: 'SOL', signal: 'tug-of-war', divergenceRecency: '5',
        starredOnly: 'true', sort: 'rsi-high', direction: 'bearish',
      },
      timeframe: '1h', cardDensity: 'compact', starredSymbols: ['SOLUSDT'],
      settings: { requireSameRsiCycle: false },
    })
    const store = createScannerStore(storage)

    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES,
      search: 'SOL', sort: 'rsi-high', timeframe: '1h', cardDensity: 'compact',
    })
    expect(store.getState().screenerFilters).not.toHaveProperty('direction')
    expect(store.getState().starredSymbols).toEqual(['SOLUSDT'])
    expect(store.getState().settings.requireSameRsiCycle).toBe(false)
    expect(typeof store.getState().updateScreenerFilters).toBe('function')
  })

  test('invalid saved timeframe and density do not prevent valid screener filters from restoring', () => {
    const store = createScannerStore(memoryStorage({
      timeframe: '12h', cardDensity: 'dense', starredSymbols: ['BTCUSDT'],
      screenerFilters: {
        search: 'BTC', signal: 'divergence', divergenceRecency: 5,
        starredOnly: true, sort: 'change',
      },
    }).storage)

    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, search: 'BTC', signal: 'divergence',
      divergenceRecency: 5, starredOnly: true, sort: 'change',
    })
    expect(store.getState().starredSymbols).toEqual(['BTCUSDT'])
  })

  test('missing or corrupt stored filters recover to defaults and remain editable', () => {
    const legacy = createScannerStore(memoryStorage({ timeframe: '1d', starredSymbols: ['BTCUSDT'] }).storage)
    expect(legacy.getState().screenerFilters).toEqual(DEFAULT_FILTERS)
    expect(legacy.getState().timeframe).toBe('1d')
    expect(legacy.getState().starredSymbols).toEqual(['BTCUSDT'])

    const { storage, values } = memoryStorage()
    values.set(STORAGE_KEY, '{ invalid JSON')
    const recovered = createScannerStore(storage)
    expect(preferences(recovered)).toEqual(DEFAULT_SCREENER_PREFERENCES)
    recovered.getState().updateScreenerFilters({ search: 'BTC', sort: 'symbol' })
    expect(createScannerStore(storage).getState().screenerFilters).toEqual({
      ...DEFAULT_FILTERS, search: 'BTC', sort: 'symbol',
    })
  })

  test('restoring a timeframe publishes the complete view only after old market data is cleared', () => {
    const store = createScannerStore(memoryStorage().storage)
    store.getState().toggleStarredSymbol('BTCUSDT')
    setSymbolSnapshot('BTCUSDT', loadedSnapshot())
    setFeedStatus('BTCUSDT', { state: 'ready', updatedAt: 900_000, error: null })
    const observed: Array<{ view: ScreenerPreferences; bars: number; feed: string }> = []
    cleanups.push(store.subscribe(() => observed.push({
      view: preferences(store), bars: getSymbolSnapshot('BTCUSDT').bars.length,
      feed: getFeedStatus('BTCUSDT').state,
    })))

    store.getState().applyScreenerPreferences(SELECTED)

    expect(observed).toEqual([{ view: SELECTED, bars: 0, feed: 'loading' }])
    expect(store.getState().starredSymbols).toEqual(['BTCUSDT'])

    const loaded = loadedSnapshot()
    const ready = { state: 'ready' as const, updatedAt: 1_800_000, error: null }
    setSymbolSnapshot('BTCUSDT', loaded)
    setFeedStatus('BTCUSDT', ready)
    const marketVersion = getSymbolStoreVersion()
    const feedVersion = getFeedStatusVersion()
    store.getState().applyScreenerPreferences({ ...SELECTED, search: 'BTC' })

    expect(getSymbolSnapshot('BTCUSDT')).toBe(loaded)
    expect(getFeedStatus('BTCUSDT')).toBe(ready)
    expect(getSymbolStoreVersion()).toBe(marketVersion)
    expect(getFeedStatusVersion()).toBe(feedVersion)
    expect(observed).toHaveLength(2)
  })
})

describe('screener URL and store synchronization', () => {
  test('a URL without screener keys uses saved preferences and preserves unrelated URL and history data', () => {
    const { storage } = memoryStorage()
    const saved = createScannerStore(storage)
    saved.getState().applyScreenerPreferences(SELECTED)
    saved.getState().toggleStarredSymbol('ETHUSDT')
    const store = createScannerStore(storage)
    const historyState = { router: { position: 7 } }
    const browser = fakeBrowser('/market/screener?campaign=a&campaign=b#price', historyState)

    cleanups.push(startScreenerPreferenceSync(store, browser))

    expect(preferences(store)).toEqual(SELECTED)
    expect(browser.location.pathname).toBe('/market/screener')
    expect(browser.location.hash).toBe('#price')
    expect(browser.history.state).toBe(historyState)
    const params = new URLSearchParams(browser.location.search)
    expect(params.getAll('campaign')).toEqual(['a', 'b'])
    expect(params.get('q')).toBe('ETH / USDT')
    expect(params.get('indicator')).toBe('divergence')
    expect(params.get('candles')).toBe('any')
    expect(params.get('starred')).toBe('1')
    expect(params.get('sort')).toBe('signals')
    expect(params.get('timeframe')).toBe('4h')
    expect(params.get('density')).toBe('compact')
    expect(browser.location.search).not.toContain('ETHUSDT')
    expect(browser.listenerCount()).toBe(1)
  })

  test('a shared URL applies a complete view synchronously and persists it over saved choices', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().applyScreenerPreferences(SELECTED)
    store.getState().toggleStarredSymbol('ETHUSDT')
    store.getState().updateSettings({ requireBodyAgreement: false })
    setSymbolSnapshot('ETHUSDT', loadedSnapshot())
    const browser = fakeBrowser('/screener?indicator=divergence&candles=1')
    const expected = { ...DEFAULT_SCREENER_PREFERENCES, signal: 'divergence', divergenceRecency: 1 }

    cleanups.push(startScreenerPreferenceSync(store, browser))

    expect(preferences(store)).toEqual(expected)
    expect(getSymbolSnapshot('ETHUSDT').bars).toEqual([])
    expect(store.getState().starredSymbols).toEqual(['ETHUSDT'])
    expect(store.getState().settings.requireBodyAgreement).toBe(false)
    expect(createScannerStore(storage).getState().screenerFilters).toEqual({
      ...DEFAULT_FILTERS, signal: 'divergence', divergenceRecency: 1,
    })
    expect(new URLSearchParams(browser.location.search).get('timeframe')).toBe('15m')
  })

  test('recognized invalid URL values reset the shared view instead of inheriting saved filters', () => {
    const store = createScannerStore(memoryStorage().storage)
    store.getState().applyScreenerPreferences(SELECTED)
    const browser = fakeBrowser('/screener?indicator=tug-of-war&candles=14&timeframe=12h&campaign=friend#rsi')

    cleanups.push(startScreenerPreferenceSync(store, browser))

    expect(preferences(store)).toEqual(DEFAULT_SCREENER_PREFERENCES)
    expect(browser.location.search).toBe('?campaign=friend&timeframe=15m')
    expect(browser.location.hash).toBe('#rsi')
  })

  test('filter edits and reset update the shareable URL and storage while retaining timeframe, density, and favorites', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    const historyState = { router: 'keep me' }
    const browser = fakeBrowser('/screener?source=shared#rsi', historyState)
    cleanups.push(startScreenerPreferenceSync(store, browser))
    store.getState().toggleStarredSymbol('ETHUSDT')
    store.getState().applyScreenerPreferences(SELECTED)
    store.getState().updateScreenerFilters({ search: 'SOL + ETH', divergenceRecency: 5, sort: 'rsi-low' })

    const selected = new URLSearchParams(browser.location.search)
    expect(selected.get('q')).toBe('SOL + ETH')
    expect(selected.get('candles')).toBe('5')
    expect(selected.get('sort')).toBe('rsi-low')
    expect(selected.get('indicator')).toBe('divergence')
    expect(selected.get('starred')).toBe('1')
    expect(createScannerStore(storage).getState().screenerFilters).toEqual(store.getState().screenerFilters)

    store.getState().resetScreenerFilters()

    expect(store.getState().screenerFilters).toEqual(DEFAULT_FILTERS)
    expect(store.getState().starredSymbols).toEqual(['ETHUSDT'])
    expect(store.getState().timeframe).toBe('4h')
    expect(store.getState().cardDensity).toBe('compact')
    expect([...new URLSearchParams(browser.location.search).entries()]).toEqual([
      ['source', 'shared'], ['timeframe', '4h'], ['density', 'compact'],
    ])
    expect(browser.location.hash).toBe('#rsi')
    expect(browser.history.state).toBe(historyState)
    expect(preferences(createScannerStore(storage))).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, timeframe: '4h', cardDensity: 'compact',
    })
  })

  test('unrelated UI and personal preference changes do not rewrite the URL', () => {
    const store = createScannerStore(memoryStorage().storage)
    const browser = fakeBrowser('/screener?timeframe=15m')
    cleanups.push(startScreenerPreferenceSync(store, browser))
    const initialWrites = browser.replacements.length

    store.getState().openSettings()
    store.getState().selectSymbol('BTCUSDT')
    store.getState().toggleStarredSymbol('BTCUSDT')
    store.getState().toggleStarredTimeframe('3m')
    store.getState().updateSettings({ requireBodyAgreement: false })
    store.getState().setCellSize(180)
    store.getState().updateScreenerFilters({ search: '' })

    expect(browser.replacements).toHaveLength(initialWrites)
    store.getState().setCardDensity('compact')
    store.getState().setTimeframe('1h')
    expect(new URLSearchParams(browser.location.search).get('density')).toBe('compact')
    expect(new URLSearchParams(browser.location.search).get('timeframe')).toBe('1h')
  })

  test('back and forward navigation restore full views and cleanup stops both synchronization directions', () => {
    const store = createScannerStore(memoryStorage().storage)
    const browser = fakeBrowser('/screener?timeframe=15m')
    const stop = startScreenerPreferenceSync(store, browser)
    cleanups.push(stop)
    setSymbolSnapshot('BTCUSDT', loadedSnapshot())
    setFeedStatus('BTCUSDT', { state: 'ready', updatedAt: 900_000, error: null })
    const historyState = { position: 2 }

    browser.navigate('/screener?q=BTC&indicator=divergence&candles=5&sort=change&timeframe=1h#price', historyState)

    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, search: 'BTC', signal: 'divergence',
      divergenceRecency: 5, sort: 'change', timeframe: '1h',
    })
    expect(getSymbolSnapshot('BTCUSDT').bars).toEqual([])
    expect(getFeedStatus('BTCUSDT').state).toBe('loading')
    expect(browser.history.state).toBe(historyState)
    expect(browser.location.hash).toBe('#price')

    browser.navigate('/screener?timeframe=15m')
    expect(preferences(store)).toEqual(DEFAULT_SCREENER_PREFERENCES)
    store.getState().updateScreenerFilters({ search: 'SOL' })
    browser.navigate('/screener?campaign=back#rsi')
    expect(preferences(store)).toEqual({ ...DEFAULT_SCREENER_PREFERENCES, search: 'SOL' })
    expect(new URLSearchParams(browser.location.search).get('campaign')).toBe('back')
    expect(new URLSearchParams(browser.location.search).get('q')).toBe('SOL')

    stop()
    expect(browser.listenerCount()).toBe(0)
    const writesAfterStop = browser.replacements.length
    store.getState().updateScreenerFilters({ search: 'ETH' })
    expect(browser.replacements).toHaveLength(writesAfterStop)
    browser.navigate('/screener?timeframe=1d&q=BTC')
    expect(preferences(store)).toEqual({ ...DEFAULT_SCREENER_PREFERENCES, search: 'ETH' })
  })

  test('storage and browser write failures leave filters usable and later URL writes can recover', () => {
    const unavailable: StateStorage = {
      getItem: () => { throw new Error('Storage reads unavailable') },
      setItem: () => { throw new Error('Storage quota exceeded') },
      removeItem: () => { throw new Error('Storage deletion unavailable') },
    }
    const store = createScannerStore(unavailable)
    const browser = fakeBrowser('/screener?campaign=friend#rsi')
    browser.failures.replace = true

    expect(() => cleanups.push(startScreenerPreferenceSync(store, browser))).not.toThrow()
    expect(() => store.getState().updateScreenerFilters({ search: 'BTC', signal: 'divergence' })).not.toThrow()
    expect(store.getState().screenerFilters).toEqual({ ...DEFAULT_FILTERS, search: 'BTC', signal: 'divergence' })

    browser.failures.replace = false
    expect(() => store.getState().updateScreenerFilters({ divergenceRecency: 5 })).not.toThrow()
    expect(new URLSearchParams(browser.location.search).get('q')).toBe('BTC')
    expect(new URLSearchParams(browser.location.search).get('candles')).toBe('5')
    expect(new URLSearchParams(browser.location.search).get('campaign')).toBe('friend')
    expect(browser.location.hash).toBe('#rsi')
    expect(() => store.getState().resetScreenerFilters()).not.toThrow()
    expect(store.getState().screenerFilters).toEqual(DEFAULT_FILTERS)
  })
})

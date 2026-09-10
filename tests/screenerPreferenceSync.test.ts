import { afterEach, describe, expect, test } from 'bun:test'
import type { StateStorage } from 'zustand/middleware'
import { DEFAULT_SCREENER_PREFERENCES } from '../src/lib/screenerPreferences'
import type { ScreenerPreferences } from '../src/lib/screenerPreferences'
import { DEFAULT_FIB_SETTINGS } from '../src/lib/fibPreferences'
import type { FibSettings } from '../src/lib/fibPreferences'
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
  search: '', signal: 'all', divergenceRecency: 3, rsiState: 'all', starredOnly: false, sort: 'watchlist',
  fibDirection: 'any', fibStage: 'any', fibConfluence: 'any',
  srSource: 'all', srSignal: 'all', srSort: 'watchlist',
}
const SELECTED: ScreenerPreferences = {
  ...DEFAULT_SCREENER_PREFERENCES,
  market: 'spot',
  search: 'ETH / USDT', signal: 'divergence', divergenceRecency: 'any',
  rsiState: 'either',
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
  return { ...state.screenerFilters, market: state.market, timeframe: state.timeframe, cardDensity: state.cardDensity, fibSettings: state.fibSettings }
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
  test('a shared SR view restores its own filters and survives reload with a canonical bare URL', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().applyScreenerPreferences(SELECTED)
    const browser = fakeBrowser('/screener?indicator=sr&market=tradfi&timeframe=1h&srSource=monday&srSignal=bullish&srSort=signals')
    cleanups.push(startScreenerPreferenceSync(store, browser))
    const expected: ScreenerPreferences = {
      ...DEFAULT_SCREENER_PREFERENCES, signal: 'sr', market: 'tradfi', timeframe: '1h',
      srSource: 'monday', srSignal: 'bullish', srSort: 'signals',
    }
    expect(preferences(store)).toEqual(expected)
    const restored = createScannerStore(storage)
    const bareBrowser = fakeBrowser('/screener')
    cleanups.push(startScreenerPreferenceSync(restored, bareBrowser))
    expect(preferences(restored)).toEqual(expected)
    const params = new URLSearchParams(bareBrowser.location.search)
    expect(params.get('indicator')).toBe('sr')
    expect(params.getAll('srSource')).toEqual(['monday'])
    expect(params.getAll('srSignal')).toEqual(['bullish'])
    expect(params.getAll('srSort')).toEqual(['signals'])
    expect(params.get('market')).toBe('tradfi')
    expect(params.get('timeframe')).toBe('1h')
  })

  test('remembers the RSI signal across SR and Fib switches, edits, and reload', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().updateScreenerFilters({ signal: 'divergence', divergenceRecency: 5 })
    store.getState().setScreenerTab('sr')
    store.getState().updateScreenerFilters({ srSource: 'month', srSignal: 'sfp', srSort: 'signals' })
    store.getState().setScreenerTab('fib')
    store.getState().updateScreenerFilters({ fibDirection: 'short', fibStage: 'near' })
    store.getState().setScreenerTab('sr')
    expect(store.getState().lastRsiSignal).toBe('divergence')
    const restored = createScannerStore(storage)
    expect(restored.getState().screenerFilters.signal).toBe('sr')
    expect(restored.getState().lastRsiSignal).toBe('divergence')
    restored.getState().setScreenerTab('rsi')
    expect(restored.getState().screenerFilters).toMatchObject({
      signal: 'divergence', divergenceRecency: 5, srSource: 'month', srSignal: 'sfp',
      srSort: 'signals', fibDirection: 'short', fibStage: 'near',
    })
    restored.getState().updateScreenerFilters({ signal: 'all' })
    restored.getState().setScreenerTab('sr')
    restored.getState().setScreenerTab('fib')
    restored.getState().setScreenerTab('rsi')
    expect(restored.getState().screenerFilters.signal).toBe('all')
    expect(restored.getState().lastRsiSignal).toBe('all')
  })

  test('SR reset clears its filters while retaining the tab, market, timeframe, and RSI memory', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().updateScreenerFilters({ signal: 'divergence' })
    const browser = fakeBrowser('/screener?indicator=sr&market=tradfi&timeframe=4h&density=compact&srSource=week&srSignal=near&srSort=symbol&q=gold&starred=1')
    cleanups.push(startScreenerPreferenceSync(store, browser))
    store.getState().toggleStarredSymbol('XAUUSDT')
    store.getState().updateFibSettings({ scale: 'log' })
    const template = store.getState().fibSettings
    store.getState().resetScreenerFilters()
    expect(store.getState().screenerFilters).toEqual({ ...DEFAULT_FILTERS, signal: 'sr' })
    expect(store.getState().lastRsiSignal).toBe('divergence')
    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, signal: 'sr', market: 'tradfi', timeframe: '4h',
      cardDensity: 'compact', fibSettings: template,
    })
    expect(store.getState().starredSymbols).toEqual(['XAUUSDT'])
    const params = new URLSearchParams(browser.location.search)
    expect(params.get('indicator')).toBe('sr')
    expect(params.get('market')).toBe('tradfi')
    expect(params.get('timeframe')).toBe('4h')
    for (const key of ['srSource', 'srSignal', 'srSort', 'q', 'starred']) expect(params.has(key)).toBe(false)
    expect(preferences(createScannerStore(storage))).toEqual(preferences(store))
    store.getState().setScreenerTab('rsi')
    expect(store.getState().screenerFilters.signal).toBe('divergence')
  })

  test('switching screener tabs restores the last RSI choice through reload', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().updateScreenerFilters({ signal: 'divergence', divergenceRecency: 5, search: 'ETH', sort: 'signals' })
    store.getState().setScreenerTab('fib')
    store.getState().setScreenerTab('fib')
    store.getState().updateScreenerFilters({ fibDirection: 'long', fibStage: 'pocket' })

    expect(store.getState().screenerFilters.signal).toBe('fib')
    expect(store.getState().lastRsiSignal).toBe('divergence')
    const restored = createScannerStore(storage)
    expect(restored.getState().screenerFilters.signal).toBe('fib')
    expect(restored.getState().lastRsiSignal).toBe('divergence')
    restored.getState().setScreenerTab('rsi')
    expect(restored.getState().screenerFilters).toEqual({
      ...DEFAULT_FILTERS, signal: 'divergence', divergenceRecency: 5, search: 'ETH', sort: 'signals',
      fibDirection: 'long', fibStage: 'pocket',
    })

    restored.getState().updateScreenerFilters({ signal: 'all' })
    restored.getState().setScreenerTab('fib')
    restored.getState().setScreenerTab('rsi')
    expect(restored.getState().screenerFilters.signal).toBe('all')
    expect(restored.getState().lastRsiSignal).toBe('all')
  })

  test.each([undefined, null, 'fib', 'Divergence', false, 1, ['divergence'], { value: 'divergence' }].map((lastRsiSignal) => ({ lastRsiSignal })))(
    'legacy or malformed remembered RSI choice defaults to all ($lastRsiSignal)', ({ lastRsiSignal }) => {
      const store = createScannerStore(memoryStorage({ screenerFilters: { signal: 'fib' }, lastRsiSignal }).storage)
      expect(store.getState().screenerFilters.signal).toBe('fib')
      expect(store.getState().lastRsiSignal).toBe('all')
      store.getState().setScreenerTab('rsi')
      expect(store.getState().screenerFilters.signal).toBe('all')
    },
  )

  test('an active saved RSI signal takes precedence over stale tab memory', () => {
    for (const signal of ['all', 'divergence'] as const) {
      const store = createScannerStore(memoryStorage({
        screenerFilters: { signal }, lastRsiSignal: signal === 'all' ? 'divergence' : 'all',
      }).storage)
      expect(store.getState().lastRsiSignal).toBe(signal)
      store.getState().setScreenerTab('fib')
      store.getState().setScreenerTab('rsi')
      expect(store.getState().screenerFilters.signal).toBe(signal)
    }
  })

  test('reset clears filters and sort while retaining the active Fib tab and remembered RSI choice', () => {
    const store = createScannerStore(memoryStorage().storage)
    store.getState().updateScreenerFilters({ signal: 'divergence', divergenceRecency: 5, rsiState: 'oversold' })
    store.getState().setScreenerTab('fib')
    store.getState().updateScreenerFilters({ search: 'BTC', starredOnly: true, sort: 'signals',
      fibDirection: 'short', fibStage: 'active', fibConfluence: 'aligned' })
    store.getState().resetScreenerFilters()
    expect(store.getState().screenerFilters).toEqual({ ...DEFAULT_FILTERS, signal: 'fib' })
    expect(store.getState().lastRsiSignal).toBe('divergence')

    store.getState().setScreenerTab('rsi')
    expect(store.getState().screenerFilters.signal).toBe('divergence')
    store.getState().resetScreenerFilters()
    expect(store.getState().screenerFilters).toEqual(DEFAULT_FILTERS)
    expect(store.getState().lastRsiSignal).toBe('all')
    store.getState().setScreenerTab('fib')
    store.getState().setScreenerTab('rsi')
    expect(store.getState().screenerFilters.signal).toBe('all')
  })

  test('legacy favorites migrate to Spot only, even if the saved market is TradFi', () => {
    const { storage } = memoryStorage({ market: 'tradfi', starredSymbols: ['BTCUSDT', 7, 'BTCUSDT', 'ETHUSDT'] })
    const store = createScannerStore(storage)

    expect(store.getState().market).toBe('tradfi')
    expect(store.getState().starredSymbols).toEqual([])
    expect(store.getState().starredSymbolsByMarket).toEqual({ spot: ['BTCUSDT', 'ETHUSDT'], tradfi: [] })
    store.getState().toggleStarredSymbol('XAUUSDT')
    store.getState().setMarket('spot')
    expect(store.getState().starredSymbols).toEqual(['BTCUSDT', 'ETHUSDT'])

    const reloaded = createScannerStore(storage)
    expect(reloaded.getState().market).toBe('spot')
    expect(reloaded.getState().starredSymbolsByMarket).toEqual({ spot: ['BTCUSDT', 'ETHUSDT'], tradfi: ['XAUUSDT'] })
    reloaded.getState().setMarket('tradfi')
    expect(reloaded.getState().starredSymbols).toEqual(['XAUUSDT'])
  })

  test('favorites remain independent across markets and reloads, including overlapping symbol names', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    expect(store.getState().market).toBe('spot')
    store.getState().toggleStarredSymbol('BTCUSDT')
    store.getState().toggleStarredSymbol('SHAREDUSDT')
    store.getState().setMarket('tradfi')
    expect(store.getState().starredSymbols).toEqual([])
    store.getState().toggleStarredSymbol('SHAREDUSDT')
    store.getState().toggleStarredSymbol('XAUUSDT')
    store.getState().toggleStarredSymbol('SHAREDUSDT')

    const reloaded = createScannerStore(storage)
    expect(reloaded.getState().market).toBe('tradfi')
    expect(reloaded.getState().starredSymbols).toEqual(['XAUUSDT'])
    reloaded.getState().setMarket('spot')
    expect(reloaded.getState().starredSymbols).toEqual(['BTCUSDT', 'SHAREDUSDT'])
    expect(reloaded.getState().starredSymbolsByMarket.tradfi).toEqual(['XAUUSDT'])
  })

  test('invalid saved markets default to Spot and malformed favorites are isolated to their own collection', () => {
    const store = createScannerStore(memoryStorage({
      market: 'futures',
      starredSymbols: ['LEGACYUSDT'],
      starredSymbolsByMarket: { spot: ['BTCUSDT', null, 'BTCUSDT'], tradfi: 'XAUUSDT' },
    }).storage)
    expect(store.getState().market).toBe('spot')
    expect(store.getState().starredSymbols).toEqual(['BTCUSDT'])
    store.getState().setMarket('tradfi')
    expect(store.getState().starredSymbols).toEqual([])
  })

  test('market subscribers see empty caches and a closed chart while other preferences are retained', () => {
    const store = createScannerStore(memoryStorage().storage)
    store.getState().applyScreenerPreferences(SELECTED)
    store.getState().toggleStarredSymbol('BTCUSDT')
    store.getState().selectSymbol('BTCUSDT')
    store.getState().updateSettings({ showVolume: true })
    const previous = store.getState()
    for (const symbol of ['BTCUSDT', 'XAUUSDT']) {
      setSymbolSnapshot(symbol, loadedSnapshot())
      setFeedStatus(symbol, { state: 'ready', updatedAt: 900_000, error: null })
    }
    const observed: unknown[] = []
    cleanups.push(store.subscribe((state) => observed.push({
      market: state.market,
      selectedSymbol: state.selectedSymbol,
      favorites: state.starredSymbols,
      bars: ['BTCUSDT', 'XAUUSDT'].map((symbol) => getSymbolSnapshot(symbol).bars.length),
      feeds: ['BTCUSDT', 'XAUUSDT'].map((symbol) => getFeedStatus(symbol).state),
    })))

    store.getState().setMarket('tradfi')

    expect(observed).toEqual([{
      market: 'tradfi', selectedSymbol: null, favorites: [], bars: [0, 0], feeds: ['loading', 'loading'],
    }])
    expect(store.getState().timeframe).toBe(previous.timeframe)
    expect(store.getState().screenerFilters).toBe(previous.screenerFilters)
    expect(store.getState().settings).toBe(previous.settings)
    expect(store.getState().cardDensity).toBe(previous.cardDensity)

    store.getState().selectSymbol('XAUUSDT')
    const loaded = loadedSnapshot()
    setSymbolSnapshot('XAUUSDT', loaded)
    const marketVersion = getSymbolStoreVersion()
    const feedVersion = getFeedStatusVersion()
    store.getState().setMarket('tradfi')
    expect(getSymbolSnapshot('XAUUSDT')).toBe(loaded)
    expect(getSymbolStoreVersion()).toBe(marketVersion)
    expect(getFeedStatusVersion()).toBe(feedVersion)
    expect(store.getState().selectedSymbol).toBe('XAUUSDT')
  })

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
        rsiState: 'extreme',
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
  test('tab changes use the existing indicator URL field and navigation updates RSI memory', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().updateScreenerFilters({ signal: 'divergence' })
    const browser = fakeBrowser('/screener?indicator=fib')
    cleanups.push(startScreenerPreferenceSync(store, browser))
    expect(store.getState().screenerFilters.signal).toBe('fib')
    expect(store.getState().lastRsiSignal).toBe('divergence')
    store.getState().setScreenerTab('rsi')
    expect(browser.location.search).toBe('?timeframe=15m&indicator=divergence')
    store.getState().setScreenerTab('fib')
    expect(browser.location.search).toBe('?timeframe=15m&indicator=fib')

    browser.navigate('/screener?timeframe=1h')
    expect(store.getState().lastRsiSignal).toBe('all')
    browser.navigate('/screener?indicator=fib')
    expect(store.getState().lastRsiSignal).toBe('all')
    browser.navigate('/screener?indicator=divergence')
    expect(store.getState().lastRsiSignal).toBe('divergence')
    store.getState().setScreenerTab('fib')
    const reloaded = createScannerStore(storage)
    reloaded.getState().setScreenerTab('rsi')
    expect(reloaded.getState().screenerFilters.signal).toBe('divergence')
  })

  test('Fib filters and templates persist through reload and a bare URL restores them', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().updateScreenerFilters({ signal: 'fib', fibDirection: 'long', fibStage: 'pocket', fibConfluence: 'aligned' })
    store.getState().updateFibSettings({ scale: 'log', stopRatio: 1.04, tp3Ratio: 0, tp4Ratio: -0.5, runnerRatio: -1 })
    const expected = preferences(store)
    const reloaded = createScannerStore(storage)
    const browser = fakeBrowser('/screener')

    cleanups.push(startScreenerPreferenceSync(reloaded, browser))

    expect(preferences(reloaded)).toEqual(expected)
    const params = new URLSearchParams(browser.location.search)
    expect(params.get('indicator')).toBe('fib')
    expect(params.get('fibSide')).toBe('long')
    expect(params.get('fibStage')).toBe('pocket')
    expect(params.get('fibTrend')).toBe('aligned')
    expect(params.get('fibScale')).toBe('log')
    expect(params.get('fibStop')).toBe('1.04')
    expect(params.get('fibTp3')).toBe('0')
    expect(params.get('fibTp4')).toBe('-0.5')
    expect(params.get('fibRunner')).toBe('-1')
  })

  test('Fib setting changes synchronize while filter reset retains the Fib tab and chosen template', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    const browser = fakeBrowser('/screener?timeframe=4h&density=compact&indicator=fib&fibSide=short&fibStage=waiting&fibTrend=aligned&sort=signals')
    cleanups.push(startScreenerPreferenceSync(store, browser))
    store.getState().updateFibSettings({ scale: 'log', stopRatio: 1.272, runnerRatio: -1 })
    store.getState().toggleStarredSymbol('BTCUSDT')
    store.getState().updateSettings({ showVolume: true })
    const template = store.getState().fibSettings
    expect(new URLSearchParams(browser.location.search).get('fibScale')).toBe('log')
    expect(new URLSearchParams(browser.location.search).get('fibStop')).toBe('1.272')
    expect(new URLSearchParams(browser.location.search).get('fibRunner')).toBe('-1')

    store.getState().resetScreenerFilters()

    expect(store.getState().screenerFilters).toEqual({ ...DEFAULT_FILTERS, signal: 'fib' })
    expect(store.getState().fibSettings).toBe(template)
    expect(store.getState().settings.showVolume).toBe(true)
    expect(store.getState().starredSymbols).toEqual(['BTCUSDT'])
    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, signal: 'fib', timeframe: '4h', cardDensity: 'compact', fibSettings: template,
    })
    const params = new URLSearchParams(browser.location.search)
    expect(params.get('indicator')).toBe('fib')
    expect(params.has('fibSide')).toBe(false)
    expect(params.has('fibStage')).toBe(false)
    expect(params.has('fibTrend')).toBe(false)
    expect(params.get('fibScale')).toBe('log')
    expect(preferences(createScannerStore(storage))).toEqual(preferences(store))
  })

  test('a Fib-only shared URL and browser navigation replace the complete template', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().applyScreenerPreferences(SELECTED)
    store.getState().updateFibSettings({ stopRatio: 1.272, tp3Ratio: 0, tp4Ratio: -1, runnerRatio: -2 })
    const browser = fakeBrowser('/screener?fibScale=log')
    cleanups.push(startScreenerPreferenceSync(store, browser))

    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, fibSettings: { ...DEFAULT_FIB_SETTINGS, scale: 'log' },
    })
    expect(preferences(createScannerStore(storage))).toEqual(preferences(store))
    browser.navigate('/screener?indicator=fib&fibSide=short&fibStage=active&fibTrend=aligned&fibStop=1.14&fibTp3=0&fibTp4=-0.5&fibRunner=-1')
    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES,
      signal: 'fib', fibDirection: 'short', fibStage: 'active', fibConfluence: 'aligned',
      fibSettings: { scale: 'linear', stopRatio: 1.14, tp3Ratio: 0, tp4Ratio: -0.5, runnerRatio: -1 },
    })
    browser.navigate('/screener?fibStage=invalid&fibTp3=&fibTp4=Infinity&fibRunner=-Infinity')
    expect(preferences(store)).toEqual(DEFAULT_SCREENER_PREFERENCES)
    expect(browser.location.search).toBe('?timeframe=15m')
  })

  test('legacy storage gets default Fib settings and malformed saved values remain safely editable', () => {
    const legacy = createScannerStore(memoryStorage({
      timeframe: '1h', screenerFilters: { signal: 'divergence', divergenceRecency: 5 },
    }).storage)
    expect(legacy.getState().fibSettings).toEqual(DEFAULT_FIB_SETTINGS)
    expect(legacy.getState().screenerFilters).toEqual({ ...DEFAULT_FILTERS, signal: 'divergence', divergenceRecency: 5 })
    const { storage } = memoryStorage({
      fibSettings: { scale: 'log', stopRatio: '1.04', tp3Ratio: false, tp4Ratio: 0, runnerRatio: -1 },
      screenerFilters: { signal: 'fib', fibDirection: 'bullish', fibStage: 'active', fibConfluence: 'unknown' },
    })
    const restored = createScannerStore(storage)
    expect(restored.getState().screenerFilters).toEqual({ ...DEFAULT_FILTERS, signal: 'fib', fibStage: 'active' })
    expect(restored.getState().fibSettings).toEqual({ ...DEFAULT_FIB_SETTINGS, scale: 'log', runnerRatio: -1 })
    restored.getState().updateFibSettings({ stopRatio: 1.04, tp4Ratio: NaN, runnerRatio: Infinity })
    expect(restored.getState().fibSettings).toEqual({ ...DEFAULT_FIB_SETTINGS, scale: 'log', stopRatio: 1.04 })
    restored.getState().updateFibSettings({ scale: 'Log', stopRatio: 1, tp3Ratio: '0' } as unknown as Partial<FibSettings>)
    expect(restored.getState().fibSettings).toEqual(DEFAULT_FIB_SETTINGS)
    expect(createScannerStore(storage).getState().fibSettings).toEqual(DEFAULT_FIB_SETTINGS)
  })

  test('market-only shared URLs override saved markets before the feed starts and persist on reload', () => {
    const { storage } = memoryStorage({ starredSymbols: ['BTCUSDT'] })
    const store = createScannerStore(storage)
    store.getState().selectSymbol('BTCUSDT')
    setSymbolSnapshot('BTCUSDT', loadedSnapshot())
    setFeedStatus('BTCUSDT', { state: 'ready', updatedAt: 900_000, error: null })
    const browser = fakeBrowser('/screener?market=tradfi')

    cleanups.push(startScreenerPreferenceSync(store, browser))

    expect(preferences(store)).toEqual({ ...DEFAULT_SCREENER_PREFERENCES, market: 'tradfi' })
    expect(store.getState().selectedSymbol).toBeNull()
    expect(store.getState().starredSymbols).toEqual([])
    expect(store.getState().starredSymbolsByMarket.spot).toEqual(['BTCUSDT'])
    expect(getSymbolSnapshot('BTCUSDT').bars).toEqual([])
    expect(getFeedStatus('BTCUSDT').state).toBe('loading')
    expect(browser.location.search).toBe('?timeframe=15m&market=tradfi')

    const reloaded = createScannerStore(storage)
    const bareBrowser = fakeBrowser('/screener')
    cleanups.push(startScreenerPreferenceSync(reloaded, bareBrowser))
    expect(reloaded.getState().market).toBe('tradfi')
    expect(bareBrowser.location.search).toBe('?timeframe=15m&market=tradfi')
    bareBrowser.navigate('/screener?market=spot')
    expect(reloaded.getState().market).toBe('spot')
    expect(reloaded.getState().starredSymbols).toEqual(['BTCUSDT'])
    expect(bareBrowser.location.search).toBe('?timeframe=15m')
    expect(createScannerStore(storage).getState().market).toBe('spot')
  })

  test('old shared URLs restore Spot over saved TradFi and browser navigation clears data at the same timeframe', () => {
    const store = createScannerStore(memoryStorage().storage)
    store.getState().toggleStarredSymbol('BTCUSDT')
    store.getState().setMarket('tradfi')
    store.getState().toggleStarredSymbol('XAUUSDT')
    const browser = fakeBrowser('/screener?timeframe=15m')
    cleanups.push(startScreenerPreferenceSync(store, browser))
    expect(store.getState().market).toBe('spot')
    expect(store.getState().starredSymbols).toEqual(['BTCUSDT'])
    store.getState().selectSymbol('BTCUSDT')
    setSymbolSnapshot('BTCUSDT', loadedSnapshot())
    setFeedStatus('BTCUSDT', { state: 'ready', updatedAt: 900_000, error: null })

    browser.navigate('/screener?market=tradfi&timeframe=15m')

    expect(store.getState().market).toBe('tradfi')
    expect(store.getState().starredSymbols).toEqual(['XAUUSDT'])
    expect(store.getState().selectedSymbol).toBeNull()
    expect(getSymbolSnapshot('BTCUSDT').bars).toEqual([])
    expect(getFeedStatus('BTCUSDT').state).toBe('loading')
  })

  test('market selection updates the URL and filter reset retains market and its favorites', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    const browser = fakeBrowser('/screener?timeframe=4h&density=compact&q=gold&sort=signals')
    cleanups.push(startScreenerPreferenceSync(store, browser))
    store.getState().setMarket('tradfi')
    store.getState().toggleStarredSymbol('XAUUSDT')
    expect(new URLSearchParams(browser.location.search).get('market')).toBe('tradfi')
    expect(new URLSearchParams(browser.location.search).get('q')).toBe('gold')

    store.getState().resetScreenerFilters()

    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, market: 'tradfi', timeframe: '4h', cardDensity: 'compact',
    })
    expect(store.getState().starredSymbols).toEqual(['XAUUSDT'])
    expect(browser.location.search).toBe('?timeframe=4h&market=tradfi&density=compact')
    expect(preferences(createScannerStore(storage))).toEqual(preferences(store))
  })

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
    expect(params.get('rsi')).toBe('either')
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

  test('an RSI-only shared URL replaces saved filters and persists its complete view', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    store.getState().applyScreenerPreferences(SELECTED)
    const browser = fakeBrowser('/screener?rsi=oversold')

    cleanups.push(startScreenerPreferenceSync(store, browser))

    const expected = { ...DEFAULT_SCREENER_PREFERENCES, rsiState: 'oversold' }
    expect(preferences(store)).toEqual(expected)
    expect(preferences(createScannerStore(storage))).toEqual(expected)
    expect(browser.location.search).toBe('?timeframe=15m&rsi=oversold')
  })

  test('filter edits and reset update the shareable URL and storage while retaining timeframe, density, and favorites', () => {
    const { storage } = memoryStorage()
    const store = createScannerStore(storage)
    const historyState = { router: 'keep me' }
    const browser = fakeBrowser('/screener?source=shared#rsi', historyState)
    cleanups.push(startScreenerPreferenceSync(store, browser))
    store.getState().toggleStarredSymbol('ETHUSDT')
    store.getState().applyScreenerPreferences(SELECTED)
    store.getState().updateScreenerFilters({ search: 'SOL + ETH', divergenceRecency: 5, rsiState: 'overbought', sort: 'rsi-low' })

    const selected = new URLSearchParams(browser.location.search)
    expect(selected.get('q')).toBe('SOL + ETH')
    expect(selected.get('candles')).toBe('5')
    expect(selected.get('rsi')).toBe('overbought')
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

    browser.navigate('/screener?q=BTC&indicator=divergence&candles=5&rsi=neutral&sort=change&timeframe=1h#price', historyState)

    expect(preferences(store)).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, search: 'BTC', signal: 'divergence',
      divergenceRecency: 5, rsiState: 'neutral', sort: 'change', timeframe: '1h',
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

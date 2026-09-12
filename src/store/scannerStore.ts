import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'
import { resetSymbolData } from './dataStore'
import { resetFeedStatus } from './feedStatusStore'
import { DEFAULT_SCREENER_PREFERENCES, restoreScreenerPreferences } from '../lib/screenerPreferences'
import type { ScreenerFilterPreferences, ScreenerPreferences } from '../lib/screenerPreferences'
import type { ScreenerMarket } from '../lib/markets'
import { DEFAULT_FIB_SETTINGS, restoreFibSettings } from '../lib/fibPreferences'
import type { FibSettings } from '../lib/fibPreferences'
import type {
  ChartSettings, SupportResistanceFilters, SupportResistanceSort, SupportResistanceView, Timeframe,
} from '../types'

export const DEFAULT_SETTINGS: ChartSettings = {
  rsiColor: '#8B46F2',
  smaColor: '#8B46F280',
  midlineColor: '#333333',
  lineWidth: 2,
  showPrice: true,
  showVolume: false,
  showDivergences: true,
  showHiddenDivergences: false,
  requireBodyAgreement: true,
  requireSameRsiCycle: true,
  divergenceInvalidationAnchor: 'second',
}

export const DEFAULT_STARRED_TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d']

export const DEFAULT_SUPPORT_RESISTANCE_FILTERS: SupportResistanceFilters = {
  side: 'any',
  maxDistancePercent: null,
  trend: 'any',
  minTouches: 1,
  breakFilter: 'all',
}

/** Preserve the selected side when migrating the old combined pending-break filter. */
export function restoreSupportResistanceFilters(
  saved?: Partial<SupportResistanceFilters> & { testingOnly?: boolean; pendingBreakoutsOnly?: boolean },
): SupportResistanceFilters {
  const { testingOnly, pendingBreakoutsOnly, breakFilter, ...filters } = saved ?? {}
  const legacyBreakFilter = (pendingBreakoutsOnly ?? testingOnly)
    ? filters.side === 'support' ? 'breakdowns'
      : filters.side === 'resistance' ? 'breakouts' : 'either'
    : 'all'
  return {
    ...DEFAULT_SUPPORT_RESISTANCE_FILTERS,
    ...filters,
    breakFilter: breakFilter === 'all' || breakFilter === 'breakouts' || breakFilter === 'breakdowns' || breakFilter === 'either'
      ? breakFilter : legacyBreakFilter,
  }
}

interface ScannerState {
  market: ScreenerMarket
  starredSymbols: string[]
  starredSymbolsByMarket: Record<ScreenerMarket, string[]>
  cardDensity: 'comfortable' | 'compact'
  timeframe: Timeframe
  cellSize: number
  starredTimeframes: Timeframe[]
  selectedSymbol: string | null
  settingsOpen: boolean
  settings: ChartSettings
  fibSettings: FibSettings
  screenerFilters: ScreenerFilterPreferences
  lastRsiSignal: 'all' | 'divergence'
  supportResistanceView: SupportResistanceView
  supportResistanceSort: SupportResistanceSort
  supportResistanceFilters: SupportResistanceFilters
  setMarket: (market: ScreenerMarket) => void
  toggleStarredSymbol: (symbol: string) => void
  setCardDensity: (density: 'comfortable' | 'compact') => void
  setScreenerTab: (tab: 'rsi' | 'fib' | 'sr' | 'harmonic') => void
  updateScreenerFilters: (patch: Partial<ScreenerFilterPreferences>) => void
  resetScreenerFilters: () => void
  applyScreenerPreferences: (preferences: ScreenerPreferences) => void
  setSupportResistanceView: (view: SupportResistanceView) => void
  setSupportResistanceSort: (sort: SupportResistanceSort) => void
  updateSupportResistanceFilters: (filters: Partial<SupportResistanceFilters>) => void
  resetSupportResistanceFilters: () => void
  setTimeframe: (timeframe: Timeframe) => void
  setCellSize: (cellSize: number) => void
  toggleStarredTimeframe: (timeframe: Timeframe) => void
  selectSymbol: (symbol: string) => void
  closeChart: () => void
  openSettings: () => void
  closeSettings: () => void
  updateSettings: (patch: Partial<ChartSettings>) => void
  updateFibSettings: (patch: Partial<FibSettings>) => void
}

const SORT_KEYS: readonly SupportResistanceSort[] = ['symbol', 'nearest', 'support', 'resistance']

function restoreChartSettings(saved?: Partial<ChartSettings>): ChartSettings {
  const settings = { ...DEFAULT_SETTINGS, ...saved, showDivergences: true }
  // Update the previous theme defaults while keeping explicitly chosen colors.
  if (typeof settings.rsiColor !== 'string' || ['#29ffb8', '#78cfbe', '#6b21d3'].includes(settings.rsiColor.toLowerCase())) settings.rsiColor = DEFAULT_SETTINGS.rsiColor
  if (typeof settings.smaColor !== 'string' || ['#4ec3fa', '#6b21d380'].includes(settings.smaColor.toLowerCase())) settings.smaColor = DEFAULT_SETTINGS.smaColor
  if (typeof settings.midlineColor !== 'string' || ['#39435a', '#e5e5e5'].includes(settings.midlineColor.toLowerCase())) settings.midlineColor = DEFAULT_SETTINGS.midlineColor
  return settings
}

function pickScreenerFilters({
  search, signal, divergenceRecency, fibDirection, fibStage, fibConfluence, srSource, srSignal, srSort, rsiState, starredOnly, sort,
  harmonicPattern, harmonicDirection, harmonicStage, harmonicSort,
}: ScreenerPreferences): ScreenerFilterPreferences {
  return {
    search, signal, divergenceRecency, fibDirection, fibStage, fibConfluence, srSource, srSignal, srSort, rsiState, starredOnly, sort,
    harmonicPattern, harmonicDirection, harmonicStage, harmonicSort,
  }
}

function restoreLastRsiSignal(signal: ScreenerFilterPreferences['signal'], saved: unknown): 'all' | 'divergence' {
  if (signal === 'all' || signal === 'divergence') return signal
  return saved === 'divergence' ? 'divergence' : 'all'
}

function restoreStarredSymbols(input: unknown): string[] {
  return Array.isArray(input)
    ? [...new Set(input.filter((symbol): symbol is string => typeof symbol === 'string'))] : []
}

/** The original unscoped favorites belong to Spot, including when opening a TradFi URL. */
function restoreStarredSymbolsByMarket(saved?: Partial<ScannerState>): Record<ScreenerMarket, string[]> {
  const favorites = saved?.starredSymbolsByMarket
  if (favorites === null || typeof favorites !== 'object' || Array.isArray(favorites)) {
    return { spot: restoreStarredSymbols(saved?.starredSymbols), tradfi: [] }
  }
  return { spot: restoreStarredSymbols(favorites.spot), tradfi: restoreStarredSymbols(favorites.tradfi) }
}

/** Storage may be blocked or full; controls and shareable URLs must still work. */
function safeStorage(storage?: StateStorage): StateStorage {
  return {
    getItem: (name) => {
      try {
        const value = (storage ?? localStorage).getItem(name)
        return value instanceof Promise ? value.catch(() => null) : value
      } catch { return null }
    },
    setItem: (name, value) => {
      try {
        const result = (storage ?? localStorage).setItem(name, value)
        if (result instanceof Promise) return result.catch(() => undefined)
      } catch { /* Keep in-memory preferences when storage is unavailable. */ }
    },
    removeItem: (name) => {
      try {
        const result = (storage ?? localStorage).removeItem(name)
        if (result instanceof Promise) return result.catch(() => undefined)
      } catch { /* Storage can also be unavailable when clearing preferences. */ }
    },
  }
}

export const createScannerStore = (storage?: StateStorage) => create<ScannerState>()(
  persist(
    (set, get) => ({
      market: DEFAULT_SCREENER_PREFERENCES.market,
      starredSymbols: [],
      starredSymbolsByMarket: { spot: [], tradfi: [] },
      cardDensity: DEFAULT_SCREENER_PREFERENCES.cardDensity,
      timeframe: DEFAULT_SCREENER_PREFERENCES.timeframe,
      cellSize: 120,
      starredTimeframes: DEFAULT_STARRED_TIMEFRAMES,
      selectedSymbol: null,
      settingsOpen: false,
      settings: DEFAULT_SETTINGS,
      fibSettings: { ...DEFAULT_FIB_SETTINGS },
      screenerFilters: pickScreenerFilters(DEFAULT_SCREENER_PREFERENCES),
      lastRsiSignal: 'all',
      supportResistanceView: 'cards',
      supportResistanceSort: 'symbol',
      supportResistanceFilters: DEFAULT_SUPPORT_RESISTANCE_FILTERS,
      setMarket: (market) => {
        const state = get()
        if (state.market === market) return
        resetSymbolData()
        resetFeedStatus()
        set({ market, selectedSymbol: null, starredSymbols: state.starredSymbolsByMarket[market] })
      },
      toggleStarredSymbol: (symbol) => set((state) => {
        const starredSymbols = state.starredSymbols.includes(symbol)
          ? state.starredSymbols.filter((item) => item !== symbol)
          : [...state.starredSymbols, symbol]
        return {
          starredSymbols,
          starredSymbolsByMarket: { ...state.starredSymbolsByMarket, [state.market]: starredSymbols },
        }
      }),
      setCardDensity: (cardDensity) => set({ cardDensity }),
      setScreenerTab: (tab) => set((state) => {
        const lastRsiSignal = restoreLastRsiSignal(state.screenerFilters.signal, state.lastRsiSignal)
        return {
          lastRsiSignal,
          screenerFilters: { ...state.screenerFilters, signal: tab === 'rsi' ? lastRsiSignal : tab },
        }
      }),
      updateScreenerFilters: (patch) => set((state) => {
        const screenerFilters = pickScreenerFilters(restoreScreenerPreferences({ ...state.screenerFilters, ...patch }))
        return {
          screenerFilters,
          lastRsiSignal: restoreLastRsiSignal(screenerFilters.signal, state.lastRsiSignal),
        }
      }),
      resetScreenerFilters: () => set((state) => ({
        screenerFilters: {
          ...pickScreenerFilters(DEFAULT_SCREENER_PREFERENCES),
          signal: state.screenerFilters.signal === 'all' || state.screenerFilters.signal === 'divergence' ? 'all' : state.screenerFilters.signal,
        },
        lastRsiSignal: state.screenerFilters.signal === 'all' || state.screenerFilters.signal === 'divergence' ? 'all' : state.lastRsiSignal,
      })),
      applyScreenerPreferences: (preferences) => {
        const restored = restoreScreenerPreferences(preferences)
        const state = get()
        const marketChanged = state.market !== restored.market
        if (marketChanged || state.timeframe !== restored.timeframe) {
          resetSymbolData()
          resetFeedStatus()
        }
        set({
          market: restored.market,
          starredSymbols: state.starredSymbolsByMarket[restored.market],
          selectedSymbol: marketChanged ? null : state.selectedSymbol,
          screenerFilters: pickScreenerFilters(restored),
          lastRsiSignal: restoreLastRsiSignal(restored.signal, state.lastRsiSignal),
          timeframe: restored.timeframe,
          cardDensity: restored.cardDensity,
          fibSettings: restored.fibSettings,
        })
      },
      setSupportResistanceView: (supportResistanceView) => set({ supportResistanceView }),
      setSupportResistanceSort: (supportResistanceSort) => set({ supportResistanceSort }),
      updateSupportResistanceFilters: (filters) => set((state) => ({
        supportResistanceFilters: { ...state.supportResistanceFilters, ...filters },
      })),
      resetSupportResistanceFilters: () => set({ supportResistanceFilters: DEFAULT_SUPPORT_RESISTANCE_FILTERS }),
      setTimeframe: (timeframe) => {
        if (get().timeframe === timeframe) return
        // Clear synchronously so the new timeframe never labels the old candles
        // during the market-wide subscription's throttle window.
        resetSymbolData()
        resetFeedStatus()
        set({ timeframe })
      },
      setCellSize: (cellSize) => set({ cellSize }),
      toggleStarredTimeframe: (timeframe) => set((state) => ({
        starredTimeframes: state.starredTimeframes.includes(timeframe)
          ? state.starredTimeframes.filter((tf) => tf !== timeframe)
          : [...state.starredTimeframes, timeframe],
      })),
      selectSymbol: (selectedSymbol) => set({ selectedSymbol }),
      closeChart: () => set({ selectedSymbol: null }),
      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),
      updateSettings: (patch) => set((state) => ({
        settings: { ...state.settings, ...patch },
      })),
      updateFibSettings: (patch) => set((state) => ({
        fibSettings: restoreFibSettings({ ...state.fibSettings, ...patch }),
      })),
    }),
    {
      name: 'rsi-scanner-preferences',
      storage: createJSONStorage(() => safeStorage(storage)),
      partialize: ({
        market, starredSymbolsByMarket, cardDensity, timeframe, cellSize, starredTimeframes, settings, fibSettings, screenerFilters, lastRsiSignal,
        supportResistanceView, supportResistanceSort, supportResistanceFilters,
      }) => ({
        market, starredSymbolsByMarket, cardDensity, timeframe, cellSize, starredTimeframes, settings, fibSettings, screenerFilters, lastRsiSignal,
        supportResistanceView, supportResistanceSort, supportResistanceFilters,
      }),
      // Keep defaults for preferences added after a user's settings were saved.
      merge: (persisted, current) => {
        const saved = persisted as Partial<ScannerState> | undefined
        const { market, timeframe, cardDensity } = restoreScreenerPreferences(saved)
        const screenerFilters = pickScreenerFilters(restoreScreenerPreferences(saved?.screenerFilters))
        const starredSymbolsByMarket = restoreStarredSymbolsByMarket(saved)
        return {
          ...current,
          ...saved,
          market,
          starredSymbols: starredSymbolsByMarket[market],
          starredSymbolsByMarket,
          timeframe,
          cardDensity,
          screenerFilters,
          lastRsiSignal: restoreLastRsiSignal(screenerFilters.signal, saved?.lastRsiSignal),
          settings: restoreChartSettings(saved?.settings),
          fibSettings: restoreFibSettings(saved?.fibSettings),
          supportResistanceView: saved?.supportResistanceView === 'list' ? 'list' : 'cards',
          supportResistanceSort: SORT_KEYS.find((key) => key === saved?.supportResistanceSort) ?? 'symbol',
          supportResistanceFilters: restoreSupportResistanceFilters(saved?.supportResistanceFilters),
        }
      },
    },
  ),
)

export const useScannerStore = createScannerStore()

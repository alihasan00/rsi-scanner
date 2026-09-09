import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { StateStorage } from 'zustand/middleware'
import { resetSymbolData } from './dataStore'
import { resetFeedStatus } from './feedStatusStore'
import { DEFAULT_SCREENER_PREFERENCES, restoreScreenerPreferences } from '../lib/screenerPreferences'
import type { ScreenerFilterPreferences, ScreenerPreferences } from '../lib/screenerPreferences'
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
  starredSymbols: string[]
  cardDensity: 'comfortable' | 'compact'
  timeframe: Timeframe
  cellSize: number
  starredTimeframes: Timeframe[]
  selectedSymbol: string | null
  settingsOpen: boolean
  settings: ChartSettings
  screenerFilters: ScreenerFilterPreferences
  supportResistanceView: SupportResistanceView
  supportResistanceSort: SupportResistanceSort
  supportResistanceFilters: SupportResistanceFilters
  toggleStarredSymbol: (symbol: string) => void
  setCardDensity: (density: 'comfortable' | 'compact') => void
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

function pickScreenerFilters({ search, signal, divergenceRecency, rsiState, starredOnly, sort }: ScreenerPreferences): ScreenerFilterPreferences {
  return { search, signal, divergenceRecency, rsiState, starredOnly, sort }
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
      starredSymbols: [],
      cardDensity: DEFAULT_SCREENER_PREFERENCES.cardDensity,
      timeframe: DEFAULT_SCREENER_PREFERENCES.timeframe,
      cellSize: 120,
      starredTimeframes: DEFAULT_STARRED_TIMEFRAMES,
      selectedSymbol: null,
      settingsOpen: false,
      settings: DEFAULT_SETTINGS,
      screenerFilters: pickScreenerFilters(DEFAULT_SCREENER_PREFERENCES),
      supportResistanceView: 'cards',
      supportResistanceSort: 'symbol',
      supportResistanceFilters: DEFAULT_SUPPORT_RESISTANCE_FILTERS,
      toggleStarredSymbol: (symbol) => set((state) => ({
        starredSymbols: state.starredSymbols.includes(symbol)
          ? state.starredSymbols.filter((item) => item !== symbol)
          : [...state.starredSymbols, symbol],
      })),
      setCardDensity: (cardDensity) => set({ cardDensity }),
      updateScreenerFilters: (patch) => set((state) => ({
        screenerFilters: pickScreenerFilters(restoreScreenerPreferences({ ...state.screenerFilters, ...patch })),
      })),
      resetScreenerFilters: () => set({ screenerFilters: pickScreenerFilters(DEFAULT_SCREENER_PREFERENCES) }),
      applyScreenerPreferences: (preferences) => {
        const restored = restoreScreenerPreferences(preferences)
        if (get().timeframe !== restored.timeframe) {
          resetSymbolData()
          resetFeedStatus()
        }
        set({
          screenerFilters: pickScreenerFilters(restored),
          timeframe: restored.timeframe,
          cardDensity: restored.cardDensity,
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
    }),
    {
      name: 'rsi-scanner-preferences',
      storage: createJSONStorage(() => safeStorage(storage)),
      partialize: ({
        starredSymbols, cardDensity, timeframe, cellSize, starredTimeframes, settings, screenerFilters,
        supportResistanceView, supportResistanceSort, supportResistanceFilters,
      }) => ({
        starredSymbols, cardDensity, timeframe, cellSize, starredTimeframes, settings, screenerFilters,
        supportResistanceView, supportResistanceSort, supportResistanceFilters,
      }),
      // Keep defaults for preferences added after a user's settings were saved.
      merge: (persisted, current) => {
        const saved = persisted as Partial<ScannerState> | undefined
        const { timeframe, cardDensity } = restoreScreenerPreferences(saved)
        return {
          ...current,
          ...saved,
          starredSymbols: Array.isArray(saved?.starredSymbols)
            ? saved.starredSymbols.filter((symbol): symbol is string => typeof symbol === 'string') : [],
          timeframe,
          cardDensity,
          screenerFilters: pickScreenerFilters(restoreScreenerPreferences(saved?.screenerFilters)),
          settings: restoreChartSettings(saved?.settings),
          supportResistanceView: saved?.supportResistanceView === 'list' ? 'list' : 'cards',
          supportResistanceSort: SORT_KEYS.find((key) => key === saved?.supportResistanceSort) ?? 'symbol',
          supportResistanceFilters: restoreSupportResistanceFilters(saved?.supportResistanceFilters),
        }
      },
    },
  ),
)

export const useScannerStore = createScannerStore()

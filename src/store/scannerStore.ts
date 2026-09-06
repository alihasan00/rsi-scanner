import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  ChartSettings, ScannerTab, SupportResistanceFilters, SupportResistanceSort, SupportResistanceView, Timeframe,
} from '../types'

export const DEFAULT_SETTINGS: ChartSettings = {
  rsiColor: '#29ffb8',
  smaColor: '#4ec3fa',
  midlineColor: '#39435a',
  lineWidth: 2,
  showPrice: true,
  showVolume: false,
  showDivergences: false,
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
  scannerTab: ScannerTab
  timeframe: Timeframe
  cellSize: number
  starredTimeframes: Timeframe[]
  selectedSymbol: string | null
  settingsOpen: boolean
  settings: ChartSettings
  supportResistanceView: SupportResistanceView
  supportResistanceSort: SupportResistanceSort
  supportResistanceFilters: SupportResistanceFilters
  setScannerTab: (scannerTab: ScannerTab) => void
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

export const useScannerStore = create<ScannerState>()(
  persist(
    (set) => ({
      scannerTab: 'rsi',
      timeframe: '15m',
      cellSize: 120,
      starredTimeframes: DEFAULT_STARRED_TIMEFRAMES,
      selectedSymbol: null,
      settingsOpen: false,
      settings: DEFAULT_SETTINGS,
      supportResistanceView: 'cards',
      supportResistanceSort: 'symbol',
      supportResistanceFilters: DEFAULT_SUPPORT_RESISTANCE_FILTERS,
      setScannerTab: (scannerTab) => set({ scannerTab, selectedSymbol: null, settingsOpen: false }),
      setSupportResistanceView: (supportResistanceView) => set({ supportResistanceView }),
      setSupportResistanceSort: (supportResistanceSort) => set({ supportResistanceSort }),
      updateSupportResistanceFilters: (filters) => set((state) => ({
        supportResistanceFilters: { ...state.supportResistanceFilters, ...filters },
      })),
      resetSupportResistanceFilters: () => set({ supportResistanceFilters: DEFAULT_SUPPORT_RESISTANCE_FILTERS }),
      setTimeframe: (timeframe) => set({ timeframe }),
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
      partialize: ({
        scannerTab, timeframe, cellSize, starredTimeframes, settings,
        supportResistanceView, supportResistanceSort, supportResistanceFilters,
      }) => ({
        scannerTab, timeframe, cellSize, starredTimeframes, settings,
        supportResistanceView, supportResistanceSort, supportResistanceFilters,
      }),
      // Keep defaults for preferences added after a user's settings were saved.
      merge: (persisted, current) => {
        const saved = persisted as Partial<ScannerState> | undefined
        return {
          ...current,
          ...saved,
          scannerTab: saved?.scannerTab === 'support-resistance' ? 'support-resistance' : 'rsi',
          settings: { ...DEFAULT_SETTINGS, ...saved?.settings },
          supportResistanceView: saved?.supportResistanceView === 'list' ? 'list' : 'cards',
          supportResistanceSort: SORT_KEYS.find((key) => key === saved?.supportResistanceSort) ?? 'symbol',
          supportResistanceFilters: restoreSupportResistanceFilters(saved?.supportResistanceFilters),
        }
      },
    },
  ),
)

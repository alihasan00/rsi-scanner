import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChartSettings, Timeframe } from '../types'

export const DEFAULT_SETTINGS: ChartSettings = {
  rsiColor: '#29ffb8',
  smaColor: '#4ec3fa',
  midlineColor: '#39435a',
  lineWidth: 2,
  showPrice: true,
  showVolume: false,
}

export const DEFAULT_STARRED_TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d']

interface ScannerState {
  timeframe: Timeframe
  cellSize: number
  starredTimeframes: Timeframe[]
  selectedSymbol: string | null
  settingsOpen: boolean
  settings: ChartSettings
  setTimeframe: (timeframe: Timeframe) => void
  setCellSize: (cellSize: number) => void
  toggleStarredTimeframe: (timeframe: Timeframe) => void
  selectSymbol: (symbol: string) => void
  closeChart: () => void
  openSettings: () => void
  closeSettings: () => void
  updateSettings: (patch: Partial<ChartSettings>) => void
}

export const useScannerStore = create<ScannerState>()(
  persist(
    (set) => ({
      timeframe: '15m',
      cellSize: 120,
      starredTimeframes: DEFAULT_STARRED_TIMEFRAMES,
      selectedSymbol: null,
      settingsOpen: false,
      settings: DEFAULT_SETTINGS,
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
      partialize: ({ timeframe, cellSize, starredTimeframes, settings }) => (
        { timeframe, cellSize, starredTimeframes, settings }
      ),
    },
  ),
)

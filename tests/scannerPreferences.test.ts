import { expect, test } from 'bun:test'
import type { SymbolSnapshot } from '../src/types'
import { useScannerStore } from '../src/store/scannerStore'
import {
  getSymbolSnapshot,
  getSymbolStoreVersion,
  resetSymbolData,
  setSymbolSnapshot,
} from '../src/store/dataStore'
import {
  getFeedStatus,
  getFeedStatusVersion,
  resetFeedStatus,
  setFeedStatus,
} from '../src/store/feedStatusStore'

function snapshot(duration: number, close: number): SymbolSnapshot {
  return {
    price: close,
    volume: 10,
    series: [55],
    bars: [{
      openTime: 0, closeTime: duration - 1,
      open: 100, high: 110, low: 90, close, volume: 10, rsi: 55, isClosed: true,
    }],
  }
}

test('timeframe subscribers see cleared market data immediately, while same-timeframe selections preserve data and preferences', () => {
  const original = useScannerStore.getState()
  let unsubscribe = () => {}
  try {
    useScannerStore.setState({ timeframe: '15m', starredSymbols: ['BTCUSDT', 'ETHUSDT'], cardDensity: 'compact' })
    const favorites = useScannerStore.getState().starredSymbols
    setSymbolSnapshot('BTCUSDT', snapshot(15 * 60_000, 105))
    setSymbolSnapshot('ETHUSDT', snapshot(15 * 60_000, 95))
    setFeedStatus('BTCUSDT', { state: 'ready', updatedAt: 900_000, error: null })
    setFeedStatus('ETHUSDT', { state: 'error', updatedAt: 900_000, error: 'Disconnected' })

    const observed: Array<{ timeframe: string; snapshots: SymbolSnapshot[]; statuses: ReturnType<typeof getFeedStatus>[] }> = []
    unsubscribe = useScannerStore.subscribe((state, previous) => {
      if (state.timeframe === previous.timeframe) return
      // Read in the synchronous timeframe callback, before any throttled
      // market-wide subscriber gets a chance to refresh its rendered rows.
      observed.push({
        timeframe: state.timeframe,
        snapshots: ['BTCUSDT', 'ETHUSDT'].map(getSymbolSnapshot),
        statuses: ['BTCUSDT', 'ETHUSDT'].map(getFeedStatus),
      })
    })

    useScannerStore.getState().setTimeframe('1h')

    expect(observed).toEqual([{
      timeframe: '1h',
      snapshots: [
        { price: 0, volume: 0, series: [], bars: [] },
        { price: 0, volume: 0, series: [], bars: [] },
      ],
      statuses: [
        { state: 'loading', updatedAt: null, error: null },
        { state: 'loading', updatedAt: null, error: null },
      ],
    }])
    expect(useScannerStore.getState().starredSymbols).toBe(favorites)
    expect(useScannerStore.getState().cardDensity).toBe('compact')

    const hourly = snapshot(60 * 60_000, 108)
    const ready = { state: 'ready' as const, updatedAt: 3_600_000, error: null }
    setSymbolSnapshot('BTCUSDT', hourly)
    setFeedStatus('BTCUSDT', ready)
    const marketVersion = getSymbolStoreVersion()
    const feedVersion = getFeedStatusVersion()

    useScannerStore.getState().setTimeframe('1h')

    expect(getSymbolSnapshot('BTCUSDT')).toBe(hourly)
    expect(getFeedStatus('BTCUSDT')).toBe(ready)
    expect(getSymbolStoreVersion()).toBe(marketVersion)
    expect(getFeedStatusVersion()).toBe(feedVersion)
    expect(observed).toHaveLength(1)
    expect(useScannerStore.getState().starredSymbols).toBe(favorites)
    expect(useScannerStore.getState().cardDensity).toBe('compact')
  } finally {
    unsubscribe()
    useScannerStore.setState(original, true)
    resetSymbolData()
    resetFeedStatus()
  }
})

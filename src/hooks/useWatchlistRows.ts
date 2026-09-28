import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { createWatchlistAnalysisCache } from '../lib/watchlistAnalysis'
import { buildWatchlistRows, getWatchlistFreshness, sortWatchlistRows } from '../lib/watchlist'
import type { WatchlistRow } from '../lib/watchlist'
import { getSymbolSnapshot, getSymbolStoreVersion, subscribeAllSymbols } from '../store/dataStore'
import { getFeedStatus, getFeedStatusVersion, subscribeAllFeedStatuses } from '../store/feedStatusStore'
import { getSrContext, getSrContextVersion, subscribeAllSrContexts } from '../store/srContextStore'
import { useScannerStore } from '../store/scannerStore'

const version = () => `${getSymbolStoreVersion()}:${getFeedStatusVersion()}:${getSrContextVersion()}`

export function useWatchlistRows(symbols: readonly string[]) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // Disconnected feeds still age out, even when no new tick arrives.
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])
  const market = useScannerStore((state) => state.market)
  const timeframe = useScannerStore((state) => state.timeframe)
  const fibOptions = useScannerStore((state) => state.fibSettings)
  const divergenceOptions = useScannerStore(useShallow((state) => ({
    includeHidden: state.settings.showHiddenDivergences,
    requireBodyAgreement: state.settings.requireBodyAgreement,
    requireSameRsiCycle: state.settings.requireSameRsiCycle,
    invalidationAnchor: state.settings.divergenceInvalidationAnchor,
  })))
  const cache = useMemo(() => createWatchlistAnalysisCache(Math.max(128, symbols.length)), [symbols.length])
  const subscribe = useCallback((notify: () => void) => {
    let pending: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (pending !== null) return
      pending = setTimeout(() => { pending = null; notify() }, 500)
    }
    const unsubscribe = [subscribeAllSymbols(schedule), subscribeAllFeedStatuses(schedule), subscribeAllSrContexts(schedule)]
    return () => {
      unsubscribe.forEach((stop) => stop())
      if (pending !== null) clearTimeout(pending)
    }
  }, [])
  const currentVersion = useSyncExternalStore(subscribe, version, version)
  return useMemo(() => {
    const coverage = { total: symbols.length, fresh: 0, loading: 0, delayed: 0, error: 0 }
    const rows: WatchlistRow[] = []
    for (const symbol of symbols) {
      const snapshot = getSymbolSnapshot(symbol)
      const feed = getFeedStatus(symbol)
      const freshness = getWatchlistFreshness({ snapshot, feed, timeframe, now })
      coverage[freshness]++
      if (!snapshot.bars.length) continue
      const daily = getSrContext(symbol)
      const analysis = cache.get({
        symbol, market, timeframe, bars: snapshot.bars, divergenceOptions, fibOptions,
        calendarMap: daily.status === 'ready' ? daily.map : null,
      })
      rows.push(...buildWatchlistRows({ symbol, market, timeframe, snapshot, feed, ...analysis, now }))
    }
    return { rows: sortWatchlistRows(rows), coverage, now }
  }, [symbols, market, timeframe, fibOptions, divergenceOptions, cache, currentVersion, now]) // eslint-disable-line react-hooks/exhaustive-deps
}

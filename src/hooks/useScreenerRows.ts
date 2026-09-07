import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { SYMBOLS } from '../lib/symbols'
import { getScreenerAnalysis } from '../lib/screener'
import type { ScreenerRow } from '../lib/screener'
import { previewTugOfWar } from '../lib/tugOfWar'
import { getSymbolSnapshot, subscribeAllSymbols, getSymbolStoreVersion } from '../store/dataStore'
import { getFeedStatus, getFeedStatusVersion, subscribeAllFeedStatuses } from '../store/feedStatusStore'
import { useScannerStore } from '../store/scannerStore'
const rowCache = new Map<string, ScreenerRow>()
const version = () => `${getSymbolStoreVersion()}:${getFeedStatusVersion()}`

/** Batch market-wide filters to twice a second rather than on every socket tick. */
export function useScreenerRows() {
  const settings = useScannerStore(useShallow((state) => ({
    showHiddenDivergences: state.settings.showHiddenDivergences,
    requireBodyAgreement: state.settings.requireBodyAgreement,
    requireSameRsiCycle: state.settings.requireSameRsiCycle,
    divergenceInvalidationAnchor: state.settings.divergenceInvalidationAnchor,
  })))
  const subscribe = useCallback((notify: () => void) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (timer !== null) return
      timer = setTimeout(() => { timer = null; notify() }, 500)
    }
    const unsubscribeData = subscribeAllSymbols(schedule)
    const unsubscribeStatus = subscribeAllFeedStatuses(schedule)
    return () => { unsubscribeData(); unsubscribeStatus(); if (timer !== null) clearTimeout(timer) }
  }, [])
  const currentVersion = useSyncExternalStore(subscribe, version, version)
  return useMemo(() => SYMBOLS.map((symbol) => {
    const snapshot = getSymbolSnapshot(symbol)
    const analysis = getScreenerAnalysis(symbol, snapshot.bars, settings)
    const feed = getFeedStatus(symbol)
    const cached = rowCache.get(symbol)
    if (cached?.snapshot === snapshot && cached.analysis === analysis && cached.feed === feed) return cached
    const row = { symbol, snapshot, analysis, feed, preview: previewTugOfWar(snapshot.bars, analysis.tugOfWar) }
    rowCache.set(symbol, row)
    return row
  }), [settings, currentVersion]) // eslint-disable-line react-hooks/exhaustive-deps
}

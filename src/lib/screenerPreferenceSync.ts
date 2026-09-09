import { useScannerStore } from '../store/scannerStore'
import type { createScannerStore } from '../store/scannerStore'
import { readScreenerPreferencesFromSearch, writeScreenerPreferencesToSearch } from './screenerPreferences'

interface PreferenceBrowser {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>
  history: Pick<History, 'state' | 'replaceState'>
  addEventListener: (type: 'popstate', listener: () => void) => void
  removeEventListener: (type: 'popstate', listener: () => void) => void
}

/** Start before rendering so the feed uses the shared timeframe on its first request. */
export function startScreenerPreferenceSync(
  store: ReturnType<typeof createScannerStore> = useScannerStore,
  browser: PreferenceBrowser = window,
): () => void {
  const writeUrl = () => {
    const { screenerFilters, timeframe, cardDensity } = store.getState()
    const { pathname, search, hash } = browser.location
    const nextSearch = writeScreenerPreferencesToSearch(search, { ...screenerFilters, timeframe, cardDensity })
    if (nextSearch === search) return
    try {
      browser.history.replaceState(browser.history.state, '', `${pathname}${nextSearch}${hash}`)
    } catch { /* Local preferences still work if the browser blocks history writes. */ }
  }

  const readUrl = () => {
    const preferences = readScreenerPreferencesFromSearch(browser.location.search)
    if (preferences) store.getState().applyScreenerPreferences(preferences)
    writeUrl()
  }

  readUrl()
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.screenerFilters !== previous.screenerFilters
      || state.timeframe !== previous.timeframe || state.cardDensity !== previous.cardDensity) writeUrl()
  })
  browser.addEventListener('popstate', readUrl)
  return () => {
    unsubscribe()
    browser.removeEventListener('popstate', readUrl)
  }
}

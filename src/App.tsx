import { lazy, Suspense, useMemo } from 'react'
import { Header } from './components/Header'
import { ScreenerGrid } from './components/ScreenerGrid'
import { useRsiFeed } from './hooks/useRsiFeed'
import { useMarketUniverse } from './hooks/useMarketUniverse'
import { useScannerStore } from './store/scannerStore'
import { useSrContextFeed } from './hooks/useSrContext'

const ChartModal = lazy(() => import('./components/ChartModal').then(
  (module) => ({ default: module.ChartModal }),
))
const SettingsDrawer = lazy(() => import('./components/SettingsDrawer').then(
  (module) => ({ default: module.SettingsDrawer }),
))
const CoinFamilies = lazy(() => import('./components/CoinFamilies').then(
  (module) => ({ default: module.CoinFamilies }),
))
const NO_SYMBOLS: readonly string[] = []

function App() {
  const appView = useScannerStore((state) => state.appView)
  const market = useScannerStore((state) => state.market)
  const selectedSymbol = useScannerStore((state) => state.selectedSymbol)
  const settingsOpen = useScannerStore((state) => state.settingsOpen)
  const showLiquidity = useScannerStore((state) => state.appView === 'scanner' && state.screenerFilters.signal === 'sr')

  const universe = useMarketUniverse(market)
  const rsiSymbols = useMemo(() => {
    if (appView === 'scanner') return universe.symbols
    return selectedSymbol ? [selectedSymbol] : NO_SYMBOLS
  }, [appView, selectedSymbol, universe.symbols])
  useRsiFeed(rsiSymbols, market)
  const contextSymbols = useMemo(() => showLiquidity ? universe.symbols : selectedSymbol ? [selectedSymbol] : [], [showLiquidity, universe.symbols, selectedSymbol])
  useSrContextFeed(contextSymbols, market, contextSymbols.length > 0, showLiquidity ? 'liquidity' : 'selected')

  return (
    <div className="app-shell">
      <Header />
      <main className="scanner-panel" id="screener-panel">
        {appView === 'families' ? (
          <Suspense fallback={<div className="app-view-loading" role="status">Loading coin families…</div>}>
            <CoinFamilies />
          </Suspense>
        ) : <ScreenerGrid key={market} universe={universe} />}
      </main>
      {selectedSymbol && (
        <Suspense fallback={null}>
          <ChartModal key={appView} />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDrawer />
        </Suspense>
      )}
    </div>
  )
}

export default App

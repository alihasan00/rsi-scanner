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

function App() {
  const market = useScannerStore((state) => state.market)
  const selectedSymbol = useScannerStore((state) => state.selectedSymbol)
  const settingsOpen = useScannerStore((state) => state.settingsOpen)
  const showLiquidity = useScannerStore((state) => state.screenerFilters.signal === 'sr')

  const universe = useMarketUniverse(market)
  useRsiFeed(universe.symbols, market)
  const contextSymbols = useMemo(() => showLiquidity ? universe.symbols : selectedSymbol ? [selectedSymbol] : [], [showLiquidity, universe.symbols, selectedSymbol])
  useSrContextFeed(contextSymbols, market, contextSymbols.length > 0, showLiquidity ? 'liquidity' : 'selected')

  return (
    <div className="app-shell">
      <Header />
      <main className="scanner-panel" id="screener-panel">
        <ScreenerGrid key={market} universe={universe} />
      </main>
      {selectedSymbol && (
        <Suspense fallback={null}>
          <ChartModal />
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

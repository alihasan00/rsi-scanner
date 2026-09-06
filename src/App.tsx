import { lazy, Suspense } from 'react'
import { Header } from './components/Header'
import { RsiGrid } from './components/RsiGrid'
import { SupportResistanceGrid } from './components/SupportResistanceGrid'
import { useRsiFeed } from './hooks/useRsiFeed'
import { useScannerStore } from './store/scannerStore'

const ChartModal = lazy(() => import('./components/ChartModal').then(
  (module) => ({ default: module.ChartModal }),
))
const SettingsDrawer = lazy(() => import('./components/SettingsDrawer').then(
  (module) => ({ default: module.SettingsDrawer }),
))

function App() {
  const scannerTab = useScannerStore((state) => state.scannerTab)
  const selectedSymbol = useScannerStore((state) => state.selectedSymbol)
  const settingsOpen = useScannerStore((state) => state.settingsOpen)

  useRsiFeed()

  return (
    <div className="app-shell">
      <Header />
      <main
        className="scanner-panel"
        id={`${scannerTab}-panel`}
        role="tabpanel"
        aria-labelledby={`${scannerTab}-tab`}
        tabIndex={0}
      >
        {scannerTab === 'rsi' ? <RsiGrid /> : <SupportResistanceGrid />}
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

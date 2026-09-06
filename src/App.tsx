import { lazy, Suspense } from 'react'
import { Header } from './components/Header'
import { RsiGrid } from './components/RsiGrid'
import { useRsiFeed } from './hooks/useRsiFeed'
import { useScannerStore } from './store/scannerStore'

const ChartModal = lazy(() => import('./components/ChartModal').then(
  (module) => ({ default: module.ChartModal }),
))
const SettingsDrawer = lazy(() => import('./components/SettingsDrawer').then(
  (module) => ({ default: module.SettingsDrawer }),
))

function App() {
  const selectedSymbol = useScannerStore((state) => state.selectedSymbol)
  const settingsOpen = useScannerStore((state) => state.settingsOpen)

  useRsiFeed()

  return (
    <div className="app-shell">
      <Header />
      <RsiGrid />
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

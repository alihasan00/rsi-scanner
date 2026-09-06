import { useState } from 'react'
import { Button, Checkbox, Slider, Space, Tooltip } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import { useScannerStore } from '../store/scannerStore'
import type { ScannerTab } from '../types'
import { TimeframePicker } from './TimeframePicker'
import './Header.css'

const SCANNER_TABS: { id: ScannerTab; label: string }[] = [
  { id: 'rsi', label: 'RSI' },
  { id: 'support-resistance', label: 'Support & Resistance' },
]

export function Header() {
  const { scannerTab, setScannerTab, cellSize, setCellSize, openSettings, showDivergences, updateSettings } = useScannerStore(useShallow((state) => ({
    scannerTab: state.scannerTab,
    setScannerTab: state.setScannerTab,
    cellSize: state.cellSize,
    setCellSize: state.setCellSize,
    openSettings: state.openSettings,
    showDivergences: state.settings.showDivergences,
    updateSettings: state.updateSettings,
  })))
  const [draftCellSize, setDraftCellSize] = useState(cellSize)

  return (
    <header className="app-header">
      <div className="app-header__main">
        <h1 className="app-header__title">Market Scanners</h1>
        <Space size="middle" wrap>
          <TimeframePicker />
          {scannerTab === 'rsi' && (
            <>
              <Tooltip title="Show RSI divergences between confirmed RSI pivots. Hidden divergences can be included in Settings.">
                <Checkbox
                  checked={showDivergences}
                  onChange={(event) => updateSettings({ showDivergences: event.target.checked })}
                >
                  Divergences
                </Checkbox>
              </Tooltip>
              <div className="app-header__size">
                <span className="app-header__size-label">Size</span>
                <Slider
                  value={draftCellSize}
                  min={80}
                  max={250}
                  onChange={setDraftCellSize}
                  onChangeComplete={setCellSize}
                  tooltip={{ formatter: (value) => `${value}px` }}
                  style={{ width: 120 }}
                />
              </div>
              <Button icon={<SettingOutlined />} onClick={openSettings} aria-label="Open settings" />
            </>
          )}
        </Space>
      </div>
      <div className="scanner-tabs" role="tablist" aria-label="Scanners">
        {SCANNER_TABS.map((tab, index) => (
          <button
            key={tab.id}
            id={`${tab.id}-tab`}
            type="button"
            role="tab"
            aria-selected={scannerTab === tab.id}
            aria-controls={scannerTab === tab.id ? `${tab.id}-panel` : undefined}
            tabIndex={scannerTab === tab.id ? 0 : -1}
            className="scanner-tabs__tab"
            onClick={() => setScannerTab(tab.id)}
            onKeyDown={(event) => {
              let nextIndex: number
              if (event.key === 'ArrowRight') nextIndex = (index + 1) % SCANNER_TABS.length
              else if (event.key === 'ArrowLeft') nextIndex = (index + SCANNER_TABS.length - 1) % SCANNER_TABS.length
              else if (event.key === 'Home') nextIndex = 0
              else if (event.key === 'End') nextIndex = SCANNER_TABS.length - 1
              else return
              event.preventDefault()
              const nextTab = SCANNER_TABS[nextIndex]
              setScannerTab(nextTab.id)
              document.getElementById(`${nextTab.id}-tab`)?.focus()
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </header>
  )
}

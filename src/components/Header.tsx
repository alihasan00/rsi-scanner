import { useState } from 'react'
import { Button, Checkbox, Slider, Space, Tooltip } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import { useScannerStore } from '../store/scannerStore'
import { TimeframePicker } from './TimeframePicker'
import './Header.css'

export function Header() {
  const { cellSize, setCellSize, openSettings, showDivergences, updateSettings } = useScannerStore(useShallow((state) => ({
    cellSize: state.cellSize,
    setCellSize: state.setCellSize,
    openSettings: state.openSettings,
    showDivergences: state.settings.showDivergences,
    updateSettings: state.updateSettings,
  })))
  const [draftCellSize, setDraftCellSize] = useState(cellSize)

  return (
    <header className="app-header">
      <div className="app-header__title">RSI Scanner</div>
      <Space size="middle" wrap>
        <TimeframePicker />
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
      </Space>
    </header>
  )
}

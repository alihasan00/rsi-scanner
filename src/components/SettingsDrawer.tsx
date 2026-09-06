import { useState } from 'react'
import { ColorPicker, Drawer, Slider, Space, Switch, Typography } from 'antd'
import { useShallow } from 'zustand/react/shallow'
import { useScannerStore } from '../store/scannerStore'

const { Text } = Typography

export function SettingsDrawer() {
  const { settings, closeSettings, updateSettings } = useScannerStore(useShallow((state) => ({
    settings: state.settings,
    closeSettings: state.closeSettings,
    updateSettings: state.updateSettings,
  })))
  const [draftLineWidth, setDraftLineWidth] = useState(settings.lineWidth)

  return (
    <Drawer title="Display Settings" open onClose={closeSettings} size={320}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <div>
          <Text strong>RSI Line Color</Text>
          <div style={{ marginTop: 8 }}>
            <ColorPicker
              value={settings.rsiColor}
              onChangeComplete={(c) => updateSettings({ rsiColor: c.toHexString() })}
            />
          </div>
        </div>

        <div>
          <Text strong>SMA Line Color</Text>
          <div style={{ marginTop: 8 }}>
            <ColorPicker
              value={settings.smaColor}
              onChangeComplete={(c) => updateSettings({ smaColor: c.toHexString() })}
            />
          </div>
        </div>

        <div>
          <Text strong>Midline Color</Text>
          <div style={{ marginTop: 8 }}>
            <ColorPicker
              value={settings.midlineColor}
              onChangeComplete={(c) => updateSettings({ midlineColor: c.toHexString() })}
            />
          </div>
        </div>

        <div>
          <Text strong>Line Width: {draftLineWidth}</Text>
          <Slider
            min={1}
            max={10}
            value={draftLineWidth}
            onChange={setDraftLineWidth}
            onChangeComplete={(lineWidth) => updateSettings({ lineWidth })}
          />
        </div>

        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Text>Show price in tooltip</Text>
          <Switch checked={settings.showPrice} onChange={(checked) => updateSettings({ showPrice: checked })} />
        </Space>

        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Text>Show volume in tooltip</Text>
          <Switch checked={settings.showVolume} onChange={(checked) => updateSettings({ showVolume: checked })} />
        </Space>
      </Space>
    </Drawer>
  )
}

import { useState } from 'react'
import { Checkbox, ColorPicker, Divider, Drawer, Select, Slider, Space, Switch, Typography } from 'antd'
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

        <div>
          <Divider />
          <Space orientation="vertical" size="small">
            <Text strong>RSI divergences</Text>
            <Checkbox
              checked={settings.showDivergences}
              onChange={(event) => updateSettings({ showDivergences: event.target.checked })}
            >
              Enable divergences
            </Checkbox>
            <Checkbox
              checked={settings.showHiddenDivergences}
              disabled={!settings.showDivergences}
              onChange={(event) => updateSettings({ showHiddenDivergences: event.target.checked })}
            >
              Include hidden divergences
            </Checkbox>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Hidden patterns are an optional extension and always invalidate at
              their second pivot’s RSI.
            </Text>
            <Text strong style={{ marginTop: 8 }}>RSI invalidation anchor</Text>
            <Select
              aria-label="RSI invalidation anchor"
              value={settings.divergenceInvalidationAnchor}
              disabled={!settings.showDivergences}
              style={{ width: '100%' }}
              options={[
                { value: 'second', label: 'Second pivot (default)' },
                { value: 'first', label: 'First pivot (more room)' },
              ]}
              onChange={(divergenceInvalidationAnchor: 'first' | 'second') => updateSettings({ divergenceInvalidationAnchor })}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              Regular bullish setups die when RSI closes below the anchor; bearish
              setups die above it. Equality does not invalidate. Applies before
              and after confirmation.
            </Text>
            <Text strong style={{ marginTop: 8 }}>Lecture filters</Text>
            <Checkbox
              checked={settings.requireBodyAgreement}
              disabled={!settings.showDivergences}
              onChange={(event) => updateSettings({ requireBodyAgreement: event.target.checked })}
            >
              Require wick and body agreement
            </Checkbox>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Candle bodies must make the same higher/lower relationship as the
              wicks. Equal body edges do not qualify.
            </Text>
            <Checkbox
              checked={settings.requireSameRsiCycle}
              disabled={!settings.showDivergences}
              onChange={(event) => updateSettings({ requireSameRsiCycle: event.target.checked })}
            >
              Keep pivots in one RSI 50 cycle
            </Checkbox>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Bullish pairs must stay strictly below 50 and bearish pairs strictly
              above 50 from the first pivot through the second. Touching or crossing
              50 between them excludes the pair.
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              The first RSI pivot uses 5 candles on each side. The second is the
              strict low or high of the last 5 closed candles, including itself,
              and appears at its own close. Pivots are 5–60 candles apart.
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              The next candle must close green for bullish or red for bearish;
              closing beyond the pivot candle’s open is strong confirmation.
              Wrong colour or a doji ends the setup. Confirmation starts at 0/14;
              RSI 50 must be reached within the next 14 closed candles.
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Green: bullish · Red: bearish. Solid: regular · Dashed: hidden.
              Cards show live setups. Open a chart for the retained outcome log
              and a historical replay using these settings.
            </Text>
          </Space>
        </div>
      </Space>
    </Drawer>
  )
}

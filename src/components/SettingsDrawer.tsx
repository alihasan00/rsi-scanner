import { useState } from 'react'
import { Checkbox, ColorPicker, Divider, Drawer, Select, Slider, Space, Typography } from 'antd'
import { useShallow } from 'zustand/react/shallow'
import { useScannerStore } from '../store/scannerStore'
import { FibSettingsPanel } from './FibSettingsPanel'

const { Text, Paragraph } = Typography

export function SettingsDrawer() {
  const { settings, closeSettings, updateSettings, isFib } = useScannerStore(useShallow((state) => ({
    settings: state.settings,
    closeSettings: state.closeSettings,
    updateSettings: state.updateSettings,
    isFib: state.screenerFilters.signal === 'fib',
  })))
  const [draftLineWidth, setDraftLineWidth] = useState(settings.lineWidth)

  if (isFib) return <Drawer title="Fib settings" open onClose={closeSettings} size={360}>
    <Paragraph type="secondary" style={{ fontSize: 13 }}>Adjust the template used for the full plan inside each card.</Paragraph>
    <FibSettingsPanel />
  </Drawer>

  return (
    <Drawer title="Screener settings" open onClose={closeSettings} size={360}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          Adjust the chart and divergence rules for your screener.
        </Paragraph>
        <div>
          <Text strong>RSI line color</Text>
          <div style={{ marginTop: 8 }}>
            <ColorPicker
              showText
              value={settings.rsiColor}
              onChangeComplete={(c) => updateSettings({ rsiColor: c.toHexString() })}
            />
          </div>
        </div>

        <div>
          <Text strong>RSI average line color</Text>
          <div style={{ marginTop: 8 }}>
            <ColorPicker
              showText
              value={settings.smaColor}
              onChangeComplete={(c) => updateSettings({ smaColor: c.toHexString() })}
            />
          </div>
        </div>

        <div>
          <Text strong>Midline color</Text>
          <div style={{ marginTop: 8 }}>
            <ColorPicker
              showText
              value={settings.midlineColor}
              onChangeComplete={(c) => updateSettings({ midlineColor: c.toHexString() })}
            />
          </div>
        </div>

        <div>
          <Text strong>Line width: {draftLineWidth}</Text>
          <Slider
            min={1}
            max={10}
            value={draftLineWidth}
            onChange={setDraftLineWidth}
            onChangeComplete={(lineWidth) => updateSettings({ lineWidth })}
          />
        </div>

        <div>
          <Divider />
          <Space orientation="vertical" size="small">
            <Text strong>RSI divergences</Text>
            <Checkbox
              checked={settings.showHiddenDivergences}
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
        <div>
          <Divider />
          <Text strong>Tug of War</Text>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12, lineHeight: 1.7 }}>
            Heikin-Ashi wicks show bullish control, bearish control, or an undecided
            tug of war. Confirmation requires at least 2 tug-of-war candles,
            followed by a directional close with a body of at least 30% of its range.
            Wicks shorter than 5% of the range are ignored; the first 20 closed
            candles warm up the calculation. The current candle shows a live
            preview; confirmations use closed candles.
          </Paragraph>
        </div>
      </Space>
    </Drawer>
  )
}

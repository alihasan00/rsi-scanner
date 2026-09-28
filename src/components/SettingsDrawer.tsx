import { useState } from 'react'
import { Checkbox, ColorPicker, Divider, Drawer, Select, Slider, Space, Typography } from 'antd'
import { useShallow } from 'zustand/react/shallow'
import { useScannerStore } from '../store/scannerStore'
import { FibSettingsPanel } from './FibSettingsPanel'
import { LiquidityGuide } from './LiquidityGuide'
import { HarmonicGuide } from './HarmonicGuide'
import { RsiTrendlineGuide } from './RsiTrendlineStatus'
import './Liquidity.css'

const { Text, Paragraph } = Typography

export function SettingsDrawer() {
  const { settings, closeSettings, updateSettings, isFib, isLiquidity, isHarmonic, isIchimoku, isWatchlist } = useScannerStore(useShallow((state) => ({
    settings: state.settings,
    closeSettings: state.closeSettings,
    updateSettings: state.updateSettings,
    isFib: state.screenerFilters.signal === 'fib',
    isLiquidity: state.screenerFilters.signal === 'sr',
    isHarmonic: state.screenerFilters.signal === 'harmonic',
    isIchimoku: state.appView === 'scanner' && state.screenerFilters.signal === 'ichimoku',
    isWatchlist: state.appView === 'watchlist',
  })))
  const [draftLineWidth, setDraftLineWidth] = useState(settings.lineWidth)

  if (isIchimoku) return <Drawer title="Ichimoku Cloud settings" open onClose={closeSettings} size={440}>
    <Paragraph>This indicator view shows Ichimoku setups: cloud breakouts and retests, Kijun reclaims, TK and PK crosses, and cloud edge-to-edge opportunities. Use the view’s filters to choose direction, stage and starred pairs.</Paragraph>
    <Divider />
    <Text strong>Lecture settings · 20 / 60 / 120 / 30</Text>
    <Paragraph style={{ marginTop: 12 }}>Tenkan is orange and Kijun is red. The shaded cloud is green or red; the dashed forward cloud is already calculated from completed candles and displayed 30 bars ahead. It does not forecast future prices.</Paragraph>
    <Paragraph>The toolbar’s timeframe picker chooses the candles used to detect setups, from 1m to 1w. Only that candle history is loaded. Each setup’s algorithm applies its trigger, invalidation and expiry rules to the selected timeframe.</Paragraph>
    <Paragraph>Open a setup to inspect its captured chart, toggle Ichimoku overlays, and review the recorded crosses, flat edges and retracement cautions. Changing the toolbar timeframe starts a new scan and closes the previous setup detail.</Paragraph>
    <Paragraph type="secondary">The lecture’s periods stay fixed in this view. Chikou is intentionally omitted. Entry references, invalidation, targets and reward/risk after modeled costs belong to each saved evaluation.</Paragraph>
  </Drawer>

  if (isWatchlist) return <Drawer title="Watchlist settings" open onClose={closeSettings} size={440}>
    <Paragraph>Setups use the selected timeframe. A zone test must close before a later aligned trigger can confirm it. The trigger stays recent for four completed candles, while the live price must remain within one ATR of the zone (0.5% when ATR is unavailable).</Paragraph>
    <Paragraph type="secondary">Trigger confirmation is an observation to review. The displayed reward/risk uses the first target before costs; higher-timeframe evidence is available in Context.</Paragraph>
    <Divider />
    <Text strong>RSI confirmation rules</Text>
    <Space orientation="vertical" style={{ marginTop: 12 }}>
      <Checkbox checked={settings.showHiddenDivergences} onChange={(event) => updateSettings({ showHiddenDivergences: event.target.checked })}>Include hidden divergences</Checkbox>
      <Checkbox checked={settings.requireBodyAgreement} onChange={(event) => updateSettings({ requireBodyAgreement: event.target.checked })}>Require wick and body agreement</Checkbox>
      <Checkbox checked={settings.requireSameRsiCycle} onChange={(event) => updateSettings({ requireSameRsiCycle: event.target.checked })}>Require one RSI 50 cycle</Checkbox>
    </Space>
    <Divider />
    <details><summary>Fib template</summary><FibSettingsPanel /></details>
  </Drawer>

  if (isHarmonic) return <Drawer title="Harmonic patterns" open onClose={closeSettings} size={480}><HarmonicGuide /></Drawer>

  if (isLiquidity) return <Drawer title="Support & resistance" open onClose={closeSettings} size={440}><LiquidityGuide /></Drawer>

  if (isFib) return <Drawer title="Fib settings" open onClose={closeSettings} size={360}>
    <Paragraph type="secondary" style={{ fontSize: 13 }}>Adjust the template used for the full plan inside each card.</Paragraph>
    <FibSettingsPanel />
  </Drawer>

  return (
    <Drawer title="Screener settings" open onClose={closeSettings} size={360}>
      <Space orientation="vertical" size="large" style={{ width: '100%' }}>
        <Paragraph type="secondary" style={{ margin: 0, fontSize: 13 }}>
          Adjust the chart and divergence rules for your screener. Select RSI trendlines in Filters for the separate trendline view.
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
          <Text strong>RSI trendlines</Text>
          <RsiTrendlineGuide />
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

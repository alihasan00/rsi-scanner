import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Empty, Modal, Segmented, Tag } from 'antd'
import { useShallow } from 'zustand/react/shallow'
import { useSymbolData } from '../hooks/useSymbolData'
import { useDivergences } from '../hooks/useDivergences'
import { useRsiTrendlines } from '../hooks/useRsiTrendlines'
import { useElementSize } from '../hooks/useElementSize'
import { drawDetailRsiChart } from '../lib/drawRsiChart'
import { isLiveDivergence } from '../lib/divergenceLifecycle'
import { formatQuotePrice } from '../lib/priceFormatting'
import { getRsiState, RSI_OVERBOUGHT, RSI_OVERSOLD, RSI_STATE_LABELS } from '../lib/rsiState'
import { analyzeTugOfWar, previewTugOfWar } from '../lib/tugOfWar'
import { useScannerStore } from '../store/scannerStore'
import { getFibAnalysis } from '../lib/fibScreener'
import { FibChart } from './FibChart'
import { FibDetails } from './FibDetails'
import { LiquidityDetails } from './LiquidityDetails'
import { HarmonicDetails } from './HarmonicDetails'
import { SignalContextPanel } from './SignalContextPanel'
import { ResearchPanel } from './ResearchPanel'
import { RsiTrendlineGuide, RsiTrendlineStatus } from './RsiTrendlineStatus'
import './ChartModal.css'

export function ChartModal() {
  const { symbol, market, timeframe, closeChart, rsiColor, smaColor, midlineColor, lineWidth, showHiddenDivergences, requireBodyAgreement, requireSameRsiCycle, divergenceInvalidationAnchor } = useScannerStore(
    useShallow((state) => ({
      symbol: state.selectedSymbol,
      market: state.market,
      timeframe: state.timeframe,
      closeChart: state.closeChart,
      rsiColor: state.settings.rsiColor,
      smaColor: state.settings.smaColor,
      midlineColor: state.settings.midlineColor,
      lineWidth: state.settings.lineWidth,
      showHiddenDivergences: state.settings.showHiddenDivergences,
      requireBodyAgreement: state.settings.requireBodyAgreement,
      requireSameRsiCycle: state.settings.requireSameRsiCycle,
      divergenceInvalidationAnchor: state.settings.divergenceInvalidationAnchor,
    })),
  )
  const open = symbol !== null
  const harmonicTab = useScannerStore((state) => state.appView === 'scanner' && state.screenerFilters.signal === 'harmonic')
  const showTrendlines = useScannerStore((state) => state.appView === 'scanner' && state.screenerFilters.signal === 'trendline')
  const [view, setView] = useState<'rsi' | 'fib' | 'sr' | 'harmonic' | 'context' | 'research'>(() => {
    const { appView, screenerFilters: { signal } } = useScannerStore.getState()
    if (appView === 'families') return 'rsi'
    return signal === 'sr' || signal === 'fib' || signal === 'harmonic' ? signal : 'rsi'
  })
  const [fibGrid, setFibGrid] = useState(false)
  const fibSettings = useScannerStore((state) => state.fibSettings)
  const { price, series, bars } = useSymbolData(symbol ?? '', open)
  const trendlineAnalysis = useRsiTrendlines(symbol ?? '', bars, open && showTrendlines && view === 'rsi')
  const fib = useMemo(() => getFibAnalysis(`${market}:${timeframe}:${symbol ?? ''}`, bars, fibSettings), [symbol, market, timeframe, bars, fibSettings])
  const divergences = useDivergences(bars, open && !showTrendlines, {
    includeHidden: showHiddenDivergences,
    requireBodyAgreement,
    requireSameRsiCycle,
    invalidationAnchor: divergenceInvalidationAnchor,
  })
  const liveDivergences = useMemo(() => divergences.filter(isLiveDivergence), [divergences])
  const heikinAshiBars = useMemo(() => {
    const closed = analyzeTugOfWar(bars)
    const preview = previewTugOfWar(bars, closed)
    return preview ? [...closed.heikinAshi, preview.heikinAshi] : closed.heikinAshi
  }, [bars])
  const { ref: chartAreaRef, width, height } = useElementSize<HTMLDivElement>()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latestBar = bars.at(-1)
  const isLive = latestBar !== undefined && !latestBar.isClosed
  const currentRsi = series.at(-1)
  const rsiState = getRsiState(currentRsi)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas && width > 0 && height > 0) {
      drawDetailRsiChart(
        canvas, series, { rsiColor, smaColor, midlineColor, lineWidth },
        { bars, signals: liveDivergences, showPricePanel: true, heikinAshiBars,
          rsiMode: showTrendlines ? 'trendlines' : 'divergence', trendlines: trendlineAnalysis.displayed },
      )
    }
  }, [series, bars, liveDivergences, heikinAshiBars, showTrendlines, trendlineAnalysis, rsiColor, smaColor, midlineColor, lineWidth, width, height, view])

  const chartLabel = `${symbol}, ${timeframe}. Price, Heikin-Ashi candles, and RSI 14 on a shared UTC timeline. ${showTrendlines ? 'RSI trendline overlays.' : 'RSI divergence overlays.'} Heikin-Ashi uses averaged prices.${isLive ? ' The final Heikin-Ashi candle is hollow and still forming; current price and RSI are provisional.' : ''}${rsiState && currentRsi !== undefined ? ` RSI ${currentRsi.toFixed(2)}, ${RSI_STATE_LABELS[rsiState].toLowerCase()}.` : ' RSI unavailable.'} Overbought at ${RSI_OVERBOUGHT} or above; oversold at ${RSI_OVERSOLD} or below.`

  return (
    <Modal
      open={open}
      onCancel={closeChart}
      footer={null}
      width="min(1120px, 96vw)"
      centered
      destroyOnHidden
      className="chart-modal"
      title={
        <div className="chart-modal__title">
          <span className="chart-modal__symbol">{symbol}</span>
          <Tag className="chart-modal__timeframe">{timeframe}</Tag>
          {market === 'tradfi' && <Tag>TradFi perpetual</Tag>}
          <span className="chart-modal__price">{formatQuotePrice(price)} <small>USDT</small></span>
          {isLive && <Tag color="purple" className="chart-modal__live">{harmonicTab ? 'Forming candle' : 'Live'}</Tag>}
        </div>
      }
    >
      <div className="chart-modal__view"><Segmented<'rsi' | 'fib' | 'sr' | 'harmonic' | 'context' | 'research'> aria-label="Chart view" value={view} onChange={setView} options={[{ value: 'rsi', label: 'Price & RSI' }, { value: 'fib', label: 'Fib system' }, { value: 'sr', label: 'S&R' }, { value: 'harmonic', label: 'Harmonics' }, { value: 'context', label: 'Context' }, { value: 'research', label: 'Research' }]} />{view === 'fib' && <Segmented aria-label="Fib chart levels" value={fibGrid ? 'grid' : 'trade'} onChange={(value) => setFibGrid(value === 'grid')} options={[{ value: 'trade', label: 'Trade levels' }, { value: 'grid', label: 'Full grid' }]} />}</div>
      {view === 'context' ? <SignalContextPanel key={`${market}:${timeframe}:${symbol}`} symbol={symbol ?? ''} market={market} timeframe={timeframe} bars={bars} price={price} fib={fib} /> : view === 'research' ? <ResearchPanel symbol={symbol ?? ''} timeframe={timeframe} market={market} /> : view === 'harmonic' ? <HarmonicDetails symbol={symbol ?? ''} bars={bars} price={price} /> : view === 'sr' ? <LiquidityDetails symbol={symbol ?? ''} bars={bars} price={price} timeframe={timeframe} /> : view === 'fib' ? <>{fib.continuity && <Alert type={fib.continuity.state === 'reset' ? 'warning' : 'info'} showIcon title={fib.continuity.state === 'reset' ? 'Fib history rebuilt' : 'Fib plan history restored'} description={fib.continuity.detail} />}{fib.persistenceIssue && <Alert type="warning" title="Browser storage unavailable" description="Fib plans continue in this session, but continuity across reloads cannot be saved." />}<FibChart symbol={symbol ?? ''} bars={bars} setup={fib.setup} showReferenceGrid={fibGrid} /><FibDetails analysis={fib} price={price} live={isLive} market={market} /></> : <div className="chart-modal__chart-area" ref={chartAreaRef}>
        <canvas ref={canvasRef} className="chart-modal__base-canvas" role="img" aria-label={chartLabel} />
        {!latestBar && (
          <div className="chart-modal__empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Waiting for candles" />
          </div>
        )}
      </div>}
      {view === 'rsi' && showTrendlines && <>
        <RsiTrendlineStatus analysis={trendlineAnalysis} />
        <details className="rsi-trendlines__disclosure">
          <summary>How to read RSI trendlines</summary>
          <RsiTrendlineGuide />
        </details>
      </>}
    </Modal>
  )
}

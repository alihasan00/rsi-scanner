import { useEffect, useMemo, useRef, useState } from 'react'
import { Empty, Modal, Segmented, Tag } from 'antd'
import { useShallow } from 'zustand/react/shallow'
import { useSymbolData } from '../hooks/useSymbolData'
import { useDivergences } from '../hooks/useDivergences'
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
  const [view, setView] = useState<'rsi' | 'fib'>(() => useScannerStore.getState().screenerFilters.signal === 'fib' ? 'fib' : 'rsi')
  const [fibGrid, setFibGrid] = useState(false)
  const fibSettings = useScannerStore((state) => state.fibSettings)
  const { price, series, bars } = useSymbolData(symbol ?? '', open)
  const fib = useMemo(() => getFibAnalysis(symbol ?? '', bars, fibSettings), [symbol, bars, fibSettings])
  const divergences = useDivergences(bars, open, {
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
        { bars, signals: liveDivergences, showPricePanel: true, heikinAshiBars },
      )
    }
  }, [series, bars, liveDivergences, heikinAshiBars, rsiColor, smaColor, midlineColor, lineWidth, width, height, view])

  const chartLabel = `${symbol}, ${timeframe}. Price, Heikin-Ashi candles, and RSI 14 on a shared UTC timeline. Heikin-Ashi uses averaged prices.${isLive ? ' The final Heikin-Ashi candle is hollow and still forming; current price and RSI are provisional.' : ''}${rsiState && currentRsi !== undefined ? ` RSI ${currentRsi.toFixed(2)}, ${RSI_STATE_LABELS[rsiState].toLowerCase()}.` : ' RSI unavailable.'} Overbought at ${RSI_OVERBOUGHT} or above; oversold at ${RSI_OVERSOLD} or below.`

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
          {isLive && <Tag color="purple" className="chart-modal__live">Live</Tag>}
        </div>
      }
    >
      <div className="chart-modal__view"><Segmented<'rsi' | 'fib'> aria-label="Chart view" value={view} onChange={setView} options={[{ value: 'rsi', label: 'Price & RSI' }, { value: 'fib', label: 'Fib system' }]} />{view === 'fib' && <Segmented aria-label="Fib chart levels" value={fibGrid ? 'grid' : 'trade'} onChange={(value) => setFibGrid(value === 'grid')} options={[{ value: 'trade', label: 'Trade levels' }, { value: 'grid', label: 'Full grid' }]} />}</div>
      {view === 'fib' ? <><FibChart symbol={symbol ?? ''} bars={bars} setup={fib.setup} showReferenceGrid={fibGrid} /><FibDetails analysis={fib} price={price} live={isLive} market={market} /></> : <div className="chart-modal__chart-area" ref={chartAreaRef}>
        <canvas ref={canvasRef} className="chart-modal__base-canvas" role="img" aria-label={chartLabel} />
        {!latestBar && (
          <div className="chart-modal__empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Waiting for candles" />
          </div>
        )}
      </div>}
    </Modal>
  )
}

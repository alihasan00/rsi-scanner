import { memo, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useElementSize } from '../hooks/useElementSize'
import { useRsiTrendlines } from '../hooks/useRsiTrendlines'
import { trendlineStatusLabel } from '../lib/rsiTrendlineAnalysis'
import { RsiTrendlineStatus } from './RsiTrendlineStatus'
import { drawScreenerChart } from '../lib/drawScreenerChart'
import type { DivergenceSetup } from '../lib/divergenceLifecycle'
import { formatQuotePrice } from '../lib/priceFormatting'
import { getRsiState, RSI_OVERBOUGHT, RSI_OVERSOLD, RSI_STATE_LABELS } from '../lib/rsiState'
import { useScannerStore } from '../store/scannerStore'
import type { RsiBar, Timeframe } from '../types'
import './ScreenerChart.css'

export interface ScreenerChartProps {
  bars: readonly RsiBar[]
  divergences: readonly DivergenceSetup[]
  active?: boolean
  symbol: string
  timeframe: Timeframe
  rsiMode?: 'divergence' | 'trendlines'
}

function ScreenerChartImpl({ bars, divergences, active = true, symbol, timeframe, rsiMode = 'divergence' }: ScreenerChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { ref: sizeRef, width, height } = useElementSize<HTMLDivElement>()
  const { rsiColor, lineWidth, midlineColor } = useScannerStore(useShallow((state) => ({
    rsiColor: state.settings.rsiColor,
    lineWidth: state.settings.lineWidth,
    midlineColor: state.settings.midlineColor,
  })))
  const latest = bars.at(-1)
  const trendlineMode = rsiMode === 'trendlines'
  const trendlineAnalysis = useRsiTrendlines(symbol, bars, trendlineMode)
  const rsiState = getRsiState(latest?.rsi)
  const latestDivergence = trendlineMode ? undefined : divergences.at(-1)
  const trendlineLabel = trendlineMode
    ? ` RSI trendline view. ${trendlineAnalysis.displayed.map(trendlineStatusLabel).join('. ') || 'No qualifying trendline'}.${trendlineAnalysis.noLongs ? ' No longs: RSI support broken.' : ''}`
    : ''
  const label = latest
    ? `${symbol}, ${timeframe} price candlesticks and RSI 14. Showing the latest ${Math.min(bars.length, 72)} candles. Price ${formatQuotePrice(latest.close)} USDT. ${rsiState ? `RSI ${latest.rsi.toFixed(1)}, ${RSI_STATE_LABELS[rsiState].toLowerCase()}.` : 'RSI unavailable.'} Overbought at ${RSI_OVERBOUGHT} or above; oversold at ${RSI_OVERSOLD} or below. ${latest.isClosed ? 'Latest candle is closed.' : 'The hollow final candle is still forming; price and RSI are provisional.'}${latestDivergence ? ` Latest divergence: ${latestDivergence.kind.replaceAll('-', ' ')}, ${latestDivergence.state}.` : ''}${trendlineLabel} Chart times are UTC.`
    : `${symbol}, ${timeframe}. Waiting for market data.`

  useEffect(() => {
    const canvas = canvasRef.current
    if (!active || !canvas || width === 0 || height === 0) return
    drawScreenerChart(canvas, {
      bars, divergences, timeframe, rsiMode, trendlines: trendlineAnalysis.displayed,
      settings: { rsiColor, lineWidth, midlineColor },
    })
  }, [bars, divergences, active, timeframe, rsiMode, trendlineAnalysis, width, height, rsiColor, lineWidth, midlineColor])

  return (
    <><div ref={sizeRef} className={`screener-chart${latest ? '' : ' screener-chart--empty'}`}>
      <canvas ref={canvasRef} className="screener-chart__canvas" role="img" aria-label={label} />
      {!latest && (
        <div className="screener-chart__empty" aria-hidden="true">
          <span className="screener-chart__empty-mark" />
          <span>Waiting for market data</span>
        </div>
      )}
    </div>
      {trendlineMode && latest && <RsiTrendlineStatus analysis={trendlineAnalysis} compact />}
    </>
  )
}

export const ScreenerChart = memo(ScreenerChartImpl)

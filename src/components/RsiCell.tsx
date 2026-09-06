import { memo, useEffect, useRef } from 'react'
import { Tooltip } from 'antd'
import { useShallow } from 'zustand/react/shallow'
import { useNearViewport } from '../hooks/useNearViewport'
import { useSymbolData } from '../hooks/useSymbolData'
import { drawMiniRsiChart } from '../lib/drawRsiChart'
import { useScannerStore } from '../store/scannerStore'
import './RsiCell.css'

interface RsiCellProps {
  symbol: string
  width: number
  height: number
}

function RsiCellImpl({ symbol, width, height }: RsiCellProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { ref: visibilityRef, isNearViewport } = useNearViewport<HTMLDivElement>()
  const { price, volume, series } = useSymbolData(symbol, isNearViewport)
  const { rsiColor, midlineColor, lineWidth, showPrice, showVolume, selectSymbol } = useScannerStore(
    useShallow((state) => ({
      rsiColor: state.settings.rsiColor,
      midlineColor: state.settings.midlineColor,
      lineWidth: state.settings.lineWidth,
      showPrice: state.settings.showPrice,
      showVolume: state.settings.showVolume,
      selectSymbol: state.selectSymbol,
    })),
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) drawMiniRsiChart(canvas, series, { rsiColor, midlineColor, lineWidth })
  }, [series, rsiColor, midlineColor, lineWidth, width, height])

  const rsi = series.length > 0 ? series[series.length - 1] : null
  const rsiClass = rsi === null ? '' : rsi >= 70 ? 'is-high' : rsi <= 30 ? 'is-low' : ''

  const tooltipContent = (
    <div>
      <strong>{symbol}</strong>
      {rsi !== null && <div>RSI: {rsi.toFixed(2)}</div>}
      {showPrice && <div>Price: {price.toFixed(4)}</div>}
      {showVolume && <div>Volume: {volume.toFixed(2)}</div>}
    </div>
  )

  return (
    <Tooltip title={tooltipContent} mouseEnterDelay={0.15}>
      <div
        ref={visibilityRef}
        className="rsi-cell"
        style={{ width, height }}
        role="button"
        tabIndex={0}
        onClick={() => selectSymbol(symbol)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            selectSymbol(symbol)
          }
        }}
      >
        <canvas ref={canvasRef} className="rsi-cell__canvas" />
        <div className="rsi-cell__label">
          <span className="rsi-cell__symbol">{symbol.replace('USDT', '')}</span>
          {rsi !== null && <span className={`rsi-cell__value ${rsiClass}`}>{rsi.toFixed(1)}</span>}
        </div>
      </div>
    </Tooltip>
  )
}

export const RsiCell = memo(RsiCellImpl)

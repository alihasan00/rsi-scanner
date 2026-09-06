import { memo, useEffect, useMemo, useRef } from 'react'
import { Tooltip } from 'antd'
import { useShallow } from 'zustand/react/shallow'
import { useNearViewport } from '../hooks/useNearViewport'
import { useSymbolData } from '../hooks/useSymbolData'
import { useDivergences } from '../hooks/useDivergences'
import { drawMiniRsiChart } from '../lib/drawRsiChart'
import { DIVERGENCE_LABELS, divergenceStatus, formatSignalTime, liveDivergenceLabel } from '../lib/divergencePresentation'
import { isLiveDivergence } from '../lib/divergenceLifecycle'
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
  const { price, volume, series, bars } = useSymbolData(symbol, isNearViewport)
  const { rsiColor, midlineColor, lineWidth, showPrice, showVolume, showDivergences, showHiddenDivergences, requireBodyAgreement, requireSameRsiCycle, divergenceInvalidationAnchor, selectSymbol } = useScannerStore(
    useShallow((state) => ({
      rsiColor: state.settings.rsiColor,
      midlineColor: state.settings.midlineColor,
      lineWidth: state.settings.lineWidth,
      showPrice: state.settings.showPrice,
      showVolume: state.settings.showVolume,
      showDivergences: state.settings.showDivergences,
      showHiddenDivergences: state.settings.showHiddenDivergences,
      requireBodyAgreement: state.settings.requireBodyAgreement,
      requireSameRsiCycle: state.settings.requireSameRsiCycle,
      divergenceInvalidationAnchor: state.settings.divergenceInvalidationAnchor,
      selectSymbol: state.selectSymbol,
    })),
  )
  const divergences = useDivergences(bars, showDivergences, {
    includeHidden: showHiddenDivergences, requireBodyAgreement, requireSameRsiCycle,
    invalidationAnchor: divergenceInvalidationAnchor,
  })
  const liveDivergences = useMemo(() => divergences.filter(isLiveDivergence), [divergences])
  const latestDivergence = liveDivergences.at(-1)
  const bullish = latestDivergence?.kind.endsWith('bullish') ?? false
  const hidden = latestDivergence?.kind.startsWith('hidden') ?? false

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas) drawMiniRsiChart(
      canvas, series, { rsiColor, midlineColor, lineWidth },
      showDivergences ? { bars, signals: liveDivergences } : undefined,
    )
  }, [series, bars, liveDivergences, showDivergences, rsiColor, midlineColor, lineWidth, width, height])

  const rsi = series.length > 0 ? series[series.length - 1] : null
  const rsiClass = rsi === null ? '' : rsi >= 70 ? 'is-high' : rsi <= 30 ? 'is-low' : ''

  const tooltipContent = (
    <div className="rsi-cell__tooltip-content">
      <strong>{symbol}</strong>
      {rsi !== null && <div>RSI: {rsi.toFixed(2)}</div>}
      {showPrice && <div>Price: {price.toFixed(4)}</div>}
      {showVolume && <div>Volume: {volume.toFixed(2)}</div>}
      {showDivergences && (liveDivergences.length ? (
        <>
          {[...liveDivergences].reverse().map((signal) => (
            <div className="rsi-cell__signal-tooltip" key={signal.id}>
              <strong>{DIVERGENCE_LABELS[signal.kind]} · {divergenceStatus(signal)}</strong>
              {signal.confirmedAt === null ? (
                <><div>Detected: {formatSignalTime(signal.detectedAt)} UTC</div><div>Awaiting the next closed candle</div></>
              ) : (
                <>
                  <div>{signal.confirmation === 'strong' ? 'Strong' : 'Ordinary'} candle confirmation</div>
                  <div>Confirmed: {formatSignalTime(signal.confirmedAt)} UTC</div>
                  <div>{signal.barsElapsed}/{signal.expiryBars} closed candles elapsed · target RSI 50</div>
                </>
              )}
              <div>Invalidates {signal.kind.endsWith('bullish') ? 'below' : 'above'} {signal.invalidationRsi.toFixed(2)} RSI ({signal.invalidationAnchor} pivot)</div>
            </div>
          ))}
          <div className="rsi-cell__signal-tooltip">Open chart for the retained setup log</div>
        </>
      ) : <div>No live divergence setup · open chart for past outcomes</div>)}
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
        {latestDivergence && (
          <div
            className={`rsi-cell__divergence ${bullish ? 'is-bullish' : 'is-bearish'}`}
            aria-label={`${liveDivergenceLabel(latestDivergence)}${liveDivergences.length > 1 ? `, ${liveDivergences.length} live setups total` : ''}`}
          >
            <span>{hidden ? 'H ' : ''}{bullish ? 'Bull' : 'Bear'} · {latestDivergence.state}</span>
            {(latestDivergence.state === 'confirmed' || liveDivergences.length > 1) && (
              <span className="rsi-cell__divergence-progress">
                {latestDivergence.state === 'confirmed' && `${latestDivergence.barsElapsed}/${latestDivergence.expiryBars}`}
                {latestDivergence.state === 'confirmed' && liveDivergences.length > 1 && ' · '}
                {liveDivergences.length > 1 && `+${liveDivergences.length - 1} live`}
              </span>
            )}
          </div>
        )}
      </div>
    </Tooltip>
  )
}

export const RsiCell = memo(RsiCellImpl)

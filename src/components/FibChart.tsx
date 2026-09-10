import { useEffect, useRef } from 'react'
import { useElementSize } from '../hooks/useElementSize'
import { drawFibChart } from '../lib/drawFibChart'
import type { FibSetup } from '../lib/fibonacci'
import { FIB_STATUS_LABELS } from '../lib/fibScreener'
import type { RsiBar } from '../types'
import './Fibonacci.css'

export function FibChart({ bars, setup, symbol, compact = false, active = true, showReferenceGrid = false }: {
  bars: readonly RsiBar[]; setup: FibSetup | null; symbol: string; compact?: boolean; active?: boolean; showReferenceGrid?: boolean
}) {
  const { ref, width, height } = useElementSize<HTMLDivElement>()
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (active && canvas.current && width && height) drawFibChart(canvas.current, { bars, setup, compact, showReferenceGrid })
  }, [bars, setup, compact, active, width, height, showReferenceGrid])
  const description = compact
    ? `${setup ? `${setup.direction === 'long' ? 'Uptrend' : 'Downtrend'}, ${setup.scale} price scale. ` : ''}Raw price candles and confirmed impulse trendline when both anchors are visible.`
    : `${setup ? `${setup.direction} setup, ${FIB_STATUS_LABELS[setup.status]}. Golden pocket, entries, stop and targets on ${setup.scale} price scale.` : 'No confirmed Fib setup.'} Raw price candles.`
  const liveDescription = bars.at(-1)?.isClosed === false ? ' The hollow latest candle is provisional.' : ''
  return <div className={`fib-chart${compact ? ' fib-chart--compact' : ''}`} ref={ref}>
    <canvas ref={canvas} role="img" aria-label={`${symbol} ${compact ? 'price' : 'Fibonacci'} chart. ${description}${liveDescription} All times UTC.`} />
    {!bars.length && <span className="fib-chart__empty">Waiting for market data</span>}
  </div>
}

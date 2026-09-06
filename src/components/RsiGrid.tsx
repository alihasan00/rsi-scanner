import { useMemo } from 'react'
import { SYMBOLS } from '../lib/symbols'
import { useElementSize } from '../hooks/useElementSize'
import { useScannerStore } from '../store/scannerStore'
import { RsiCell } from './RsiCell'
import './RsiGrid.css'

const GAP = 12
const MIN_COLUMNS = 3

export function RsiGrid() {
  const cellHeight = useScannerStore((state) => state.cellSize)
  const { ref, width: containerWidth } = useElementSize<HTMLDivElement>()
  const cellWidth = Math.round(cellHeight * 1.5)

  const columns = useMemo(() => {
    if (containerWidth === 0) return MIN_COLUMNS
    const fit = Math.floor((containerWidth + GAP) / (cellWidth + GAP))
    return Math.max(MIN_COLUMNS, fit)
  }, [containerWidth, cellWidth])

  return (
    <div
      ref={ref}
      className="rsi-grid"
      style={{ gridTemplateColumns: `repeat(${columns}, ${cellWidth}px)`, gap: GAP }}
    >
      {SYMBOLS.map((symbol) => (
        <RsiCell key={symbol} symbol={symbol} width={cellWidth} height={cellHeight} />
      ))}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, ColorPicker, Modal, Segmented, Slider, Space, Tooltip } from 'antd'
import {
  ClearOutlined,
  DeleteOutlined,
  DownloadOutlined,
  HighlightOutlined,
  LineOutlined,
  RedoOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import type Konva from 'konva'
import { useShallow } from 'zustand/react/shallow'
import { useSymbolData } from '../hooks/useSymbolData'
import { useDivergences } from '../hooks/useDivergences'
import { useElementSize } from '../hooks/useElementSize'
import { useDrawingTools } from '../hooks/useDrawingTools'
import { drawDetailRsiChart } from '../lib/drawRsiChart'
import { formatSignalTime } from '../lib/divergencePresentation'
import { isLiveDivergence } from '../lib/divergenceLifecycle'
import { useScannerStore } from '../store/scannerStore'
import { DrawingCanvas } from './DrawingCanvas'
import { DivergenceDetails } from './DivergenceDetails'
import { DivergenceBacktest } from './DivergenceBacktest'
import type { DrawingTool } from '../types'
import './ChartModal.css'

const TOOL_OPTIONS = [
  { value: 'brush', label: <span><HighlightOutlined /> Brush</span> },
  { value: 'trendline', label: <span><LineOutlined /> Trendline</span> },
  { value: 'eraser', label: <span><ClearOutlined /> Eraser</span> },
]

export function ChartModal() {
  const { symbol, timeframe, closeChart, rsiColor, smaColor, midlineColor, lineWidth, showDivergences, showHiddenDivergences, requireBodyAgreement, requireSameRsiCycle, divergenceInvalidationAnchor } = useScannerStore(
    useShallow((state) => ({
      symbol: state.selectedSymbol,
      timeframe: state.timeframe,
      closeChart: state.closeChart,
      rsiColor: state.settings.rsiColor,
      smaColor: state.settings.smaColor,
      midlineColor: state.settings.midlineColor,
      lineWidth: state.settings.lineWidth,
      showDivergences: state.settings.showDivergences,
      showHiddenDivergences: state.settings.showHiddenDivergences,
      requireBodyAgreement: state.settings.requireBodyAgreement,
      requireSameRsiCycle: state.settings.requireSameRsiCycle,
      divergenceInvalidationAnchor: state.settings.divergenceInvalidationAnchor,
    })),
  )
  const open = symbol !== null
  const { price, volume, series, bars } = useSymbolData(symbol ?? '')
  const divergenceOptions = {
    includeHidden: showHiddenDivergences, requireBodyAgreement, requireSameRsiCycle,
    invalidationAnchor: divergenceInvalidationAnchor,
  }
  const divergences = useDivergences(bars, showDivergences, divergenceOptions)
  const [overlayScope, setOverlayScope] = useState<'live' | 'history'>('live')
  const liveDivergences = useMemo(() => divergences.filter(isLiveDivergence), [divergences])
  const chartDivergences = overlayScope === 'live' ? liveDivergences : divergences
  const { ref: chartAreaRef, width, height } = useElementSize<HTMLDivElement>()
  const baseCanvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<Konva.Stage>(null)

  const drawing = useDrawingTools({ active: open })
  const { reset: resetDrawing } = drawing

  useEffect(() => {
    resetDrawing()
  }, [symbol, resetDrawing])

  useEffect(() => {
    const canvas = baseCanvasRef.current
    if (canvas && width > 0 && height > 0) {
      drawDetailRsiChart(
        canvas, series, { rsiColor, smaColor, midlineColor, lineWidth },
        { bars, signals: chartDivergences, showPricePanel: showDivergences },
      )
    }
  }, [series, bars, chartDivergences, showDivergences, rsiColor, smaColor, midlineColor, lineWidth, width, height])

  const currentRsi = series.length > 0 ? series[series.length - 1] : null
  const firstVisibleBar = series.length > 0 ? bars[Math.max(0, bars.length - series.length)] : undefined
  const lastVisibleBar = bars.at(-1)

  function handleExport(): void {
    const base = baseCanvasRef.current
    const stage = stageRef.current
    if (!base || !stage || !symbol) return

    const merged = document.createElement('canvas')
    merged.width = base.width
    merged.height = base.height
    const ctx = merged.getContext('2d')
    if (!ctx) return

    ctx.drawImage(base, 0, 0, merged.width, merged.height)
    const overlay = stage.toCanvas({ pixelRatio: base.width / stage.width() })
    ctx.drawImage(overlay, 0, 0, merged.width, merged.height)

    const link = document.createElement('a')
    link.download = `${symbol}_${timeframe}_RSI_Chart.png`
    link.href = merged.toDataURL('image/png')
    link.click()
  }

  return (
    <Modal
      open={open}
      onCancel={closeChart}
      footer={null}
      width="min(960px, 95vw)"
      destroyOnHidden
      title={
        <div className="chart-modal__title">
          <span className="chart-modal__symbol">{symbol} · {timeframe}</span>
          <Space size="middle" className="chart-modal__stats">
            <span>Price: <strong>{price.toFixed(4)}</strong></span>
            <span>Volume: <strong>{volume.toFixed(2)}</strong></span>
            <span>RSI: <strong>{currentRsi !== null ? currentRsi.toFixed(2) : '—'}</strong></span>
          </Space>
        </div>
      }
    >
      <div className="chart-modal__toolbar">
        <Segmented
          value={drawing.tool ?? ''}
          onChange={(value) => drawing.setTool((value || null) as DrawingTool)}
          options={TOOL_OPTIONS}
        />

        <Space size="middle">
          <span className="chart-modal__toolbar-label">Size</span>
          <Slider value={drawing.size} min={1} max={20} onChange={drawing.setSize} style={{ width: 100 }} />
          <ColorPicker value={drawing.color} onChangeComplete={(c) => drawing.setColor(c.toHexString())} />
        </Space>

        <Space size="small">
          <Tooltip title="Undo (Ctrl+Z)">
            <Button icon={<UndoOutlined />} disabled={!drawing.canUndo} onClick={drawing.undo} />
          </Tooltip>
          <Tooltip title="Redo (Ctrl+Y)">
            <Button icon={<RedoOutlined />} disabled={!drawing.canRedo} onClick={drawing.redo} />
          </Tooltip>
          <Button icon={<DeleteOutlined />} danger onClick={drawing.clear}>Clear</Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={handleExport}>Export</Button>
        </Space>
      </div>

      {showDivergences && (
        <div className="chart-modal__divergence-controls">
          <Segmented
            aria-label="Divergence chart overlays"
            value={overlayScope}
            onChange={(value: 'live' | 'history') => setOverlayScope(value)}
            options={[
              { label: `Live setups (${liveDivergences.length})`, value: 'live' },
              { label: 'All retained setups', value: 'history' },
            ]}
            size="small"
          />
          <span>Lines require both pivots in view{overlayScope === 'history' ? ' · resolved setups are faded' : ''}</span>
        </div>
      )}
      {firstVisibleBar && lastVisibleBar && (
        <div className="chart-modal__time-range">
          <span>Candle times (UTC)</span>
          <span>
            <time dateTime={new Date(firstVisibleBar.openTime).toISOString()}>
              {formatSignalTime(firstVisibleBar.openTime)}
            </time>
            {' → '}
            <time dateTime={new Date(lastVisibleBar.openTime).toISOString()}>
              {formatSignalTime(lastVisibleBar.openTime)}
            </time>
          </span>
        </div>
      )}
      <div className="chart-modal__chart-area" ref={chartAreaRef}>
        <canvas ref={baseCanvasRef} className="chart-modal__base-canvas" />
        {width > 0 && height > 0 && (
          <DrawingCanvas
            stageRef={stageRef}
            width={width}
            height={height}
            tool={drawing.tool}
            objects={drawing.objects}
            onBegin={drawing.beginStroke}
            onExtend={drawing.extendStroke}
            onEnd={drawing.endStroke}
            onErase={drawing.eraseObject}
          />
        )}
      </div>
      {showDivergences && (
        <>
          <DivergenceDetails
            signals={divergences}
            bars={bars}
            includeHidden={showHiddenDivergences}
            requireBodyAgreement={requireBodyAgreement}
            requireSameRsiCycle={requireSameRsiCycle}
            invalidationAnchor={divergenceInvalidationAnchor}
          />
          {symbol && (
            <DivergenceBacktest
              key={`${symbol}:${timeframe}`}
              symbol={symbol}
              timeframe={timeframe}
              options={divergenceOptions}
            />
          )}
        </>
      )}
    </Modal>
  )
}

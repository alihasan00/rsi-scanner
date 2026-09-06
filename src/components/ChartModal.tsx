import { useEffect, useRef } from 'react'
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
import { useElementSize } from '../hooks/useElementSize'
import { useDrawingTools } from '../hooks/useDrawingTools'
import { drawDetailRsiChart } from '../lib/drawRsiChart'
import { useScannerStore } from '../store/scannerStore'
import { DrawingCanvas } from './DrawingCanvas'
import type { DrawingTool } from '../types'
import './ChartModal.css'

const TOOL_OPTIONS = [
  { value: 'brush', label: <span><HighlightOutlined /> Brush</span> },
  { value: 'trendline', label: <span><LineOutlined /> Trendline</span> },
  { value: 'eraser', label: <span><ClearOutlined /> Eraser</span> },
]

export function ChartModal() {
  const { symbol, closeChart, rsiColor, smaColor, midlineColor, lineWidth } = useScannerStore(
    useShallow((state) => ({
      symbol: state.selectedSymbol,
      closeChart: state.closeChart,
      rsiColor: state.settings.rsiColor,
      smaColor: state.settings.smaColor,
      midlineColor: state.settings.midlineColor,
      lineWidth: state.settings.lineWidth,
    })),
  )
  const open = symbol !== null
  const { price, volume, series } = useSymbolData(symbol ?? '')
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
      drawDetailRsiChart(canvas, series, { rsiColor, smaColor, midlineColor, lineWidth })
    }
  }, [series, rsiColor, smaColor, midlineColor, lineWidth, width, height])

  const currentRsi = series.length > 0 ? series[series.length - 1] : null

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
    link.download = `${symbol}_RSI_Chart.png`
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
          <span className="chart-modal__symbol">{symbol}</span>
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
    </Modal>
  )
}

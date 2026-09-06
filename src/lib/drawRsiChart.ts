import { computeSma } from './rsi'
import type { ChartSettings } from '../types'

interface RsiScale {
  min: number
  max: number
}

function computeRsiScale(data: number[], padding: number): RsiScale {
  let dataMax = -Infinity
  let dataMin = Infinity
  for (const v of data) {
    if (v > dataMax) dataMax = v
    if (v < dataMin) dataMin = v
  }
  const range = dataMax - dataMin

  let max = Math.min(Math.max(dataMax + padding, 70), 100)
  let min = Math.max(Math.min(dataMin - padding, 30), 0)

  if (range < 10) {
    const midpoint = (dataMax + dataMin) / 2
    max = midpoint + 10
    min = midpoint - 10
  }
  return { min, max }
}

/** Resizes a canvas' backing store to match its CSS size at the current device pixel ratio. */
export function syncCanvasResolution(canvas: HTMLCanvasElement): { width: number; height: number } {
  // A 2x backing store is already crisp while avoiding hundreds of MB of
  // canvas memory on 3x/4x displays when the grid contains ~100 charts.
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
  const width = canvas.clientWidth || canvas.offsetWidth
  const height = canvas.clientHeight || canvas.offsetHeight
  const targetWidth = Math.max(1, Math.round(width * pixelRatio))
  const targetHeight = Math.max(1, Math.round(height * pixelRatio))
  if (canvas.width !== targetWidth) canvas.width = targetWidth
  if (canvas.height !== targetHeight) canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  ctx?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
  return { width, height }
}

/** Compact sparkline used inside grid cells. */
export function drawMiniRsiChart(
  canvas: HTMLCanvasElement,
  data: number[],
  settings: Pick<ChartSettings, 'rsiColor' | 'midlineColor' | 'lineWidth'>,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = syncCanvasResolution(canvas)
  ctx.clearRect(0, 0, width, height)
  if (data.length === 0) return

  const dataRange = Math.max(...data) - Math.min(...data)
  const padding = Math.max(5, dataRange * 0.2)
  const { min: minRsi, max: maxRsi } = computeRsiScale(data, padding)
  const scaleY = height / (maxRsi - minRsi)

  const rightGap = width * 0.12
  const chartWidth = width - rightGap
  const stepX = data.length > 1 ? chartWidth / (data.length - 1) : 0

  ctx.beginPath()
  ctx.strokeStyle = settings.rsiColor
  ctx.lineWidth = Math.max(2, settings.lineWidth) / 2
  ctx.lineJoin = 'round'
  for (let i = 0; i < data.length; i++) {
    const x = i * stepX
    const y = height - (data[i] - minRsi) * scaleY
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  const fiftyLineY = height - (50 - minRsi) * scaleY
  ctx.beginPath()
  ctx.strokeStyle = settings.midlineColor
  ctx.lineWidth = 1
  ctx.setLineDash([2, 2])
  ctx.moveTo(0, fiftyLineY)
  ctx.lineTo(width, fiftyLineY)
  ctx.stroke()
  ctx.setLineDash([])
}

export interface DetailChartLayout {
  chartLeft: number
  chartRight: number
  chartTop: number
  chartBottom: number
  minRsi: number
  maxRsi: number
}

/** Enlarged chart used in the detail modal, with axis labels and an SMA overlay. */
export function drawDetailRsiChart(
  canvas: HTMLCanvasElement,
  data: number[],
  settings: Pick<ChartSettings, 'rsiColor' | 'smaColor' | 'midlineColor' | 'lineWidth'>,
): DetailChartLayout | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const { width, height } = syncCanvasResolution(canvas)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#1c212c'
  ctx.fillRect(0, 0, width, height)
  if (data.length === 0) return null

  const scaleWidth = 56
  const margin = 16
  const chartLeft = margin
  const chartRight = width - scaleWidth - margin
  const chartTop = margin
  const chartBottom = height - margin
  const chartWidth = chartRight - chartLeft
  const chartHeight = chartBottom - chartTop

  const { min: minRsi, max: maxRsi } = computeRsiScale(data, 10)
  const scaleY = chartHeight / (maxRsi - minRsi)
  const stepX = data.length > 1 ? chartWidth / (data.length - 1) : 0

  ctx.font = '12px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (let v = Math.ceil(minRsi / 10) * 10; v <= maxRsi; v += 10) {
    const y = chartBottom - (v - minRsi) * scaleY
    ctx.beginPath()
    ctx.moveTo(chartLeft, y)
    ctx.lineTo(chartRight, y)
    ctx.strokeStyle = v === 50 ? settings.midlineColor : 'rgba(229, 233, 242, 0.12)'
    ctx.lineWidth = v === 50 ? 1.5 : 1
    ctx.stroke()

    ctx.fillStyle = '#8891a5'
    ctx.textAlign = 'right'
    ctx.fillText(v.toFixed(0), width - margin - 8, y)
  }

  ctx.beginPath()
  ctx.strokeStyle = settings.rsiColor
  ctx.lineWidth = settings.lineWidth
  ctx.lineJoin = 'round'
  for (let i = 0; i < data.length; i++) {
    const x = chartLeft + i * stepX
    const y = chartBottom - (data[i] - minRsi) * scaleY
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  const smaLength = 14
  const smaValues = computeSma(data, smaLength)
  if (smaValues.length > 0) {
    ctx.beginPath()
    ctx.strokeStyle = settings.smaColor
    ctx.lineWidth = 1.5
    ctx.setLineDash([5, 3])
    for (let i = 0; i < smaValues.length; i++) {
      const x = chartLeft + (i + smaLength - 1) * stepX
      const y = chartBottom - (smaValues[i] - minRsi) * scaleY
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.setLineDash([])
  }

  return { chartLeft, chartRight, chartTop, chartBottom, minRsi, maxRsi }
}

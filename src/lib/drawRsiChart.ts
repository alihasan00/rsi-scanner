import { computeSma } from './rsi'
import type { DivergenceSignal } from './divergence'
import type { DivergenceSetup } from './divergenceLifecycle'
import type { ChartSettings, RsiBar } from '../types'

type ChartDivergence = Pick<DivergenceSignal, 'id' | 'kind' | 'start' | 'end'>
  & Partial<Pick<DivergenceSetup, 'state'>>

export interface RsiDivergenceChartContext {
  bars: readonly RsiBar[]
  signals: readonly ChartDivergence[]
}

export interface DetailRsiChartContext extends RsiDivergenceChartContext {
  /** Context still provides candle timestamps when the price panel is hidden. */
  showPricePanel?: boolean
}

interface VisibleDivergence {
  signal: ChartDivergence
  startIndex: number
  endIndex: number
}

interface ChartRegion {
  left: number
  right: number
  top: number
  bottom: number
}

const BULLISH_COLOR = '#29ffb8'
const BEARISH_COLOR = '#ff6b81'

function visibleDivergences(context: RsiDivergenceChartContext, dataLength: number): VisibleDivergence[] {
  const bars = context.bars.slice(-dataLength)
  const offset = dataLength - bars.length
  const indexes = new Map(bars.map((bar, index) => [bar.openTime, index + offset]))
  return context.signals.flatMap((signal) => {
    const startIndex = indexes.get(signal.start.time)
    const endIndex = indexes.get(signal.end.time)
    // Do not stretch a historical signal onto the visible chart's first bar.
    if (startIndex === undefined || endIndex === undefined) return []
    return [{ signal, startIndex, endIndex }]
  })
}

function drawDivergences(
  ctx: CanvasRenderingContext2D,
  signals: VisibleDivergence[],
  region: ChartRegion,
  stepX: number,
  toY: (value: number) => number,
  valueKey: 'price' | 'rsi',
  labels: boolean,
): void {
  ctx.save()
  // Keep overlays out of the axes and the adjacent panel.
  ctx.beginPath()
  ctx.rect(region.left - 3, region.top, region.right - region.left + 6, region.bottom - region.top)
  ctx.clip()
  ctx.lineJoin = 'round'
  ctx.font = '600 10px Inter, system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const labelBoxes: ChartRegion[] = []

  for (const { signal, startIndex, endIndex } of signals) {
    ctx.globalAlpha = signal.state && signal.state !== 'forming' && signal.state !== 'confirmed' ? 0.5 : 1
    const bullish = signal.kind.endsWith('bullish')
    const hidden = signal.kind.startsWith('hidden')
    const color = bullish ? BULLISH_COLOR : BEARISH_COLOR
    const startX = region.left + startIndex * stepX
    const endX = region.left + endIndex * stepX
    const startY = toY(signal.start[valueKey])
    const endY = toY(signal.end[valueKey])
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = labels ? 2 : 1.7
    ctx.setLineDash(hidden ? [4, 3] : [])
    ctx.beginPath()
    ctx.moveTo(startX, startY)
    ctx.lineTo(endX, endY)
    ctx.stroke()
    ctx.setLineDash([])
    for (const [x, y] of [[startX, startY], [endX, endY]]) {
      ctx.beginPath()
      ctx.arc(x, y, labels ? 2.8 : 2.2, 0, Math.PI * 2)
      ctx.fill()
    }

    if (!labels) continue
    const label = `${hidden ? 'H' : 'R'} ${bullish ? 'Bull' : 'Bear'}${signal.state ? ` · ${signal.state}` : ''}`
    const labelWidth = ctx.measureText(label).width + 8
    if (labelWidth > region.right - region.left) continue
    const centerX = Math.max(region.left + labelWidth / 2, Math.min(region.right - labelWidth / 2, (startX + endX) / 2))
    const middleY = (startY + endY) / 2
    const direction = bullish ? 1 : -1
    // Try both sides of a line; crowded charts keep the colored line and dots.
    for (const distance of [13 * direction, -13 * direction, 27 * direction]) {
      const centerY = middleY + distance
      const box = { left: centerX - labelWidth / 2, right: centerX + labelWidth / 2, top: centerY - 8, bottom: centerY + 8 }
      if (box.top < region.top || box.bottom > region.bottom) continue
      if (labelBoxes.some((placed) => box.left < placed.right && box.right > placed.left && box.top < placed.bottom && box.bottom > placed.top)) continue
      ctx.fillStyle = 'rgba(28, 33, 44, 0.92)'
      ctx.fillRect(box.left, box.top, labelWidth, 16)
      ctx.fillStyle = color
      ctx.fillText(label, centerX, centerY)
      labelBoxes.push(box)
      break
    }
  }
  ctx.restore()
}

function formatPriceTick(value: number, step: number): string {
  if (value !== 0 && (Math.abs(value) < 1e-8 || Math.abs(value) >= 1e10)) {
    const precision = Math.min(12, Math.max(3, Math.floor(Math.log10(Math.abs(value))) - Math.floor(Math.log10(step)) + 1))
    return value.toExponential(precision)
  }
  const digits = Math.min(12, Math.max(0, 1 - Math.floor(Math.log10(step))))
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  bars: readonly RsiBar[],
  dataLength: number,
  stepX: number,
  chartLeft: number,
  chartRight: number,
  chartBottom: number,
  timezoneRight: number,
): void {
  const chartWidth = chartRight - chartLeft
  if (bars.length === 0 || chartWidth <= 0) return
  const offset = dataLength - bars.length
  const timestamps = bars.map((bar) => {
    const iso = new Date(bar.openTime).toISOString()
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
  })
  ctx.save()
  ctx.font = '11px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'left'
  const labelWidth = Math.min(chartWidth, Math.max(...timestamps.map(({ date, time }) => (
    Math.max(ctx.measureText(date).width, ctx.measureText(time).width)
  ))))
  const gap = 16
  const visibleWidth = (bars.length - 1) * stepX
  let tickCount = Math.min(bars.length, Math.max(1, Math.floor(visibleWidth / (labelWidth + gap)) + 1))
  let ticks: { index: number; x: number; left: number }[] = []
  // Keep endpoint labels inside the plot, then thin ticks until their boxes fit.
  while (tickCount >= 1) {
    ticks = Array.from({ length: tickCount }, (_, index) => {
      const barIndex = tickCount === 1 ? bars.length - 1 : Math.round(index * (bars.length - 1) / (tickCount - 1))
      const x = chartLeft + (barIndex + offset) * stepX
      return {
        index: barIndex,
        x,
        left: Math.max(chartLeft, Math.min(chartRight - labelWidth, x - labelWidth / 2)),
      }
    })
    if (ticks.every((tick, index) => index === 0 || tick.left >= ticks[index - 1].left + labelWidth + gap)) break
    tickCount--
  }

  ctx.strokeStyle = 'rgba(229, 233, 242, 0.2)'
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(chartLeft, chartBottom + 1)
  ctx.lineTo(chartRight, chartBottom + 1)
  for (const { x } of ticks) {
    ctx.moveTo(x, chartBottom + 1)
    ctx.lineTo(x, chartBottom + 6)
  }
  ctx.stroke()
  ctx.fillStyle = '#8891a5'
  for (const tick of ticks) {
    const timestamp = timestamps[tick.index]
    const nearLeftEdge = tick.x < chartLeft + labelWidth / 2
    const nearRightEdge = tick.x > chartRight - labelWidth / 2
    ctx.textAlign = nearLeftEdge ? 'left' : nearRightEdge ? 'right' : 'center'
    const labelX = tick.left + (nearLeftEdge ? 0 : nearRightEdge ? labelWidth : labelWidth / 2)
    ctx.fillText(timestamp.date, labelX, chartBottom + 10, labelWidth)
    ctx.fillText(timestamp.time, labelX, chartBottom + 25, labelWidth)
  }
  ctx.textAlign = 'right'
  ctx.fillText('UTC', timezoneRight, chartBottom + 25)
  ctx.restore()
}

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
  context?: RsiDivergenceChartContext,
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

  if (context) {
    drawDivergences(
      ctx,
      visibleDivergences(context, data.length),
      { left: 0, right: chartWidth, top: 0, bottom: height },
      stepX,
      (value) => height - (value - minRsi) * scaleY,
      'rsi',
      false,
    )
  }
}

/** Bounds and scale of the RSI panel, including when the price panel is shown. */
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
  context?: DetailRsiChartContext,
): DetailChartLayout | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const { width, height } = syncCanvasResolution(canvas)
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#1c212c'
  ctx.fillRect(0, 0, width, height)
  if (data.length === 0) return null

  const visibleBars = context?.bars.slice(-data.length) ?? []
  const showPricePanel = context !== undefined && context.showPricePanel !== false
  const timeAxisHeight = visibleBars.length > 0 ? 48 : 0
  const plotHeight = height - timeAxisHeight
  const divergences = context ? visibleDivergences(context, data.length) : []
  const lowestPrice = visibleBars.length ? Math.min(...visibleBars.map((bar) => bar.low)) : 0
  const highestPrice = visibleBars.length ? Math.max(...visibleBars.map((bar) => bar.high)) : 1
  const priceRange = highestPrice - lowestPrice
  const pricePadding = priceRange > 0 ? priceRange * 0.12 : (Math.abs(highestPrice) * 0.005 || 1)
  const minPrice = lowestPrice - pricePadding
  const maxPrice = highestPrice + pricePadding
  const priceStep = (maxPrice - minPrice) / 3
  const priceTicks = Array.from({ length: 4 }, (_, index) => minPrice + index * priceStep)
  ctx.font = '12px Inter, system-ui, sans-serif'
  const priceScaleWidth = showPricePanel
    ? Math.max(...priceTicks.map((value) => ctx.measureText(formatPriceTick(value, priceStep)).width)) + 16
    : 0
  const scaleWidth = showPricePanel ? Math.min(width * 0.35, Math.max(56, priceScaleWidth)) : 56
  const margin = 16
  const chartLeft = margin
  const chartRight = width - scaleWidth - margin
  const chartBottom = plotHeight - margin
  const panelTitleHeight = 18
  const panelGap = 30
  const priceTop = margin + panelTitleHeight
  const priceHeight = Math.max(1, (plotHeight - margin * 2 - panelTitleHeight * 2 - panelGap) * 0.35)
  const priceBottom = priceTop + priceHeight
  const chartTop = showPricePanel ? priceBottom + panelGap + panelTitleHeight : margin
  const chartWidth = chartRight - chartLeft
  const chartHeight = chartBottom - chartTop

  const { min: minRsi, max: maxRsi } = computeRsiScale(data, 10)
  const scaleY = chartHeight / (maxRsi - minRsi)
  const stepX = data.length > 1 ? chartWidth / (data.length - 1) : 0

  ctx.font = '12px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  if (showPricePanel) {
    const priceToY = (value: number) => priceBottom - (value - minPrice) / (maxPrice - minPrice) * priceHeight
    for (const value of priceTicks) {
      const y = priceToY(value)
      ctx.beginPath()
      ctx.moveTo(chartLeft, y)
      ctx.lineTo(chartRight, y)
      ctx.strokeStyle = 'rgba(229, 233, 242, 0.12)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.textAlign = 'right'
      ctx.fillStyle = '#8891a5'
      ctx.fillText(formatPriceTick(value, priceStep), width - margin - 4, y, scaleWidth - 8)
    }

    const candleWidth = Math.max(1, Math.min(7, stepX * 0.65))
    const offset = data.length - visibleBars.length
    ctx.save()
    ctx.beginPath()
    ctx.rect(chartLeft - 4, priceTop, chartWidth + 8, priceHeight)
    ctx.clip()
    for (let i = 0; i < visibleBars.length; i++) {
      const bar = visibleBars[i]
      const x = chartLeft + (i + offset) * stepX
      const color = bar.close >= bar.open ? '#5d9d8d' : '#b16d7a'
      ctx.globalAlpha = bar.isClosed ? 0.85 : 0.5
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x, priceToY(bar.high))
      ctx.lineTo(x, priceToY(bar.low))
      ctx.stroke()
      const openY = priceToY(bar.open)
      const closeY = priceToY(bar.close)
      ctx.fillRect(x - candleWidth / 2, Math.min(openY, closeY), candleWidth, Math.max(1, Math.abs(openY - closeY)))
    }
    ctx.restore()
    drawDivergences(ctx, divergences, { left: chartLeft, right: chartRight, top: priceTop, bottom: priceBottom }, stepX, priceToY, 'price', true)

    ctx.font = '600 11px Inter, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#c5ccda'
    ctx.fillText('Price', chartLeft, margin + 3)
    ctx.fillText('RSI (14)', chartLeft, chartTop - 12)
    ctx.beginPath()
    ctx.moveTo(chartLeft, priceBottom + panelGap / 2)
    ctx.lineTo(width - margin, priceBottom + panelGap / 2)
    ctx.strokeStyle = 'rgba(229, 233, 242, 0.18)'
    ctx.lineWidth = 1
    ctx.stroke()

    // The pattern legend also survives chart export without the modal's text.
    if (chartWidth > 270) {
      ctx.font = '10px Inter, system-ui, sans-serif'
      ctx.fillStyle = '#8891a5'
      ctx.strokeStyle = '#aab4c6'
      for (const [label, x, dashed] of [['Regular', chartRight - 168, false], ['Hidden', chartRight - 78, true]] as const) {
        const y = margin + 3
        ctx.setLineDash(dashed ? [4, 3] : [])
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + 19, y)
        ctx.stroke()
        ctx.fillText(label, x + 24, y)
      }
      ctx.setLineDash([])
    }
    ctx.font = '12px Inter, system-ui, sans-serif'
  }

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

  if (context) {
    drawDivergences(
      ctx,
      divergences,
      { left: chartLeft, right: chartRight, top: chartTop, bottom: chartBottom },
      stepX,
      (value) => chartBottom - (value - minRsi) * scaleY,
      'rsi',
      true,
    )
  }

  drawTimeAxis(ctx, visibleBars, data.length, stepX, chartLeft, chartRight, chartBottom, width - margin - 8)

  return { chartLeft, chartRight, chartTop, chartBottom, minRsi, maxRsi }
}

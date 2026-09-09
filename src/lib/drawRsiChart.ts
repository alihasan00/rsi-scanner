import { computeSma } from './rsi'
import { getRsiState, RSI_OVERBOUGHT, RSI_OVERSOLD, RSI_STATE_LABELS } from './rsiState'
import type { DivergenceSignal } from './divergence'
import type { DivergenceSetup } from './divergenceLifecycle'
import type { HeikinAshiBar, TugOfWarPreview } from './tugOfWar'
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
  /** Closed HA history plus its optional live preview, aligned by open time. */
  heikinAshiBars?: readonly (HeikinAshiBar | TugOfWarPreview['heikinAshi'])[]
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

const BULLISH_COLOR = '#34D399'
const BEARISH_COLOR = '#EF4444'
const CHART_BACKGROUND = '#1A1A1A'
const GRID_COLOR = '#333333'
const AXIS_COLOR = '#D4D4D4'

/** Shared, fixed-scale RSI context for card, detail, and compact charts. */
export function drawRsiZones(
  ctx: CanvasRenderingContext2D,
  region: ChartRegion,
  labels: 'detail' | 'compact' | 'none',
): ChartRegion[] {
  const width = region.right - region.left
  const height = region.bottom - region.top
  const toY = (value: number) => region.bottom - value / 100 * height
  const labelBoxes: ChartRegion[] = []
  ctx.save()
  ctx.fillStyle = 'rgba(239, 68, 68, 0.07)'
  ctx.fillRect(region.left, region.top, width, toY(RSI_OVERBOUGHT) - region.top)
  ctx.fillStyle = 'rgba(52, 211, 153, 0.07)'
  ctx.fillRect(region.left, toY(RSI_OVERSOLD), width, region.bottom - toY(RSI_OVERSOLD))

  ctx.font = `${labels === 'detail' ? 10 : 9}px Inter, system-ui, sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 4])
  for (const { threshold, label, color, stroke, offset } of [
    { threshold: RSI_OVERBOUGHT, label: `Overbought ≥ ${RSI_OVERBOUGHT}`, color: '#F28B8B', stroke: 'rgba(239, 68, 68, 0.32)', offset: -8 },
    { threshold: RSI_OVERSOLD, label: `Oversold ≤ ${RSI_OVERSOLD}`, color: '#73C9AA', stroke: 'rgba(52, 211, 153, 0.32)', offset: 8 },
  ]) {
    const y = toY(threshold)
    ctx.strokeStyle = stroke
    ctx.beginPath()
    ctx.moveTo(region.left, y)
    ctx.lineTo(region.right, y)
    ctx.stroke()
    const labelWidth = ctx.measureText(label).width
    if (labels !== 'none' && height >= 64 && labelWidth <= width - 12) {
      ctx.fillStyle = color
      ctx.fillText(label, region.left + 5, y + offset)
      labelBoxes.push({ left: region.left + 4, right: region.left + labelWidth + 6, top: y + offset - 7, bottom: y + offset + 7 })
    }
  }
  ctx.restore()
  return labelBoxes
}

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
  reservedLabelBoxes: readonly ChartRegion[] = [],
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
  const labelBoxes: ChartRegion[] = [...reservedLabelBoxes]

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
      ctx.fillStyle = 'rgba(26, 26, 26, 0.96)'
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

type ChartCandle = Pick<RsiBar, 'open' | 'high' | 'low' | 'close' | 'isClosed'>

interface IndexedCandle {
  bar: ChartCandle
  index: number
}

interface PriceScale {
  min: number
  max: number
  step: number
  ticks: number[]
}

function computePriceScale(bars: readonly ChartCandle[]): PriceScale {
  const lowestPrice = bars.length ? Math.min(...bars.map((bar) => bar.low)) : 0
  const highestPrice = bars.length ? Math.max(...bars.map((bar) => bar.high)) : 1
  const range = highestPrice - lowestPrice
  const padding = range > 0 ? range * 0.12 : (Math.abs(highestPrice) * 0.005 || 1)
  const min = lowestPrice - padding
  const max = highestPrice + padding
  const step = (max - min) / 3
  return { min, max, step, ticks: Array.from({ length: 4 }, (_, index) => min + index * step) }
}

function drawCandlePanel(
  ctx: CanvasRenderingContext2D,
  candles: readonly IndexedCandle[],
  region: ChartRegion,
  stepX: number,
  scale: PriceScale,
  scaleRight: number,
  scaleWidth: number,
  hollowLive: boolean,
): (value: number) => number {
  const panelHeight = region.bottom - region.top
  const toY = (value: number) => region.bottom - (value - scale.min) / (scale.max - scale.min) * panelHeight
  ctx.font = '12px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.setLineDash([])
  for (const value of scale.ticks) {
    const y = toY(value)
    ctx.beginPath()
    ctx.moveTo(region.left, y)
    ctx.lineTo(region.right, y)
    ctx.strokeStyle = GRID_COLOR
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.textAlign = 'right'
    ctx.fillStyle = AXIS_COLOR
    ctx.fillText(formatPriceTick(value, scale.step), scaleRight, y, scaleWidth - 8)
  }

  const candleWidth = stepX > 0 ? Math.max(1, Math.min(7, stepX * 0.65)) : 7
  ctx.save()
  ctx.beginPath()
  ctx.rect(region.left - 4, region.top, region.right - region.left + 8, panelHeight)
  ctx.clip()
  for (const { bar, index } of candles) {
    const x = region.left + index * stepX
    const color = bar.close >= bar.open ? BULLISH_COLOR : BEARISH_COLOR
    ctx.globalAlpha = bar.isClosed ? 0.9 : hollowLive ? 1 : 0.65
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, toY(bar.high))
    ctx.lineTo(x, toY(bar.low))
    ctx.stroke()
    const openY = toY(bar.open)
    const closeY = toY(bar.close)
    const bodyTop = Math.min(openY, closeY)
    const bodyHeight = Math.max(1, Math.abs(openY - closeY))
    if (hollowLive && !bar.isClosed) {
      ctx.fillStyle = CHART_BACKGROUND
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight)
      ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight)
    } else {
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight)
    }
  }
  ctx.restore()
  return toY
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

  ctx.strokeStyle = GRID_COLOR
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
  ctx.fillStyle = AXIS_COLOR
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

  // Keep the same 0–100 reference even when RSI is flat or at an extreme.
  const toY = (value: number) => height - value / 100 * height

  const rightGap = width * 0.12
  const chartWidth = width - rightGap
  const stepX = data.length > 1 ? chartWidth / (data.length - 1) : 0

  drawRsiZones(ctx, { left: 0, right: width, top: 0, bottom: height }, 'none')

  ctx.beginPath()
  ctx.strokeStyle = settings.rsiColor
  ctx.lineWidth = Math.max(2, settings.lineWidth) / 2
  ctx.lineJoin = 'round'
  for (let i = 0; i < data.length; i++) {
    const x = i * stepX
    const y = toY(data[i])
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  const fiftyLineY = toY(50)
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
      toY,
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
  ctx.fillStyle = CHART_BACKGROUND
  ctx.fillRect(0, 0, width, height)
  if (data.length === 0) return null

  const visibleBars = context?.bars.slice(-data.length) ?? []
  const showPricePanel = context !== undefined && context.showPricePanel !== false
  const showHeikinAshiPanel = context?.heikinAshiBars !== undefined
  const offset = data.length - visibleBars.length
  const priceCandles = visibleBars.map((bar, index) => ({ bar, index: index + offset }))
  const heikinAshiByTime = new Map(context?.heikinAshiBars?.map((bar) => [bar.openTime, bar]))
  // A missing HA candle must leave a gap at its own raw timestamp, rather than
  // shifting the remaining synthetic candles onto unrelated price/RSI bars.
  const heikinAshiCandles = visibleBars.flatMap((raw, index) => {
    const bar = heikinAshiByTime.get(raw.openTime)
    return bar ? [{ bar, index: index + offset }] : []
  })
  const timeAxisHeight = visibleBars.length > 0 ? 48 : 0
  const plotHeight = height - timeAxisHeight
  const divergences = context ? visibleDivergences(context, data.length) : []
  const priceScale = computePriceScale(visibleBars)
  const heikinAshiScale = computePriceScale(heikinAshiCandles.map(({ bar }) => bar))
  ctx.font = '12px Inter, system-ui, sans-serif'
  const priceScaleWidths = [
    ...(showPricePanel ? [priceScale] : []),
    ...(showHeikinAshiPanel ? [heikinAshiScale] : []),
  ].flatMap((scale) => scale.ticks.map((value) => ctx.measureText(formatPriceTick(value, scale.step)).width + 16))
  const scaleWidth = priceScaleWidths.length ? Math.min(width * 0.35, Math.max(56, ...priceScaleWidths)) : 56
  const margin = 16
  const chartLeft = margin
  const chartRight = width - scaleWidth - margin
  const chartBottom = plotHeight - margin
  const panelTitleHeight = 18
  const panelGap = 30
  const priceTop = margin + panelTitleHeight
  const candlePanelCount = Number(showPricePanel) + Number(showHeikinAshiPanel)
  const availablePanelHeight = plotHeight - margin * 2 - panelTitleHeight * (candlePanelCount + 1) - panelGap * candlePanelCount
  const priceHeight = Math.max(1, availablePanelHeight * (showHeikinAshiPanel ? (showPricePanel ? 0.32 : 0.45) : 0.35))
  const priceBottom = priceTop + priceHeight
  const heikinAshiTop = showPricePanel ? priceBottom + panelGap + panelTitleHeight : margin + panelTitleHeight
  const heikinAshiBottom = heikinAshiTop + priceHeight
  const chartTop = showHeikinAshiPanel
    ? heikinAshiBottom + panelGap + panelTitleHeight
    : showPricePanel ? priceBottom + panelGap + panelTitleHeight : margin + panelTitleHeight
  const chartWidth = chartRight - chartLeft
  const chartHeight = chartBottom - chartTop

  const minRsi = 0
  const maxRsi = 100
  const scaleY = chartHeight / (maxRsi - minRsi)
  const stepX = data.length > 1 ? chartWidth / (data.length - 1) : 0

  ctx.font = '12px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  if (showPricePanel) {
    const region = { left: chartLeft, right: chartRight, top: priceTop, bottom: priceBottom }
    const priceToY = drawCandlePanel(ctx, priceCandles, region, stepX, priceScale, width - margin - 4, scaleWidth, false)
    drawDivergences(ctx, divergences, region, stepX, priceToY, 'price', true)

    ctx.font = '600 11px Inter, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#F9F9F9'
    ctx.fillText('Price', chartLeft, margin + 3)
    ctx.beginPath()
    ctx.moveTo(chartLeft, priceBottom + panelGap / 2)
    ctx.lineTo(width - margin, priceBottom + panelGap / 2)
    ctx.strokeStyle = GRID_COLOR
    ctx.lineWidth = 1
    ctx.stroke()

    if (divergences.length > 0 && chartWidth > 270) {
      ctx.font = '10px Inter, system-ui, sans-serif'
      ctx.fillStyle = AXIS_COLOR
      ctx.strokeStyle = '#888888'
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

  if (showHeikinAshiPanel) {
    const region = { left: chartLeft, right: chartRight, top: heikinAshiTop, bottom: heikinAshiBottom }
    if (heikinAshiCandles.length > 0) {
      drawCandlePanel(ctx, heikinAshiCandles, region, stepX, heikinAshiScale, width - margin - 4, scaleWidth, true)
    } else {
      ctx.font = '11px Inter, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillStyle = '#888888'
      ctx.fillText('No Heikin-Ashi candles', (chartLeft + chartRight) / 2, (heikinAshiTop + heikinAshiBottom) / 2)
    }
    ctx.font = '600 11px Inter, system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillStyle = '#F9F9F9'
    ctx.fillText('Heikin-Ashi', chartLeft, heikinAshiTop - 12)
    const titleWidth = ctx.measureText('Heikin-Ashi').width
    ctx.font = '10px Inter, system-ui, sans-serif'
    ctx.fillStyle = AXIS_COLOR
    ctx.fillText(' · averaged prices', chartLeft + titleWidth, heikinAshiTop - 12)
    if (heikinAshiCandles.some(({ bar }) => !bar.isClosed)) {
      ctx.font = '600 9px Inter, system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillStyle = '#A366F5'
      ctx.fillText('LIVE', chartRight, heikinAshiTop - 12)
    }
    ctx.beginPath()
    ctx.moveTo(chartLeft, heikinAshiBottom + panelGap / 2)
    ctx.lineTo(width - margin, heikinAshiBottom + panelGap / 2)
    ctx.strokeStyle = GRID_COLOR
    ctx.lineWidth = 1
    ctx.stroke()
  }

  ctx.font = '600 11px Inter, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillStyle = '#F9F9F9'
  ctx.fillText('RSI (14)', chartLeft, chartTop - 12)
  const titleWidth = ctx.measureText('RSI (14)').width
  const latestRsi = data.at(-1)!
  const rsiState = getRsiState(latestRsi)
  if (rsiState) {
    const isLive = visibleBars.at(-1)?.isClosed === false
    ctx.font = '11px Inter, system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillStyle = rsiState === 'overbought' ? '#F28B8B' : rsiState === 'oversold' ? '#73C9AA' : AXIS_COLOR
    ctx.fillText(`${latestRsi.toFixed(1)} · ${RSI_STATE_LABELS[rsiState]}${isLive ? ' · Live' : ''}`, chartRight, chartTop - 12, Math.max(1, chartWidth - titleWidth - 12))
  }
  const rsiZoneLabelBoxes = drawRsiZones(ctx, { left: chartLeft, right: chartRight, top: chartTop, bottom: chartBottom }, 'detail')
  ctx.font = '12px Inter, system-ui, sans-serif'

  const rsiTicks = chartHeight >= 180 ? Array.from({ length: 11 }, (_, index) => index * 10) : [0, RSI_OVERSOLD, 50, RSI_OVERBOUGHT, 100]
  for (const v of rsiTicks) {
    const y = chartBottom - (v - minRsi) * scaleY
    if (v !== RSI_OVERBOUGHT && v !== RSI_OVERSOLD) {
      ctx.beginPath()
      ctx.moveTo(chartLeft, y)
      ctx.lineTo(chartRight, y)
      ctx.strokeStyle = v === 50 ? settings.midlineColor : GRID_COLOR
      ctx.lineWidth = v === 50 ? 1.5 : 1
      ctx.stroke()
    }

    ctx.fillStyle = v === RSI_OVERBOUGHT ? '#F28B8B' : v === RSI_OVERSOLD ? '#73C9AA' : AXIS_COLOR
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
      rsiZoneLabelBoxes,
    )
  }

  drawTimeAxis(ctx, visibleBars, data.length, stepX, chartLeft, chartRight, chartBottom, width - margin - 8)

  return { chartLeft, chartRight, chartTop, chartBottom, minRsi, maxRsi }
}

import type { ChartSettings, RsiBar, Timeframe } from '../types'
import type { DivergenceSetup } from './divergenceLifecycle'
import { syncCanvasResolution } from './drawRsiChart'

interface ScreenerChartData {
  bars: readonly RsiBar[]
  divergences: readonly DivergenceSetup[]
  timeframe: Timeframe
  settings?: Pick<ChartSettings, 'rsiColor' | 'lineWidth' | 'midlineColor'>
}

interface ChartRegion {
  left: number
  right: number
  top: number
  bottom: number
}

const BACKGROUND = '#1A1A1A'
const GRID_COLOR = '#333333'
const AXIS_COLOR = '#D4D4D4'
const UP_COLOR = '#34D399'
const DOWN_COLOR = '#EF4444'
const RSI_COLOR = '#8B46F2'
const FONT = '10px Inter, system-ui, sans-serif'

function formatPriceTick(value: number, step: number, exponential = false): string {
  const exponent = Math.floor(Math.log10(Math.abs(value) || 1))
  const stepExponent = Math.floor(Math.log10(step))
  if (exponential || exponent < -7 || exponent > 8) {
    return value.toExponential(Math.min(8, Math.max(1, exponent - stepExponent + 1)))
  }
  const digits = Math.min(12, Math.max(0, 1 - stepExponent))
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function formatTimestamp(timestamp: number, daily: boolean): [string, string] {
  const date = new Date(timestamp)
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  const day = date.getUTCDate().toString().padStart(2, '0')
  return [
    `${day} ${month}`,
    daily ? `${date.getUTCFullYear()}` : date.toISOString().slice(11, 16),
  ]
}

function drawDivergences(
  ctx: CanvasRenderingContext2D,
  bars: readonly RsiBar[],
  divergences: readonly DivergenceSetup[],
  region: ChartRegion,
  toX: (timestamp: number) => number,
  toY: (value: number) => number,
  valueKey: 'price' | 'rsi',
): void {
  const visibleTimes = new Set(bars.map((bar) => bar.openTime))
  ctx.save()
  ctx.beginPath()
  ctx.rect(region.left, region.top, region.right - region.left, region.bottom - region.top)
  ctx.clip()
  ctx.lineWidth = 1.6
  ctx.lineCap = 'round'
  for (const signal of divergences) {
    // Never pin an offscreen pivot to a visible edge; both anchors must exist.
    if (!visibleTimes.has(signal.start.time) || !visibleTimes.has(signal.end.time)) continue
    const bullish = signal.kind.endsWith('bullish')
    const color = bullish ? UP_COLOR : DOWN_COLOR
    const live = signal.state === 'forming' || signal.state === 'confirmed'
    ctx.globalAlpha = live ? 0.95 : 0.3
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.setLineDash(signal.kind.startsWith('hidden') ? [4, 3] : [])
    const startX = toX(signal.start.time)
    const endX = toX(signal.end.time)
    const startY = toY(signal.start[valueKey])
    const endY = toY(signal.end[valueKey])
    ctx.beginPath()
    ctx.moveTo(startX, startY)
    ctx.lineTo(endX, endY)
    ctx.stroke()
    ctx.setLineDash([])
    for (const [x, y] of [[startX, startY], [endX, endY]]) {
      ctx.beginPath()
      ctx.arc(x, y, 2.1, 0, Math.PI * 2)
      ctx.fillStyle = signal.state === 'forming' ? BACKGROUND : color
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
}

/** A compact, raw OHLC price chart with a separate fixed 0–100 RSI scale. */
export function drawScreenerChart(canvas: HTMLCanvasElement, data: ScreenerChartData): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = syncCanvasResolution(canvas)
  const rsiColor = data.settings?.rsiColor ?? RSI_COLOR
  const rsiLineWidth = data.settings?.lineWidth ?? 1.35
  const midlineColor = data.settings?.midlineColor ?? '#888888'
  ctx.clearRect(0, 0, width, height)
  if (data.bars.length === 0 || width < 80 || height < 100) return
  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, width, height)

  const bars = data.bars.slice(-72).filter((bar) => (
    Number.isFinite(bar.openTime) && Number.isFinite(bar.closeTime)
    && Number.isFinite(bar.open) && Number.isFinite(bar.high)
    && Number.isFinite(bar.low) && Number.isFinite(bar.close)
    && Number.isFinite(bar.rsi) && bar.low > 0 && bar.high >= bar.low
  ))
  if (bars.length === 0) return

  const first = bars[0]
  const latest = bars[bars.length - 1]
  const lowest = Math.min(...bars.map((bar) => bar.low))
  const highest = Math.max(...bars.map((bar) => bar.high))
  const padding = Math.max((highest - lowest) * 0.13, highest * 0.00005)
  const minPrice = Math.max(0, lowest - padding)
  const maxPrice = highest + padding
  const priceRange = maxPrice - minPrice
  // Three ticks keep a usable candle plot even for very small token prices.
  const priceStep = priceRange / 2
  const priceTicks = [maxPrice, minPrice + priceStep, minPrice]
  ctx.font = FONT
  let priceLabels = priceTicks.map((value) => formatPriceTick(value, priceStep))
  if (Math.max(...priceLabels.map((label) => ctx.measureText(label).width)) > width * 0.23) {
    priceLabels = priceTicks.map((value) => formatPriceTick(value, priceStep, true))
  }
  const axisWidth = Math.max(42, ...priceLabels.map((label) => ctx.measureText(label).width + 12))
  const left = 12
  const right = width - axisWidth - 8
  const plotWidth = right - left
  const priceTop = 10
  const priceBottom = Math.round(height * 0.5)
  const rsiTop = Math.round(height * 0.61)
  const rsiBottom = height - 30
  const priceToY = (value: number) => priceBottom - (value - minPrice) / priceRange * (priceBottom - priceTop)
  const rsiToY = (value: number) => rsiBottom - value / 100 * (rsiBottom - rsiTop)

  const candleDuration = Math.max(1, latest.closeTime - latest.openTime + 1)
  const totalTime = Math.max(candleDuration, latest.openTime - first.openTime + candleDuration)
  const candleSpace = Math.min(12, plotWidth * candleDuration / totalTime)
  // Timestamps preserve visible gaps instead of connecting missing candles.
  const toX = (timestamp: number) => left + (timestamp - first.openTime + candleDuration / 2) / totalTime * plotWidth
  const candleWidth = Math.max(1, Math.min(6, candleSpace * 0.64))
  const dateTicks = bars.length === 1 ? [first] : plotWidth >= 210
    ? [first, bars[Math.floor((bars.length - 1) / 2)], latest]
    : [first, latest]

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.lineWidth = 1
  for (let index = 0; index < priceTicks.length; index++) {
    const y = priceToY(priceTicks[index])
    ctx.strokeStyle = GRID_COLOR
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
    ctx.stroke()
    ctx.fillStyle = AXIS_COLOR
    ctx.fillText(priceLabels[index], right + 8, y)
  }

  for (const bar of dateTicks) {
    const x = toX(bar.openTime)
    ctx.strokeStyle = GRID_COLOR
    ctx.beginPath()
    ctx.moveTo(x, priceTop)
    ctx.lineTo(x, priceBottom)
    ctx.moveTo(x, rsiTop)
    ctx.lineTo(x, rsiBottom)
    ctx.stroke()
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(left, priceTop, plotWidth, priceBottom - priceTop)
  ctx.clip()
  if (!latest.isClosed) {
    ctx.fillStyle = '#261042'
    ctx.fillRect(toX(latest.openTime) - candleSpace / 2, priceTop, candleSpace, priceBottom - priceTop)
  }
  ctx.strokeStyle = latest.close >= latest.open ? 'rgba(52, 211, 153, 0.28)' : 'rgba(239, 68, 68, 0.28)'
  ctx.setLineDash([2, 4])
  ctx.beginPath()
  ctx.moveTo(left, priceToY(latest.close))
  ctx.lineTo(right, priceToY(latest.close))
  ctx.stroke()
  ctx.setLineDash([])
  for (const bar of bars) {
    const x = toX(bar.openTime)
    const openY = priceToY(bar.open)
    const closeY = priceToY(bar.close)
    const bodyTop = Math.min(openY, closeY)
    const bodyHeight = Math.max(1, Math.abs(openY - closeY))
    const color = bar.close >= bar.open ? UP_COLOR : DOWN_COLOR
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.globalAlpha = bar.isClosed ? 0.9 : 0.75
    ctx.beginPath()
    ctx.moveTo(x, priceToY(bar.high))
    ctx.lineTo(x, priceToY(bar.low))
    ctx.stroke()
    if (bar.isClosed) {
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight)
    } else {
      ctx.fillStyle = BACKGROUND
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight)
      ctx.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight)
    }
  }
  ctx.restore()
  drawDivergences(ctx, bars, data.divergences, { left, right, top: priceTop, bottom: priceBottom }, toX, priceToY, 'price')

  ctx.strokeStyle = GRID_COLOR
  ctx.beginPath()
  ctx.moveTo(left, priceBottom + 10)
  ctx.lineTo(width - 12, priceBottom + 10)
  ctx.stroke()

  ctx.fillStyle = rsiColor
  ctx.font = '500 9px Inter, system-ui, sans-serif'
  ctx.fillText('RSI 14', left, rsiTop - 4)
  ctx.font = '9px Inter, system-ui, sans-serif'
  for (const value of [30, 50, 70]) {
    const y = rsiToY(value)
    ctx.strokeStyle = value === 50 ? midlineColor : GRID_COLOR
    ctx.setLineDash(value === 50 ? [2, 3] : [])
    ctx.beginPath()
    ctx.moveTo(left, y)
    ctx.lineTo(right, y)
    ctx.stroke()
    ctx.fillStyle = AXIS_COLOR
    ctx.fillText(`${value}`, right + 8, y)
  }
  ctx.setLineDash([])
  ctx.save()
  ctx.beginPath()
  ctx.rect(left, rsiTop, plotWidth, rsiBottom - rsiTop)
  ctx.clip()
  ctx.strokeStyle = rsiColor
  ctx.lineWidth = rsiLineWidth
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  // Do not imply continuous RSI evidence across history gaps. A live segment
  // stays dashed so a provisional RSI cannot look like a closed observation.
  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1]
    const current = bars[index]
    if (previous.closeTime + 1 !== current.openTime) continue
    ctx.setLineDash(current.isClosed ? [] : [2, 2])
    ctx.beginPath()
    ctx.moveTo(toX(previous.openTime), rsiToY(previous.rsi))
    ctx.lineTo(toX(current.openTime), rsiToY(current.rsi))
    ctx.stroke()
  }
  ctx.setLineDash([])
  ctx.fillStyle = rsiColor
  ctx.beginPath()
  ctx.arc(toX(latest.openTime), rsiToY(latest.rsi), 1.8, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  drawDivergences(ctx, bars, data.divergences, { left, right, top: rsiTop, bottom: rsiBottom }, toX, rsiToY, 'rsi')

  const daily = data.timeframe.endsWith('d') || data.timeframe.endsWith('w')
  ctx.font = '9px Inter, system-ui, sans-serif'
  ctx.fillStyle = AXIS_COLOR
  // Clamp label boxes inside the plot and skip a crowded interior tick.
  let previousLabelRight = -Infinity
  for (let index = 0; index < dateTicks.length; index++) {
    const bar = dateTicks[index]
    const [date, time] = formatTimestamp(bar.openTime, daily)
    const labelWidth = Math.max(ctx.measureText(date).width, ctx.measureText(time).width)
    const x = Math.max(left, Math.min(right - labelWidth, toX(bar.openTime) - labelWidth / 2))
    const lastLabelWidth = Math.max(...formatTimestamp(latest.openTime, daily).map((label) => ctx.measureText(label).width))
    if (index > 0 && index < dateTicks.length - 1 && (x <= previousLabelRight + 12 || x + labelWidth + 12 > right - lastLabelWidth)) continue
    if (index > 0 && x <= previousLabelRight + 8) continue
    ctx.fillText(date, x, height - 17)
    ctx.fillText(time, x, height - 5)
    previousLabelRight = x + labelWidth
  }
  ctx.fillStyle = '#888888'
  ctx.fillText('UTC', right + 8, height - 5)
}

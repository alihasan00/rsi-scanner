import type { RsiBar } from '../types'
import type { FibSetup } from './fibonacci'
import { isActiveFibSetup } from './fibonacci'
import { syncCanvasResolution } from './drawRsiChart'
import { formatQuotePrice } from './priceFormatting'

interface FibChartData {
  bars: readonly RsiBar[]
  setup: FibSetup | null
  compact?: boolean
  showReferenceGrid?: boolean
}

function compactPriceTick(value: number): string {
  if (value > 0 && (value < 0.00001 || value >= 100_000_000)) return value.toExponential(2)
  return value.toLocaleString('en-US', { maximumSignificantDigits: 5 })
}

/** Raw wick prices share the exact linear/log scale used for Fib calculations. */
export function drawFibChart(canvas: HTMLCanvasElement, { bars: input, setup, compact = false, showReferenceGrid = false }: FibChartData): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const { width, height } = syncCanvasResolution(canvas)
  ctx.clearRect(0, 0, width, height)
  if (width < 100 || height < 100) return
  ctx.fillStyle = '#1A1A1A'
  ctx.fillRect(0, 0, width, height)
  const anchorIndex = setup ? input.findIndex((bar) => bar.openTime === setup.start.time) : -1
  const lookback = compact ? 96 : 120
  const start = Math.max(0, Math.min(input.length - lookback, anchorIndex < 0 ? input.length - lookback : anchorIndex - 6))
  const bars = input.slice(Math.max(start, input.length - 500)).filter((bar) => (
    [bar.open, bar.high, bar.low, bar.close, bar.openTime, bar.closeTime].every(Number.isFinite)
    && bar.low > 0 && bar.high >= bar.low
  ))
  if (!bars.length) return
  const wide = width >= 650 && !compact
  const left = 12
  const right = width - (compact ? 76 : wide ? 220 : 108)
  const top = compact ? 16 : 32
  const bottom = height - (compact ? 24 : 32)
  const log = setup?.scale === 'log'
  const transform = (value: number) => log ? Math.log(value) : value
  const inverse = (value: number) => log ? Math.exp(value) : value
  const tradeLines = setup && !compact ? [
    ...setup.entries.map((entry, index) => ({
      price: entry.price, label: `E${index + 1} · ${entry.ratio}`, color: '#F2C66D',
      detail: `${entry.weight}%`,
    })),
    { price: setup.currentStop, label: 'Stop', color: '#F87171', detail: '' },
    ...setup.targets.filter((_, index) => !compact || index === 0).map((target) => ({
      price: target.price, label: target.id === 'runner' ? 'Runner' : target.id.toUpperCase(),
      color: '#6EE7B7', detail: target.id === 'runner' ? 'trail stop' : `${target.exitPercent}%`,
    })),
  ].filter((line) => line.price > 0 && Number.isFinite(line.price)) : []
  const referenceLines = setup && !compact && showReferenceGrid ? setup.levels
    .filter((level) => !tradeLines.some((line) => line.price === level.price))
    .map((level) => ({ price: level.price, label: String(level.ratio), color: '#B6A3D1', detail: 'reference' })) : []
  const lines = [...tradeLines, ...referenceLines]
  const values = [...bars.flatMap((bar) => [bar.low, bar.high]), ...lines.map((line) => line.price)]
  const visibleAnchors = setup && [setup.start, setup.end].every((anchor) => (
    Number.isFinite(anchor.price) && anchor.price > 0
    && bars.some((bar) => bar.isClosed && bar.openTime === anchor.time)
  ))
  if (setup && (!compact || visibleAnchors)) values.push(setup.start.price, setup.end.price)
  const low = Math.min(...values.map(transform))
  const high = Math.max(...values.map(transform))
  const pad = Math.max((high - low) * 0.08, Math.abs(high) * 0.00005, Number.EPSILON)
  const min = low - pad
  const max = high + pad
  const toY = (price: number) => bottom - (transform(price) - min) / (max - min) * (bottom - top)
  const first = bars[0]
  const last = bars[bars.length - 1]
  const duration = Math.max(1, last.closeTime - last.openTime + 1)
  const span = Math.max(duration, last.openTime - first.openTime + duration * 3)
  const toX = (time: number) => left + (time - first.openTime + duration / 2) / span * (right - left)
  const bodyWidth = Math.max(1, Math.min(9, (right - left) * duration / span * 0.65))
  ctx.font = '10px Inter, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 1
  const ticks = compact ? 3 : 5
  for (let i = 0; i < ticks; i++) {
    const y = top + (bottom - top) * i / (ticks - 1)
    ctx.strokeStyle = '#2D2D2D'
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke()
    if (compact || !setup) {
      ctx.fillStyle = '#888888'
      const price = inverse(max - (max - min) * i / (ticks - 1))
      ctx.fillText(compact ? compactPriceTick(price) : formatQuotePrice(price), right + 8, y)
    }
  }
  ctx.save()
  ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip()
  if (setup && !compact) {
    ctx.globalAlpha = isActiveFibSetup(setup) ? 1 : 0.4
    const from = Math.max(left, toX(setup.end.time))
    ctx.fillStyle = 'rgba(242, 198, 109, 0.14)'
    ctx.fillRect(from, toY(setup.goldenPocket.high), right - from, toY(setup.goldenPocket.low) - toY(setup.goldenPocket.high))
    ctx.strokeStyle = '#9C83C9'
    ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(toX(setup.start.time), toY(setup.start.price)); ctx.lineTo(toX(setup.end.time), toY(setup.end.price)); ctx.stroke()
    for (const line of lines) {
      ctx.strokeStyle = line.color
      ctx.setLineDash(line.label === 'Stop' ? [5, 3] : [2, 4])
      ctx.beginPath(); ctx.moveTo(from, toY(line.price)); ctx.lineTo(right, toY(line.price)); ctx.stroke()
    }
    ctx.setLineDash([])
    ctx.globalAlpha = 1
  }
  for (const bar of bars) {
    const x = toX(bar.openTime)
    ctx.strokeStyle = bar.close >= bar.open ? '#34D399' : '#EF4444'
    ctx.fillStyle = bar.isClosed ? ctx.strokeStyle : '#1A1A1A'
    ctx.beginPath(); ctx.moveTo(x, toY(bar.high)); ctx.lineTo(x, toY(bar.low)); ctx.stroke()
    const y = Math.min(toY(bar.open), toY(bar.close))
    const h = Math.max(1, Math.abs(toY(bar.open) - toY(bar.close)))
    ctx.fillRect(x - bodyWidth / 2, y, bodyWidth, h)
    ctx.strokeRect(x - bodyWidth / 2, y, bodyWidth, h)
  }
  if (compact && setup && visibleAnchors) {
    ctx.strokeStyle = setup.direction === 'long' ? '#6EE7B7' : '#FCA5A5'
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = 1.5
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(toX(setup.start.time), toY(setup.start.price))
    ctx.lineTo(toX(setup.end.time), toY(setup.end.price))
    ctx.stroke()
    for (const anchor of [setup.start, setup.end]) {
      ctx.beginPath()
      ctx.arc(toX(anchor.time), toY(anchor.price), 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
  // Spread nearby labels without moving their actual price lines.
  const ordered = lines.map((line) => ({ ...line, y: toY(line.price), labelY: toY(line.price) })).sort((a, b) => a.y - b.y)
  const spacing = Math.min(wide ? 23 : 20, (bottom - top - 10) / Math.max(1, ordered.length - 1))
  ordered.forEach((line, index) => { line.labelY = Math.max(line.y, top + 5, index ? ordered[index - 1].labelY + spacing : top + 5) })
  for (let i = ordered.length - 1; i >= 0; i--) {
    ordered[i].labelY = Math.min(ordered[i].labelY, bottom - 5, i < ordered.length - 1 ? ordered[i + 1].labelY - spacing : bottom - 5)
  }
  for (const line of ordered) {
    ctx.strokeStyle = line.color
    ctx.globalAlpha = 0.5
    ctx.beginPath(); ctx.moveTo(right, line.y); ctx.lineTo(right + 8, line.labelY); ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = line.color
    ctx.fillText(wide ? `${line.label}  ${formatQuotePrice(line.price)}  ${line.detail}` : line.label, right + 12, line.labelY)
  }
  if (!compact) {
    ctx.fillStyle = '#D4D4D4'
    ctx.fillText(`${log ? 'Log' : 'Linear'} · ${setup ? 'Golden pocket 0.618–0.666' : 'Waiting for structure'}`, left, 14)
  }
  ctx.fillStyle = '#888888'
  const dateLabel = (time: number) => new Date(time).toLocaleString('en-GB', {
    timeZone: 'UTC', day: '2-digit', month: 'short', ...(compact ? {} : { hour: '2-digit', minute: '2-digit' }),
  })
  ctx.fillText(dateLabel(first.openTime), left, height - 13)
  ctx.textAlign = 'right'
  ctx.fillText(`${dateLabel(last.openTime)} UTC`, right, height - 13)
  ctx.textAlign = 'left'
}

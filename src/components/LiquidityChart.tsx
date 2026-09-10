import { useId, useMemo } from 'react'
import { useElementSize } from '../hooks/useElementSize'
import type { LiquidityLevel } from '../lib/liquidityLevels'
import { formatQuotePrice } from '../lib/priceFormatting'
import type { Candle } from '../types'
import './LiquidityChart.css'

interface LiquidityChartProps {
  bars: readonly (Candle & { isClosed: boolean })[]
  levels: readonly LiquidityLevel[]
  price: number
  compact?: boolean
}

const COLORS = {
  support: '#6EE7B7', resistance: '#FCA5A5', monday: '#C3A570',
  current: '#D4D4D4', rising: '#34D399', falling: '#F87171',
}

function chartPrice(value: number): string {
  if (value < 0.000001 || value >= 100_000_000) return value.toExponential(3)
  return value.toLocaleString('en-US', { maximumSignificantDigits: 7 })
}

function utcLabel(time: number): string {
  return new Date(time).toLocaleString('en-GB', {
    timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function sideOf(price: number, current: number): 'support' | 'resistance' | 'current' {
  return price < current ? 'support' : price > current ? 'resistance' : 'current'
}

/** Calendar levels begin only after their source period has fully closed. */
export function LiquidityChart({ bars: input, levels, price, compact = false }: LiquidityChartProps) {
  const { ref, width: measuredWidth } = useElementSize<HTMLDivElement>()
  const clipId = useId()
  const bars = useMemo(() => input.slice(compact ? -40 : -80).filter((bar) => (
    [bar.openTime, bar.closeTime, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
    && bar.closeTime >= bar.openTime && bar.low > 0
    && bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close)
  )), [input, compact])
  const last = bars.at(-1)
  const current = Number.isFinite(price) && price > 0 ? price : last?.close
  const validLevels = levels.filter((level) => (
    Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.availableFrom)
  ))
  const live = last?.isClosed === false
  const levelDescription = validLevels.map((level) => (
    `${level.label}: ${formatQuotePrice(level.price)}${current ? `, ${sideOf(level.price, current) === 'current' ? 'at current price' : sideOf(level.price, current)}` : ''}`
  )).join('. ')
  const description = bars.length
    ? `Support and resistance chart with ${bars.length} raw candles. Current price ${formatQuotePrice(current ?? 0)}. ${live ? 'The hollow forming candle is provisional.' : 'All displayed candles are closed.'} ${levelDescription || 'No completed reference levels available.'} Level lines begin when their source period closes. All times UTC.`
    : 'Support and resistance chart. Waiting for market data.'

  if (!bars.length || current == null) {
    return <div ref={ref} className={`liquidity-chart${compact ? ' liquidity-chart--compact' : ''}`} role="img" aria-label={description}>
      <span className="liquidity-chart__empty">Waiting for market data</span>
    </div>
  }

  const width = measuredWidth || (compact ? 320 : 700)
  const height = compact ? 150 : 330
  const gutter = compact ? Math.min(108, width * 0.35) : Math.min(172, Math.max(112, width * 0.26))
  const left = 10
  const right = Math.max(left + 35, width - gutter)
  const top = compact ? 12 : 28
  const bottom = height - (compact ? 20 : 38)
  const first = bars[0]
  const final = bars[bars.length - 1]
  const duration = Math.max(1, final.closeTime - final.openTime + 1)
  const visibleEnd = final.openTime + duration
  const span = Math.max(duration, visibleEnd - first.openTime) + duration * 1.5
  const toX = (time: number) => left + (time - first.openTime) / span * (right - left)
  const bodyWidth = Math.max(1, Math.min(compact ? 5 : 8, (right - left) * duration / span * 0.65))
  const baseLow = Math.min(current, ...bars.map((bar) => bar.low))
  const baseHigh = Math.max(current, ...bars.map((bar) => bar.high))
  const baseSpan = Math.max(baseHigh - baseLow, current * 0.002)
  const availableLevels = validLevels.filter((level) => level.availableFrom <= visibleEnd)
  // Preserve candle detail when a weekly/monthly extreme is far from this window.
  const visibleLevels = availableLevels.filter((level) => (
    level.price >= baseLow - baseSpan * 0.75 && level.price <= baseHigh + baseSpan * 0.75
  ))
  const offChartCount = availableLevels.length - visibleLevels.length
  const low = Math.min(baseLow, ...visibleLevels.map((level) => level.price))
  const high = Math.max(baseHigh, ...visibleLevels.map((level) => level.price))
  const pad = Math.max((high - low) * 0.1, baseSpan * 0.08)
  const min = Math.max(0, low - pad)
  const max = high + pad
  const toY = (value: number) => bottom - (value - min) / (max - min) * (bottom - top)
  const currentY = toY(current)
  const labels = [
    ...visibleLevels.map((level) => ({
      id: level.id, price: level.price, name: level.label,
      color: COLORS[sideOf(level.price, current)], monday: level.source === 'monday',
      isCurrent: false, y: toY(level.price), labelY: toY(level.price),
    })),
    { id: 'current-price', price: current, name: live ? 'Live price' : 'Latest price', color: COLORS.current, monday: false, isCurrent: true, y: currentY, labelY: currentY },
  ].sort((a, b) => a.y - b.y)
  const labelHeight = compact ? 14 : 27
  const spacing = Math.min(labelHeight, (bottom - top - 12) / Math.max(1, labels.length - 1))
  labels.forEach((label, index) => {
    label.labelY = Math.max(label.y, top + 6, index ? labels[index - 1].labelY + spacing : top + 6)
  })
  for (let index = labels.length - 1; index >= 0; index--) {
    labels[index].labelY = Math.min(labels[index].labelY, bottom - 6, index < labels.length - 1 ? labels[index + 1].labelY - spacing : bottom - 6)
  }
  const textWidth = width - right - 15
  const maxNameLength = Math.max(8, Math.floor(textWidth / 5.2))
  const shortName = (name: string) => name.length > maxNameLength ? `${name.slice(0, maxNameLength - 1)}…` : name
  const priceText = (value: number) => chartPrice(value)
  const ticks = compact ? 3 : 5

  return <div ref={ref} className={`liquidity-chart${compact ? ' liquidity-chart--compact' : ''}`}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${description}${offChartCount ? ` ${offChartCount} distant ${offChartCount === 1 ? 'level is' : 'levels are'} outside the visible price range.` : ''}`}>
      <defs><clipPath id={clipId}><rect x={left} y={top} width={right - left} height={bottom - top} /></clipPath></defs>
      {Array.from({ length: ticks }, (_, index) => {
        const y = top + (bottom - top) * index / (ticks - 1)
        return <line key={index} x1={left} x2={right} y1={y} y2={y} className="liquidity-chart__grid" />
      })}
      {!compact && <text x={left} y={14} className="liquidity-chart__caption">Raw candles · UTC{live ? ' · Hollow = forming' : ''}</text>}
      <g clipPath={`url(#${clipId})`}>
        {visibleLevels.map((level) => {
          const y = toY(level.price)
          const from = Math.max(left, toX(level.availableFrom))
          const color = level.source === 'monday' ? COLORS.monday : COLORS[sideOf(level.price, current)]
          return <g key={level.id}>
            <line x1={from} x2={right} y1={y} y2={y} stroke={color} strokeOpacity={level.source === 'monday' ? 0.64 : 0.72} strokeDasharray={level.source === 'monday' ? '3 4' : '6 4'} />
            {from > left && <circle cx={from} cy={y} r={2} fill={color} />}
          </g>
        })}
        {bars.map((bar) => {
          const x = toX(bar.openTime + (bar.closeTime - bar.openTime + 1) / 2)
          const color = bar.close >= bar.open ? COLORS.rising : COLORS.falling
          const y = Math.min(toY(bar.open), toY(bar.close))
          const bodyHeight = Math.max(1, Math.abs(toY(bar.open) - toY(bar.close)))
          return <g key={bar.openTime}>
            <line x1={x} x2={x} y1={toY(bar.high)} y2={toY(bar.low)} stroke={color} strokeWidth={1} />
            <rect x={x - bodyWidth / 2} y={y} width={bodyWidth} height={bodyHeight} fill={bar.isClosed ? color : 'var(--color-surface)'} stroke={color} strokeWidth={1} />
          </g>
        })}
        <line x1={left} x2={right} y1={currentY} y2={currentY} stroke={COLORS.current} strokeOpacity={0.55} strokeDasharray="2 4" />
      </g>
      {labels.map((label) => <g key={label.id}>
        <path d={`M ${right} ${label.y} L ${right + 7} ${label.labelY} L ${right + 10} ${label.labelY}`} fill="none" stroke={label.color} strokeOpacity={0.5} />
        {compact ? <text x={right + 13} y={label.labelY + 3} fill={label.color} className="liquidity-chart__price liquidity-chart__price--compact">
          {label.isCurrent ? '●' : label.price < current ? 'S' : label.price > current ? 'R' : '='} {priceText(label.price)}
        </text> : <>
          <text x={right + 13} y={label.labelY - 5} fill={label.monday ? COLORS.monday : 'var(--color-ink-muted)'} className="liquidity-chart__level-name">{shortName(label.name)}</text>
          <text x={right + 13} y={label.labelY + 8} fill={label.color} className="liquidity-chart__price">{priceText(label.price)}</text>
        </>}
      </g>)}
      {compact ? <text x={left} y={height - 6} className="liquidity-chart__caption">
        {offChartCount ? `${offChartCount} ${offChartCount === 1 ? 'level' : 'levels'} outside chart range` : live ? 'Hollow candle = forming' : 'Closed candles'}
      </text> : <>
        <text x={left} y={height - 18} className="liquidity-chart__caption">{utcLabel(first.openTime)}</text>
        {right - left >= 275 && <text x={right} y={height - 18} textAnchor="end" className="liquidity-chart__caption">{utcLabel(final.openTime)}</text>}
        {offChartCount > 0 && <text x={left} y={height - 4} className="liquidity-chart__caption">{offChartCount} distant {offChartCount === 1 ? 'level' : 'levels'} outside chart range</text>}
      </>}
    </svg>
  </div>
}

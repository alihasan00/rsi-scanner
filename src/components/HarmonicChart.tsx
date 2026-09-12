import { useId } from 'react'
import type { RsiBar } from '../types'
import type { HarmonicSetup } from '../lib/harmonics'
import { HARMONIC_COLORS, HARMONIC_NAMES } from '../lib/harmonicRows'
import { formatQuotePrice } from '../lib/priceFormatting'
import { useElementSize } from '../hooks/useElementSize'
import './Harmonic.css'

export function HarmonicChart({ bars: source, setup, price, compact = false }: {
  bars: readonly RsiBar[]; setup: HarmonicSetup; price: number; compact?: boolean
}) {
  const { ref, width: measuredWidth } = useElementSize<HTMLDivElement>()
  const clipId = useId().replace(/:/g, '')
  const bars = source.filter((bar) => bar.openTime >= setup.x.time && Number.isFinite(bar.high) && Number.isFinite(bar.low))
  const width = Math.max(240, measuredWidth || (compact ? 340 : 900))
  const height = compact ? 186 : 390
  const left = compact ? 14 : 22
  const right = width - (compact ? 16 : 96)
  const top = 30
  const bottom = height - 30
  const last = bars.at(-1)
  const duration = last ? last.closeTime - last.openTime + 1 : 60_000
  const lastTime = Math.max(setup.c.time, last?.openTime ?? setup.c.time)
  // A projected D has no forecast date; the extra space separates it from actual candles.
  const projectedTime = lastTime + duration * Math.max(6, bars.length * 0.12)
  const d = setup.d ?? { time: projectedTime, price: (setup.zone.low + setup.zone.high) / 2 }
  const endTime = Math.max(projectedTime, d.time) + duration * 2
  const prices = [setup.x.price, setup.a.price, setup.b.price, setup.c.price, setup.zone.low, setup.zone.high,
    ...bars.flatMap((bar) => [bar.low, bar.high]), ...(price > 0 ? [price] : []),
    ...(!compact ? [setup.cInvalidation, setup.stopReference] : [])]
  const low = Math.min(...prices)
  const high = Math.max(...prices)
  const padding = Math.max((high - low) * 0.12, high * 0.001)
  const min = Math.max(0, low - padding)
  const max = high + padding
  const x = (time: number) => left + (time - setup.x.time) / (endTime - setup.x.time) * (right - left)
  const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top)
  const color = HARMONIC_COLORS[setup.kind]
  const candleWidth = Math.max(1, Math.min(7, (right - left) * duration / (endTime - setup.x.time) * 0.6))
  const points = [setup.x, setup.a, setup.b, setup.c, d]
  const pointString = (indexes: number[]) => indexes.map((index) => `${x(points[index].time)},${y(points[index].price)}`).join(' ')
  const caption = `${HARMONIC_NAMES[setup.kind]}, ${setup.direction}. X A B C confirmed swings. D ${setup.d ? 'zone touched on a closed candle' : 'zone is projected, with no predicted arrival time'}. Linear price scale. Hollow candles are provisional.`
  const utc = (time: number) => new Date(time).toLocaleString('en-GB', { timeZone: 'UTC', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

  return <div ref={ref} className={`harmonic-chart${compact ? ' harmonic-chart--compact' : ''}`}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={caption}>
      <defs><clipPath id={clipId}><rect x={left - 3} y={top - 12} width={right - left + 6} height={bottom - top + 24} /></clipPath></defs>
      {[0, 1, 2, 3].map((index) => {
        const value = min + (max - min) * index / 3
        return <g key={index}><line x1={left} x2={right} y1={y(value)} y2={y(value)} className="harmonic-chart__grid" />{!compact && <text x={right + 10} y={y(value) + 3} className="harmonic-chart__muted">{formatQuotePrice(value)}</text>}</g>
      })}
      <g clipPath={`url(#${clipId})`}>
        <rect x={x(setup.c.time)} y={y(setup.zone.high)} width={right - x(setup.c.time)} height={Math.max(1, y(setup.zone.low) - y(setup.zone.high))} fill={color} fillOpacity={0.09} stroke={color} strokeOpacity={0.4} strokeDasharray="4 4" />
        <polygon points={pointString([0, 1, 2])} fill={color} fillOpacity={0.1} />
        <polygon points={pointString([2, 3, 4])} fill={color} fillOpacity={0.1} />
        {bars.map((bar) => {
          const px = x(bar.openTime)
          const tone = bar.close >= bar.open ? '#609a87' : '#bd747e'
          return <g key={bar.openTime} opacity={0.85}>
            <line x1={px} x2={px} y1={y(bar.high)} y2={y(bar.low)} stroke={tone} />
            <rect x={px - candleWidth / 2} y={Math.min(y(bar.open), y(bar.close))} width={candleWidth} height={Math.max(1, Math.abs(y(bar.open) - y(bar.close)))} fill={bar.isClosed ? tone : 'var(--color-surface)'} stroke={tone} />
          </g>
        })}
        {!compact && <>
          <line x1={x(setup.c.time)} x2={right} y1={y(setup.cInvalidation)} y2={y(setup.cInvalidation)} stroke="#c77d85" strokeDasharray="2 5" />
          <line x1={x(setup.c.time)} x2={right} y1={y(setup.stopReference)} y2={y(setup.stopReference)} stroke="#888" strokeDasharray="2 5" />
        </>}
        {price > 0 && <line x1={left} x2={right} y1={y(price)} y2={y(price)} stroke="#999" strokeDasharray="2 5" strokeOpacity={0.5} />}
        <polyline points={pointString([0, 1, 2, 3])} fill="none" stroke={color} strokeWidth={compact ? 1.6 : 2} />
        <polyline points={pointString([3, 4])} fill="none" stroke={color} strokeWidth={compact ? 1.6 : 2} strokeDasharray={setup.d ? undefined : '5 4'} />
      </g>
      {points.map((point, index) => {
        const above = setup.direction === 'bullish' ? index === 1 || index === 3 : index !== 1 && index !== 3
        return <g key={index}>
          <circle cx={x(point.time)} cy={y(point.price)} r={compact ? 2.5 : 3.5} fill="var(--color-surface)" stroke={color} strokeWidth={1.5} />
          <text x={x(point.time)} y={y(point.price) + (above ? -9 : 16)} textAnchor={index === 0 ? 'start' : 'middle'} fill={color} className="harmonic-chart__point">{'XABCD'[index]}{index === 4 && !setup.d ? '?' : ''}</text>
        </g>
      })}
      <text x={left} y={14} className="harmonic-chart__muted">{compact ? 'Linear · XABCD' : 'Raw candles · Linear price · UTC'}</text>
      <text x={right} y={14} textAnchor="end" fill={color} className="harmonic-chart__muted">{setup.d ? 'D zone touched' : 'D = possible reversal zone'}</text>
      <text x={left} y={height - 7} className="harmonic-chart__muted">{compact ? setup.d ? 'D = first closed touch' : 'Dashed leg = projected' : `X: ${utc(setup.x.time)}`}</text>
      {!compact && <text x={right} y={height - 7} textAnchor="end" className="harmonic-chart__muted">Latest candle: {utc(lastTime)} · Hollow = forming</text>}
    </svg>
  </div>
}

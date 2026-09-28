import { memo, useEffect, useId, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Timeframe } from '../types'
import { TIMEFRAME_MILLISECONDS } from '../lib/binanceHistory'
import { formatQuotePrice } from '../lib/priceFormatting'
import type { WatchlistRow } from '../lib/watchlist'
import { chartCandleAt, chartZoneAvailableAt, layoutChartCallouts, selectWatchlistChartCandles } from '../lib/watchlistChartGeometry'
import './WatchlistSetupChart.css'

const positive = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
const utcStamp = (time: number) => new Date(time).toLocaleString('en-GB', {
  timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}) + ' UTC'
const utcDate = (time: number) => new Date(time).toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short' })
const utcTime = (time: number) => new Date(time).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false })

interface ChartLevel { id: string; label: string; price: number; tone: string }

function priceTicks(low: number, high: number): number[] {
  const magnitude = 10 ** Math.floor(Math.log10((high - low) / 5))
  const scaled = (high - low) / 5 / magnitude
  const step = magnitude * (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10)
  if (!positive(step)) return []
  const result: number[] = []
  for (let value = Math.ceil(low / step) * step; value <= high && result.length < 8; value += step) result.push(value)
  return result
}

/** Drawing only. Every candle, pivot and event belongs to the captured Go evaluation. */
export const WatchlistSetupChart = memo(function WatchlistSetupChart({ row, compact = false }: { row: WatchlistRow; compact?: boolean }) {
  const snapshot = row.reference?.chart
  const identity = `${row.id}:${snapshot?.snapshotId ?? 'unavailable'}`
  const [selection, setSelection] = useState<{ identity: string; timeframe: Timeframe; view: 'setup' | 'recent' } | null>(null)
  const [hover, setHover] = useState<{ key: string; index: number } | null>(null)
  const [keyboardAnnouncement, setKeyboardAnnouncement] = useState<{ key: string; message: string } | null>(null)
  const [width, setWidth] = useState(compact ? 380 : 960)
  const container = useRef<HTMLDivElement>(null)
  const clipId = `watch-plot-${useId().replaceAll(':', '')}`
  const titleId = `watch-title-${useId().replaceAll(':', '')}`
  const selected = selection?.identity === identity ? selection : null
  const timeframe = compact ? snapshot?.defaultTimeframe ?? row.timeframe : selected?.timeframe ?? snapshot?.defaultTimeframe ?? row.timeframe
  const view = compact ? 'setup' : selected?.view ?? 'setup'
  const chartKey = `${identity}:${timeframe}:${view}`

  useEffect(() => {
    const node = container.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width
      if (measured && measured > 0) setWidth(Math.max(260, Math.round(measured)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const candles = snapshot ? selectWatchlistChartCandles(snapshot, timeframe, view) : []
  if (!snapshot || !candles.length) return <div ref={container} className={`watch-setup-chart is-empty${compact ? ' is-compact' : ''}`}>
    <span className="watch-setup-chart__empty-mark" aria-hidden="true">⌁</span><p>{compact ? 'Captured chart unavailable' : 'The evaluated snapshot has no available candles for this chart.'}</p>
  </div>

  const mobile = width < 640
  const height = compact ? 180 : mobile ? 300 : 430
  const plot = { left: compact ? 8 : 14, right: width - (compact ? 9 : mobile ? 124 : 161), top: compact ? 12 : 25, bottom: height - (compact ? 10 : 42) }
  const first = candles[0].candle
  const last = candles.at(-1)!.candle
  const duration = first.closeTime - first.openTime + 1
  const start = first.openTime - duration * 0.7
  const end = last.closeTime + duration * 1.7
  const x = (time: number) => plot.left + (time - start) / (end - start) * (plot.right - plot.left)
  const candleX = (time: number) => {
    const observed = chartCandleAt(time, candles)?.candle
    return observed ? x((observed.openTime + observed.closeTime) / 2) : null
  }
  const pointInputs = snapshot.points.filter((point) => point.timeframe === timeframe)
  const points = pointInputs.map((point) => ({ ...point, x: candleX(point.time) }))
    .filter((point): point is typeof point & { x: number } => point.x !== null && positive(point.price))
  const eventInputs = snapshot.events.filter((event) => event.timeframe === timeframe)
  const events = eventInputs.map((event) => ({ ...event, x: candleX(event.time) }))
    .filter((event): event is typeof event & { x: number } => event.x !== null)
  const levels: ChartLevel[] = []
  if (positive(row.target)) levels.push({ id: 'target', label: 'First target', price: row.target, tone: 'target' })
  if (positive(row.stop)) levels.push({ id: 'stop', label: 'Stop reference', price: row.stop, tone: 'stop' })
  if (positive(row.reference?.entry)) levels.push({ id: 'reference', label: row.source === 'trend' ? 'Pullback level' : 'Entry reference', price: row.reference.entry, tone: 'reference' })
  const sameQuoteAndEntry = positive(row.reference?.planEntry) && row.reference.planEntry === row.price
  if (positive(row.reference?.planEntry) && !sameQuoteAndEntry) levels.push({ id: 'plan-entry', label: 'Plan entry', price: row.reference.planEntry, tone: 'plan' })
  if (positive(row.price)) levels.push({ id: 'quote', label: sameQuoteAndEntry ? 'Evaluated price' : 'Evaluated quote', price: row.price, tone: 'quote' })
  const prices = [...candles.flatMap(({ candle }) => [candle.low, candle.high]), ...points.map((point) => point.price),
    ...[row.zone.low, row.zone.high, row.price].filter(positive),
    ...(compact ? [] : [...levels.map((level) => level.price), ...events.flatMap((event) => [event.price, event.low, event.high].filter(positive))])]
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  const padding = Math.max((max - min) * (compact ? 0.1 : 0.15), max * 0.002)
  const low = Math.max(min - padding, Math.min(min * 0.5, min))
  const high = max + padding
  const y = (price: number) => plot.bottom - (price - low) / (high - low) * (plot.bottom - plot.top)
  const ticks = priceTicks(low, high)
  const candleWidth = clamp(duration / (end - start) * (plot.right - plot.left) * 0.65, compact ? 0.8 : 1, compact ? 5 : 10)
  const zoneValid = positive(row.zone.low) && positive(row.zone.high) && row.zone.low <= row.zone.high
  const zoneTime = chartZoneAvailableAt(snapshot)
  const zoneStart = zoneTime === null ? null : clamp(x(zoneTime + 1), plot.left, plot.right)
  const zoneTop = zoneValid ? y(row.zone.high) : 0
  const zoneBottom = zoneValid ? y(row.zone.low) : 0
  const callouts = layoutChartCallouts(levels.map((level) => ({ ...level, y: y(level.price) })), plot.top + 15, plot.bottom - 17, mobile ? 35 : 38)
  const pointByLabel = new Map(points.map((point) => [point.label.toUpperCase(), point]))
  const triangles = [['X', 'A', 'B'], ['B', 'C', 'D']].map((labels) => labels.map((label) => pointByLabel.get(label)))
    .filter((triangle) => triangle.every((point) => point !== undefined))
  let path = ''
  let connected = false
  for (const point of pointInputs) {
    const mapped = points.find((candidate) => candidate.label === point.label && candidate.time === point.time)
    if (!mapped) { connected = false; continue }
    path += `${connected ? 'L' : 'M'}${mapped.x},${y(mapped.price)} `
    connected = true
  }
  const hoverIndex = hover?.key === chartKey ? clamp(hover.index, 0, candles.length - 1) : null
  const inspected = candles[hoverIndex ?? candles.length - 1]
  const inspectionX = x((inspected.candle.openTime + inspected.candle.closeTime) / 2)
  const base = row.symbol.replace(/USDT$/, '')
  const summary = `${base} ${row.name}, ${timeframe} ${view === 'setup' ? 'Setup' : 'Recent'} view. ${candles.length} captured candles from ${utcStamp(first.openTime)} to ${utcStamp(last.closeTime)}.${candles.at(-1)?.preview ? ' The outlined final candle is open and provisional.' : ''} ${points.length ? `Observed anchors ${points.map((point) => point.label).join(', ')}. ` : ''}Evaluated quote ${positive(row.price) ? formatQuotePrice(row.price) : 'unavailable'}. Stop ${positive(row.stop) ? formatQuotePrice(row.stop) : 'unavailable'}, first target ${positive(row.target) ? formatQuotePrice(row.target) : 'unavailable'}.`
  const switchView = (nextTimeframe: Timeframe, nextView: 'setup' | 'recent') => setSelection({ identity, timeframe: nextTimeframe, view: nextView })
  const inspectPointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const pointerX = (event.clientX - bounds.left) / bounds.width * width
    if (pointerX < plot.left || pointerX > plot.right) { setHover(null); return }
    let closest = 0
    let distance = Infinity
    candles.forEach(({ candle }, index) => {
      const offset = Math.abs(x((candle.openTime + candle.closeTime) / 2) - pointerX)
      if (offset < distance) { closest = index; distance = offset }
    })
    setHover({ key: chartKey, index: closest })
  }
  const dateIndices = [...new Set(Array.from({ length: mobile ? 3 : 5 }, (_, index) => Math.round(index * (candles.length - 1) / (mobile ? 2 : 4))))]
  const sourceWindow = snapshot.sourceWindow?.timeframe === timeframe ? snapshot.sourceWindow : null
  const noD = row.source === 'harmonic' && timeframe === snapshot.defaultTimeframe && !snapshot.points.some((point) => point.label.toUpperCase() === 'D')

  return <div ref={container} className={`watch-setup-chart${compact ? ' is-compact' : ''}`}>
    {!compact && <>
      <div className="watch-setup-chart__toolbar">
        <div className="watch-setup-chart__intervals" role="group" aria-label="View this captured setup across timeframes">{[...snapshot.frames].sort((a, b) => TIMEFRAME_MILLISECONDS[a.timeframe] - TIMEFRAME_MILLISECONDS[b.timeframe]).map((frame) => {
          const isTrigger = frame.timeframe === '15m' && snapshot.defaultTimeframe !== '15m'
            && snapshot.events.some((event) => event.timeframe === '15m' && ['confirmation', 'trigger', 'retest'].includes(event.kind))
          return <button key={frame.timeframe} type="button" aria-pressed={timeframe === frame.timeframe} onClick={() => switchView(frame.timeframe, 'setup')}>{frame.timeframe}{frame.timeframe === snapshot.defaultTimeframe ? <span>setup</span> : isTrigger ? <span>trigger</span> : null}</button>
        })}</div>
        <div className="watch-setup-chart__range" role="group" aria-label="Chart range"><button type="button" aria-pressed={view === 'setup'} onClick={() => switchView(timeframe, 'setup')}>Setup</button><button type="button" aria-pressed={view === 'recent'} onClick={() => switchView(timeframe, 'recent')}>Recent</button></div>
      </div>
      <div className="watch-setup-chart__readout" aria-live="off"><time dateTime={new Date(inspected.candle.openTime).toISOString()}>{utcDate(inspected.candle.openTime)} · {utcTime(inspected.candle.openTime)} UTC</time><span className={inspected.preview ? 'is-preview' : ''}>{inspected.preview ? 'Open candle' : 'Closed candle'}</span><div>{(['open', 'high', 'low', 'close'] as const).map((field) => <span key={field}><b>{field[0].toUpperCase()}</b>{formatQuotePrice(inspected.candle[field])}</span>)}</div></div>
      <div className="watch-setup-chart__sr-only" role="status" aria-live="polite" aria-atomic="true">{keyboardAnnouncement?.key === chartKey ? keyboardAnnouncement.message : ''}</div>
    </>}
    <svg className="watch-setup-chart__canvas" width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId}
      tabIndex={compact ? undefined : 0} aria-description={compact ? undefined : 'Use left and right arrows to inspect candles.'} onPointerMove={compact ? undefined : inspectPointer} onPointerLeave={compact ? undefined : () => setHover(null)}
      onKeyDown={compact ? undefined : (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const index = clamp((hoverIndex ?? candles.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1), 0, candles.length - 1)
        const inspected = candles[index]
        setHover({ key: chartKey, index })
        setKeyboardAnnouncement({ key: chartKey, message: `${timeframe} ${inspected.preview ? 'open' : 'closed'} candle, ${utcStamp(inspected.candle.openTime)}. ${(['open', 'high', 'low', 'close'] as const).map((field) => `${field} ${formatQuotePrice(inspected.candle[field])}`).join(', ')}.` })
      }}>
      <title id={titleId}>{summary}</title>
      <defs><clipPath id={clipId}><rect x={plot.left} y={plot.top - 5} width={plot.right - plot.left} height={plot.bottom - plot.top + 10} /></clipPath></defs>
      {ticks.map((price) => <g key={price} className="watch-setup-chart__grid"><line x1={plot.left} x2={plot.right} y1={y(price)} y2={y(price)} />{!compact && <text x={plot.left + 3} y={y(price) - 5}>{formatQuotePrice(price)}</text>}</g>)}
      <g clipPath={`url(#${clipId})`}>
        {!compact && sourceWindow && <rect className="watch-setup-chart__source-window" x={clamp(x(sourceWindow.startTime), plot.left, plot.right)} y={plot.top} width={Math.max(0, clamp(x(sourceWindow.endTime), plot.left, plot.right) - clamp(x(sourceWindow.startTime), plot.left, plot.right))} height={plot.bottom - plot.top} />}
        {zoneValid && <g className="watch-setup-chart__zone">
          {zoneStart !== null && zoneStart < plot.right && <rect x={zoneStart} y={zoneTop} width={plot.right - zoneStart} height={Math.max(2, zoneBottom - zoneTop)} />}
          <line x1={zoneStart ?? plot.left} x2={plot.right} y1={zoneTop} y2={zoneTop} /><line x1={zoneStart ?? plot.left} x2={plot.right} y1={zoneBottom} y2={zoneBottom} />
          {!compact && zoneStart !== null && plot.right - zoneStart > 88 && <text x={zoneStart + 7} y={clamp(zoneTop - 7, plot.top + 10, plot.bottom - 7)}>{row.source === 'trend' ? 'Pullback level' : 'Entry zone'}</text>}
        </g>}
        {levels.filter((level) => !compact || level.price >= low && level.price <= high).map((level) => <line key={level.id} className={`watch-setup-chart__level is-${level.tone}`} x1={plot.left} x2={plot.right} y1={y(level.price)} y2={y(level.price)} />)}
        {candles.map(({ candle, preview }) => {
          const center = x((candle.openTime + candle.closeTime) / 2)
          const top = y(Math.max(candle.open, candle.close))
          return <g key={candle.openTime} className={`watch-setup-chart__candle ${candle.close >= candle.open ? 'is-up' : 'is-down'}${preview ? ' is-preview' : ''}`}>
            <line x1={center} x2={center} y1={y(candle.high)} y2={y(candle.low)} />
            <rect x={center - candleWidth / 2} y={top} width={candleWidth} height={Math.max(1, Math.abs(y(candle.open) - y(candle.close)))} />
          </g>
        })}
        {triangles.map((triangle, index) => <polygon key={index} className="watch-setup-chart__pattern-fill" points={triangle.map((point) => `${point!.x},${y(point!.price)}`).join(' ')} />)}
        {path && <path className="watch-setup-chart__pattern" d={path} />}
        {points.map((point, index) => {
          const before = points[index - 1]
          const after = points[index + 1]
          const above = (!before || point.price >= before.price) && (!after || point.price >= after.price)
          return <g key={`${point.label}:${point.time}`} className="watch-setup-chart__point"><circle cx={point.x} cy={y(point.price)} r={compact ? 2 : 3.5} />{!compact && <text x={clamp(point.x, plot.left + 9, plot.right - 9)} y={clamp(y(point.price) + (above ? -12 : 20), plot.top + 8, plot.bottom - 2)}>{point.label}</text>}<title>{point.label}: {formatQuotePrice(point.price)} · {utcStamp(point.time)}</title></g>
        })}
        {!compact && events.map((event, index) => <g key={`${event.kind}:${event.time}:${event.label}`} className={`watch-setup-chart__event is-${event.kind}`} data-event-label={`${event.timeframe} ${event.label}`}>
          <line x1={event.x} x2={event.x} y1={positive(event.price) ? y(event.price) : plot.top + 10} y2={plot.bottom - 5} />
          {positive(event.price) && <circle cx={event.x} cy={y(event.price)} r={3.5} />}
          <rect x={event.x - 7} y={plot.bottom - 15 - index % 2 * 16} width={14} height={14} rx={4} /><text x={event.x} y={plot.bottom - 5 - index % 2 * 16}>{index + 1}</text>
          <title>{event.label} · {event.timeframe} · {utcStamp(event.time)}{positive(event.price) ? ` · ${formatQuotePrice(event.price)}` : ''}</title>
        </g>)}
        {!compact && hoverIndex !== null && <g className="watch-setup-chart__crosshair"><line x1={inspectionX} x2={inspectionX} y1={plot.top} y2={plot.bottom} /><line x1={plot.left} x2={plot.right} y1={y(inspected.candle.close)} y2={y(inspected.candle.close)} /><circle cx={inspectionX} cy={y(inspected.candle.close)} r={4} /></g>}
      </g>
      {!compact && <>
        {callouts.map((level) => <g key={level.id} className={`watch-setup-chart__callout is-${level.tone}`}><path d={`M${plot.right},${level.y} H${plot.right + 5} L${plot.right + 13},${level.labelY}`} /><rect x={plot.right + 13} y={level.labelY - 15} width={width - plot.right - 17} height={30} rx={5} /><text className="watch-setup-chart__callout-label" x={plot.right + 21} y={level.labelY - 3}>{level.label}</text><text className="watch-setup-chart__callout-price" x={plot.right + 21} y={level.labelY + 10}>{formatQuotePrice(level.price)}</text><title>{level.label}: {formatQuotePrice(level.price)}</title></g>)}
        <line className="watch-setup-chart__axis" x1={plot.left} x2={plot.right} y1={plot.bottom + 4} y2={plot.bottom + 4} />
        {dateIndices.map((index, tickIndex) => {
          const candle = candles[index].candle
          return <g key={index} className="watch-setup-chart__date"><text x={x((candle.openTime + candle.closeTime) / 2)} y={plot.bottom + 21} textAnchor={tickIndex === 0 ? 'start' : tickIndex === dateIndices.length - 1 ? 'end' : 'middle'}>{duration >= 86_400_000 ? utcDate(candle.openTime) : utcTime(candle.openTime)}</text><text className="watch-setup-chart__date-day" x={x((candle.openTime + candle.closeTime) / 2)} y={plot.bottom + 33} textAnchor={tickIndex === 0 ? 'start' : tickIndex === dateIndices.length - 1 ? 'end' : 'middle'}>{duration >= 86_400_000 ? new Date(candle.openTime).getUTCFullYear() : utcDate(candle.openTime)}</text></g>
        })}
      </>}
    </svg>
    {!compact && <div className="watch-setup-chart__footer">
      {events.length > 0 && <div className="watch-setup-chart__events">{events.map((event, index) => <span key={`${event.kind}:${event.time}:${event.label}`} title={utcStamp(event.time)}><i>{index + 1}</i>{event.label}<small>{event.timeframe}</small></span>)}</div>}
      <div className="watch-setup-chart__caption"><span>{candles.length} {timeframe} candles · UTC{candles.at(-1)?.preview ? ' · outlined candle is open' : ''}</span><time dateTime={new Date(snapshot.evaluatedAt).toISOString()}>Evaluated {utcStamp(snapshot.evaluatedAt)}</time></div>
      {noD && <p className="watch-setup-chart__note">D has no recorded candle yet; the entry zone is shown without a dated D point.</p>}
      {pointInputs.length > points.length && <p className="watch-setup-chart__note">Some recorded anchors are outside this candle view.{view === 'recent' ? ' Select Setup to see the full captured pattern.' : ''}</p>}
      {eventInputs.length > events.length && <p className="watch-setup-chart__note">Some recorded events have no available candle in this view.{view === 'recent' ? ' Select Setup to inspect the full captured history.' : ''}</p>}
    </div>}
  </div>
})

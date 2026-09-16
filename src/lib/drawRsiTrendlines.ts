import { trendlineRsiAtTime, type RsiTrendline } from './rsiTrendlines'

export interface TrendlineChartRegion {
  left: number
  right: number
  top: number
  bottom: number
}

interface TrendlineProjection {
  region: TrendlineChartRegion
  /** Open timestamps of the displayed candles, in ascending order. */
  visibleTimes: readonly number[]
  toX: (time: number) => number
  toY: (rsi: number) => number
}

export const RSI_TRENDLINE_COLORS = { resistance: '#F59E0B', support: '#38BDF8' } as const

type Point = readonly [number, number]

/** Clip actual geometry; an off-screen anchor must never become an edge dot. */
function clipSegment(start: Point, end: Point, region: TrendlineChartRegion): [Point, Point] | null {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const p = [-dx, dx, -dy, dy]
  const q = [start[0] - region.left, region.right - start[0], start[1] - region.top, region.bottom - start[1]]
  let from = 0
  let to = 1
  for (let index = 0; index < p.length; index++) {
    if (p[index] === 0) {
      if (q[index] < 0) return null
      continue
    }
    const ratio = q[index] / p[index]
    if (p[index] < 0) from = Math.max(from, ratio)
    else to = Math.min(to, ratio)
    if (from > to) return null
  }
  return [[start[0] + from * dx, start[1] + from * dy], [start[0] + to * dx, start[1] + to * dy]]
}

/**
 * Project rays from their original RSI anchors, even when both are off-screen.
 * Sampling visible timestamps also preserves an index-based detail chart's
 * candle alignment when its history contains gaps.
 */
export function drawRsiTrendlines(
  ctx: CanvasRenderingContext2D,
  lines: readonly RsiTrendline[],
  { region, visibleTimes, toX, toY }: TrendlineProjection,
): number {
  if (visibleTimes.length === 0) return 0
  const visibleStart = visibleTimes[0]
  const visibleEnd = visibleTimes[visibleTimes.length - 1]
  let drawn = 0
  ctx.save()
  ctx.beginPath()
  ctx.rect(region.left, region.top, region.right - region.left, region.bottom - region.top)
  ctx.clip()
  ctx.lineWidth = 1.8
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (const line of lines) {
    if (!['formed', 'approaching', 'broken'].includes(line.state)) continue
    if (line.end.time <= line.start.time) continue
    const rayEnd = Math.min(visibleEnd, line.state === 'broken' ? line.breakTime ?? visibleEnd : visibleEnd)
    if (rayEnd < visibleStart || line.start.time > visibleEnd) continue
    const color = RSI_TRENDLINE_COLORS[line.kind]
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.globalAlpha = line.state === 'broken' ? 0.78 : 1
    let hasGeometry = false

    for (const [from, to, dashed] of [
      [Math.max(visibleStart, line.start.time), Math.min(rayEnd, line.end.time), false],
      [Math.max(visibleStart, line.end.time), rayEnd, true],
    ] as const) {
      if (to <= from) continue
      const times = [from, ...visibleTimes.filter((time) => time > from && time < to), to]
      ctx.setLineDash(dashed ? [5, 3] : [])
      ctx.beginPath()
      let hasSegment = false
      for (let index = 1; index < times.length; index++) {
        const start: Point = [toX(times[index - 1]), toY(trendlineRsiAtTime(line, times[index - 1]))]
        const end: Point = [toX(times[index]), toY(trendlineRsiAtTime(line, times[index]))]
        if (![...start, ...end].every(Number.isFinite)) continue
        const segment = clipSegment(start, end, region)
        if (!segment) continue
        ctx.moveTo(...segment[0])
        ctx.lineTo(...segment[1])
        hasSegment = true
      }
      if (hasSegment) {
        ctx.stroke()
        hasGeometry = true
      }
    }
    ctx.setLineDash([])
    for (const anchor of [line.start, line.end]) {
      if (anchor.time < visibleStart || anchor.time > rayEnd || anchor.rsi < 0 || anchor.rsi > 100) continue
      ctx.beginPath()
      ctx.arc(toX(anchor.time), toY(anchor.rsi), 2.4, 0, Math.PI * 2)
      ctx.fill()
      hasGeometry = true
    }
    if (line.state === 'broken' && line.breakTime !== null && line.breakRsi !== null
      && line.breakTime >= visibleStart && line.breakTime <= visibleEnd
      && line.breakRsi >= 0 && line.breakRsi <= 100) {
      // The marker is the observed RSI at the break candle, not the ray value.
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.arc(toX(line.breakTime), toY(line.breakRsi), 4, 0, Math.PI * 2)
      ctx.fillStyle = '#1A1A1A'
      ctx.fill()
      ctx.stroke()
      hasGeometry = true
    }
    if (hasGeometry) {
      drawn++
    }
  }
  ctx.restore()
  return drawn
}

import type { Candle } from '../types'
import { formatQuotePrice } from './priceFormatting'

/** The Go lecture contract. Values are captured observations, never browser calculations. */
export interface IchimokuLine {
  readonly status: string; readonly warmupBars: number; readonly value: number | null
  readonly distanceATRStatus: string; readonly distanceATR: number | null
  readonly slopeStatus: string; readonly slope: string; readonly change1Bar: number | null
  readonly flatBars: number | null; readonly flatHistoryBounded: boolean
}
export interface IchimokuPoint {
  /** Inclusive close at which these lines/cloud are displayed. */
  readonly time: number; readonly tenkan: number | null; readonly kijun: number | null
  readonly spanA: number | null; readonly spanB: number | null; readonly calculatedAt: number | null
}
export interface IchimokuCloudPoint {
  readonly calculatedAt: number; readonly displayedAt: number; readonly spanA: number; readonly spanB: number
}
export interface IchimokuCross {
  readonly time: number; readonly direction: string; readonly valid: boolean; readonly entryEligible: boolean
  readonly kind: string; readonly strength: string; readonly reason: string
  readonly cloudPosition: string; readonly cloudColor: string; readonly movingChange1Bar: number
  readonly kijunChange1Bar: number; readonly ageBars: number
}
export interface IchimokuTwist {
  readonly calculatedAt: number; readonly displayedAt: number; readonly direction: string
  readonly scope: string; readonly ageBars: number
}
export interface IchimokuLectureSnapshot {
  readonly status: string; readonly asOf: number | null; readonly bars: number
  readonly tenkan: IchimokuLine; readonly kijun: IchimokuLine
  readonly cloud: {
    readonly status: string; readonly warmupBars: number; readonly spanA: number | null; readonly spanB: number | null
    readonly lower: number | null; readonly upper: number | null; readonly position: string
    readonly calculatedAt: number | null; readonly displayedAt: number | null
    readonly color: string; readonly width: number | null; readonly widthATRStatus: string
    readonly widthATR: number | null; readonly widthChange1Bar: number | null; readonly widthTrend: string
    readonly upperFlatBars: number | null; readonly lowerFlatBars: number | null
    readonly upperFlatHistoryBounded: boolean; readonly lowerFlatHistoryBounded: boolean
    readonly supportResistance: string; readonly trendContext: string
  }
  readonly tkCross: IchimokuCross | null; readonly pkCross: IchimokuCross | null
  readonly currentTwist: IchimokuTwist | null; readonly projectedTwist: IchimokuTwist | null
  readonly twistsObserved: number; readonly alternatingTwists: boolean
  readonly edgeToEdge: {
    readonly status: string; readonly direction: string; readonly enteredAt: number | null; readonly ageBars: number | null
    readonly entryEdge: number | null; readonly oppositeEdge: number | null; readonly oppositeFlatBars: number | null
    readonly oppositeFlat: boolean; readonly width: number | null; readonly widthATRStatus: string; readonly widthATR: number | null
    readonly retestStatus: string; readonly retestedAt: number | null; readonly reason: string
  }
  readonly fibonacci: {
    readonly status: string; readonly lower: number | null; readonly upper: number | null
    readonly levels: readonly { readonly ratio: number; readonly price: number }[] | null; readonly reason: string
  }
  readonly extension: {
    readonly status: string; readonly priceKijunDistance: number | null; readonly priceKijunDistanceATR: number | null
    readonly priceKijunATRStatus: string; readonly tenkanKijunGap: number | null; readonly tenkanKijunGapATR: number | null
    readonly gapATRStatus: string; readonly gapChange1Bar: number | null; readonly cloudWidthChange1Bar: number | null
    readonly thinningWithWideningGap: boolean; readonly direction: string; readonly reason: string
  }
  readonly projection: readonly IchimokuCloudPoint[] | null; readonly conventions: readonly string[] | null
}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
const words = (value: string) => value.replaceAll('_', ' ')
const stamp = (value: number | null) => value === null ? 'unavailable' : new Date(value).toISOString()
const fixed = (value: number | null, status?: string) => value === null ? words(status ?? 'unavailable') : `${value.toFixed(2)} ATR`

function frozenCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((child) => frozenCopy(child))) as T
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, frozenCopy(child)]))) as T
  return value
}

/** Called only after provider receipt and candle-close matching. No indicator is recomputed. */
export function captureIchimoku(
  reading: IchimokuLectureSnapshot | null | undefined, series: readonly IchimokuPoint[] | null | undefined,
  candles: readonly Candle[], evaluatedAt: number,
): { readonly ichimoku?: IchimokuLectureSnapshot; readonly ichimokuSeries?: readonly IchimokuPoint[] } {
  const last = candles.at(-1)
  if (!reading || !last || reading.asOf !== last.closeTime || reading.bars !== candles.length || last.closeTime > evaluatedAt) return {}
  const closes = new Set(candles.map((candle) => candle.closeTime))
  const duration = last.closeTime - last.openTime + 1
  if (series && (series.length !== candles.length || series.some((point, index) => point.time !== candles[index].closeTime
    || [point.tenkan, point.kijun, point.spanA, point.spanB].some((value) => value !== null && !positive(value))
    || point.calculatedAt !== null && (!closes.has(point.calculatedAt) || point.calculatedAt >= point.time)))) return {}
  if ((reading.projection ?? []).some((point) => !closes.has(point.calculatedAt) || point.calculatedAt > evaluatedAt
    || point.displayedAt <= last.closeTime || point.displayedAt !== point.calculatedAt + 30 * duration
    || !positive(point.spanA) || !positive(point.spanB))) return {}
  return { ichimoku: frozenCopy(reading), ...(series ? { ichimokuSeries: frozenCopy(series) } : {}) }
}

export interface IchimokuPlotPoint extends IchimokuCloudPoint { readonly projected: boolean }
export interface IchimokuPlot {
  readonly lines: readonly IchimokuPoint[]; readonly cloud: readonly IchimokuPlotPoint[]
  readonly firstProjectionAt: number | null; readonly lastDisplayedAt: number | null
}

export interface IchimokuCloudBand {
  readonly points: readonly { readonly time: number; readonly price: number }[]
  readonly color: 'green' | 'red'; readonly projected: boolean
}
/** Split only the drawing at a span intersection; never connect across missing bars. */
export function ichimokuCloudBands(points: readonly IchimokuPlotPoint[], duration: number): IchimokuCloudBand[] {
  return points.slice(1).flatMap((after, index) => {
    const before = points[index]
    if (after.displayedAt - before.displayedAt !== duration) return []
    const left = before.spanA - before.spanB
    const right = after.spanA - after.spanB
    const projected = before.projected || after.projected
    if (left * right < 0) {
      const fraction = left / (left - right)
      const middle = { time: before.displayedAt + duration * fraction, price: before.spanA + (after.spanA - before.spanA) * fraction }
      return [
        { points: [{ time: before.displayedAt, price: before.spanA }, middle, { time: before.displayedAt, price: before.spanB }], color: left > 0 ? 'green' as const : 'red' as const, projected },
        { points: [middle, { time: after.displayedAt, price: after.spanA }, { time: after.displayedAt, price: after.spanB }], color: right > 0 ? 'green' as const : 'red' as const, projected },
      ]
    }
    return [{ points: [{ time: before.displayedAt, price: before.spanA }, { time: after.displayedAt, price: after.spanA },
      { time: after.displayedAt, price: after.spanB }, { time: before.displayedAt, price: before.spanB }], color: left > 0 || right > 0 ? 'green' as const : 'red' as const, projected }]
  })
}

/** Select known Go coordinates, retaining explicit forward display without future candles. */
export function selectIchimokuPlot(
  frame: { readonly ichimoku?: IchimokuLectureSnapshot; readonly ichimokuSeries?: readonly IchimokuPoint[]; readonly lastClosedAt: number },
  start: number, end: number, includeProjection = true,
): IchimokuPlot {
  const lines = (frame.ichimokuSeries ?? []).filter((point) => point.time >= start && point.time <= end && point.time <= frame.lastClosedAt)
  const cloud: IchimokuPlotPoint[] = lines.flatMap((point) => positive(point.spanA) && positive(point.spanB) && point.calculatedAt !== null
    ? [{ calculatedAt: point.calculatedAt, displayedAt: point.time, spanA: point.spanA, spanB: point.spanB, projected: false }] : [])
  const projection = includeProjection && end >= frame.lastClosedAt ? (frame.ichimoku?.projection ?? []).filter((point) => point.calculatedAt <= frame.lastClosedAt
    && point.displayedAt > frame.lastClosedAt && point.displayedAt >= start).map((point) => ({ ...point, projected: true })) : []
  cloud.push(...projection)
  return { lines, cloud, firstProjectionAt: projection[0]?.displayedAt ?? null, lastDisplayedAt: cloud.at(-1)?.displayedAt ?? null }
}

export function isIchimokuMethod(name: string): boolean { return /(?:ichimoku|kijun|kumo|cloud|\btk[ _]cross\b|\bpk[ _]cross\b)/i.test(name) }

export interface IchimokuEvidence { readonly label: string; readonly detail: string; readonly caution?: boolean }
/** Shared wording for the selected-frame detail panel and portable review. */
export function ichimokuEvidence(reading: IchimokuLectureSnapshot, quote: (value: number) => string = formatQuotePrice): IchimokuEvidence[] {
  const price = (value: number | null) => value === null ? 'unavailable' : value === 0 ? '0' : quote(value)
  const cross = (value: IchimokuCross | null) => value ? `${words(value.kind)} · ${value.direction} · ${value.ageBars} bars ago (${stamp(value.time)}). ${value.valid ? words(value.strength) : 'Excluded geometry'}; ${value.entryEligible ? 'outside-cloud entry context' : 'not eligible as an entry'}. ${value.reason}` : 'No crossover recorded in the captured history.'
  const cloud = reading.cloud
  const edge = reading.edgeToEdge
  const result: IchimokuEvidence[] = [
    { label: 'Cloud', detail: `${words(cloud.position)} · ${words(cloud.color)} · ${price(cloud.lower)}–${price(cloud.upper)}. Width ${price(cloud.width)} (${fixed(cloud.widthATR, cloud.widthATRStatus)}), ${words(cloud.widthTrend)}. ${words(cloud.supportResistance)}; ${words(cloud.trendContext)}.` },
    { label: 'Tenkan / Kijun', detail: `${price(reading.tenkan.value)} / ${price(reading.kijun.value)}. Kijun ${words(reading.kijun.slope)}, flat ${reading.kijun.flatBars ?? 'unavailable'} transitions${reading.kijun.flatHistoryBounded ? ' or more' : ''}; signed price distance ${fixed(reading.kijun.distanceATR, reading.kijun.distanceATRStatus)}.` },
    { label: 'TK cross', detail: cross(reading.tkCross) }, { label: 'PK cross', detail: cross(reading.pkCross) },
    { label: 'Cloud edges', detail: `Upper flat ${cloud.upperFlatBars ?? 'unavailable'} transitions${cloud.upperFlatHistoryBounded ? ' or more' : ''}; lower flat ${cloud.lowerFlatBars ?? 'unavailable'}${cloud.lowerFlatHistoryBounded ? ' or more' : ''}.` },
    { label: 'Edge to edge', detail: `${words(edge.status)}${edge.enteredAt !== null ? ` · ${edge.direction} · ${edge.ageBars} bars since entry (${stamp(edge.enteredAt)})` : ''}. Entry edge ${price(edge.entryEdge)}; opposite reference ${price(edge.oppositeEdge)} (${edge.oppositeFlat ? 'flat' : 'not flat'}, ${edge.oppositeFlatBars ?? 'unavailable'} transitions). Retest ${words(edge.retestStatus)}${edge.retestedAt !== null ? ` at ${stamp(edge.retestedAt)}` : ''}. ${edge.reason}` },
  ]
  const current = reading.currentTwist
  result.push({ label: 'Cloud twist', detail: current ? `${current.direction} · displayed ${stamp(current.displayedAt)}, calculated ${stamp(current.calculatedAt)} · calculated ${current.ageBars} bars ago.` : 'No twist recorded in the current displayed cloud history.' })
  const projected = reading.projectedTwist
  if (projected) result.push({ label: 'Known forward twist', detail: `${projected.direction} · calculated ${stamp(projected.calculatedAt)}, displayed ${stamp(projected.displayedAt)}. Already known from closed candles; forward placement is not a price forecast.` })
  if (reading.alternatingTwists) result.push({ label: 'Alternating twists', detail: `${reading.twistsObserved} observed twists in the engine window; repeated color changes are indecisive context.`, caution: true })
  if (reading.fibonacci.levels?.length) result.push({ label: 'Cloud Fibonacci', detail: `${price(reading.fibonacci.lower)}–${price(reading.fibonacci.upper)}: ${reading.fibonacci.levels.map((level) => `${level.ratio} = ${price(level.price)}`).join('; ')}. ${reading.fibonacci.reason}` })
  result.push({ label: 'Retracement context', detail: `${reading.extension.thinningWithWideningGap ? 'Cloud thinning and Tenkan–Kijun gap widening together. ' : ''}Gap ${price(reading.extension.tenkanKijunGap)} (${fixed(reading.extension.tenkanKijunGapATR, reading.extension.gapATRStatus)}). ${reading.extension.reason}`, caution: reading.extension.thinningWithWideningGap })
  result.push({ label: 'Calculation timing', detail: `Evaluated close ${stamp(reading.asOf)}. Current cloud calculated ${stamp(cloud.calculatedAt)}, displayed ${stamp(cloud.displayedAt)}. 20 / 60 / 120 lookbacks; actual +30-bar display offset. Projection uses only already completed candles.` })
  return result
}

export const ICHIMOKU_EXCLUSIONS = 'Chikou is excluded by the lecture. Kijun-driven crosses of flat Tenkan are excluded from TK; crosses inside the cloud are ignored for entries. Tenkan is not used as a preferred support or resistance. These related readings are one indicator family.'

import type { RsiBar } from '../types'
import { findRsiTrendlines, isVisibleRsiTrendline } from './rsiTrendlines'
import type { RsiTrendline } from './rsiTrendlines'

export interface RsiTrendlineAnalysis {
  lines: readonly RsiTrendline[]
  displayed: readonly RsiTrendline[]
  noLongs: boolean
}

export const EMPTY_TRENDLINE_ANALYSIS: RsiTrendlineAnalysis = { lines: [], displayed: [], noLongs: false }

/** Keep each pane legible, while retaining an unresolved bearish warning. */
export function selectDisplayedTrendlines(lines: readonly RsiTrendline[]): RsiTrendline[] {
  const visible = lines.filter(isVisibleRsiTrendline)
  return (['resistance', 'support'] as const).flatMap((kind) => {
    const candidates = visible.filter((line) => line.kind === kind)
    const warnings = candidates.filter((line) => line.warningActive)
    const selection = warnings.length ? warnings : candidates
    const latest = selection.reduce<RsiTrendline | undefined>((chosen, line) => (
      !chosen || line.formedAt > chosen.formedAt ? line : chosen
    ), undefined)
    return latest ? [latest] : []
  })
}

interface CacheEntry {
  committed: readonly RsiBar[]
  analysis: RsiTrendlineAnalysis
}
const cache = new Map<string, CacheEntry>()

/** Card and detail views share closed-candle work; live ticks do not replay it. */
export function getRsiTrendlineAnalysis(symbol: string, bars: readonly RsiBar[]): RsiTrendlineAnalysis {
  // Only remove trailing previews. Interior missing/unclosed evidence must still
  // reach the detector so it interrupts lines instead of bridging a data gap.
  let length = bars.length
  while (length > 0 && bars[length - 1].isClosed === false) length--
  const previous = cache.get(symbol)
  if (previous && previous.committed.length === length
    && previous.committed.every((bar, index) => bar === bars[index])) return previous.analysis
  const committed = bars.slice(0, length)
  const lines = findRsiTrendlines(committed)
  const displayed = selectDisplayedTrendlines(lines)
  const analysis = { lines, displayed, noLongs: displayed.some((line) => line.warningActive) }
  // A bounded cache also releases history for old markets and removed pairs.
  if (!cache.has(symbol) && cache.size >= 1_000) cache.delete(cache.keys().next().value!)
  cache.set(symbol, { committed, analysis })
  return analysis
}

export function trendlineStatusLabel(line: RsiTrendline): string {
  const name = line.kind === 'resistance' ? 'Resistance' : 'Support'
  if (line.state === 'broken') {
    const direction = line.kind === 'resistance' ? 'Bullish' : 'Bearish'
    return `${direction} break · ${line.breakGrade === 'ideal' ? 'ideal' : 'non-ideal'}`
  }
  return line.state === 'approaching' ? `${name} · approaching break` : `${name} · formed`
}

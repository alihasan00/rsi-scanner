import type { RsiBar } from '../types'
import { analyzeSignalEvidence } from './signalEvidence'
import type { EvidenceRequest } from './signalEvidence'
import { getFibAnalysis } from './fibScreener'
import { getHarmonicAnalysis } from './harmonicScreener'
import type { FibSettings } from './fibPreferences'
import type { FibAnalysis } from './fibonacci'
import type { HarmonicAnalysis } from './harmonics'
import { prepareWatchlistRetestTargets } from './watchlist'

export type WatchlistAnalysisRequest = Omit<EvidenceRequest,
  'asOf' | 'fibSnapshot' | 'harmonicSnapshot' | 'higherTimeframe' | 'fibOptions'> & { fibOptions: FibSettings }

export interface WatchlistClosedAnalysis {
  fib: FibAnalysis
  harmonic: HarmonicAnalysis
  evidence: ReturnType<typeof analyzeSignalEvidence>
  retestTargets?: Readonly<Record<string, number | null>>
}

const FIELDS = ['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'volume', 'rsi', 'isClosed'] as const
const value = (bar: RsiBar, field: typeof FIELDS[number]) => field === 'isClosed' ? Number(bar.isClosed) : bar[field]

function analyze(request: WatchlistAnalysisRequest): WatchlistClosedAnalysis {
  const identity = `${request.market}:${request.timeframe}:${request.symbol}`
  const fib = getFibAnalysis(identity, request.bars, request.fibOptions)
  const harmonic = getHarmonicAnalysis(identity, request.bars)
  const evidence = analyzeSignalEvidence({ ...request, fibSnapshot: fib, harmonicSnapshot: harmonic })
  return { fib, harmonic, evidence, retestTargets: prepareWatchlistRetestTargets(request.bars, evidence) }
}

/** Keep discovery off the live-tick path. No new persisted state or market requests. */
export function createWatchlistAnalysisCache(capacity = 128, analyzer = analyze) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Cache capacity must be positive')
  const entries = new Map<string, {
    values: Float64Array
    options: string
    calendarMap: EvidenceRequest['calendarMap']
    result: WatchlistClosedAnalysis
  }>()
  return {
    get(request: WatchlistAnalysisRequest): WatchlistClosedAnalysis {
      // Only trailing previews are irrelevant. Interior unfinished/invalid bars
      // remain so the detectors can interrupt a sequence rather than bridge it.
      let length = request.bars.length
      while (length && !request.bars[length - 1].isClosed) length--
      const key = `${request.market}:${request.timeframe}:${request.symbol}`
      const options = JSON.stringify([request.divergenceOptions, request.fibOptions])
      const cached = entries.get(key)
      if (cached && cached.options === options && cached.calendarMap === request.calendarMap
        && cached.values.length === length * FIELDS.length
        && request.bars.slice(0, length).every((bar, i) => FIELDS.every((field, offset) =>
          Object.is(value(bar, field), cached.values[i * FIELDS.length + offset])))) {
        entries.delete(key)
        entries.set(key, cached)
        return cached.result
      }
      const closed = request.bars.slice(0, length)
      const result = analyzer({ ...request, bars: closed })
      entries.delete(key)
      entries.set(key, {
        values: Float64Array.from(closed.flatMap((bar) => FIELDS.map((field) => value(bar, field)))),
        options, calendarMap: request.calendarMap, result,
      })
      while (entries.size > capacity) entries.delete(entries.keys().next().value!)
      return result
    },
    clear() { entries.clear() },
  }
}

import type { RsiBar } from '../types'
import { analyzeHarmonics, HARMONIC_MAX_HISTORY } from './harmonics'
import type { HarmonicAnalysis } from './harmonics'

interface CachedHarmonics {
  bars: readonly RsiBar[]
  analysis: HarmonicAnalysis
}

// Bound retained histories across market/timeframe changes as well as within a pair.
const MAX_CACHED_SYMBOLS = 1_200
const cache = new Map<string, CachedHarmonics>()

/** Cache by closed candle identity, including interior gaps and corrected anchors. */
export function getHarmonicAnalysis(symbol: string, bars: readonly RsiBar[]): HarmonicAnalysis {
  let end = bars.length
  while (end > 0 && bars[end - 1].isClosed === false) end--
  const history = bars.slice(Math.max(0, end - HARMONIC_MAX_HISTORY), end)
  const previous = cache.get(symbol)
  if (previous && history.length === previous.bars.length
    && history.every((bar, index) => bar === previous.bars[index])) return previous.analysis
  const analysis = analyzeHarmonics(history)
  cache.delete(symbol)
  cache.set(symbol, { bars: history, analysis })
  if (cache.size > MAX_CACHED_SYMBOLS) cache.delete(cache.keys().next().value!)
  return analysis
}

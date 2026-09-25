import { createHarmonicAnalysisCache } from './harmonicReplayCache'

// The identity supplied by callers includes market, timeframe and symbol.
const cache = createHarmonicAnalysisCache()
export const getHarmonicAnalysis = cache.get

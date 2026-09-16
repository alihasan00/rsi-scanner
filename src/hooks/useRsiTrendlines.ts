import { useMemo } from 'react'
import type { RsiBar } from '../types'
import { EMPTY_TRENDLINE_ANALYSIS, getRsiTrendlineAnalysis } from '../lib/rsiTrendlineAnalysis'

export function useRsiTrendlines(symbol: string, bars: readonly RsiBar[], enabled = true) {
  return useMemo(() => enabled
    ? getRsiTrendlineAnalysis(symbol, bars)
    : EMPTY_TRENDLINE_ANALYSIS, [symbol, bars, enabled])
}

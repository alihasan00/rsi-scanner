import { useMemo } from 'react'
import { findRsiDivergenceSetups } from '../lib/divergenceLifecycle'
import type { DivergenceLifecycleOptions, DivergenceSetup } from '../lib/divergenceLifecycle'
import type { RsiBar } from '../types'

const NO_SIGNALS: DivergenceSetup[] = []

/** Replay all retained candles; chart clipping must not discard the outcome log. */
export function useDivergences(
  bars: readonly RsiBar[],
  enabled: boolean,
  { includeHidden, requireBodyAgreement, requireSameRsiCycle, invalidationAnchor }: Pick<
    DivergenceLifecycleOptions, 'includeHidden' | 'requireBodyAgreement' | 'requireSameRsiCycle' | 'invalidationAnchor'
  >,
): DivergenceSetup[] {
  return useMemo(() => {
    if (!enabled || bars.length === 0) return NO_SIGNALS
    return findRsiDivergenceSetups(bars, {
      includeHidden, requireBodyAgreement, requireSameRsiCycle, invalidationAnchor,
    })
  }, [bars, enabled, includeHidden, requireBodyAgreement, requireSameRsiCycle, invalidationAnchor])
}

import { useEffect, useState } from 'react'
import type { Timeframe } from '../types'
import type { ScreenerMarket } from '../lib/markets'
import { fetchHigherTimeframeContext } from '../lib/higherTimeframe'
import type { HigherTimeframeSnapshot } from '../lib/higherTimeframe'

interface ContextState {
  identity: string
  status: 'loading' | 'ready' | 'error'
  snapshot: HigherTimeframeSnapshot | null
  error: string | null
}

export function useHigherTimeframe(symbol: string, market: ScreenerMarket, timeframe: Timeframe | null) {
  const identity = `${market}:${timeframe}:${symbol}`
  const [state, setState] = useState<ContextState | null>(null)
  useEffect(() => {
    if (!timeframe || !symbol) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const refresh = async () => {
      controller = new AbortController()
      const timeout = setTimeout(() => controller?.abort(new Error('Higher-timeframe request timed out.')), 15_000)
      try {
        const snapshot = await fetchHigherTimeframeContext({ symbol, market, timeframe, signal: controller.signal })
        if (!stopped) setState({ identity, status: 'ready', snapshot, error: null })
      } catch (cause) {
        if (!stopped) setState({ identity, status: 'error', snapshot: null, error: cause instanceof Error ? cause.message : 'Higher-timeframe history unavailable.' })
      } finally {
        clearTimeout(timeout)
        if (!stopped) timer = setTimeout(refresh, 60_000)
      }
    }
    void refresh()
    return () => { stopped = true; controller?.abort(); clearTimeout(timer) }
  }, [symbol, market, timeframe, identity])
  return state?.identity === identity ? state : { identity, status: 'loading' as const, snapshot: null, error: null }
}

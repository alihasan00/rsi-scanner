import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { SupportResistanceRow } from '../lib/supportResistanceFilters'
import {
  getSupportResistance,
  getSupportResistanceVersion,
  subscribeAllSupportResistance,
} from '../store/supportResistanceStore'

const DEFAULT_THROTTLE_MS = 250
const NOOP_UNSUBSCRIBE = (): void => undefined

/**
 * Snapshot of every requested symbol for market-wide filtering and sorting.
 * Ticks arrive for many symbols per second, so the store-wide subscription is
 * throttled; individual cards still update on their own symbol's ticks.
 */
export function useSupportResistanceRows(
  symbols: readonly string[],
  active = true,
  throttleMs = DEFAULT_THROTTLE_MS,
): SupportResistanceRow[] {
  const subscribe = useCallback((notify: () => void) => {
    if (!active) return NOOP_UNSUBSCRIBE
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = subscribeAllSupportResistance(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        notify()
      }, throttleMs)
    })
    return () => {
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
    }
  }, [active, throttleMs])

  const version = useSyncExternalStore(subscribe, getSupportResistanceVersion, getSupportResistanceVersion)

  return useMemo(
    () => symbols.map((symbol) => ({ symbol, snapshot: getSupportResistance(symbol) })),
    // The version is the signal that any snapshot may have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [symbols, version],
  )
}

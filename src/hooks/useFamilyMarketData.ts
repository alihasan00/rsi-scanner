import { useCallback, useEffect, useState } from 'react'
import { FAMILY_SYMBOLS } from '../lib/coinFamilies'
import {
  FAMILY_POLL_INTERVAL_MS, FAMILY_REQUEST_TIMEOUT_MS, FAMILY_STALE_AFTER_MS,
  familyRetryDelay, fetchFamilyMarketData, isFamilyQuoteStale,
} from '../lib/familyMarketData'
import type { FamilyMarketQuote } from '../lib/familyMarketData'

interface FamilyMarketState {
  quotes: ReadonlyMap<string, FamilyMarketQuote>
  updatedAt: number | null
  status: 'loading' | 'ready' | 'error'
  error: string | null
}

export interface FamilyMarketData extends FamilyMarketState {
  now: number
  isStale: boolean
  retry: () => void
}

/** Mount only with the Families view. Every request finishes before its next poll. */
export function useFamilyMarketData(): FamilyMarketData {
  const [state, setState] = useState<FamilyMarketState>({
    quotes: new Map(), updatedAt: null, status: 'loading', error: null,
  })
  const [now, setNow] = useState(() => Date.now())
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    let stopped = false
    let failures = 0
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let requestController: AbortController | null = null
    const clockTimer = setInterval(() => setNow(Date.now()), 5_000)

    const poll = async () => {
      const controller = new AbortController()
      requestController = controller
      let timedOut = false
      timeoutTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, FAMILY_REQUEST_TIMEOUT_MS)
      try {
        const quotes = await fetchFamilyMarketData(FAMILY_SYMBOLS, controller.signal)
        if (stopped) return
        const updatedAt = Date.now()
        failures = 0
        setNow(updatedAt)
        setState({ quotes, updatedAt, status: 'ready', error: null })
      } catch (cause: unknown) {
        if (stopped) return
        failures += 1
        setNow(Date.now())
        setState((previous) => ({
          ...previous, status: 'error',
          error: timedOut ? 'Binance 24h prices timed out. Retrying automatically.'
            : cause instanceof Error ? cause.message : 'Binance 24h prices unavailable',
        }))
      } finally {
        clearTimeout(timeoutTimer)
        requestController = null
        if (!stopped) pollTimer = setTimeout(() => void poll(), failures ? familyRetryDelay(failures) : FAMILY_POLL_INTERVAL_MS)
      }
    }
    void poll()
    return () => {
      stopped = true
      requestController?.abort()
      clearTimeout(pollTimer)
      clearTimeout(timeoutTimer)
      clearInterval(clockTimer)
    }
  }, [attempt])

  return {
    ...state, now, retry,
    isStale: state.status === 'error' || state.updatedAt === null || now - state.updatedAt >= FAMILY_STALE_AFTER_MS
      || (state.quotes.size > 0 && [...state.quotes.values()].every((quote) => isFamilyQuoteStale(quote, now))),
  }
}

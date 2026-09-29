import { useEffect, useMemo, useState } from 'react'
import type { ScreenerMarket } from '../lib/markets'
import type { Timeframe } from '../types'
import { adaptGoWatchlist, isGoWatchlistRowCurrent } from '../lib/goWatchlist'
import type { GoWatchlistResult, GoWatchlistScope } from '../lib/goWatchlist'
import { startGoWatchlistFeed } from '../lib/goWatchlistFeed'
import { getGoWatchlistTimeframes } from '../lib/goWatchlistTimeframes'
import type { GoWatchlistFrameUpdate } from '../lib/goWatchlistFeed'
import { captureWatchlistEvaluation } from '../lib/watchlistChart'
import type { WatchlistEvaluationInput } from '../lib/watchlistChart'
import { getGoWatchlistCoverage, getWatchlistSeedProgress, GoWatchlistScheduler, isEvaluatedWatchlistSourceCurrent } from '../lib/goWatchlistProgress'
import type { WatchlistRow } from '../lib/watchlist'

interface State {
  identity: string; market: ScreenerMarket; rows: WatchlistRow[]; frames: GoWatchlistFrameUpdate[]
  evaluation: GoWatchlistResult['scan'] | null; evaluatedSources: readonly GoWatchlistFrameUpdate[]
  initialScanComplete: boolean; evaluating: boolean; error: string | null; evaluatedAt: number | null; version: string | null
}
interface PendingScan {
  id: number
  input: WatchlistEvaluationInput
  sources: readonly GoWatchlistFrameUpdate[]
  allSeedsAttempted: boolean
}

export function useGoWatchlist(symbols: readonly string[], market: ScreenerMarket, scope: GoWatchlistScope = 'all', timeframe?: Timeframe) {
  const selectedTimeframe = scope === 'ichimoku' ? timeframe ?? '1h' : undefined
  const timeframes = useMemo(() => getGoWatchlistTimeframes(scope, selectedTimeframe), [scope, selectedTimeframe])
  const identity = `${scope}:${selectedTimeframe ?? 'all'}:${market}:${symbols.join(',')}`
  const [now, setNow] = useState(Date.now)
  const [state, setState] = useState<State | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    if (symbols.length === 0) return
    let stopped = false
    let ready = false
    let pending: PendingScan | null = null
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const frames = new Map<string, GoWatchlistFrameUpdate>()
    const scheduler = new GoWatchlistScheduler()
    const worker = new Worker(`${import.meta.env.BASE_URL}watchlist-worker.js`)
    let current: State = {identity, market, rows: [], frames: [], evaluation: null, evaluatedSources: [], initialScanComplete: false,
      evaluating: false, error: null, evaluatedAt: null, version: null}
    const publish = () => { if (!stopped) setState({...current, frames: [...frames.values()]}) }
    const fail = (message: string) => {
      scheduler.fail()
      pending = null
      clearTimeout(watchdog)
      clearTimeout(bootWatchdog)
      current = {...current, rows: [], evaluating: false, error: message}
      publish()
    }
    const evaluate = () => {
      if (stopped || !ready || scheduler.busy) return
      const sources = [...frames.values()]
      const scheduled = scheduler.begin(Date.now(), getWatchlistSeedProgress(symbols, sources, timeframes,
        scope === 'all' ? 'independent' : 'complete'))
      if (!scheduled) return
      const input = captureWatchlistEvaluation(`${identity}:${scheduled.evaluatedAt}:${scheduled.id}`, scheduled.evaluatedAt, sources)
      pending = {...scheduled, input, sources}
      current = {...current, evaluating: true}
      publish()
      worker.postMessage({id: scheduled.id, input: {now: input.evaluatedAt, symbols: [...symbols], histories: input.histories, scope, timeframe: selectedTimeframe}})
      watchdog = setTimeout(() => {
        if (stopped || !scheduler.busy) return
        worker.terminate()
        ready = false
        fail('The watchlist engine timed out. Reload to retry the evaluation.')
      }, 90_000)
    }
    worker.onmessage = (event: MessageEvent) => {
      if (stopped) return
      const message = event.data
      if (message.type === 'ready') { clearTimeout(bootWatchdog); ready = true; evaluate(); return }
      if (message.id !== undefined && message.id !== pending?.id) return
      if (message.type === 'error') { fail(message.message || 'Watchlist engine unavailable'); return }
      if (message.type === 'result') {
        const completed = pending
        if (!completed || message.id !== completed.id) return
        clearTimeout(watchdog)
        pending = null
        try {
          const output = message.data as GoWatchlistResult
          if (output.now !== completed.input.evaluatedAt) throw new Error('The watchlist response does not match its evaluated candle snapshot.')
          if ((output.scope ?? 'all') !== scope) throw new Error('The watchlist response does not match the selected indicator.')
          if (selectedTimeframe && output.timeframe !== selectedTimeframe) throw new Error('The watchlist response does not match the selected timeframe.')
          const rows = adaptGoWatchlist(output, market, completed.input)
          scheduler.publish(completed.id)
          current = {...current, rows, evaluation: output.scan, evaluatedSources: completed.sources,
            initialScanComplete: scheduler.initialScanComplete, evaluating: false, error: null,
            evaluatedAt: completed.input.evaluatedAt, version: output.version}
          publish()
        } catch (cause) { fail(cause instanceof Error ? cause.message : 'Invalid watchlist evaluation') }
      }
    }
    worker.onerror = () => { ready = false; fail('The watchlist engine could not load. Reload to retry.') }
    const bootWatchdog = setTimeout(() => {
      if (stopped || ready) return
      worker.terminate()
      fail('The watchlist engine could not load within 30 seconds. Reload to retry.')
    }, 30_000)
    const stopFeed = startGoWatchlistFeed({symbols, market, timeframes, onUpdate: (frame) => {
      if (stopped) return
      const key = `${frame.symbol}:${frame.timeframe}`
      const previous = frames.get(key)
      frames.set(key, frame)
      // Start as soon as an asset becomes usable instead of waiting for the UI
      // timer. The scheduler still enforces the same scan cadence and one job.
      if (!previous || previous.status !== frame.status) evaluate()
    }})
    const timer = setInterval(() => { publish(); evaluate() }, 2_000)
    return () => { stopped = true; pending = null; stopFeed(); worker.terminate(); clearInterval(timer); clearTimeout(watchdog); clearTimeout(bootWatchdog) }
  }, [symbols, market, identity, scope, selectedTimeframe, timeframes])
  return useMemo(() => {
    const current = state?.identity === identity ? state : null
    const frames = current?.frames ?? []
    const {coverage, feedError, remainingInitialFrames} = getGoWatchlistCoverage(frames, current?.evaluation ?? null,
      current?.evaluatedSources ?? [], now, symbols.length * timeframes.length)
    // Current transport failure or expiry can withhold a published candidate;
    // the chart itself remains the immutable input bound to that Go response.
    const latest = new Map(frames.map((frame) => [`${frame.symbol}:${frame.timeframe}`, frame]))
    const evaluated = new Map(current?.evaluatedSources.map((frame) => [`${frame.symbol}:${frame.timeframe}`, frame]) ?? [])
    const rows = (current?.rows ?? []).filter((row) => (row.reference?.requiredTimeframes ?? timeframes).every((tf) => {
      const key = `${row.symbol}:${tf}`
      return isEvaluatedWatchlistSourceCurrent(latest.get(key), evaluated.get(key), now)
    }) && isGoWatchlistRowCurrent(row, now))
    return {rows, coverage, now, feedError, evaluating: current?.evaluating ?? false,
      initialScanComplete: current?.initialScanComplete ?? symbols.length === 0, remainingInitialFrames,
      error: current?.error ?? null, evaluatedAt: current?.evaluatedAt ?? null, version: current?.version ?? null}
  }, [state, identity, symbols.length, now, timeframes])
}

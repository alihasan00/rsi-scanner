import type { Candle } from '../types'
import { KlineStreamManager } from './binanceSocket'
import type { KlineListener, KlineTick } from './binanceSocket'
import type { ScreenerMarket } from './markets'
import { isValidCandle } from './rsiHistory'
import { createSrContextRestClient, SR_DAILY_HISTORY_LIMIT, SR_DAY_MS, SrContextRequestError } from './srContextRest'
import type { SrContextHistory } from './srContextRest'

const SEED_CONCURRENCY = 4
const STARTS_PER_SECOND = 8
const RETRY_MS = 5000
const MAX_BUFFERED_CANDLES = 8

interface SrContextFeedOptions {
  symbols: readonly string[]
  market: ScreenerMarket
  /** Guards the interval before React cleans up a changed market or tab. */
  isCurrent: () => boolean
  publishHistory: (symbol: string, history: SrContextHistory) => void
  reportError: (symbol: string, error: unknown) => void
}

interface SrContextFeedDependencies {
  fetchSeed: (symbol: string, signal: AbortSignal, market: ScreenerMarket) => Promise<SrContextHistory>
  createStream: (listener: KlineListener, market: ScreenerMarket) => Pick<KlineStreamManager, 'connect' | 'disconnect'>
  schedule: (callback: () => void, delayMs: number) => () => void
  now: () => number
}

function isDaily(candle: Candle): boolean {
  return isValidCandle(candle) && candle.openTime % SR_DAY_MS === 0
    && candle.closeTime - candle.openTime + 1 === SR_DAY_MS
}

/** REST establishes which gaps are actual missing market sessions. */
function recoverHistory(previous: SrContextHistory | undefined, seed: SrContextHistory): SrContextHistory {
  if (!previous) return seed
  const candles = new Map(seed.candles.map((candle) => [candle.openTime, candle]))
  for (const candle of previous.candles) candles.set(candle.openTime, candle)
  const closed = [...candles.values()].sort((a, b) => a.openTime - b.openTime).slice(-SR_DAILY_HISTORY_LIMIT)
  const last = closed.at(-1)
  const previews = [seed.preview, previous.preview]
    .filter((candle): candle is Candle => candle !== null && (!last || candle.openTime > last.openTime))
    .sort((a, b) => b.openTime - a.openTime)
  return { candles: closed, preview: previews[0] ?? null, asOf: Math.max(previous.asOf, seed.asOf) }
}

function updateHistory(history: SrContextHistory, tick: KlineTick): { status: 'updated' | 'ignored' | 'gap'; history: SrContextHistory } {
  if (!isDaily(tick)) return { status: 'ignored', history }
  const last = history.candles.at(-1)
  if ((last && tick.openTime <= last.openTime)
    || (!tick.isFinal && history.preview && tick.openTime < history.preview.openTime)) {
    return { status: 'ignored', history }
  }
  // A matching REST preview authorizes a genuine session gap; a socket alone
  // cannot turn an unseen day into a closed candle.
  if (last && tick.openTime > last.closeTime + 1 && history.preview?.openTime !== tick.openTime) {
    return { status: 'gap', history }
  }
  const asOf = Math.max(history.asOf, tick.isFinal ? tick.closeTime + 1 : tick.openTime)
  return {
    status: 'updated',
    history: tick.isFinal
      ? {
        candles: [...history.candles, tick].slice(-SR_DAILY_HISTORY_LIMIT),
        preview: history.preview && history.preview.openTime > tick.openTime ? history.preview : null,
        asOf,
      }
      : { ...history, preview: tick, asOf },
  }
}

/** Daily context has its own bounded queue and never inherits display-timeframe RSI data. */
export function startSrContextFeed(
  options: SrContextFeedOptions,
  overrides: Partial<SrContextFeedDependencies> = {},
): () => void {
  const { symbols, market, isCurrent, publishHistory, reportError } = options
  const knownSymbols = new Set(symbols)
  if (!knownSymbols.size || !isCurrent()) return () => undefined
  const controller = new AbortController()
  const client = createSrContextRestClient(market, controller.signal)
  const dependencies: SrContextFeedDependencies = {
    fetchSeed: (symbol) => client.fetchSeed(symbol),
    createStream: (listener, streamMarket) => new KlineStreamManager(listener, streamMarket),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs)
      return () => clearTimeout(timer)
    },
    now: Date.now,
    ...overrides,
  }
  const histories = new Map<string, SrContextHistory>()
  const pending = new Map<string, Map<number, KlineTick>>()
  const queue = new Set(knownSymbols)
  const loading = new Set<string>()
  const retries = new Map<string, () => void>()
  let starts: number[] = []
  let cooldownUntil = 0
  let cancelDrain: (() => void) | null = null
  let cancelRollover: (() => void) | null = null
  let rolloverGeneration = 0
  let cancelled = false
  const active = () => !cancelled && isCurrent()

  function buffer(tick: KlineTick): void {
    const ticks = pending.get(tick.symbol) ?? new Map<number, KlineTick>()
    if (!ticks.get(tick.openTime)?.isFinal) ticks.set(tick.openTime, tick)
    if (ticks.size > MAX_BUFFERED_CANDLES) ticks.delete(Math.min(...ticks.keys()))
    pending.set(tick.symbol, ticks)
  }

  function drainQueue(): void {
    if (!active() || cancelDrain || loading.size >= SEED_CONCURRENCY || queue.size === 0) return
    const now = dependencies.now()
    starts = starts.filter((startedAt) => startedAt > now - 1000)
    const waitUntil = Math.max(cooldownUntil, starts.length >= STARTS_PER_SECOND ? starts[0] + 1000 : 0)
    if (waitUntil > now) {
      cancelDrain = dependencies.schedule(() => { cancelDrain = null; drainQueue() }, waitUntil - now)
      return
    }
    while (active() && loading.size < SEED_CONCURRENCY && queue.size && starts.length < STARTS_PER_SECOND) {
      const symbol = queue.values().next().value!
      queue.delete(symbol)
      starts.push(now)
      void seedSymbol(symbol)
    }
    if (queue.size && loading.size < SEED_CONCURRENCY) drainQueue()
  }

  function enqueue(symbol: string): void {
    if (!active() || loading.has(symbol) || retries.has(symbol)) return
    queue.add(symbol)
    drainQueue()
  }

  function retry(symbol: string, delay: number): void {
    if (!active() || retries.has(symbol)) return
    retries.set(symbol, dependencies.schedule(() => {
      retries.delete(symbol)
      enqueue(symbol)
    }, delay))
  }

  function scheduleRollover(asOf: number): void {
    if (!active() || cancelRollover) return
    const nextDay = (Math.floor(asOf / SR_DAY_MS) + 1) * SR_DAY_MS
    cancelRollover = dependencies.schedule(() => {
      cancelRollover = null
      if (!active()) return
      // A quiet TradFi market may supply no ticks over a weekend. Refresh from
      // exchange time after UTC midnight so its calendar periods still roll.
      rolloverGeneration += 1
      client.invalidateClock()
      for (const symbol of knownSymbols) enqueue(symbol)
    }, nextDay - asOf + 1500)
  }

  async function seedSymbol(symbol: string): Promise<void> {
    loading.add(symbol)
    const generation = rolloverGeneration
    let retryDelay: number | null = null
    try {
      const seed = await dependencies.fetchSeed(symbol, controller.signal, market)
      if (!active()) return
      let history = recoverHistory(histories.get(symbol), seed)
      const ticks = [...(pending.get(symbol)?.values() ?? [])].sort((a, b) => a.openTime - b.openTime)
      pending.delete(symbol)
      for (let index = 0; index < ticks.length; index++) {
        const update = updateHistory(history, ticks[index])
        if (update.status === 'gap') {
          for (const remaining of ticks.slice(index)) buffer(remaining)
          retryDelay = RETRY_MS
          break
        }
        history = update.history
      }
      histories.set(symbol, history)
      if (generation === rolloverGeneration) scheduleRollover(history.asOf)
      if (active()) publishHistory(symbol, history)
    } catch (error) {
      if (active() && !controller.signal.aborted) {
        retryDelay = RETRY_MS
        if (error instanceof SrContextRequestError && error.retryAfterMs !== null) {
          retryDelay = Math.max(retryDelay, error.retryAfterMs)
          cooldownUntil = Math.max(cooldownUntil, dependencies.now() + error.retryAfterMs)
          cancelDrain?.()
          cancelDrain = null
        }
        reportError(symbol, error)
      }
    } finally {
      loading.delete(symbol)
      if (retryDelay !== null) retry(symbol, retryDelay)
      else if (generation !== rolloverGeneration) enqueue(symbol)
      drainQueue()
    }
  }

  const stream = dependencies.createStream((tick) => {
    if (!active() || !knownSymbols.has(tick.symbol) || !isDaily(tick)) return
    const history = histories.get(tick.symbol)
    if (!history || loading.has(tick.symbol) || retries.has(tick.symbol) || queue.has(tick.symbol)) {
      buffer(tick)
      enqueue(tick.symbol)
      return
    }
    const update = updateHistory(history, tick)
    if (update.status === 'gap') {
      buffer(tick)
      enqueue(tick.symbol)
    } else if (update.status === 'updated') {
      histories.set(tick.symbol, update.history)
      publishHistory(tick.symbol, update.history)
    }
  }, market)
  stream.connect([...knownSymbols], '1d')
  drainQueue()

  return () => {
    if (cancelled) return
    cancelled = true
    controller.abort()
    stream.disconnect()
    cancelDrain?.()
    cancelRollover?.()
    for (const cancel of retries.values()) cancel()
    retries.clear()
    queue.clear()
    pending.clear()
    histories.clear()
  }
}

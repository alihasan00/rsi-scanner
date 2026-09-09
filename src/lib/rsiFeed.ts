import { fetchSeedKlines } from './binanceRest'
import { KlineStreamManager } from './binanceSocket'
import type { KlineListener, KlineTick } from './binanceSocket'
import type { ScreenerMarket } from './markets'
import { recoverRsiHistory, updateRsiHistory } from './rsiHistory'
import type { RsiHistory } from './rsiHistory'

const RESEED_RETRY_MS = 5000
const INSUFFICIENT_HISTORY_RETRY_MS = 60_000
const MAX_BUFFERED_CANDLES = 200
const SEED_CONCURRENCY = 8

interface RsiFeedOptions {
  symbols: readonly string[]
  market: ScreenerMarket
  timeframe: string
  /** Also guards the interval between a store change and React effect cleanup. */
  isCurrent: () => boolean
  publishHistory: (symbol: string, history: RsiHistory) => void
  reportError: (symbol: string, error: unknown) => void
}

interface RsiFeedDependencies {
  fetchSeed: typeof fetchSeedKlines
  createStream: (listener: KlineListener, market: ScreenerMarket) => Pick<KlineStreamManager, 'connect' | 'disconnect'>
  /** Returns a cancellation function, so stopping a feed also stops its retries. */
  scheduleRetry: (retry: () => void, delayMs: number) => () => void
}

const DEFAULT_DEPENDENCIES: RsiFeedDependencies = {
  fetchSeed: fetchSeedKlines,
  createStream: (listener, market) => new KlineStreamManager(listener, market),
  scheduleRetry: (retry, delayMs) => {
    const timer = setTimeout(retry, delayMs)
    return () => clearTimeout(timer)
  },
}

/**
 * Connect before seeding and replay buffered candles by identity, so a candle
 * closing during REST startup is neither missed nor counted twice. The bounded
 * queue is shared by initial seeds and gap recovery for the active universe.
 */
export function startRsiFeed(
  options: RsiFeedOptions,
  overrides: Partial<RsiFeedDependencies> = {},
): () => void {
  const { symbols, market, timeframe, isCurrent, publishHistory, reportError } = options
  const knownSymbols = new Set(symbols)
  if (knownSymbols.size === 0 || !isCurrent()) return () => undefined

  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const controller = new AbortController()
  const histories = new Map<string, RsiHistory>()
  const pending = new Map<string, Map<number, KlineTick>>()
  const loading = new Set<string>()
  const queue = new Set(knownSymbols)
  const retries = new Map<string, () => void>()
  let cancelled = false
  let draining = false

  const active = () => !cancelled && isCurrent()

  function bufferTick(tick: KlineTick): void {
    let candles = pending.get(tick.symbol)
    if (!candles) {
      candles = new Map()
      pending.set(tick.symbol, candles)
    }
    // A delayed preview must never replace a received final candle.
    if (!candles.get(tick.openTime)?.isFinal) candles.set(tick.openTime, tick)
    if (candles.size > MAX_BUFFERED_CANDLES) candles.delete(Math.min(...candles.keys()))
  }

  function drainQueue(): void {
    if (draining) return
    draining = true
    while (active() && loading.size < SEED_CONCURRENCY && queue.size > 0) {
      const symbol = queue.values().next().value!
      queue.delete(symbol)
      void seedSymbol(symbol)
    }
    draining = false
  }

  function enqueueSeed(symbol: string): void {
    if (!active() || loading.has(symbol) || retries.has(symbol) || queue.has(symbol)) return
    queue.add(symbol)
    drainQueue()
  }

  function scheduleRetry(symbol: string, delayMs: number): void {
    if (!active() || retries.has(symbol)) return
    retries.set(symbol, dependencies.scheduleRetry(() => {
      retries.delete(symbol)
      enqueueSeed(symbol)
    }, delayMs))
  }

  async function seedSymbol(symbol: string): Promise<void> {
    loading.add(symbol)
    let needsRetry = false
    let retryDelayMs = RESEED_RETRY_MS
    try {
      const seed = await dependencies.fetchSeed(symbol, timeframe, controller.signal, market)
      if (!active()) return
      let history = recoverRsiHistory(
        histories.get(symbol) ?? null, seed.closedCandles, seed.previewCandle,
      )
      if (!history) {
        // New listings need more candle closes, so a short retry loop cannot
        // make their indicators ready and would only consume request weight.
        retryDelayMs = INSUFFICIENT_HISTORY_RETRY_MS
        throw new Error('Insufficient closed candles to seed RSI')
      }

      const buffered = [...(pending.get(symbol)?.values() ?? [])]
        .sort((a, b) => a.openTime - b.openTime)
      pending.delete(symbol)
      for (let index = 0; index < buffered.length; index++) {
        const tick = buffered[index]
        const update = updateRsiHistory(history, tick, tick.isFinal)
        if (update.status === 'gap') {
          // REST may lag the newest socket event. Keep it for a retry rather
          // than advancing across an unobserved candle close.
          for (const remaining of buffered.slice(index)) bufferTick(remaining)
          needsRetry = true
          break
        }
        history = update.history
      }
      histories.set(symbol, history)
      if (active()) publishHistory(symbol, history)
    } catch (error) {
      if (active() && !controller.signal.aborted) {
        reportError(symbol, error)
        needsRetry = true
      }
    } finally {
      loading.delete(symbol)
      if (needsRetry) scheduleRetry(symbol, retryDelayMs)
      drainQueue()
    }
  }

  const manager = dependencies.createStream((tick) => {
    if (!active() || !knownSymbols.has(tick.symbol)) return
    const history = histories.get(tick.symbol)
    if (!history || loading.has(tick.symbol) || retries.has(tick.symbol) || queue.has(tick.symbol)) {
      bufferTick(tick)
      enqueueSeed(tick.symbol)
      return
    }

    const update = updateRsiHistory(history, tick, tick.isFinal)
    if (update.status === 'gap') {
      bufferTick(tick)
      enqueueSeed(tick.symbol)
    } else if (update.status === 'updated') {
      histories.set(tick.symbol, update.history)
      if (active()) publishHistory(tick.symbol, update.history)
    }
  }, market)

  manager.connect([...knownSymbols], timeframe)
  drainQueue()

  return () => {
    if (cancelled) return
    cancelled = true
    controller.abort()
    for (const cancelRetry of retries.values()) cancelRetry()
    retries.clear()
    queue.clear()
    pending.clear()
    histories.clear()
    manager.disconnect()
  }
}

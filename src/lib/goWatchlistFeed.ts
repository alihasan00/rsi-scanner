import type { Candle } from '../types'
import { TIMEFRAME_MILLISECONDS, validateHistoryIdentity } from './binanceHistory'
import { KlineStreamManager } from './binanceSocket'
import type { KlineListener, KlineTick } from './binanceSocket'
import { MARKETS } from './markets'
import type { ScreenerMarket } from './markets'
import { isValidCandle } from './rsiHistory'

export const GO_WATCHLIST_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const
export type GoWatchlistTimeframe = typeof GO_WATCHLIST_TIMEFRAMES[number]
export const GO_WATCHLIST_HISTORY_LIMIT = 500

export interface GoWatchlistFrameUpdate {
  symbol: string
  timeframe: GoWatchlistTimeframe
  candles: Candle[]
  preview: Candle | null
  /** Actual last successful quote receipt. Errors never advance this clock. */
  receivedAt: number
  status: 'ready' | 'error'
  error: string | null
}

export interface GoWatchlistFeedOptions {
  symbols: readonly string[]
  market: ScreenerMarket
  onUpdate: (update: GoWatchlistFrameUpdate) => void
}

export interface GoWatchlistFeedDependencies {
  fetcher: typeof fetch
  createStream: (listener: KlineListener, market: ScreenerMarket) => Pick<KlineStreamManager, 'connect' | 'disconnect'>
  schedule: (callback: () => void, delayMs: number) => () => void
  now: () => number
}

// Overlap slower responses without increasing the shared request-start budget.
const CONCURRENCY = 8
const STARTS_PER_SECOND = 8
const REQUEST_TIMEOUT_MS = 15_000
const RETRY_MS = 5_000
const MAX_RETRY_MS = 120_000
const MAX_BUFFERED_CANDLES = GO_WATCHLIST_HISTORY_LIMIT + 12
const GAP_MESSAGE = 'Missing completed candles; refreshing market history.'

interface History {
  candles: Candle[]
  preview: Candle | null
  receivedAt: number
}
interface Frame extends History {
  symbol: string
  timeframe: GoWatchlistTimeframe
  status: 'ready' | 'error'
  error: string | null
  seeded: boolean
}
interface BufferedTick { tick: KlineTick; receivedAt: number }

class SeedRequestError extends Error {
  readonly cooldownMs: number | null

  constructor(message: string, cooldownMs: number | null = null) {
    super(message)
    this.cooldownMs = cooldownMs
  }
}

function validFrameCandle(candle: Candle, timeframe: GoWatchlistTimeframe): boolean {
  const duration = TIMEFRAME_MILLISECONDS[timeframe]
  return isValidCandle(candle) && candle.openTime % duration === 0 && candle.closeTime - candle.openTime + 1 === duration
}

function numberField(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && value.trim() === '')) {
    throw new Error('Malformed Binance candle number.')
  }
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error('Malformed Binance candle number.')
  return number
}

/** A following REST candle proves earlier rows closed; the newest stays provisional. */
export function parseGoWatchlistSeed(raw: unknown, timeframe: GoWatchlistTimeframe): Pick<History, 'candles' | 'preview'> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > GO_WATCHLIST_HISTORY_LIMIT + 1) {
    throw new Error('Invalid Binance watchlist history.')
  }
  const bars = raw.map((row: unknown): Candle => {
    if (!Array.isArray(row) || row.length < 7 || typeof row[0] !== 'number' || typeof row[6] !== 'number') {
      throw new Error('Malformed Binance watchlist candle.')
    }
    const candle: Candle = {
      openTime: row[0], closeTime: row[6], open: numberField(row[1]), high: numberField(row[2]),
      low: numberField(row[3]), close: numberField(row[4]), volume: numberField(row[5]),
    }
    if (!validFrameCandle(candle, timeframe)) throw new Error('Invalid Binance candle geometry or timeframe.')
    return candle
  })
  for (let index = 1; index < bars.length; index++) {
    if (bars[index].openTime <= bars[index - 1].closeTime) throw new Error('Unordered Binance watchlist history.')
  }
  // Real missing market sessions remain gaps for the Go engine to evaluate.
  // Never fill them with synthetic candles or smooth indicators across them.
  return { candles: bars.slice(0, -1), preview: bars.at(-1)! }
}

function sameCandle(a: Candle, b: Candle): boolean {
  return a.openTime === b.openTime && a.closeTime === b.closeTime && a.open === b.open && a.high === b.high
    && a.low === b.low && a.close === b.close && a.volume === b.volume
}

function quoteTime(history: History): number {
  return history.preview?.openTime ?? history.candles.at(-1)?.openTime ?? -1
}

function recoverHistory(previous: History, seed: History): History {
  const candles = new Map(previous.candles.map((candle) => [candle.openTime, candle]))
  // REST may correct old completed candles, but cannot remove a newer final
  // which was already received while the exchange snapshot lagged.
  for (const candle of seed.candles) candles.set(candle.openTime, candle)
  const closed = [...candles.values()].sort((a, b) => a.openTime - b.openTime).slice(-GO_WATCHLIST_HISTORY_LIMIT)
  const latest = closed.at(-1)
  const preview = [seed.preview, previous.preview].filter((candle): candle is Candle => candle !== null
    && (!latest || candle.openTime > latest.openTime)).sort((a, b) => b.openTime - a.openTime)[0] ?? null
  return { candles: closed, preview, receivedAt: quoteTime(seed) >= quoteTime(previous) ? seed.receivedAt : previous.receivedAt }
}

function applyTick(history: History, event: BufferedTick): { state: 'updated' | 'ignored' | 'gap'; history: History } {
  const { tick, receivedAt } = event
  const candle: Candle = { openTime: tick.openTime, closeTime: tick.closeTime, open: tick.open, high: tick.high,
    low: tick.low, close: tick.close, volume: tick.volume }
  const latest = history.candles.at(-1)
  if (latest && tick.openTime <= latest.openTime) {
    if (!tick.isFinal) return { state: 'ignored', history }
    const index = history.candles.findIndex((candle) => candle.openTime === tick.openTime)
    if (index < 0 || sameCandle(history.candles[index], tick)) return { state: 'ignored', history }
    const candles = [...history.candles]
    candles[index] = candle
    return { state: 'updated', history: { ...history, candles,
      receivedAt: !history.preview && index === candles.length - 1 ? receivedAt : history.receivedAt } }
  }
  if (history.preview && tick.openTime < history.preview.openTime && !tick.isFinal) return { state: 'ignored', history }
  // A REST preview can establish a genuine missing session. A socket jump
  // alone cannot finalize a stale preview or invent an unseen completed bar.
  if ((latest && tick.openTime > latest.closeTime + 1 && history.preview?.openTime !== tick.openTime)
    || (!latest && history.preview && tick.openTime > history.preview.openTime)) return { state: 'gap', history }
  if (tick.isFinal) {
    const preview = history.preview && history.preview.openTime > tick.openTime ? history.preview : null
    return { state: 'updated', history: {
      candles: [...history.candles, candle].slice(-GO_WATCHLIST_HISTORY_LIMIT), preview,
      receivedAt: preview ? history.receivedAt : receivedAt,
    } }
  }
  return { state: 'updated', history: { ...history, preview: candle, receivedAt } }
}

function retryAfter(response: Response, now: number): number | null {
  if (response.status !== 429 && response.status !== 418) return null
  const header = response.headers.get('retry-after')
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
    const timestamp = Date.parse(header)
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now)
  }
  return response.status === 418 ? 120_000 : 60_000
}

/** Independent raw histories for the fixed Go watchlist universe. */
export function startGoWatchlistFeed(options: GoWatchlistFeedOptions, overrides: Partial<GoWatchlistFeedDependencies> = {}): () => void {
  const { market, onUpdate } = options
  const symbols = [...new Set(options.symbols)]
  if (!symbols.length) return () => undefined
  if (!Object.hasOwn(MARKETS, market)) throw new TypeError('Unsupported watchlist market.')
  for (const symbol of symbols) validateHistoryIdentity(symbol, '15m')
  const dependencies: GoWatchlistFeedDependencies = {
    fetcher: fetch, createStream: (listener, streamMarket) => new KlineStreamManager(listener, streamMarket),
    schedule: (callback, delay) => { const timer = setTimeout(callback, delay); return () => clearTimeout(timer) },
    now: Date.now, ...overrides,
  }
  // Browser fetch is a host function: calling it as dependencies.fetcher(...)
  // gives it an invalid receiver even though ordinary test functions allow it.
  const fetcher = dependencies.fetcher
  const frames = new Map<string, Frame>()
  const queue = new Set<string>()
  const loading = new Map<string, AbortController>()
  const pending = new Map<string, Map<number, BufferedTick>>()
  const failures = new Map<string, number>()
  const retries = new Map<string, () => void>()
  const timers = new Set<() => void>()
  const streams: Pick<KlineStreamManager, 'connect' | 'disconnect'>[] = []
  let starts: number[] = []
  let cooldownUntil = 0
  let cancelDrain: (() => void) | null = null
  let stopped = false
  for (const symbol of symbols) for (const timeframe of GO_WATCHLIST_TIMEFRAMES) {
    const key = `${symbol}:${timeframe}`
    frames.set(key, { symbol, timeframe, candles: [], preview: null, receivedAt: 0, seeded: false, status: 'error', error: null })
    queue.add(key)
  }

  function schedule(callback: () => void, delay: number): () => void {
    let cancelled = false
    const stopTimer = dependencies.schedule(() => {
      if (cancelled || stopped) return
      cancelled = true
      timers.delete(cancel)
      callback()
    }, Math.max(0, delay))
    const cancel = () => { cancelled = true; stopTimer(); timers.delete(cancel) }
    timers.add(cancel)
    return cancel
  }

  function publish(frame: Frame): void {
    if (stopped) return
    const { symbol, timeframe, candles, preview, receivedAt, status, error } = frame
    // These are internally owned candles. Freeze each newly published history
    // once so later evaluation snapshots can safely share completed bars.
    if (!Object.isFrozen(candles)) {
      for (const candle of candles) Object.freeze(candle)
      Object.freeze(candles)
    }
    if (preview && !Object.isFrozen(preview)) Object.freeze(preview)
    onUpdate({ symbol, timeframe, candles, preview, receivedAt, status, error })
  }

  function reportError(key: string, error: string): void {
    const previous = frames.get(key)!
    if (previous.status === 'error' && previous.error === error) return
    const frame: Frame = { ...previous, status: 'error', error }
    frames.set(key, frame)
    publish(frame)
  }

  function buffer(key: string, event: BufferedTick): void {
    const buffered = pending.get(key) ?? new Map<number, BufferedTick>()
    if (!buffered.get(event.tick.openTime)?.tick.isFinal || event.tick.isFinal) buffered.set(event.tick.openTime, event)
    if (buffered.size > MAX_BUFFERED_CANDLES) buffered.delete(Math.min(...buffered.keys()))
    pending.set(key, buffered)
  }

  function drain(): void {
    if (stopped || cancelDrain || loading.size >= CONCURRENCY || queue.size === 0) return
    const now = dependencies.now()
    starts = starts.filter((startedAt) => startedAt > now - 1_000)
    const until = Math.max(cooldownUntil, starts.length >= STARTS_PER_SECOND ? starts[0] + 1_000 : 0)
    if (until > now) {
      cancelDrain = schedule(() => { cancelDrain = null; drain() }, until - now)
      return
    }
    while (!stopped && loading.size < CONCURRENCY && queue.size && starts.length < STARTS_PER_SECOND) {
      const key = queue.values().next().value!
      queue.delete(key)
      starts.push(now)
      void seedFrame(key)
    }
    if (queue.size && loading.size < CONCURRENCY) drain()
  }

  function enqueue(key: string): void {
    if (stopped || loading.has(key) || queue.has(key) || retries.has(key)) return
    queue.add(key)
    drain()
  }

  function retry(key: string): void {
    if (stopped || retries.has(key)) return
    const attempts = (failures.get(key) ?? 0) + 1
    failures.set(key, attempts)
    const delay = Math.max(Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.min(attempts - 1, 5)), cooldownUntil - dependencies.now())
    retries.set(key, schedule(() => { retries.delete(key); enqueue(key) }, delay))
  }

  async function seedFrame(key: string): Promise<void> {
    const frame = frames.get(key)!
    const controller = new AbortController()
    loading.set(key, controller)
    const cancelTimeout = schedule(() => controller.abort(new Error('Watchlist market request timed out.')), REQUEST_TIMEOUT_MS)
    let onAbort: () => void = () => undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason ?? new Error('Watchlist market request aborted.'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    let needsRetry = false
    try {
      const request = async (): Promise<History> => {
        const params = new URLSearchParams({ symbol: frame.symbol, interval: frame.timeframe, limit: String(GO_WATCHLIST_HISTORY_LIMIT + 1) })
        const response = await fetcher(`${MARKETS[market].restBase}/klines?${params}`, { signal: controller.signal })
        controller.signal.throwIfAborted()
        if (!response.ok) throw new SeedRequestError(`Binance watchlist history unavailable (HTTP ${response.status}).`, retryAfter(response, dependencies.now()))
        const raw: unknown = await response.json()
        controller.signal.throwIfAborted()
        return { ...parseGoWatchlistSeed(raw, frame.timeframe), receivedAt: dependencies.now() }
      }
      const seed = await Promise.race([request(), aborted])
      if (stopped) return
      let history = recoverHistory(frames.get(key)!, seed)
      const buffered = [...(pending.get(key)?.values() ?? [])].sort((a, b) => a.tick.openTime - b.tick.openTime)
      pending.delete(key)
      for (let index = 0; index < buffered.length; index++) {
        const update = applyTick(history, buffered[index])
        if (update.state === 'gap') {
          for (const event of buffered.slice(index)) buffer(key, event)
          needsRetry = true
          break
        }
        history = update.history
      }
      const current: Frame = { ...frame, ...history, seeded: true, status: needsRetry ? 'error' : 'ready', error: needsRetry ? GAP_MESSAGE : null }
      frames.set(key, current)
      if (!needsRetry) failures.delete(key)
      publish(current)
    } catch (cause) {
      if (!stopped) {
        needsRetry = true
        if (cause instanceof SeedRequestError && cause.cooldownMs !== null) {
          cooldownUntil = Math.max(cooldownUntil, dependencies.now() + cause.cooldownMs)
          cancelDrain?.()
          cancelDrain = null
        }
        reportError(key, cause instanceof Error ? cause.message : 'Watchlist market history unavailable.')
      }
    } finally {
      cancelTimeout()
      controller.signal.removeEventListener('abort', onAbort)
      loading.delete(key)
      if (needsRetry) retry(key)
      drain()
    }
  }

  for (const timeframe of GO_WATCHLIST_TIMEFRAMES) {
    const stream = dependencies.createStream((tick) => {
      if (stopped || typeof tick.isFinal !== 'boolean' || !validFrameCandle(tick, timeframe)) return
      const key = `${tick.symbol}:${timeframe}`
      const frame = frames.get(key)
      if (!frame) return
      const event = { tick, receivedAt: dependencies.now() }
      if (!frame.seeded || loading.has(key) || queue.has(key) || retries.has(key)) {
        buffer(key, event)
        enqueue(key)
        return
      }
      const update = applyTick(frame, event)
      if (update.state === 'gap') {
        buffer(key, event)
        reportError(key, GAP_MESSAGE)
        enqueue(key)
      } else if (update.state === 'updated') {
        const current: Frame = { ...frame, ...update.history, status: 'ready', error: null }
        frames.set(key, current)
        publish(current)
      }
    }, market)
    streams.push(stream)
    stream.connect(symbols, timeframe)
  }
  drain()

  return () => {
    if (stopped) return
    stopped = true
    for (const cancel of [...timers]) cancel()
    for (const controller of loading.values()) controller.abort(new Error('Watchlist feed stopped.'))
    for (const stream of streams) stream.disconnect()
    queue.clear()
    retries.clear()
    pending.clear()
    frames.clear()
  }
}

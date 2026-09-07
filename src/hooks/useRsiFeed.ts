import { useEffect } from 'react'
import { fetchSeedKlines } from '../lib/binanceRest'
import { KlineStreamManager } from '../lib/binanceSocket'
import type { KlineTick } from '../lib/binanceSocket'
import { recoverRsiHistory, snapshotFromRsiHistory, updateRsiHistory } from '../lib/rsiHistory'
import type { RsiHistory } from '../lib/rsiHistory'
import { SYMBOLS } from '../lib/symbols'
import { resetSymbolData, setSymbolSnapshot } from '../store/dataStore'
import { resetFeedStatus, setFeedStatus } from '../store/feedStatusStore'
import { useScannerStore } from '../store/scannerStore'

const RESEED_RETRY_MS = 5000
const MAX_BUFFERED_CANDLES = 200

/** Every derived per-symbol store reads from the same published snapshot. */
function publishHistory(symbol: string, history: RsiHistory): void {
  const snapshot = snapshotFromRsiHistory(history)
  setSymbolSnapshot(symbol, snapshot)
  setFeedStatus(symbol, { state: 'ready', updatedAt: Date.now(), error: null })
}

/**
 * Connect before seeding and replay buffered candles by identity, so a candle
 * closing during REST startup is neither missed nor counted twice. Only final
 * candles enter committed Wilder state and divergence analysis.
 */
export function useRsiFeed(): void {
  const timeframe = useScannerStore((state) => state.timeframe)

  useEffect(() => {
    const controller = new AbortController()
    const histories = new Map<string, RsiHistory>()
    const pending = new Map<string, Map<number, KlineTick>>()
    const loading = new Set<string>()
    const retries = new Map<string, ReturnType<typeof setTimeout>>()
    const knownSymbols = new Set<string>(SYMBOLS)
    let cancelled = false

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

    function scheduleRetry(symbol: string): void {
      if (cancelled || retries.has(symbol)) return
      retries.set(symbol, setTimeout(() => {
        retries.delete(symbol)
        void seedSymbol(symbol)
      }, RESEED_RETRY_MS))
    }

    async function seedSymbol(symbol: string): Promise<void> {
      if (cancelled || loading.has(symbol) || retries.has(symbol)) return
      loading.add(symbol)
      let needsRetry = false
      try {
        const seed = await fetchSeedKlines(symbol, timeframe, controller.signal)
        if (cancelled) return
        let history = recoverRsiHistory(
          histories.get(symbol) ?? null, seed.closedCandles, seed.previewCandle,
        )
        if (!history) throw new Error('Insufficient closed candles to seed RSI')

        const buffered = [...(pending.get(symbol)?.values() ?? [])]
          .sort((a, b) => a.openTime - b.openTime)
        pending.delete(symbol)
        for (let index = 0; index < buffered.length; index++) {
          const tick = buffered[index]
          const update = updateRsiHistory(history, tick, tick.isFinal)
          if (update.status === 'gap') {
            // REST may still lag the newest socket event. Preserve it for a
            // retry instead of advancing across an unobserved candle close.
            for (const remaining of buffered.slice(index)) bufferTick(remaining)
            needsRetry = true
            break
          }
          history = update.history
        }
        histories.set(symbol, history)
        publishHistory(symbol, history)
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error(`RSI seed failed for ${symbol}`, error)
          setFeedStatus(symbol, {
            state: 'error', updatedAt: null,
            error: error instanceof Error ? error.message : 'Market data unavailable',
          })
          needsRetry = true
        }
      } finally {
        loading.delete(symbol)
        if (needsRetry) scheduleRetry(symbol)
      }
    }

    const manager = new KlineStreamManager((tick) => {
      if (cancelled || !knownSymbols.has(tick.symbol)) return
      const history = histories.get(tick.symbol)
      if (!history || loading.has(tick.symbol) || retries.has(tick.symbol)) {
        bufferTick(tick)
        void seedSymbol(tick.symbol)
        return
      }

      const update = updateRsiHistory(history, tick, tick.isFinal)
      if (update.status === 'gap') {
        bufferTick(tick)
        void seedSymbol(tick.symbol)
      } else if (update.status === 'updated') {
        histories.set(tick.symbol, update.history)
        publishHistory(tick.symbol, update.history)
      }
    })

    resetSymbolData()
    resetFeedStatus()
    manager.connect(SYMBOLS, timeframe)
    for (const symbol of SYMBOLS) void seedSymbol(symbol)

    return () => {
      cancelled = true
      controller.abort()
      for (const timer of retries.values()) clearTimeout(timer)
      manager.disconnect()
    }
  }, [timeframe])
}

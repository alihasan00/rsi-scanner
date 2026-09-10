import { afterEach, describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import { SR_DAY_MS } from '../src/lib/srContextRest'
import {
  EMPTY_SR_CONTEXT, getSrContext, getSrContextVersion, publishSrContextHistory,
  reportSrContextError, resetSrContexts, subscribeAllSrContexts, subscribeSrContext,
} from '../src/store/srContextStore'

function days(start: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    openTime: start + index * SR_DAY_MS, closeTime: start + (index + 1) * SR_DAY_MS - 1,
    open: 100, high: 120, low: 90, close: 110, volume: 20,
  }))
}

afterEach(resetSrContexts)

describe('daily liquidity context store', () => {
  test('builds a map per symbol and keeps the map stable through intraday previews', () => {
    const candles = days(Date.UTC(2026, 5, 1), 70)
    const asOf = candles.at(-1)!.closeTime + 1
    let own = 0
    let other = 0
    const unsubscribeOwn = subscribeSrContext('BTCUSDT', () => { own += 1 })
    const unsubscribeOther = subscribeSrContext('ETHUSDT', () => { other += 1 })
    publishSrContextHistory('BTCUSDT', { candles, preview: null, asOf })
    const first = getSrContext('BTCUSDT')
    expect(first.status).toBe('ready')
    expect(first.map).not.toBeNull()
    expect(first.updatedAt).toBe(asOf)
    expect(own).toBe(1)
    expect(other).toBe(0)
    publishSrContextHistory('BTCUSDT', { candles, preview: days(asOf, 1)[0], asOf: asOf + 60_000 })
    expect(getSrContext('BTCUSDT')).toBe(first)
    expect(own).toBe(1)
    expect(getSrContext('ETHUSDT')).toBe(EMPTY_SR_CONTEXT)
    unsubscribeOwn()
    unsubscribeOther()
  })

  test('rolls calendar maps on a new UTC day even when the market has no new candles', () => {
    const candles = days(Date.UTC(2026, 5, 1), 70)
    const asOf = Date.UTC(2026, 7, 9, 23, 59)
    publishSrContextHistory('XAUUSDT', { candles, preview: null, asOf })
    const map = getSrContext('XAUUSDT').map
    publishSrContextHistory('XAUUSDT', { candles, preview: null, asOf: Date.UTC(2026, 7, 10) })
    expect(getSrContext('XAUUSDT').map).not.toBe(map)
    expect(getSrContext('XAUUSDT').map?.asOf).toBe(Date.UTC(2026, 7, 10))
  })

  test('errors are explicit and a recovered publication restores readiness', () => {
    const candles = days(Date.UTC(2026, 5, 1), 70)
    const history = { candles, preview: null, asOf: candles.at(-1)!.closeTime + 1 }
    publishSrContextHistory('BTCUSDT', history)
    const map = getSrContext('BTCUSDT').map
    reportSrContextError('BTCUSDT', new Error('Daily candles unavailable'))
    expect(getSrContext('BTCUSDT')).toMatchObject({ status: 'error', error: 'Daily candles unavailable', map })
    publishSrContextHistory('BTCUSDT', history)
    expect(getSrContext('BTCUSDT')).toMatchObject({ status: 'ready', error: null, map })
  })

  test('a market reset clears values, invalidates cached maps, and notifies aggregate subscribers', () => {
    const candles = days(Date.UTC(2026, 5, 1), 70)
    const history = { candles, preview: null, asOf: candles.at(-1)!.closeTime + 1 }
    publishSrContextHistory('BTCUSDT', history)
    const firstMap = getSrContext('BTCUSDT').map
    const version = getSrContextVersion()
    let notifications = 0
    const unsubscribe = subscribeAllSrContexts(() => { notifications += 1 })
    resetSrContexts()
    expect(getSrContext('BTCUSDT')).toBe(EMPTY_SR_CONTEXT)
    expect(getSrContextVersion()).toBe(version + 1)
    expect(notifications).toBe(1)
    publishSrContextHistory('BTCUSDT', history)
    expect(getSrContext('BTCUSDT').map).not.toBe(firstMap)
    unsubscribe()
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import {
  getSymbolSnapshot,
  resetSymbolData,
  setSymbolSnapshot,
  subscribeSymbol,
} from '../src/store/dataStore'

afterEach(() => {
  resetSymbolData()
})

describe('dataStore', () => {
  test('publishes updates only to subscribers of the changed symbol', () => {
    let btcNotifications = 0
    let ethNotifications = 0
    const unsubscribeBtc = subscribeSymbol('BTCUSDT', () => { btcNotifications += 1 })
    const unsubscribeEth = subscribeSymbol('ETHUSDT', () => { ethNotifications += 1 })
    const snapshot = { price: 101, volume: 12, series: [45, 51], bars: [] }

    setSymbolSnapshot('BTCUSDT', snapshot)

    expect(getSymbolSnapshot('BTCUSDT')).toBe(snapshot)
    expect(btcNotifications).toBe(1)
    expect(ethNotifications).toBe(0)

    unsubscribeBtc()
    unsubscribeEth()
  })

  test('notifies subscribers when reset removes their snapshots', () => {
    const snapshot = { price: 101, volume: 12, series: [45, 51], bars: [] }
    setSymbolSnapshot('BTCUSDT', snapshot)
    let notifications = 0
    const unsubscribe = subscribeSymbol('BTCUSDT', () => { notifications += 1 })

    resetSymbolData()

    expect(notifications).toBe(1)
    expect(getSymbolSnapshot('BTCUSDT')).toEqual({ price: 0, volume: 0, series: [], bars: [] })

    unsubscribe()
  })

  test('stops publishing after unsubscribe', () => {
    let notifications = 0
    const unsubscribe = subscribeSymbol('BTCUSDT', () => { notifications += 1 })
    unsubscribe()

    setSymbolSnapshot('BTCUSDT', { price: 102, volume: 3, series: [60], bars: [] })

    expect(notifications).toBe(0)
  })
})

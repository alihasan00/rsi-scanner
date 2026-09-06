import { afterEach, describe, expect, test } from 'bun:test'
import {
  EMPTY_SUPPORT_RESISTANCE,
  getSupportResistance,
  resetSupportResistance,
  subscribeSupportResistance,
  updateSupportResistance,
} from '../src/store/supportResistanceStore'
import type { RsiBar, SymbolSnapshot } from '../src/types'

const START = 1_700_000_000_000
const MINUTE = 60_000

function makeBars(prices: number[]): RsiBar[] {
  return prices.map((price, index) => ({
    openTime: START + index * MINUTE,
    closeTime: START + (index + 1) * MINUTE - 1,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1,
    rsi: 50,
    isClosed: true,
  }))
}

/** Enough closed bars for the default 3/3 pivots: a low at 90 and a high at 120. */
function seededBars(): RsiBar[] {
  const bars = makeBars(Array.from({ length: 16 }, () => 100))
  bars[3].low = 90
  bars[10].high = 120
  return bars
}

function snapshot(bars: RsiBar[]): SymbolSnapshot {
  const latest = bars[bars.length - 1]
  return { price: latest.close, volume: latest.volume, series: bars.map((bar) => bar.rsi), bars }
}

function withPreview(bars: RsiBar[], close: number): RsiBar[] {
  const last = bars[bars.length - 1]
  return [...bars, {
    ...last, openTime: last.closeTime + 1, closeTime: last.closeTime + MINUTE,
    open: last.close, high: Math.max(last.close, close) + 1, low: Math.min(last.close, close) - 1,
    close, isClosed: false,
  }]
}

afterEach(() => {
  resetSupportResistance()
})

describe('supportResistanceStore', () => {
  test('derives levels for a published symbol and notifies only that symbol', () => {
    let btcNotifications = 0
    let ethNotifications = 0
    const unsubscribeBtc = subscribeSupportResistance('BTCUSDT', () => { btcNotifications += 1 })
    const unsubscribeEth = subscribeSupportResistance('ETHUSDT', () => { ethNotifications += 1 })

    updateSupportResistance('BTCUSDT', snapshot(seededBars()))

    expect(getSupportResistance('BTCUSDT')).toEqual({
      trend: 'unknown',
      support: { price: 90, touches: 1 },
      resistance: { price: 120, touches: 1 },
      pendingBreaks: [],
      closedBarCount: 16,
      price: 100,
      hasData: true,
    })
    expect(getSupportResistance('ETHUSDT')).toBe(EMPTY_SUPPORT_RESISTANCE)
    expect(btcNotifications).toBe(1)
    expect(ethNotifications).toBe(0)

    unsubscribeBtc()
    unsubscribeEth()
  })

  test('live previews reselect against the new price without changing closed structure', () => {
    const bars = seededBars()
    updateSupportResistance('BTCUSDT', snapshot(bars))

    updateSupportResistance('BTCUSDT', snapshot(withPreview(bars, 89)))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      price: 89, closedBarCount: 16, support: null,
      resistance: { price: 120, touches: 1 },
      pendingBreaks: [{ kind: 'support', price: 90, touches: 1 }],
    })

    updateSupportResistance('BTCUSDT', snapshot(withPreview(bars, 121)))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      price: 121, closedBarCount: 16,
      support: { price: 90, touches: 1 }, resistance: null,
      pendingBreaks: [{ kind: 'resistance', price: 120, touches: 1 }],
    })

    updateSupportResistance('BTCUSDT', snapshot(withPreview(bars, 100)))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      price: 100, closedBarCount: 16,
      support: { price: 90, touches: 1 }, resistance: { price: 120, touches: 1 }, pendingBreaks: [],
    })
  })

  test('publishes the next available levels while live crossed zones remain pending', () => {
    const bars = makeBars(Array.from({ length: 30 }, () => 100))
    bars[3].low = 80
    bars[10].low = 90
    bars[17].high = 120
    bars[24].high = 110
    updateSupportResistance('BTCUSDT', snapshot(bars))

    updateSupportResistance('BTCUSDT', snapshot(withPreview(bars, 89)))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      price: 89, closedBarCount: 30,
      support: { price: 80, touches: 1 }, resistance: { price: 110, touches: 1 },
      pendingBreaks: [{ kind: 'support', price: 90, touches: 1 }],
    })

    updateSupportResistance('BTCUSDT', snapshot(withPreview(bars, 111)))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      price: 111, closedBarCount: 30,
      support: { price: 90, touches: 1 }, resistance: { price: 120, touches: 1 },
      pendingBreaks: [{ kind: 'resistance', price: 110, touches: 1 }],
    })
  })

  test.each([
    { close: 85, kind: 'support', price: 90, support: null, resistance: { price: 120, touches: 1 } },
    { close: 125, kind: 'resistance', price: 120, support: { price: 90, touches: 1 }, resistance: null },
  ])('a closed $kind break clears its pending status and retires the zone', ({ close, kind, price, support, resistance }) => {
    const bars = seededBars()
    const preview = withPreview(bars, close)
    updateSupportResistance('BTCUSDT', snapshot(preview))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      support, resistance, pendingBreaks: [{ kind, price, touches: 1 }], closedBarCount: 16,
    })

    const closedBreak = preview.map((bar) => ({ ...bar, isClosed: true }))
    updateSupportResistance('BTCUSDT', snapshot(closedBreak))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      support, resistance, pendingBreaks: [], closedBarCount: 17,
    })
  })

  test('a final close within the buffer keeps the zone pending until price recrosses it', () => {
    const bars = withPreview(seededBars(), 89.95).map((bar) => ({ ...bar, isClosed: true }))
    updateSupportResistance('BTCUSDT', snapshot(bars))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      support: null, pendingBreaks: [{ kind: 'support', price: 90, touches: 1 }], closedBarCount: 17,
    })

    updateSupportResistance('BTCUSDT', snapshot(withPreview(bars, 90)))
    expect(getSupportResistance('BTCUSDT')).toMatchObject({
      support: { price: 90, touches: 1 }, pendingBreaks: [], closedBarCount: 17,
    })
  })

  test('publishes the empty snapshot for symbols without closed bars', () => {
    updateSupportResistance('BTCUSDT', snapshot(seededBars()))
    updateSupportResistance('BTCUSDT', { price: 0, volume: 0, series: [], bars: [] })
    expect(getSupportResistance('BTCUSDT')).toBe(EMPTY_SUPPORT_RESISTANCE)
  })

  test('reset clears every symbol and notifies subscribers', () => {
    updateSupportResistance('BTCUSDT', snapshot(seededBars()))
    let notifications = 0
    const unsubscribe = subscribeSupportResistance('BTCUSDT', () => { notifications += 1 })

    resetSupportResistance()

    expect(notifications).toBe(1)
    expect(getSupportResistance('BTCUSDT')).toBe(EMPTY_SUPPORT_RESISTANCE)
    unsubscribe()
  })
})

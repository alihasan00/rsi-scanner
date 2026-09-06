import { describe, expect, test } from 'bun:test'
import { parseSeedKlines } from '../src/lib/binanceRest'
import { parseKlineTick } from '../src/lib/binanceSocket'
import { recoverRsiHistory, snapshotFromRsiHistory } from '../src/lib/rsiHistory'

function rawCandle(index: number) {
  return [index * 60_000, '100', '110', '90', '105', '12', (index + 1) * 60_000 - 1]
}

describe('Binance candle parsing', () => {
  test('preserves OHLC and timestamps while always leaving the newest REST bar provisional', () => {
    // All these timestamps are long in the past on the client clock. REST
    // still supplies no final flag, so only a later candle proves closure.
    const seed = parseSeedKlines(Array.from({ length: 20 }, (_, index) => rawCandle(index)))
    expect(seed.closedCandles).toHaveLength(19)
    expect(seed.previewCandle).toEqual({
      openTime: 1_140_000, closeTime: 1_199_999,
      open: 100, high: 110, low: 90, close: 105, volume: 12,
    })
    const history = recoverRsiHistory(null, seed.closedCandles, seed.previewCandle)!
    expect(snapshotFromRsiHistory(history).bars.at(-1)?.isClosed).toBe(false)
    expect(history.closedBars.at(-1)?.openTime).toBe(18 * 60_000)
  })

  test('uses the next REST candle as confirmation independently of request timing', () => {
    const seed = parseSeedKlines([rawCandle(0), rawCandle(1)])
    expect(seed.closedCandles[0].closeTime).toBe(59_999)
    expect(seed.previewCandle?.openTime).toBe(60_000)
  })

  test('reads live OHLC and an explicit final flag from combined stream events', () => {
    const event = { data: { k: {
      s: 'btcusdt', t: 60_000, T: 119_999,
      o: '100', h: '110', l: '90', c: '105', v: '12', x: false,
    } } }
    const preview = parseKlineTick(event)
    expect(preview).toEqual({
      symbol: 'BTCUSDT', openTime: 60_000, closeTime: 119_999,
      open: 100, high: 110, low: 90, close: 105, volume: 12, isFinal: false,
    })
    expect(parseKlineTick({ data: { k: { ...event.data.k, x: true } } })?.isFinal).toBe(true)
    expect(parseKlineTick({ data: { k: { ...event.data.k, x: 'true' } } })).toBeNull()
  })

  test('rejects malformed and non-finite data instead of contaminating RSI', () => {
    expect(() => parseSeedKlines([])).toThrow('No kline data')
    expect(() => parseSeedKlines([[0, '100', '110', '90', 'NaN', '12', 59_999]])).toThrow('Invalid')
    expect(parseKlineTick(null)).toBeNull()
    expect(parseKlineTick({ data: { k: { s: 'BTCUSDT', x: true } } })).toBeNull()
  })
})

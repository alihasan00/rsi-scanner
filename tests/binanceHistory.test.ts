import { describe, expect, test } from 'bun:test'
import {
  fetchClosedCandleHistory,
  TIMEFRAME_MILLISECONDS,
  validateHistoryIdentity,
} from '../src/lib/binanceHistory'

const HOUR = TIMEFRAME_MILLISECONDS['1h']

function rawCandle(index: number): (number | string)[] {
  return [index * HOUR, '100', '110', '90', '105', '12', (index + 1) * HOUR - 1, '0', 0, '0', '0', '0']
}

/** Simulates Binance: klines ending at or before endTime, newest last, up to `limit`. */
function mockBinance(totalCandles: number, serverTime: number, failOnPage: number | null = null) {
  const calls: URL[] = []
  let page = 0
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(url)
    if (url.pathname.endsWith('/time')) return Response.json({ serverTime })
    init?.signal?.throwIfAborted()
    page++
    if (failOnPage === page) return new Response('rate limited', { status: 429 })
    const endTime = Number(url.searchParams.get('endTime'))
    const limit = Number(url.searchParams.get('limit'))
    const lastIndex = Math.min(totalCandles - 1, Math.floor(endTime / HOUR))
    const firstIndex = Math.max(0, lastIndex - limit + 1)
    const rows = []
    for (let index = firstIndex; index <= lastIndex; index++) rows.push(rawCandle(index))
    return Response.json(rows)
  }) as typeof fetch
  return { fetcher, calls }
}

describe('fetchClosedCandleHistory', () => {
  test('pages backwards from the exchange clock and drops the in-progress candle', async () => {
    // Server time sits inside candle 2500, so candle 2500 must not be treated as closed.
    const serverTime = 2500 * HOUR + 1234
    const { fetcher, calls } = mockBinance(2600, serverTime)
    const progress: number[] = []
    const history = await fetchClosedCandleHistory({
      symbol: 'BTCUSDT', timeframe: '1h', count: 1500, onProgress: (p) => progress.push(p.fetched),
    }, fetcher)
    expect(history.complete).toBe(true)
    expect(history.candles).toHaveLength(1500)
    expect(history.candles.at(-1)?.openTime).toBe(2499 * HOUR)
    expect(history.candles[0].openTime).toBe(1000 * HOUR)
    expect(history.asOf).toBe(serverTime - 1)
    expect(history.serverTime).toBe(serverTime)
    for (let index = 1; index < history.candles.length; index++) {
      expect(history.candles[index].openTime).toBe(history.candles[index - 1].closeTime + 1)
    }
    expect(calls.filter((url) => url.pathname.endsWith('/klines'))).toHaveLength(2)
    expect(progress.at(-1)).toBe(1500)
  })

  test('respects an explicit endTime that predates the server clock', async () => {
    const { fetcher } = mockBinance(2600, 2500 * HOUR + 5)
    const history = await fetchClosedCandleHistory({
      symbol: 'BTCUSDT', timeframe: '1h', count: 10, endTime: 100 * HOUR - 1,
    }, fetcher)
    expect(history.candles.at(-1)?.closeTime).toBe(100 * HOUR - 1)
    expect(history.candles).toHaveLength(10)
  })

  test('returns explicitly partial history when a later page fails', async () => {
    const { fetcher } = mockBinance(2600, 2500 * HOUR + 5, 2)
    const history = await fetchClosedCandleHistory({ symbol: 'BTCUSDT', timeframe: '1h', count: 1500 }, fetcher)
    expect(history.complete).toBe(false)
    // The newest page holds 1000 rows, but candle 2500 is still open and is dropped.
    expect(history.candles).toHaveLength(999)
    expect(history.error).toContain('429')
    expect(history.warnings.join(' ')).toContain('Loaded 999 of 1500')
  })

  test('throws when the first page fails or the request is aborted', async () => {
    const failing = mockBinance(2600, 2500 * HOUR + 5, 1)
    await expect(fetchClosedCandleHistory({ symbol: 'BTCUSDT', timeframe: '1h', count: 10 }, failing.fetcher))
      .rejects.toThrow('429')
    const controller = new AbortController()
    controller.abort()
    await expect(fetchClosedCandleHistory(
      { symbol: 'BTCUSDT', timeframe: '1h', count: 10, signal: controller.signal }, mockBinance(2600, HOUR).fetcher,
    )).rejects.toThrow()
  })

  test('stops when the exchange has no older candles', async () => {
    const { fetcher } = mockBinance(300, 300 * HOUR + 5)
    const history = await fetchClosedCandleHistory({ symbol: 'BTCUSDT', timeframe: '1h', count: 1000 }, fetcher)
    expect(history.candles).toHaveLength(300)
    expect(history.complete).toBe(false)
    expect(history.error).toBeNull()
  })

  test('rejects malformed identities, counts, and mismatched intervals', async () => {
    expect(() => validateHistoryIdentity('btc-usdt', '1h')).toThrow(TypeError)
    expect(() => validateHistoryIdentity('BTCUSDT', '7h' as '1h')).toThrow(TypeError)
    await expect(fetchClosedCandleHistory({ symbol: 'BTCUSDT', timeframe: '1h', count: 0 }, mockBinance(10, HOUR).fetcher))
      .rejects.toThrow(RangeError)
    // A 1h payload requested as 4h must be rejected rather than silently accepted.
    await expect(fetchClosedCandleHistory({ symbol: 'BTCUSDT', timeframe: '4h', count: 5 }, mockBinance(50, 50 * HOUR).fetcher))
      .rejects.toThrow('interval')
  })
})

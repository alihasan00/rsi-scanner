import { describe, expect, mock, test } from 'bun:test'
import { fetchFamilyMarketData, parseFamilyMarketData } from '../src/lib/familyMarketData'

const SYMBOLS = ['ETHUSDT', 'AAVEUSDT', 'UNIUSDT']
const NOW = 1_790_000_000_000
function ticker(symbol: string, patch: Record<string, unknown> = {}) {
  return {
    symbol, lastPrice: '100.00', priceChangePercent: '5.25', quoteVolume: '12345.67',
    highPrice: '110', lowPrice: '90', closeTime: NOW, ...patch,
  }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('Binance family ticker parser', () => {
  test('parses only requested symbols and tolerates partial coverage', () => {
    const result = parseFamilyMarketData([ticker('ETHUSDT'), ticker('SOLUSDT')], SYMBOLS)
    expect(result.size).toBe(1)
    expect(result.get('ETHUSDT')).toEqual({ symbol: 'ETHUSDT', price: 100, changePercent: 5.25, quoteVolume: 12345.67, high: 110, low: 90, closeTime: NOW })
    expect(result.has('AAVEUSDT')).toBe(false)
  })

  test('valid zero change and volume are preserved', () => {
    expect(parseFamilyMarketData([ticker('ETHUSDT', { priceChangePercent: '0', quoteVolume: '0' })], SYMBOLS).get('ETHUSDT'))
      .toMatchObject({ changePercent: 0, quoteVolume: 0 })
  })

  test.each([
    { lastPrice: 'NaN' }, { lastPrice: 'Infinity' }, { lastPrice: '' }, { lastPrice: null },
    { lastPrice: 0 }, { lastPrice: -1 }, { lastPrice: true }, { priceChangePercent: 'NaN' },
    { priceChangePercent: -101 }, { quoteVolume: -1 }, { quoteVolume: undefined },
    { highPrice: 99 }, { lowPrice: 101 }, { lowPrice: 0 }, { highPrice: 'Infinity' },
    { closeTime: undefined }, { closeTime: 0 }, { closeTime: NOW + 0.5 },
  ])('omits invalid ticker fields without losing valid neighbors (%j)', (patch) => {
    const result = parseFamilyMarketData([ticker('ETHUSDT', patch), ticker('AAVEUSDT')], SYMBOLS)
    expect([...result.keys()]).toEqual(['AAVEUSDT'])
  })

  test('skips malformed entries and keeps newest duplicate data', () => {
    const result = parseFamilyMarketData([
      null, undefined, false, 3, 'ETHUSDT', {}, ticker('ETHUSDT', { closeTime: NOW - 1, lastPrice: 99 }),
      ticker('ETHUSDT'), ticker('ETHUSDT', { closeTime: NOW - 2, lastPrice: 98 }),
    ], SYMBOLS)
    expect(result.size).toBe(1)
    expect(result.get('ETHUSDT')?.price).toBe(100)
  })

  test.each([undefined, null, false, {}, { code: -1121 }])('rejects malformed response containers (%j)', (raw) => {
    expect(() => parseFamilyMarketData(raw, SYMBOLS)).toThrow('Invalid Binance 24h ticker response')
  })
})

describe('family ticker request behavior', () => {
  test('makes one batched spot request with deduplicated symbols and forwards cancellation', async () => {
    const controller = new AbortController()
    const fetcher = mock(async () => response([ticker('ETHUSDT'), ticker('AAVEUSDT')]))
    const result = await fetchFamilyMarketData(['ETHUSDT', 'AAVEUSDT', 'ETHUSDT'], controller.signal, fetcher as typeof fetch)
    expect(result.size).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const requestUrl = new URL(url)
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://api.binance.com/api/v3/ticker/24hr')
    expect(JSON.parse(requestUrl.searchParams.get('symbols')!)).toEqual(['ETHUSDT', 'AAVEUSDT'])
    expect(options.signal).toBe(controller.signal)
  })

  test('recovers partial coverage from an invalid-symbol batch using a filtered bulk response', async () => {
    const requestUrls: Array<string | URL | Request> = []
    const fetcher = mock(async (url: string | URL | Request) => {
      requestUrls.push(url)
      return requestUrls.length === 1
        ? response({ code: -1121, msg: 'Invalid symbol.' }, 400)
        : response([ticker('ETHUSDT'), ticker('SOLUSDT')])
    })
    const result = await fetchFamilyMarketData(['ETHUSDT', 'DELISTEDUSDT'], undefined, fetcher as typeof fetch)
    expect([...result.keys()]).toEqual(['ETHUSDT'])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[1][0]).toBe('https://api.binance.com/api/v3/ticker/24hr')
  })

  test.each([400, 403, 429, 451, 500])('does not multiply requests for HTTP %s errors', async (status) => {
    const fetcher = mock(async () => response({ code: -1003, msg: 'Unavailable' }, status))
    await expect(fetchFamilyMarketData(SYMBOLS, undefined, fetcher as typeof fetch)).rejects.toThrow(`HTTP ${status}`)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('keeps HTTP errors useful even when the body is not JSON', async () => {
    const fetcher = mock(async () => new Response('Unavailable', { status: 502 }))
    await expect(fetchFamilyMarketData(SYMBOLS, undefined, fetcher as typeof fetch)).rejects.toThrow('HTTP 502')
  })

  test('a failed invalid-symbol recovery reports its HTTP error', async () => {
    const fetcher = mock(async () => fetcher.mock.calls.length === 1
      ? response({ code: -1121 }, 400) : response({}, 429))
    await expect(fetchFamilyMarketData(SYMBOLS, undefined, fetcher as typeof fetch)).rejects.toThrow('HTTP 429')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('an empty selection makes no request', async () => {
    const fetcher = mock(async () => response([]))
    expect((await fetchFamilyMarketData([], undefined, fetcher as typeof fetch)).size).toBe(0)
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('already cancelled work makes no request', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = mock(async () => response([ticker('ETHUSDT')]))
    await expect(fetchFamilyMarketData(SYMBOLS, controller.signal, fetcher as typeof fetch)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('late responses and aborts before fallback do not leak into the view', async () => {
    for (const status of [200, 400]) {
      const controller = new AbortController()
      const fetcher = mock(async () => {
        controller.abort()
        return status === 200 ? response([ticker('ETHUSDT')]) : response({ code: -1121 }, status)
      })
      await expect(fetchFamilyMarketData(SYMBOLS, controller.signal, fetcher as typeof fetch)).rejects.toMatchObject({ name: 'AbortError' })
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  test('empty or entirely invalid responses are failures instead of fabricated flat prices', async () => {
    for (const body of [[], [ticker('ETHUSDT', { lastPrice: 'NaN' })]]) {
      const fetcher = mock(async () => response(body))
      await expect(fetchFamilyMarketData(SYMBOLS, undefined, fetcher as typeof fetch)).rejects.toThrow('No usable Binance 24h prices returned')
    }
  })
})

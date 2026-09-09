import { describe, expect, mock, test } from 'bun:test'
import { fetchMarketSymbols, parseTradfiSymbols } from '../src/lib/markets'
import { SYMBOLS } from '../src/lib/symbols'

function contract(symbol: unknown, patch: Record<string, unknown> = {}) {
  return {
    symbol, contractType: 'TRADIFI_PERPETUAL', status: 'TRADING',
    quoteAsset: 'USDT', marginAsset: 'USDT', underlyingType: 'COMMODITY', ...patch,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('Binance TradFi market discovery', () => {
  test('selects active USDT TradFi contracts using the exact exchange contract type', () => {
    expect(parseTradfiSymbols({ symbols: [
      contract('XAUUSDT'),
      contract('TSLAUSDT', { underlyingType: 'STOCK' }),
      contract('US500USDT', { underlyingType: 'INDEX' }),
      contract('BTCDOMUSDT', { contractType: 'PERPETUAL', underlyingType: 'INDEX' }),
      contract('BTCUSDT', { contractType: 'PERPETUAL', underlyingType: 'COIN' }),
      contract('MISLEADINGUSDT', { contractType: 'TRADFI_PERPETUAL' }),
      contract('XAUUSD1', { quoteAsset: 'USD1', marginAsset: 'USD1' }),
      contract('WRONGQUOTEUSDT', { quoteAsset: 'USD1' }),
      contract('WRONGMARGINUSDT', { marginAsset: 'USD1' }),
      contract('PRELAUNCHUSDT', { status: 'PENDING_TRADING' }),
      contract('DELISTEDUSDT', { status: 'CLOSE' }),
    ] })).toEqual(['XAUUSDT', 'TSLAUSDT', 'US500USDT'])
  })

  test('deduplicates in exchange listing order and never substitutes crypto for an empty TradFi list', () => {
    expect(parseTradfiSymbols({ symbols: [
      contract('XAUUSDT'), contract('XAGUSDT'), contract('XAUUSDT'), contract('TSLAUSDT'),
    ] })).toEqual(['XAUUSDT', 'XAGUSDT', 'TSLAUSDT'])
    expect(parseTradfiSymbols({ symbols: [] })).toEqual([])
    expect(parseTradfiSymbols({ symbols: [contract('BTCDOMUSDT', { contractType: 'PERPETUAL', underlyingType: 'INDEX' })] })).toEqual([])
  })

  test.each([undefined, null, [], false, {}, { symbols: null }, { symbols: {} }].map((raw) => ({ raw })))(
    'rejects malformed exchange-info containers ($raw)', ({ raw }) => {
      expect(() => parseTradfiSymbols(raw)).toThrow('Invalid Binance market list')
    },
  )

  test.each([null, false, 17, 'XAUUSDT'].map((entry) => ({ entry })))(
    'rejects malformed contract metadata ($entry)', ({ entry }) => {
      expect(() => parseTradfiSymbols({ symbols: [entry] })).toThrow('Invalid Binance contract metadata')
    },
  )

  test.each([undefined, 42, 'xauusdt', 'XAUUSDT ', 'XAU/USDT', 'XAUUSD1'].map((symbol) => ({ symbol })))(
    'rejects invalid symbols on otherwise eligible TradFi contracts ($symbol)', ({ symbol }) => {
      expect(() => parseTradfiSymbols({ symbols: [contract(symbol)] })).toThrow('Invalid Binance TradFi symbol')
    },
  )
})

describe('market symbol loading', () => {
  test('Spot uses the existing watchlist without requesting exchange metadata', async () => {
    const fetcher = mock(async () => { throw new Error('Unexpected network request') })
    expect(await fetchMarketSymbols('spot', undefined, fetcher as typeof fetch)).toBe(SYMBOLS)
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('TradFi requests futures exchangeInfo exactly once and forwards cancellation', async () => {
    const controller = new AbortController()
    const fetcher = mock(async () => jsonResponse({ symbols: [contract('XAUUSDT'), contract('TSLAUSDT')] }))

    expect(await fetchMarketSymbols('tradfi', controller.signal, fetcher as typeof fetch)).toEqual(['XAUUSDT', 'TSLAUSDT'])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('https://fapi.binance.com/fapi/v1/exchangeInfo', { signal: controller.signal })
  })

  test.each(['spot', 'tradfi'] as const)('an already aborted %s discovery never requests data', async (market) => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = mock(async () => jsonResponse({ symbols: [contract('XAUUSDT')] }))

    await expect(fetchMarketSymbols(market, controller.signal, fetcher as typeof fetch)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('discarding an in-flight discovery remains safe when the transport still resolves', async () => {
    const controller = new AbortController()
    const fetcher = mock(async () => {
      controller.abort()
      return jsonResponse({ symbols: [contract('XAUUSDT')] })
    })

    await expect(fetchMarketSymbols('tradfi', controller.signal, fetcher as typeof fetch)).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('HTTP failures report their status and never fall back to Spot symbols', async () => {
    const fetcher = mock(async () => jsonResponse({ symbols: [contract('XAUUSDT')] }, 451))
    await expect(fetchMarketSymbols('tradfi', undefined, fetcher as typeof fetch)).rejects.toThrow('Binance market list unavailable (HTTP 451)')
  })

  test('transport and malformed responses remain discovery failures', async () => {
    const offline = mock(async () => { throw new Error('Offline') })
    await expect(fetchMarketSymbols('tradfi', undefined, offline as typeof fetch)).rejects.toThrow('Offline')
    const malformed = mock(async () => jsonResponse({ symbols: 'XAUUSDT' }))
    await expect(fetchMarketSymbols('tradfi', undefined, malformed as typeof fetch)).rejects.toThrow('Invalid Binance market list')
    const invalidJson = mock(async () => new Response('{'))
    await expect(fetchMarketSymbols('tradfi', undefined, invalidJson as typeof fetch)).rejects.toBeInstanceOf(SyntaxError)
  })
})

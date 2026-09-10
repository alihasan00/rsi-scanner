import { describe, expect, test } from 'bun:test'
import {
  createSrContextRestClient, parseSrDailyHistory, SR_DAILY_HISTORY_LIMIT, SR_DAY_MS, SrContextRequestError,
} from '../src/lib/srContextRest'

function row(day: number) {
  return [day * SR_DAY_MS, '100', '110', '90', '105', '12', (day + 1) * SR_DAY_MS - 1]
}

describe('daily calendar history', () => {
  test('uses exchange time to close a Friday tail even without a later session', () => {
    const history = parseSrDailyHistory([row(1), row(2), row(3)], 6 * SR_DAY_MS)
    expect(history.candles).toHaveLength(3)
    expect(history.preview).toBeNull()
    expect(history.asOf).toBe(6 * SR_DAY_MS)
  })

  test('keeps forming data separate, retains real gaps, and ignores a response that crosses the clock cutoff', () => {
    const history = parseSrDailyHistory([row(1), row(3), row(4)], 3 * SR_DAY_MS + 1000)
    expect(history.candles.map((candle) => candle.openTime)).toEqual([SR_DAY_MS])
    expect(history.preview?.openTime).toBe(3 * SR_DAY_MS)
    const atClose = parseSrDailyHistory([row(3)], 4 * SR_DAY_MS - 1)
    expect(atClose.candles).toHaveLength(0)
    expect(atClose.preview).not.toBeNull()
  })

  test('caps closed history and accepts short listings without fabricating candles', () => {
    const rows = Array.from({ length: SR_DAILY_HISTORY_LIMIT + 1 }, (_, index) => row(index))
    expect(parseSrDailyHistory(rows, 200 * SR_DAY_MS).candles).toHaveLength(SR_DAILY_HISTORY_LIMIT)
    expect(parseSrDailyHistory([], 200 * SR_DAY_MS).candles).toEqual([])
  })

  test('rejects malformed values, reordered days, duplicates, and the wrong interval', () => {
    for (const invalid of [
      [row(2), row(1)], [row(1), row(1)], [[0, '', '110', '90', '105', '12', SR_DAY_MS - 1]],
      [[0, '100', '110', '90', '105', null, SR_DAY_MS - 1]],
      [[0, '100', '110', '90', '105', '12', 59_999]],
      [[1, '100', '110', '90', '105', '12', SR_DAY_MS]],
    ]) expect(() => parseSrDailyHistory(invalid, 4 * SR_DAY_MS)).toThrow()
    expect(() => parseSrDailyHistory([row(0)], 0)).toThrow()
  })

  test.each([
    { market: 'spot' as const, base: 'https://api.binance.com/api/v3' },
    { market: 'tradfi' as const, base: 'https://fapi.binance.com/fapi/v1' },
  ])('shares the $market clock across seed requests and forwards cancellation', async ({ market, base }) => {
    const calls: { url: string; signal: AbortSignal | null | undefined }[] = []
    const controller = new AbortController()
    let now = 1000
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, signal: init?.signal })
      return new Response(JSON.stringify(url.endsWith('/time') ? { serverTime: 4 * SR_DAY_MS } : [row(1), row(3)]))
    }) as typeof fetch
    const client = createSrContextRestClient(market, controller.signal, fetcher, () => now)
    const results = await Promise.all([client.fetchSeed('XAUUSDT'), client.fetchSeed('XAGUSDT')])
    expect(calls.map((call) => call.url)).toEqual([
      `${base}/time`, `${base}/klines?symbol=XAUUSDT&interval=1d&limit=181`, `${base}/klines?symbol=XAGUSDT&interval=1d&limit=181`,
    ])
    expect(calls.every((call) => call.signal && !call.signal.aborted)).toBe(true)
    expect(results.every((result) => result.candles.length === 2 && result.preview === null)).toBe(true)
    now += 30_001
    await client.fetchSeed('XAUUSDT')
    expect(calls.filter((call) => call.url.endsWith('/time'))).toHaveLength(2)
    client.invalidateClock()
    await client.fetchSeed('XAUUSDT')
    expect(calls.filter((call) => call.url.endsWith('/time'))).toHaveLength(3)
    controller.abort()
    expect(calls.every((call) => call.signal?.aborted)).toBe(true)
    await expect(client.fetchSeed('XAUUSDT')).rejects.toThrow()
    expect(calls).toHaveLength(7)
  })

  test('exposes Retry-After and never retries a Futures failure on Spot', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(url)
      return new Response('Slow down', { status: 429, headers: { 'Retry-After': '12' } })
    }) as typeof fetch
    const client = createSrContextRestClient('tradfi', undefined, fetcher)
    const error = await client.fetchSeed('XAUUSDT').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(SrContextRequestError)
    expect(error).toMatchObject({ status: 429, retryAfterMs: 12_000 })
    expect(calls).toEqual(['https://fapi.binance.com/fapi/v1/time'])
  })

  test('expires a shared clock at UTC midnight so a recovered final does not stay provisional', async () => {
    let now = 1000
    let serverTime = 4 * SR_DAY_MS - 2000
    let clockRequests = 0
    const fetcher = (async (url: string) => {
      if (url.endsWith('/time')) {
        clockRequests += 1
        return new Response(JSON.stringify({ serverTime }))
      }
      return new Response(JSON.stringify([row(3), row(4)]))
    }) as typeof fetch
    const client = createSrContextRestClient('spot', undefined, fetcher, () => now)
    const before = await client.fetchSeed('BTCUSDT')
    expect(before.candles).toHaveLength(0)
    expect(before.preview?.openTime).toBe(3 * SR_DAY_MS)
    now = 2999
    await client.fetchSeed('ETHUSDT')
    expect(clockRequests).toBe(1)

    now = 3000
    serverTime = 4 * SR_DAY_MS + 1000
    const recovered = await client.fetchSeed('BTCUSDT')
    expect(clockRequests).toBe(2)
    expect(recovered.candles.at(-1)?.openTime).toBe(3 * SR_DAY_MS)
    expect(recovered.preview?.openTime).toBe(4 * SR_DAY_MS)
  })

  test('supports the Unicode Binance symbols in the configured market list', async () => {
    const calls: string[] = []
    const fetcher = (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify(url.endsWith('/time') ? { serverTime: 4 * SR_DAY_MS } : [row(3)]))
    }) as typeof fetch
    const client = createSrContextRestClient('spot', undefined, fetcher)
    await client.fetchSeed('币安人生USDT')
    expect(new URL(calls[1]).searchParams.get('symbol')).toBe('币安人生USDT')
  })
})

describe('bounded daily REST requests', () => {
  test('a hanging shared clock times out for all waiting symbols and can be retried', async () => {
    const signals: AbortSignal[] = []
    let clockRequests = 0
    const fetcher = ((url: string, init?: RequestInit) => {
      signals.push(init!.signal!)
      if (url.endsWith('/time')) {
        clockRequests += 1
        if (clockRequests === 1) return new Promise<Response>(() => undefined)
        return Promise.resolve(new Response(JSON.stringify({ serverTime: 4 * SR_DAY_MS })))
      }
      return Promise.resolve(new Response(JSON.stringify([row(3)])))
    }) as typeof fetch
    const client = createSrContextRestClient('spot', undefined, fetcher, Date.now, 10)
    const results = await Promise.allSettled([client.fetchSeed('BTCUSDT'), client.fetchSeed('ETHUSDT')])
    expect(clockRequests).toBe(1)
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ name: 'TimeoutError', message: 'Binance clock request timed out' })
    }
    expect(signals[0].aborted).toBe(true)
    expect((await client.fetchSeed('BTCUSDT')).candles).toHaveLength(1)
    expect(clockRequests).toBe(2)
  })

  test.each(['clock', 'daily history'] as const)('times out a stalled %s JSON body after the response headers arrived', async (stage) => {
    let stalledSignal: AbortSignal | null = null
    const fetcher = (async (url: string, init?: RequestInit) => {
      const clock = url.endsWith('/time')
      if ((stage === 'clock') === clock) {
        stalledSignal = init!.signal!
        const response = new Response('')
        response.json = () => new Promise<unknown>(() => undefined)
        return response
      }
      return new Response(JSON.stringify({ serverTime: 4 * SR_DAY_MS }))
    }) as typeof fetch
    const client = createSrContextRestClient('spot', undefined, fetcher, Date.now, 10)
    const error = await client.fetchSeed('BTCUSDT').catch((cause: unknown) => cause)
    expect(error).toMatchObject({ name: 'TimeoutError' })
    expect((error as Error).message).toContain(stage)
    expect(stalledSignal?.aborted).toBe(true)
  })

  test.each(['clock', 'daily history'] as const)('lifecycle cancellation immediately rejects a hanging %s request', async (stage) => {
    const controller = new AbortController()
    let stalledSignal: AbortSignal | null = null
    let ready!: () => void
    const started = new Promise<void>((resolve) => { ready = resolve })
    const fetcher = (async (url: string, init?: RequestInit) => {
      const clock = url.endsWith('/time')
      if ((stage === 'clock') === clock) {
        stalledSignal = init!.signal!
        ready()
        return new Promise<Response>(() => undefined)
      }
      return new Response(JSON.stringify({ serverTime: 4 * SR_DAY_MS }))
    }) as typeof fetch
    const client = createSrContextRestClient('tradfi', controller.signal, fetcher)
    const result = client.fetchSeed('XAUUSDT').catch((cause: unknown) => cause)
    await started
    const reason = new DOMException('Market changed', 'AbortError')
    controller.abort(reason)
    expect(await result).toBe(reason)
    expect(stalledSignal?.aborted).toBe(true)
  })
})

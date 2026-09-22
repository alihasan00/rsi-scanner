import { describe, expect, test } from 'bun:test'
import { defaultHigherTimeframe, fetchHigherTimeframeContext, higherTimeframeChoices } from '../src/lib/higherTimeframe'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import type { Timeframe } from '../src/types'

const HOUR = 3_600_000
const request = { symbol: 'XAUUSDT', market: 'tradfi' as const, timeframe: '1h' as const }
function exchange(serverTime = 300 * HOUR + 1000, total = 301) {
  const urls: URL[] = []
  const fetcher = (async (input, init) => {
    init?.signal?.throwIfAborted()
    const url = new URL(String(input)); urls.push(url)
    if (url.pathname.endsWith('/time')) return Response.json({ serverTime })
    const end = Math.min(total - 1, Math.floor(Number(url.searchParams.get('endTime')) / HOUR))
    const start = Math.max(0, end - Number(url.searchParams.get('limit')) + 1)
    return Response.json(Array.from({ length: Math.max(0, end - start + 1) }, (_, offset) => {
      const index = start + offset
      return [index * HOUR, '100', '120', '90', String(105 + index % 5), '1000', (index + 1) * HOUR - 1]
    }))
  }) as typeof fetch
  return { urls, fetcher }
}
describe('completed higher timeframe history', () => {
  test('defaults and selectable choices are strictly higher, with an explicit highest-interval state', () => {
    for (const frame of Object.keys(TIMEFRAME_MILLISECONDS) as Timeframe[]) {
      const selected = defaultHigherTimeframe(frame)
      if (selected) expect(TIMEFRAME_MILLISECONDS[selected]).toBeGreaterThan(TIMEFRAME_MILLISECONDS[frame])
      for (const candidate of higherTimeframeChoices(frame)) expect(TIMEFRAME_MILLISECONDS[candidate]).toBeGreaterThan(TIMEFRAME_MILLISECONDS[frame])
    }
    expect(defaultHigherTimeframe('15m')).toBe('4h')
    expect(defaultHigherTimeframe('1w')).toBeNull()
    expect(higherTimeframeChoices('1w')).toEqual([])
  })
  test('uses Futures clock/history and excludes the open HTF candle before RSI calculation', async () => {
    const { urls, fetcher } = exchange()
    const snapshot = await fetchHigherTimeframeContext(request, fetcher)
    expect(snapshot.market).toBe('tradfi')
    expect(snapshot.bars.at(-1)!.closeTime).toBe(300 * HOUR - 1)
    expect(snapshot.bars.every((bar) => bar.isClosed && bar.closeTime < snapshot.checkedAt)).toBe(true)
    expect(urls.every((url) => url.origin === 'https://fapi.binance.com')).toBe(true)
    expect(urls.filter((url) => url.pathname.endsWith('/klines')).every((url) => url.searchParams.get('interval') === '1h' && url.searchParams.get('symbol') === 'XAUUSDT')).toBe(true)
  })
  test('rejects delayed history and insufficient RSI warmup', async () => {
    await expect(fetchHigherTimeframeContext(request, exchange(305 * HOUR, 300).fetcher)).rejects.toThrow('delayed')
    await expect(fetchHigherTimeframeContext(request, exchange(10 * HOUR, 10).fetcher)).rejects.toThrow('Not enough')
  })
  test('cancellation before loading makes no requests', async () => {
    const { urls, fetcher } = exchange()
    const controller = new AbortController(); controller.abort()
    await expect(fetchHigherTimeframeContext({ ...request, signal: controller.signal }, fetcher)).rejects.toThrow()
    expect(urls).toHaveLength(0)
  })
  test('cancellation after the response cannot publish stale context', async () => {
    const controller = new AbortController()
    const base = exchange().fetcher
    const fetcher = (async (input, init) => {
      const response = await base(input, init)
      if (String(input).includes('/klines')) controller.abort()
      return response
    }) as typeof fetch
    await expect(fetchHigherTimeframeContext({ ...request, signal: controller.signal }, fetcher)).rejects.toThrow()
  })
})

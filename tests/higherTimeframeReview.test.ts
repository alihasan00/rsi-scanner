import { describe, expect, test } from 'bun:test'
import { fetchHigherTimeframeContext } from '../src/lib/higherTimeframe'

const HOUR = 3_600_000
function exchangeWithGap(gapAt: number) {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/time')) return Response.json({ serverTime: 300 * HOUR + 1000 })
    const end = Math.floor(Number(url.searchParams.get('endTime')) / HOUR)
    const count = Number(url.searchParams.get('limit'))
    const indices = Array.from({ length: Math.max(0, end + 1) }, (_, index) => index).filter((index) => index !== gapAt).slice(-count)
    return Response.json(indices.map((index) => [index * HOUR, '110', '120', '90', String(110 + index % 3), '1000', (index + 1) * HOUR - 1]))
  }) as typeof fetch
}

describe('higher-timeframe gap review', () => {
  test('a sufficiently long latest suffix warms up after an older missing session', async () => {
    const snapshot = await fetchHigherTimeframeContext({ symbol: 'XAUUSDT', market: 'tradfi', timeframe: '1h' }, exchangeWithGap(200))
    expect(snapshot.bars[0].openTime).toBe(215 * HOUR)
    expect(snapshot.bars.at(-1)!.closeTime).toBe(300 * HOUR - 1)
    expect(snapshot.bars.every((bar) => Number.isFinite(bar.rsi))).toBe(true)
  })

  test('a recent gap keeps HTF RSI unavailable until its own suffix is warmed', async () => {
    await expect(fetchHigherTimeframeContext({ symbol: 'XAUUSDT', market: 'tradfi', timeframe: '1h' }, exchangeWithGap(290))).rejects.toThrow('Not enough completed')
  })
})

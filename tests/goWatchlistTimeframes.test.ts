import { expect, test } from 'bun:test'
import { getGoWatchlistTimeframes, getGoWatchlistExpectedClose } from '../src/lib/goWatchlistTimeframes'

test('paper Watchlist fetches daily and four-hour sources while Ichimoku keeps its selected source', () => {
  expect(getGoWatchlistTimeframes('all', '1w')).toEqual(['1d', '4h'])
  expect(getGoWatchlistTimeframes('ichimoku', '1w')).toEqual(['1w'])
  expect(getGoWatchlistTimeframes('ichimoku', '30m')).toEqual(['30m'])
  expect(getGoWatchlistTimeframes('ichimoku', '15m')).toEqual(['15m'])
  expect(getGoWatchlistTimeframes('ichimoku', '1m')).toEqual(['1m'])
})

test('weekly and three-day freshness respect exchange boundaries and the five-second delivery grace', () => {
  const last = Date.parse('2026-09-27T23:59:59.999Z')
  const monday = Date.parse('2026-10-05T00:00:00Z')
  expect(getGoWatchlistExpectedClose(monday + 4_999, '1w', last)).toBe(last)
  expect(getGoWatchlistExpectedClose(monday + 5_000, '1w', last)).toBe(monday - 1)
  const thirdDay = Date.parse('2026-10-01T00:00:00Z')
  expect(getGoWatchlistExpectedClose(thirdDay + 4_999, '3d', last)).toBe(last)
  expect(getGoWatchlistExpectedClose(thirdDay + 5_000, '3d', last)).toBe(thirdDay - 1)
})

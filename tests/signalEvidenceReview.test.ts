import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import type { LiquidityLevel } from '../src/lib/liquidityLevels'
import type { HigherTimeframeSnapshot } from '../src/lib/higherTimeframe'
import { analyzeSignalEvidence } from '../src/lib/signalEvidence'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const START = Date.parse('2026-09-10T00:00:00Z')
const identity = { symbol: 'BTCUSDT', market: 'spot' as const, timeframe: '1m' as const }
function minute(index: number, patch: Partial<RsiBar> = {}): RsiBar {
  return { openTime: START + index * MINUTE, closeTime: START + (index + 1) * MINUTE - 1, open: 109, close: 110, high: 115, low: 105, volume: 100, rsi: 50, isClosed: true, ...patch }
}
function hourly(index: number, patch: Partial<RsiBar> = {}): RsiBar {
  return minute(index * 60, { closeTime: START + (index + 1) * HOUR - 1, rsi: 60, ...patch })
}

describe('evidence review regressions', () => {
  test('the replay clock cannot be advanced by a future calendar map timestamp', () => {
    const weekly: LiquidityLevel = { id: 'week-low', label: 'Weekly low', source: 'week', price: 100, periodStart: Date.parse('2026-08-31'), periodEnd: Date.parse('2026-09-07'), availableFrom: Date.parse('2026-09-07') }
    const bars = [minute(0), minute(1, { low: 95 })]
    const earlierMap = { asOf: START, levels: [weekly], warnings: [] }
    const futureMap = { ...earlierMap, asOf: Date.parse('2026-09-22') }
    const earlier = analyzeSignalEvidence({ ...identity, bars, calendarMap: earlierMap })
    const later = analyzeSignalEvidence({ ...identity, bars: [...bars, minute(2)], asOf: bars[1].closeTime, calendarMap: futureMap })
    expect(later.items.filter((item) => item.source === 'Calendar sweep')).toEqual(earlier.items.filter((item) => item.source === 'Calendar sweep'))
    expect(later.items.filter((item) => item.source === 'Calendar sweep')).toHaveLength(1)
  })

  test('rebasing the calendar clock cannot publish future levels', () => {
    const future: LiquidityLevel = { id: 'next-week', label: 'Weekly low', source: 'week', price: 100, periodStart: Date.parse('2026-09-07'), periodEnd: Date.parse('2026-09-14'), availableFrom: Date.parse('2026-09-14') }
    const result = analyzeSignalEvidence({ ...identity, bars: [minute(0), minute(1, { low: 95 })], calendarMap: { asOf: Date.parse('2026-09-22'), levels: [future], warnings: [] } })
    expect(result.items.some((item) => item.source === 'Calendar sweep')).toBe(false)
  })

  test.each([NaN, Infinity, -1, 101])('invalid completed HTF RSI %s cannot become directional evidence', (rsi) => {
    const bars = Array.from({ length: 150 }, (_, index) => minute(index))
    const snapshot: HigherTimeframeSnapshot = { ...identity, timeframe: '1h', checkedAt: bars.at(-1)!.closeTime + 1, bars: [hourly(0), hourly(1, { rsi })] }
    const result = analyzeSignalEvidence({ ...identity, bars, higherTimeframe: snapshot })
    expect(result.items.filter((item) => item.family === 'higher-timeframe')).toEqual([])
  })

  test('actual HTF candle intervals must match the snapshot label', () => {
    const bars = Array.from({ length: 90 }, (_, index) => minute(index))
    const result = analyzeSignalEvidence({ ...identity, bars, higherTimeframe: { ...identity, timeframe: '1h', checkedAt: bars.at(-1)!.closeTime + 1, bars: [minute(89, { rsi: 60 })] } })
    expect(result.items.filter((item) => item.family === 'higher-timeframe')).toEqual([])
  })

  test('an invalid future HTF candle does not affect the earlier observation', () => {
    const bars = Array.from({ length: 90 }, (_, index) => minute(index))
    const snapshot: HigherTimeframeSnapshot = { ...identity, timeframe: '1h', checkedAt: bars.at(-1)!.closeTime + 1, bars: [hourly(0), hourly(1, { rsi: NaN })] }
    const result = analyzeSignalEvidence({ ...identity, bars, higherTimeframe: snapshot })
    expect(result.items.filter((item) => item.family === 'higher-timeframe')).toHaveLength(1)
    expect(result.items.find((item) => item.family === 'higher-timeframe')?.direction).toBe('bullish')
  })
})

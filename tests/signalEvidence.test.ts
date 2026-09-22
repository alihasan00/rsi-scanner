import { describe, expect, test } from 'bun:test'
import { analyzeSignalEvidence, summarizeEvidence } from '../src/lib/signalEvidence'
import type { SignalEvidence } from '../src/lib/signalEvidence'
import type { RsiBar } from '../src/types'
import type { LiquidityLevel } from '../src/lib/liquidityLevels'

const MINUTE = 60_000
const START = Date.parse('2026-09-10T00:00:00Z')
const request = { symbol: 'BTCUSDT', market: 'spot' as const, timeframe: '1m' as const }
function bar(index: number, rsi = 50, patch: Partial<RsiBar> = {}): RsiBar {
  return { openTime: START + index * MINUTE, closeTime: START + (index + 1) * MINUTE - 1, open: 110, close: 109, high: 115, low: 105, volume: 100, rsi, isClosed: true, ...patch }
}
function bullish() {
  const bars = [45, 44, 40, 38, 35, 20, 40, 45, 42, 40, 30].map((rsi, index) => bar(index, rsi))
  bars[5] = bar(5, 20, { open: 104, close: 102, low: 100 })
  bars[10] = bar(10, 30, { open: 98, close: 96, low: 95 })
  bars.push(bar(11, 35, { open: 95, close: 97, low: 94 }))
  return bars
}

describe('observable combined evidence', () => {
  test('confirmation becomes a trigger only at its confirmation close, never at the drawn pivot', () => {
    const bars = bullish()
    const before = analyzeSignalEvidence({ ...request, bars, asOf: bars[9].closeTime })
    expect(before.items.filter((item) => item.source === 'RSI divergence')).toHaveLength(0)
    const formed = analyzeSignalEvidence({ ...request, bars, asOf: bars[10].closeTime })
    expect(formed.items.find((item) => item.source === 'RSI divergence')).toMatchObject({ role: 'context', direction: 'bullish', availableAt: bars[10].closeTime })
    const confirmed = analyzeSignalEvidence({ ...request, bars })
    expect(confirmed.items.find((item) => item.source === 'RSI divergence')).toMatchObject({ role: 'trigger', availableAt: bars[11].closeTime, ageBars: 0 })
  })
  test('future resolutions and live candles cannot rewrite an earlier evidence snapshot', () => {
    const bars = bullish()
    const asOf = bars.at(-1)!.closeTime
    const expected = analyzeSignalEvidence({ ...request, bars })
    const future = [...bars, bar(12, 60), bar(13, 80), bar(14, 90, { isClosed: false })]
    expect(analyzeSignalEvidence({ ...request, bars: future, asOf })).toEqual(expected)
    expect(analyzeSignalEvidence({ ...request, bars: [...bars, bar(12, 60, { isClosed: false })] })).toEqual(expected)
  })
  test('interior missing evidence prevents a divergence from bridging the interruption', () => {
    const bars = bullish()
    bars[7] = { ...bars[7], isClosed: false }
    expect(analyzeSignalEvidence({ ...request, bars }).items.filter((item) => item.source === 'RSI divergence')).toEqual([])
  })
  test('groups correlated signals and exposes opposite direction evidence', () => {
    const item: SignalEvidence = { id: 'a', family: 'momentum', source: 'RSI', direction: 'bullish', role: 'trigger', availableAt: 10, ageBars: 0, detail: '', provenance: [] }
    const summary = summarizeEvidence([item, { ...item, id: 'b' }, { ...item, id: 'c', family: 'location', direction: 'bearish' }, { ...item, id: 'future', family: 'structure', availableAt: 11 }], 10)
    expect(summary.bullishFamilies).toEqual(['momentum'])
    expect(summary.bearishFamilies).toEqual(['location'])
    expect(summary.conflict).toBe(true)
    expect(summary.items).toHaveLength(3)
  })
  test('deduplicates coincident calendar sweeps and preserves their provenance', () => {
    const base: LiquidityLevel = { id: 'week', label: 'Weekly low', source: 'week', price: 100, periodStart: Date.parse('2026-08-31'), periodEnd: Date.parse('2026-09-07'), availableFrom: Date.parse('2026-09-07') }
    const monthly: LiquidityLevel = { ...base, id: 'month', label: 'Monthly low', source: 'month', periodStart: Date.parse('2026-08-01'), periodEnd: Date.parse('2026-09-01'), availableFrom: Date.parse('2026-09-01') }
    const bars = [bar(0), bar(1, 50, { low: 95 })]
    const result = analyzeSignalEvidence({ ...request, bars, calendarMap: { asOf: START, levels: [base, monthly, { ...base, id: 'unavailable', availableFrom: START + MINUTE * 100 }], warnings: [] } })
    const sweeps = result.items.filter((item) => item.source === 'Calendar sweep')
    expect(sweeps).toHaveLength(1)
    expect(sweeps[0].provenance).toEqual(['week', 'month'])
    expect(sweeps[0].availableAt).toBe(bars[1].closeTime)
  })
  test('higher-timeframe context uses only completed actual HTF candles of the same market and symbol', () => {
    const bars = Array.from({ length: 90 }, (_, index) => bar(index))
    const htf = { symbol: request.symbol, market: request.market, timeframe: '1h' as const, checkedAt: bars.at(-1)!.closeTime + 1, bars: [bar(0, 60, { closeTime: START + 60 * MINUTE - 1 }), bar(60, 10, { closeTime: START + 120 * MINUTE - 1 })] }
    const analyze = (patch = {}) => analyzeSignalEvidence({ ...request, bars, higherTimeframe: { ...htf, ...patch } })
    const evidence = analyze().items.filter((item) => item.family === 'higher-timeframe')
    expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({ direction: 'bullish', role: 'context', availableAt: htf.bars[0].closeTime })
    expect(analyze({ market: 'tradfi' }).items.filter((item) => item.family === 'higher-timeframe')).toEqual([])
    expect(analyze({ symbol: 'ETHUSDT' }).items.filter((item) => item.family === 'higher-timeframe')).toEqual([])
    expect(analyze({ timeframe: '1m' }).items.filter((item) => item.family === 'higher-timeframe')).toEqual([])
  })
  test('empty history reports missing context without manufacturing a direction', () => {
    const result = analyzeSignalEvidence({ ...request, bars: [] })
    expect(result.asOf).toBeNull()
    expect(result.items).toEqual([])
    expect(result.missing).toContain('Daily calendar context unavailable')
  })
})

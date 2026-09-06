import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import { RSI_LENGTH } from '../src/lib/rsi'
import { seedRsiHistory } from '../src/lib/rsiHistory'
import { findRsiDivergenceSetups } from '../src/lib/divergenceLifecycle'
import type { DivergenceSetup } from '../src/lib/divergenceLifecycle'
import {
  BACKTEST_WARMUP_CANDLES,
  backtestDisposition,
  backtestDivergenceHistory,
  buildHistoricalRsiBars,
  divergenceBacktestsToCsv,
  summarizeDivergenceSetups,
} from '../src/lib/divergenceBacktest'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'

const HOUR = TIMEFRAME_MILLISECONDS['1h']

function candle(index: number, close = 100 + Math.sin(index / 5) * 8 + Math.sin(index / 23) * 15): Candle {
  const open = 100 + Math.sin((index - 1) / 5) * 8 + Math.sin((index - 1) / 23) * 15
  return {
    openTime: index * HOUR, closeTime: (index + 1) * HOUR - 1,
    open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, volume: 5,
  }
}

function candles(count: number, start = 0): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(start + index))
}

function setup(patch: Partial<DivergenceSetup>): DivergenceSetup {
  return {
    id: 'regular-bullish:1:2', kind: 'regular-bullish',
    start: { time: 1, price: 100, rsi: 20 }, end: { time: 2, price: 90, rsi: 30 },
    state: 'forming', detectedAt: 10, confirmedAt: null, resolvedAt: null, confirmation: null,
    barsElapsed: 0, expiryBars: 14, invalidationAnchor: 'second', invalidationRsi: 30,
    resolutionReason: null, ...patch,
  }
}

describe('dispositions and summary', () => {
  test.each([
    [setup({ state: 'forming' }), 'still-open'],
    [setup({ state: 'confirmed', confirmedAt: 20 }), 'still-open'],
    [setup({ state: 'unconfirmed', resolvedAt: 20 }), 'unconfirmed'],
    [setup({ state: 'harmonised', resolvedAt: 20 }), 'preconfirmation-harmonised'],
    [setup({ state: 'harmonised', confirmedAt: 20, resolvedAt: 30 }), 'harmonised'],
    [setup({ state: 'expired', confirmedAt: 20, resolvedAt: 30 }), 'expired'],
    [setup({ state: 'completed', confirmedAt: 20, resolvedAt: 30 }), 'hit'],
    [setup({ state: 'completed', confirmedAt: 20, resolvedAt: 20 }), 'confirmation-target'],
    [setup({ state: 'interrupted', resolvedAt: 20 }), 'interrupted'],
    [setup({ state: 'expired', resolvedAt: 20 }), 'invalid-outcome'],
  ] as const)('classifies %o as %s', (given, expected) => {
    expect(backtestDisposition(given)).toBe(expected)
  })

  test('hit rate only divides post-confirmation outcomes', () => {
    const summary = summarizeDivergenceSetups([
      setup({ state: 'completed', confirmedAt: 20, resolvedAt: 30 }),
      setup({ state: 'completed', confirmedAt: 20, resolvedAt: 20 }),
      setup({ state: 'harmonised', confirmedAt: 20, resolvedAt: 30 }),
      setup({ state: 'harmonised', resolvedAt: 30 }),
      setup({ state: 'expired', confirmedAt: 20, resolvedAt: 30 }),
      setup({ state: 'unconfirmed', resolvedAt: 30 }),
      setup({ state: 'confirmed', confirmedAt: 20 }),
    ])
    expect(summary).toMatchObject({
      detected: 7, confirmed: 5, targetHits: 1, confirmedHarmonised: 1, expired: 1, denominator: 3,
      excluded: { stillOpen: 1, unconfirmed: 1, preconfirmationHarmonised: 1, confirmationTarget: 1, interrupted: 0, invalidOutcome: 0 },
    })
    expect(summary.targetHitRate).toBeCloseTo(1 / 3)
    expect(summarizeDivergenceSetups([]).targetHitRate).toBeNull()
  })
})

describe('historical RSI bars', () => {
  test('matches the live seed path and marks warmup and gaps', () => {
    const input = candles(400)
    const { bars, warmedUpCloseTimes, gaps } = buildHistoricalRsiBars(input)
    expect(bars).toHaveLength(400)
    expect(bars.slice(0, RSI_LENGTH).every((bar) => Number.isNaN(bar.rsi))).toBe(true)
    const reference = seedRsiHistory(input)!.closedBars
    expect(bars.slice(RSI_LENGTH).map((bar) => bar.rsi)).toEqual(reference.map((bar) => bar.rsi))
    expect(gaps).toBe(0)
    expect(warmedUpCloseTimes.size).toBe(400 - BACKTEST_WARMUP_CANDLES)
    expect(warmedUpCloseTimes.has(input[BACKTEST_WARMUP_CANDLES - 1].closeTime)).toBe(false)
    expect(warmedUpCloseTimes.has(input[BACKTEST_WARMUP_CANDLES].closeTime)).toBe(true)
  })

  test('restarts RSI and warmup after a gap and rejects disorder', () => {
    const input = [...candles(300), ...candles(300, 400)]
    const { bars, warmedUpCloseTimes, gaps } = buildHistoricalRsiBars(input)
    expect(gaps).toBe(1)
    expect(Number.isNaN(bars[300].rsi)).toBe(true)
    expect(warmedUpCloseTimes.size).toBe(2 * (300 - BACKTEST_WARMUP_CANDLES))
    expect(() => buildHistoricalRsiBars([candle(1), candle(0)])).toThrow('ordered')
    expect(() => buildHistoricalRsiBars([candle(0), { ...candle(1), close: Number.NaN }])).toThrow('Invalid')
  })
})

describe('backtestDivergenceHistory', () => {
  const request = { symbol: 'BTCUSDT', timeframe: '1h' as const, sampleCandles: 500 }

  test('evaluates only setups detected after warmup inside the sample and reuses the live engine', () => {
    const input = candles(800)
    const report = backtestDivergenceHistory(input, request)
    const { bars } = buildHistoricalRsiBars(input)
    const expected = findRsiDivergenceSetups(bars, report.settings)
      .filter((s) => s.detectedAt >= input[300].closeTime && s.detectedAt <= input[799].closeTime)
    expect(report.setups.map((s) => s.id)).toEqual(expected.map((s) => s.id))
    expect(report.setups.length).toBeGreaterThan(0)
    expect(report.window).toMatchObject({
      loadedCandles: 800, sampleCandles: 500, evaluatedCandles: 500, warmupCandles: BACKTEST_WARMUP_CANDLES,
      startTime: input[300].openTime, endTime: input[799].closeTime, gaps: 0,
    })
    expect(report.source).toMatchObject({ kind: 'offline', complete: true, asOf: input[799].closeTime })
    expect(report.summary).toEqual(summarizeDivergenceSetups(report.setups))
    const kinds = Object.values(report.byKind)
    expect(kinds.reduce((sum, summary) => sum + summary.detected, 0)).toBe(report.summary.detected)
    expect(report.setups.every((s) => s.detectedAt >= input[BACKTEST_WARMUP_CANDLES].closeTime)).toBe(true)
    expect(report.candles).toEqual(input)
  })

  test('honours endTime as a snapshot boundary and warns on short history', () => {
    const input = candles(800)
    const report = backtestDivergenceHistory(input, { ...request, endTime: input[600].closeTime })
    expect(report.window.loadedCandles).toBe(601)
    expect(report.source.asOf).toBe(input[600].closeTime)
    expect(report.setups.every((s) => s.detectedAt <= input[600].closeTime)).toBe(true)
    const short = backtestDivergenceHistory(candles(300), request)
    expect(short.source.complete).toBe(false)
    expect(short.source.warnings.join(' ')).toContain('300 closed candles')
    expect(backtestDivergenceHistory(candles(100), request).source.warnings.join(' ')).toContain('No candles remain')
  })

  test('rejects interval mismatches and invalid options', () => {
    expect(() => backtestDivergenceHistory(candles(50), { ...request, timeframe: '4h' })).toThrow('interval')
    expect(() => backtestDivergenceHistory([], { ...request, sampleCandles: 0 })).toThrow(RangeError)
    expect(() => backtestDivergenceHistory([], { ...request, options: { expiryBars: 0 } })).toThrow(RangeError)
    expect(() => backtestDivergenceHistory([], { ...request, startTime: 10, endTime: 5 })).toThrow(RangeError)
  })

  test('CSV export has a summary row per report plus one row per setup, with quoting', () => {
    const report = backtestDivergenceHistory(candles(800), request)
    const empty = backtestDivergenceHistory(candles(100), { ...request, symbol: 'ETHUSDT' })
    const csv = divergenceBacktestsToCsv([report, empty])
    const lines = csv.trimEnd().split('\n')
    expect(lines).toHaveLength(1 + 2 + report.setups.length)
    expect(lines[0].startsWith('record_type,symbol,timeframe')).toBe(true)
    expect(lines.filter((line) => line.startsWith('summary,')).map((line) => line.split(',')[1])).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(lines[1]).toContain('"{""leftBars"":5')
    expect(lines.filter((line) => line.startsWith('setup,'))).toHaveLength(report.setups.length)
  })
})

import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import {
  defaultResearchExecution, evaluateStrategyResearch, RESEARCH_CANDIDATES, researchWindows,
  runStrategyResearch, selectResearchCandidate, simulateResearchSignals, strategyResearchToCsv, summarizeResearch,
} from '../src/lib/strategyResearch'
import type { ResearchExecution, ResearchSignal, ResearchWindow } from '../src/lib/strategyResearch'

const HOUR = 3_600_000
function bar(index: number, patch: Partial<Candle> = {}): Candle {
  return { openTime: index * HOUR, closeTime: (index + 1) * HOUR - 1, open: 100, high: 102, low: 99, close: 101, volume: 10, ...patch }
}
const candles = (count = 20) => Array.from({ length: count }, (_, index) => bar(index))
const window = (endIndex = 19): ResearchWindow => ({ partition: 'training', startIndex: 0, endIndex, startTime: 0, endTime: (endIndex + 1) * HOUR - 1, candleCount: endIndex + 1 })
const execution: ResearchExecution = { ...defaultResearchExecution('spot'), stopAtr: 1, targetAtr: 2, maxHoldingBars: 3, forwardBars: 2, feeBps: 0, slippageBps: 0 }
const signal = (confirmedIndex = 1, patch: Partial<ResearchSignal> = {}): ResearchSignal => ({
  id: `signal-${confirmedIndex}`, candidateId: 'test', symbol: 'BTCUSDT', timeframe: '1h', market: 'spot',
  confirmedIndex, confirmedAt: (confirmedIndex + 1) * HOUR - 1, direction: 'bullish', atr: 5, ...patch,
})
const simulate = (input: Candle[], signals: ResearchSignal[] = [signal()], settings = execution, bounds = window(input.length - 1)) => simulateResearchSignals(input, signals, bounds, settings, 'test')

describe('causal price execution and observations', () => {
  test('enters only at the next open and ignores the confirmation bar extremes', () => {
    const input = candles()
    input[1] = bar(1, { high: 200, low: 50 })
    input[2] = bar(2, { open: 120, high: 121, low: 119, close: 120 })
    input[3] = bar(3, { open: 120, high: 131, low: 119, close: 130 })
    const result = simulate(input)
    expect(result.trades[0]).toMatchObject({ entryTime: 2 * HOUR, entryPrice: 120, exitIndex: 3, exitPrice: 130, reason: 'target', stopPrice: 115, targetPrice: 130 })
    expect(result.observations[0].forwardReturn).toBeCloseTo(130 / 120 - 1)
    expect(result.observations[0].mfe).toBeCloseTo(131 / 120 - 1)
    expect(result.observations[0].mae).toBeCloseTo(119 / 120 - 1)
  })

  test('stop wins ambiguous same-bar stop and target touches, including entry bar', () => {
    const input = candles()
    input[2] = bar(2, { high: 120, low: 80 })
    expect(simulate(input).trades[0]).toMatchObject({ exitIndex: 2, reason: 'stop', exitPrice: 95, grossReturn: -0.050000000000000044 })
  })

  test('fills adverse stop gaps at the open and favorable target gaps at the resting target', () => {
    const input = candles()
    input[3] = bar(3, { open: 90, high: 94, low: 85, close: 91 })
    expect(simulate(input).trades[0]).toMatchObject({ exitIndex: 3, reason: 'stop', exitPrice: 90 })
    input[3] = bar(3, { open: 115, high: 120, low: 90, close: 100 })
    expect(simulate(input).trades[0]).toMatchObject({ exitIndex: 3, reason: 'target', exitPrice: 110 })
  })

  test('charges both executed notionals, adverse slippage, and the holding period carry', () => {
    const input = candles()
    const result = simulate(input, [signal()], { ...execution, feeBps: 10, slippageBps: 20, carryingBpsPerDay: 24 })
    const trade = result.trades[0]
    expect(trade).toMatchObject({ reason: 'time-stop', entryIndex: 2, exitIndex: 4 })
    const entry = 100 * 1.002
    const exit = 101 * 0.998
    const fee = 0.001 * (1 + exit / entry)
    const carry = 24 / 10_000 * 3 / 24
    expect(trade.entryPrice).toBe(entry)
    expect(trade.exitPrice).toBe(exit)
    expect(trade.fees).toBeCloseTo(fee, 12)
    expect(trade.carryingCost).toBeCloseTo(carry, 12)
    expect(trade.netReturn).toBeCloseTo(exit / entry - 1 - fee - carry, 12)
    expect(trade.slippage).toBeGreaterThan(0)
  })

  test('Futures shorts use symmetric directional outcomes; Spot never opens a short', () => {
    const input = candles()
    input[2] = bar(2, { low: 89, close: 90 })
    const bearish = signal(1, { direction: 'bearish', market: 'tradfi' })
    const futures = simulate(input, [bearish])
    expect(futures.trades[0]).toMatchObject({ reason: 'target', exitPrice: 90, stopPrice: 105, targetPrice: 90, market: 'tradfi' })
    expect(futures.trades[0].netReturn).toBeCloseTo(0.1)
    const spot = simulate(input, [{ ...bearish, market: 'spot' }])
    expect(spot.trades).toHaveLength(0)
    expect(spot.observations).toHaveLength(1)
    expect(spot.excluded.spotShort).toBe(1)
  })

  test('suppresses overlapping trades, but permits a next-bar entry after an exit close', () => {
    const result = simulate(candles(), [signal(1), signal(2), signal(4)])
    expect(result.trades.map((trade) => trade.entryIndex)).toEqual([2, 5])
    expect(result.excluded.overlap).toBe(1)
    expect(result.observations).toHaveLength(3)
  })

  test('censors all boundary horizons instead of cherry-picking early exits', () => {
    const input = candles(4)
    input[2] = bar(2, { high: 130 })
    const result = simulate(input)
    expect(result.trades).toHaveLength(0)
    expect(result.observations).toHaveLength(0)
    expect(result.excluded.boundary).toBe(1)
  })

  test('does not trade through missing candles or zero ATR', () => {
    const input = candles()
    input.splice(3, 1)
    expect(simulate(input).excluded.gap).toBe(1)
    expect(simulate(candles(), [signal(1, { atr: 0 })]).excluded.atr).toBe(1)
    expect(simulate(candles(), [signal(1, { atr: null })]).trades).toHaveLength(0)
  })

  test('reports realized compounded equity and peak-to-trough drawdown', () => {
    const base = simulate(candles()).trades[0]
    const trades = [0.1, -0.2, 0.1].map((netReturn) => ({ ...base, netReturn }))
    const summary = summarizeResearch(trades, [])
    expect(summary.compoundedReturn).toBeCloseTo(1.1 * 0.8 * 1.1 - 1)
    expect(summary.maxDrawdown).toBeCloseTo(0.2)
    expect(summary.expectancy).toBeCloseTo(0)
    expect(summarizeResearch([], []).expectancy).toBeNull()
  })

  test('does not reopen an account after a gap loss depletes its equity', () => {
    const input = candles()
    input[3] = bar(3, { open: 250, high: 260, low: 240, close: 250 })
    const result = simulate(input, [signal(1, { market: 'tradfi', direction: 'bearish' }), signal(5, { market: 'tradfi' })])
    expect(result.trades[0].netReturn).toBeCloseTo(-1.5)
    expect(result.summary.compoundedReturn).toBe(-1)
    expect(result.excluded.insolvent).toBe(1)
    expect(result.trades).toHaveLength(1)
  })
})

function oscillating(count: number): Candle[] {
  const price = (index: number) => 100 + Math.sin(index / 5) * 8 + Math.sin(index / 23) * 15
  return Array.from({ length: count }, (_, index) => {
    const open = price(index - 1)
    const close = price(index)
    return bar(index, { open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1 })
  })
}
const request = { symbol: 'BTCUSDT', timeframe: '1h' as const, market: 'spot' as const, sampleCandles: 2_000, candidates: RESEARCH_CANDIDATES.slice(0, 3), minimumTrainingTrades: 1 }

describe('chronological research protocol', () => {
  test('partitions are disjoint and exclude a 250-candle warmup', () => {
    const windows = researchWindows(oscillating(1_250), 1_000)
    expect(windows.training).toMatchObject({ startIndex: 250, endIndex: 849, candleCount: 600 })
    expect(windows.validation).toMatchObject({ startIndex: 850, endIndex: 1049, candleCount: 200 })
    expect(windows.holdout).toMatchObject({ startIndex: 1050, endIndex: 1249, candleCount: 200 })
  })

  test('selection sees training only and falls back when there are insufficient trades', () => {
    const result = simulate(candles())
    const trained = ['baseline', 'candidate'].map((candidateId, index) => ({ ...result, candidateId, summary: { ...result.summary, trades: 12, expectancy: index ? 0.02 : -0.01 } }))
    expect(selectResearchCandidate(trained, 10, 'baseline')).toEqual({ candidateId: 'candidate', sufficientSample: true })
    expect(selectResearchCandidate(trained, 20, 'baseline')).toEqual({ candidateId: 'baseline', sufficientSample: false })
  })

  test('future validation/holdout prices cannot change training results or the frozen candidate', () => {
    const input = oscillating(2_250)
    const first = evaluateStrategyResearch(input, request)
    const futureStart = first.windows.validation.startIndex
    const changed = input.map((candle, index) => index < futureStart ? candle : { ...candle, open: candle.open * 1.5, high: candle.high * 1.5, low: candle.low * 1.5, close: candle.close * 1.5 })
    const second = evaluateStrategyResearch(changed, request)
    expect(second.results.map((result) => result.training)).toEqual(first.results.map((result) => result.training))
    expect(second.selection).toEqual(first.selection)
    expect(first.results.reduce((sum, result) => sum + result.training.summary.trades, 0)).toBeGreaterThan(0)
    for (const result of first.results) for (const partition of ['training', 'validation', 'holdout'] as const) {
      for (const trade of result[partition].trades) {
        expect(trade.entryTime).toBeGreaterThan(trade.confirmedAt)
        expect(trade.entryIndex).toBeGreaterThanOrEqual(result[partition].window.startIndex)
        expect(trade.exitIndex).toBeLessThanOrEqual(result[partition].window.endIndex)
        expect(trade.market).toBe('spot')
        expect(trade.timeframe).toBe('1h')
      }
    }
  })

  test('cost sensitivity uses the selected candidate and progressively lowers net returns', () => {
    const report = evaluateStrategyResearch(oscillating(2_250), { ...request, market: 'tradfi' })
    expect(report.costSensitivity.map((row) => row.multiplier)).toEqual([0, 1, 2])
    const results = report.costSensitivity.map((row) => row.evaluation)
    expect(results.every((row) => row.candidateId === report.selection.candidateId)).toBe(true)
    if (results[0].summary.trades) {
      expect(results[0].summary.expectancy!).toBeGreaterThan(results[1].summary.expectancy!)
      expect(results[1].summary.expectancy!).toBeGreaterThan(results[2].summary.expectancy!)
    }
    expect(report.source.warnings.join(' ')).toContain('Actual funding')
    expect(strategyResearchToCsv(report)).toContain('tradfi,BTCUSDT,1h,')
    expect(strategyResearchToCsv(report).trim().split('\n')).toHaveLength(1 + 3 * request.candidates.length)
  })

  test('retains insufficiency and missing history instead of inventing performance', () => {
    const report = evaluateStrategyResearch(oscillating(100), request)
    expect(report.selection.sufficientSample).toBe(false)
    expect(report.results.every((result) => result.holdout.summary.expectancy === null)).toBe(true)
    expect(report.source.complete).toBe(false)
    expect(report.source.warnings.join(' ')).toContain('Insufficient candles')
    expect(report.selection.candidateId).toBe('wilder-14')
  })

  test('applies snapshot boundaries and rejects invalid settings before running', () => {
    const input = oscillating(2_250)
    const report = evaluateStrategyResearch(input, { ...request, endTime: input[1000].closeTime })
    expect(report.candles.at(-1)?.closeTime).toBe(input[1000].closeTime)
    expect(() => evaluateStrategyResearch(input, { ...request, timeframe: '4h' })).toThrow('interval')
    expect(() => evaluateStrategyResearch(input, { ...request, execution: { maxHoldingBars: 2.5 } })).toThrow('integer')
    expect(() => evaluateStrategyResearch(input, { ...request, execution: { feeBps: -1 } })).toThrow('basis')
    expect(() => evaluateStrategyResearch(input, { ...request, candidates: [] })).toThrow('candidates')
    expect(() => evaluateStrategyResearch(input, { ...request, candidates: [RESEARCH_CANDIDATES[0], RESEARCH_CANDIDATES[0]] })).toThrow('uniquely')
  })

  test('fetches Futures history for research and honors cancellation', async () => {
    const calls: URL[] = []
    const input = oscillating(750)
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      calls.push(parsed)
      if (parsed.pathname.endsWith('/time')) return Response.json({ serverTime: 750 * HOUR })
      const cursor = Number(parsed.searchParams.get('endTime'))
      const count = Number(parsed.searchParams.get('limit'))
      return Response.json(input.filter((bar) => bar.openTime <= cursor).slice(-count)
        .map((bar) => [bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.closeTime]))
    }) as typeof fetch
    const report = await runStrategyResearch({ ...request, market: 'tradfi', sampleCandles: 500 }, fetcher)
    expect(report.market).toBe('tradfi')
    expect(calls.every((url) => url.origin === 'https://fapi.binance.com')).toBe(true)
    const controller = new AbortController()
    controller.abort()
    await expect(runStrategyResearch({ ...request, signal: controller.signal }, fetcher)).rejects.toThrow()
    const afterFetch = new AbortController()
    await expect(runStrategyResearch({
      ...request, sampleCandles: 500, signal: afterFetch.signal, onPhase: () => afterFetch.abort(),
    }, fetcher)).rejects.toThrow()
  })
})

import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import { evaluateHarmonicResearch, exportHarmonicResearchCsv, HARMONIC_RESEARCH_CANDIDATES, runHarmonicResearch } from '../src/lib/harmonicResearch'
import type { HarmonicResearchRequest } from '../src/lib/harmonicResearch'
import { analyzeVolatility } from '../src/lib/volatility'

const MINUTE = 60_000
const request: HarmonicResearchRequest = { symbol: 'BTCUSDT', timeframe: '1m', market: 'spot', sampleCandles: 1_000, minimumTrainingTrades: 1, execution: { maxHoldingBars: 5, forwardBars: 3 } }
function candle(index: number, price = 150, patch: Partial<Candle> = {}): Candle {
  return { openTime: index * MINUTE, closeTime: (index + 1) * MINUTE - 1, open: price, high: price, low: price, close: price, volume: 10, ...patch }
}
function history(count = 1_250): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(index, 150, { high: 151, low: 149 }))
}
/** An independent interpolated XABC fixture; D319 becomes a strict pivot at322. */
function inject(input: Candle[], start: number, bRatio = 0.618): void {
  const b = 200 - 100 * bRatio
  const c = b + (200 - b) * 0.618
  const anchors = [[0, 120], [3, 100], [7, 200], [11, b], [15, c], [18, c - (c - b) * 3 / 8]]
  for (let index = 0; index <= 18; index++) {
    const right = anchors.findIndex(([time]) => time >= index)
    const [endIndex, endPrice] = anchors[right]
    const [startIndex, startPrice] = anchors[Math.max(0, right - 1)]
    const price = endIndex === index ? endPrice : startPrice + (endPrice - startPrice) * (index - startIndex) / (endIndex - startIndex)
    input[start + index] = candle(start + index, price)
  }
  input[start + 19] = candle(start + 19, 123, { low: 118, high: 126 })
  input[start + 20] = candle(start + 20, 125, { low: 120, high: 128 })
  input[start + 21] = candle(start + 21, 126, { low: 121, high: 130 })
  input[start + 22] = candle(start + 22, 127, { low: 122, high: 132 })
}
const baseline = (report: ReturnType<typeof evaluateHarmonicResearch>) => report.results.find((result) => result.candidate.id === 'touch-baseline')!

describe('harmonic chronological event research', () => {
  test('retains first-observable events and completed trades long after 500 discovery candles', () => {
    const input = history()
    for (const start of [300, 900, 1100]) inject(input, start)
    const report = evaluateHarmonicResearch(input, request)
    const result = baseline(report)
    expect(result.training.summary.trades).toBeGreaterThan(0)
    expect(result.training.trades[0]).toMatchObject({ confirmedAt: input[319].closeTime, entryIndex: 320 })
    expect(result.validation.summary.trades).toBeGreaterThan(0)
    expect(result.holdout.summary.trades).toBeGreaterThan(0)
    expect(report.events.some((event) => event.candidateId === 'touch-baseline' && event.confirmedIndex === 319)).toBe(true)
    expect(report.events.filter((event) => event.candidateId === 'touch-baseline' && event.confirmedIndex === 319)).toHaveLength(1)
    expect(report.candles).toEqual(input)
  })

  test('a later failure cannot erase or rewrite the original observed touch', () => {
    const input = history()
    inject(input, 300)
    const completed = evaluateHarmonicResearch(input, request)
    const failedInput = structuredClone(input)
    failedInput[320] = candle(320, 100, { low: 95, high: 110 })
    const failed = evaluateHarmonicResearch(failedInput, request)
    const touch = (report: typeof failed) => report.events.find((event) => event.candidateId === 'touch-baseline' && event.confirmedIndex === 319)
    expect(touch(failed)).toEqual(touch(completed))
    expect(baseline(failed).training.signals).toBeGreaterThan(0)
    expect(baseline(failed).training.trades).toHaveLength(baseline(completed).training.trades.length)
  })

  test('contact before C confirmation cannot create an earlier entry', () => {
    const input = history()
    inject(input, 300)
    for (const index of [316, 317, 318]) input[index] = candle(index, 132, { low: index === 316 ? 124 : 130, high: 134 })
    const report = evaluateHarmonicResearch(input, request)
    const event = report.events.find((item) => item.candidateId === 'touch-baseline' && item.cTime === input[315].openTime)!
    expect(event.touchTime).toBe(input[316].openTime)
    expect(event.confirmedAt).toBe(input[318].closeTime)
    expect(event.confirmedAt).toBe(event.setupConfirmedAt)
    expect(baseline(report).training.trades.find((trade) => trade.signalId === event.id)?.entryTime).toBe(input[319].openTime)
  })

  test('D pivot entry waits for the third right-hand close and can precede no earlier confirmation', () => {
    const input = history()
    inject(input, 300)
    const report = evaluateHarmonicResearch(input, request)
    const event = report.events.find((item) => item.candidateId === 'confirmed-d' && item.dPivotTime === input[319].openTime)!
    expect(event).toBeDefined()
    expect(event.confirmedAt).toBe(input[322].closeTime)
    const pivot = report.results.find((result) => result.candidate.id === 'confirmed-d')!
    expect(pivot.training.trades.find((trade) => trade.signalId === event.id)?.entryTime).toBe(input[323].openTime)
    const changed = structuredClone(input)
    changed[321] = candle(321, 123, { low: 117, high: 130 })
    const second = evaluateHarmonicResearch(changed, request)
    expect(second.events.some((item) => item.candidateId === 'confirmed-d' && item.dPivotTime === input[319].openTime)).toBe(false)
    expect(second.events.find((item) => item.id === report.events.find((item) => item.candidateId === 'touch-baseline')!.id))
      .toEqual(report.events.find((item) => item.candidateId === 'touch-baseline'))
  })

  test('retains same-candle D confirmation and reference completion in the independent benchmark', () => {
    const input = history()
    inject(input, 300)
    input[322] = candle(322, 140, { low: 122, high: 145 })
    const report = evaluateHarmonicResearch(input, request)
    const event = report.events.find((item) => item.candidateId === 'confirmed-d' && item.dPivotTime === input[319].openTime)!
    expect(event).toMatchObject({ confirmedIndex: 322, statusAtEvent: 'completed' })
    expect(report.results.find((result) => result.candidate.id === 'confirmed-d')!.training.trades.some((trade) => trade.signalId === event.id)).toBe(true)
  })

  test('freezes ratio-fit filtering at contact without later D geometry', () => {
    const input = history()
    inject(input, 300)
    inject(input, 450, 0.557)
    const report = evaluateHarmonicResearch(input, request)
    const good = report.events.find((event) => event.candidateId === 'touch-baseline' && event.confirmedIndex === 319)!
    const weak = report.events.find((event) => event.candidateId === 'touch-baseline' && event.confirmedIndex === 469)!
    expect(good.ratioFit).toBeCloseTo(100)
    expect(weak.ratioFit).toBeLessThan(80)
    expect(report.events.some((event) => event.candidateId === 'touch-quality-80' && event.setupId === good.setupId)).toBe(true)
    expect(report.events.some((event) => event.candidateId === 'touch-quality-80' && event.setupId === weak.setupId)).toBe(false)
  })

  test('proportional expiry is replayed independently and excludes an overdue first touch', () => {
    const input = history()
    inject(input, 300)
    for (let index = 319; index < 340; index++) input[index] = candle(index, 150)
    input[340] = candle(340, 123, { low: 118, high: 126 })
    const report = evaluateHarmonicResearch(input, request)
    const event = report.events.find((item) => item.candidateId === 'touch-baseline' && item.confirmedIndex === 340)!
    expect(event).toBeDefined()
    expect(report.events.some((item) => item.candidateId === 'touch-proportional' && item.setupId === event.setupId)).toBe(false)
  })

  test('all ATR values use only the event-close prefix', () => {
    const input = history()
    inject(input, 300)
    const report = evaluateHarmonicResearch(input, request)
    for (const event of report.events) {
      const expected = analyzeVolatility(input.slice(0, event.confirmedIndex + 1).map((bar) => ({ ...bar, rsi: 50, isClosed: true }))).atr
      expect(event.atr).toBeCloseTo(expected!, 12)
      expect(event.confirmedAt).toBeGreaterThanOrEqual(event.setupConfirmedAt)
      expect(event.confirmedAt).toBeGreaterThanOrEqual(event.touchTime + MINUTE - 1)
    }
    const event = report.events.find((item) => item.candidateId === 'touch-baseline')!
    const changed = input.map((bar, index) => index <= event.confirmedIndex ? bar : { ...bar, high: bar.high * 2, low: bar.low / 2 })
    expect(evaluateHarmonicResearch(changed, request).events.find((item) => item.id === event.id)).toEqual(event)
  })

  test('future periods cannot change training or frozen selection; horizons stay within their partition', () => {
    const input = history()
    for (const start of [300, 900, 1100]) inject(input, start)
    const first = evaluateHarmonicResearch(input, request)
    const changed = input.map((bar, index) => index < first.windows.validation.startIndex ? bar : { ...bar, open: bar.open * 1.5, high: bar.high * 1.5, low: bar.low * 1.5, close: bar.close * 1.5 })
    const second = evaluateHarmonicResearch(changed, request)
    expect(second.results.map((result) => result.training)).toEqual(first.results.map((result) => result.training))
    expect(second.selection).toEqual(first.selection)
    for (const result of first.results) for (const partition of ['training', 'validation', 'holdout'] as const) {
      const evaluation = result[partition]
      for (const trade of evaluation.trades) {
        expect(trade.entryTime).toBeGreaterThan(trade.confirmedAt)
        expect(trade.entryIndex).toBeGreaterThanOrEqual(evaluation.window.startIndex)
        expect(trade.exitIndex).toBeLessThanOrEqual(evaluation.window.endIndex)
      }
    }
  })

  test('counts formation-boundary exclusion instead of trading a pattern started in another period', () => {
    const input = history()
    inject(input, 245)
    inject(input, 840)
    const result = baseline(evaluateHarmonicResearch(input, request))
    expect(result.training.eventExclusions.formationBoundary).toBeGreaterThan(0)
    expect(result.validation.eventExclusions.formationBoundary).toBeGreaterThan(0)
    expect(result.training.trades).toHaveLength(0)
    expect(result.validation.trades).toHaveLength(0)
  })

  test('gaps censor outcome horizons and restart detection warmup', () => {
    const input = history()
    inject(input, 300)
    const outcomeGap = structuredClone(input)
    outcomeGap.splice(320, 1)
    const gapReport = evaluateHarmonicResearch(outcomeGap, request)
    expect(baseline(gapReport).training.excluded.gap).toBeGreaterThan(0)
    expect(gapReport.source.complete).toBe(false)
    expect(gapReport.source.warnings.join(' ')).toContain('history gaps')
    const warmupGap = structuredClone(input)
    warmupGap.splice(270, 1)
    const warmupReport = evaluateHarmonicResearch(warmupGap, request)
    expect(baseline(warmupReport).training.eventExclusions.warmup).toBeGreaterThan(0)
    expect(baseline(warmupReport).training.trades).toHaveLength(0)
  })

  test('reports insufficient data and exports a repeatable frozen event snapshot', () => {
    const report = evaluateHarmonicResearch(history(100), request)
    expect(report.selection).toMatchObject({ candidateId: 'touch-baseline', sufficientSample: false })
    expect(report.results.every((result) => result.training.summary.expectancy === null)).toBe(true)
    expect(report.source.complete).toBe(false)
    expect(report.source.warnings.join(' ')).toContain('Insufficient candles')
    const csv = exportHarmonicResearchCsv(report)
    expect(csv).toContain('excluded_formation_boundary')
    expect(csv.trim().split('\n')).toHaveLength(1 + 3 * HARMONIC_RESEARCH_CANDIDATES.length)
    const serialized = JSON.parse(JSON.stringify(report))
    expect(evaluateHarmonicResearch(serialized.candles, request).results).toEqual(report.results)
  })

  test('validates closed candles, ordering, identity, intervals and settings before replay', () => {
    const input = history()
    const preview = input.map((bar, index) => ({ ...bar, isClosed: index !== 300 }))
    expect(() => evaluateHarmonicResearch(preview, request)).toThrow('closed candles')
    expect(() => evaluateHarmonicResearch([candle(0, 100, { closeTime: Number.NaN })], request)).toThrow('Invalid')
    expect(() => evaluateHarmonicResearch([candle(1), candle(0)], request)).toThrow('ordered')
    expect(() => evaluateHarmonicResearch(input, { ...request, timeframe: '4h' })).toThrow('interval')
    expect(() => evaluateHarmonicResearch(input, { ...request, market: 'unknown' as 'spot' })).toThrow('market')
    expect(() => evaluateHarmonicResearch(input, { ...request, execution: { maxHoldingBars: 2.5 } })).toThrow('integer')
    expect(() => evaluateHarmonicResearch(input, { ...request, execution: { feeBps: -1 } })).toThrow('basis')
    const ended = evaluateHarmonicResearch(input, { ...request, endTime: input[700].closeTime })
    expect(ended.candles.at(-1)?.closeTime).toBe(input[700].closeTime)
  })

  test('cost sensitivity keeps the selected candidate and includes time exits', () => {
    const input = history()
    for (const start of [300, 900, 1100]) inject(input, start)
    const report = evaluateHarmonicResearch(input, { ...request, market: 'tradfi' })
    expect(report.costSensitivity.map((item) => item.multiplier)).toEqual([0, 1, 2])
    expect(report.costSensitivity.every((item) => item.evaluation.candidateId === report.selection.candidateId)).toBe(true)
    expect(report.costSensitivity[0].evaluation.summary.trades).toBeGreaterThan(0)
    expect(report.costSensitivity[0].evaluation.summary.expectancy!).toBeGreaterThan(report.costSensitivity[1].evaluation.summary.expectancy!)
    expect(report.costSensitivity[1].evaluation.summary.expectancy!).toBeGreaterThan(report.costSensitivity[2].evaluation.summary.expectancy!)
    expect(report.source.warnings.join(' ')).toContain('Actual funding')
  })

  test('fetches Futures history with the matching venue clock and honors cancellation', async () => {
    const input = history(750)
    inject(input, 300)
    const calls: URL[] = []
    const fetcher = (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      calls.push(parsed)
      if (parsed.pathname.endsWith('/time')) return Response.json({ serverTime: 750 * MINUTE })
      const cursor = Number(parsed.searchParams.get('endTime'))
      const count = Number(parsed.searchParams.get('limit'))
      return Response.json(input.filter((bar) => bar.openTime <= cursor).slice(-count).map((bar) => [bar.openTime, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.closeTime]))
    }) as typeof fetch
    const report = await runHarmonicResearch({ ...request, market: 'tradfi', sampleCandles: 500 }, fetcher)
    expect(report.market).toBe('tradfi')
    expect(calls.every((url) => url.origin === 'https://fapi.binance.com')).toBe(true)
    const sync = evaluateHarmonicResearch(input, { ...request, market: 'tradfi', sampleCandles: 500 })
    expect(report.events).toEqual(sync.events)
    expect(report.results).toEqual(sync.results)
    const controller = new AbortController()
    controller.abort()
    await expect(runHarmonicResearch({ ...request, signal: controller.signal }, fetcher)).rejects.toThrow()
    const afterFetch = new AbortController()
    await expect(runHarmonicResearch({ ...request, sampleCandles: 500, signal: afterFetch.signal, onPhase: () => afterFetch.abort() }, fetcher)).rejects.toThrow()
    const duringReplay = new AbortController()
    let replayProgress = false
    await expect(runHarmonicResearch({ ...request, sampleCandles: 500, signal: duringReplay.signal, onPhase: (phase) => {
      if (phase.startsWith('Replayed')) {
        replayProgress = true
        setTimeout(() => duringReplay.abort(), 0)
      }
    } }, fetcher)).rejects.toThrow()
    expect(replayProgress).toBe(true)
  })
})

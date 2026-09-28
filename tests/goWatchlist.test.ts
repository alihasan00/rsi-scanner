import { describe, expect, test } from 'bun:test'
import { adaptGoWatchlist, isGoWatchlistRowCurrent, selectGoWatchlist } from '../src/lib/goWatchlist'
import type { GoCandidate, GoPlan, GoSeries, GoWatchlistResult } from '../src/lib/goWatchlist'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import { captureWatchlistEvaluation } from '../src/lib/watchlistChart'
import type { GoWatchlistFrameUpdate } from '../src/lib/goWatchlistFeed'
import type { Candle, Timeframe } from '../src/types'

const NOW = Date.parse('2026-09-28T12:05:00Z')
const plan = (patch: Partial<GoPlan> = {}): GoPlan => ({
  status: 'ready_for_review', entry: 102, stop: 99, target: 110, grossRR: 8 / 3, netRR: 2.32,
  feeBps: 20, slippageBps: 10, minNetRR: 1, trigger: 'Confirmed D and closed 15m break',
  invalidation: 'Cancel after a target or stop touch', management: 'Fixed first target', expiresAt: NOW + 60_000, reasons: [], ...patch,
})
function candidate(symbol: string, timeframe: Timeframe = '1h', patch: Partial<GoPlan> = {}): GoCandidate {
  return {setup: {symbol, interval: timeframe, price: 102, lastClosedAt: Math.floor(NOW / TIMEFRAME_MILLISECONDS[timeframe]) * TIMEFRAME_MILLISECONDS[timeframe] - 1,
    pattern: {id: `${symbol}:${timeframe}`, kind: 'gartley', direction: 'bullish', entry: 101, zone: {low: 100, high: 102}, stage: 'confirmed'},
    decision: {confirmation: {event: {confirmedAt: NOW - 300_000}}}},
    plan: plan(patch), mode: 'trend_aligned', confirmation: true, entryDistanceATR: 0.5, reason: 'Four-frame evidence agrees', next: 'Reassess the entry reference', caution: ''}
}
function output(items: GoCandidate[]): GoWatchlistResult {
  const symbols = [...new Set(items.map((item) => item.setup.symbol))]
  const series: GoSeries[] = symbols.flatMap((symbol) => (['15m', '1h', '4h', '1d'] as const).map((interval) => ({
    symbol, interval, price: 102, observedAt: NOW - 1_000, lastClosedAt: Math.floor(NOW / TIMEFRAME_MILLISECONDS[interval]) * TIMEFRAME_MILLISECONDS[interval] - 1,
    closedCandles: 500, ready: true, trend: 'bullish', momentum: 'bullish', internalBias: 'bullish', warnings: [],
  })))
  return {version: '0.13.1-26e07587190d', maxAgeMs: 120_000, result: {
    config: {feeBps: 20, slippageBps: 10, minNetRR: 1}, items, trends: [], strategies: {items: []},
    examined: items.length, eligible: items.length, directionFiltered: 0, costFiltered: 0,
  }, scan: {series, errors: [], progress: {done: series.length, total: series.length}}}
}

describe('Go watchlist presentation', () => {
  test('uses the exact capped plan and net cost output rather than recomputing target or reward', () => {
    const result = output([candidate('BTCUSDT', '1h', {target: 106, grossRR: 1.333, netRR: 1.08})])
    result.scan.series[0].observedAt = NOW - 9_000
    const [row] = adaptGoWatchlist(result, 'spot')
    expect(row.target).toBe(106)
    expect(row.riskReward).toBe(1.333)
    expect(row.updatedAt).toBe(NOW - 9_000)
    expect(row.reference).toMatchObject({netRiskReward: 1.08, feeBps: 20, slippageBps: 10, minNetRR: 1, entry: 101, distanceLabel: '0.50 ATR from entry'})
    expect(row.reference?.frames).toHaveLength(4)
  })

  test('never promotes a blocked plan just because a historical trigger exists', () => {
    const [row] = adaptGoWatchlist(output([candidate('BTCUSDT', '1h', {status: 'cost_blocked', netRR: 0.5})]), 'spot')
    expect(row.status).toBe('blocked')
    expect(row.reference?.statusLabel).toBe('Cost blocked')
  })

  test('unready or missing context cannot reach a displayed candidate', () => {
    const result = output([candidate('BTCUSDT')])
    result.scan.series[2].ready = false
    expect(adaptGoWatchlist(result, 'spot')).toEqual([])
    result.scan.series.splice(2, 1)
    expect(adaptGoWatchlist(result, 'spot')).toEqual([])
  })

  test('groups multiple timeframes of the same asset into one row with their own plans', () => {
    const rows = adaptGoWatchlist(output([candidate('BTCUSDT', '1h'), candidate('BTCUSDT', '4h', {target: 115})]), 'spot')
    const [instrument] = selectGoWatchlist(rows, NOW)
    expect(selectGoWatchlist(rows, NOW)).toHaveLength(1)
    expect(instrument.allSetups.map((item) => item.timeframe)).toEqual(['1h', '4h'])
    expect(instrument.allSetups.map((item) => item.target)).toEqual([110, 115])
    expect(instrument.lead).toBe(rows[0])
  })

  test('retains Go source ranking, caps twelve unique assets, and never fills unused slots', () => {
    const rows = adaptGoWatchlist(output(Array.from({length: 18}, (_, index) => candidate(`COIN${18 - index}USDT`))), 'spot')
    const instruments = selectGoWatchlist(rows, NOW)
    expect(instruments).toHaveLength(12)
    expect(instruments.map((item) => item.symbol)).toEqual(rows.slice(0, 12).map((item) => item.symbol))
    expect(selectGoWatchlist(rows.slice(0, 2), NOW)).toHaveLength(2)
    expect(selectGoWatchlist([], NOW)).toEqual([])
  })

  test('source filters select the matching plan and preserve opposing evidence', () => {
    const rows = adaptGoWatchlist(output([candidate('BTCUSDT'), candidate('ETHUSDT')]), 'spot')
    const trend = {...rows[0], id: 'trend', source: 'trend' as const, direction: 'bearish' as const, target: 95}
    const [instrument] = selectGoWatchlist([...rows, trend], NOW, {source: 'trend', direction: 'bearish'})
    expect(instrument.lead).toBe(trend)
    expect(instrument.allSetups).toHaveLength(2)
    expect(instrument.hasMixedDirections).toBe(true)
    expect(selectGoWatchlist([...rows, trend], NOW, {source: 'trend', direction: 'bullish'})).toEqual([])
  })

  test('Triggered finds a confirmed secondary setup before grouping and retains the unconfirmed lead for comparison', () => {
    const rows = adaptGoWatchlist(output([candidate('BTCUSDT', '1h', {status: 'awaiting_trigger'}), candidate('BTCUSDT', '4h')]), 'spot')
    expect(selectGoWatchlist(rows, NOW)[0].lead.status).toBe('approaching')
    const [triggered] = selectGoWatchlist(rows, NOW, {stage: 'confirmed'})
    expect(triggered.lead.timeframe).toBe('4h')
    expect(triggered.lead.status).toBe('confirmed')
    expect(triggered.setups).toHaveLength(1)
    expect(triggered.allSetups).toHaveLength(2)
  })

  test('a source filter retains Go ordering even when an earlier different-source setup shares its symbol', () => {
    const rows = adaptGoWatchlist(output([candidate('BTCUSDT'), candidate('ETHUSDT'), candidate('SOLUSDT')]), 'spot')
    const trend = {...rows[2], id: 'sol-trend', source: 'trend' as const}
    expect(selectGoWatchlist([...rows, trend], NOW, {source: 'harmonic'}).map((item) => item.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
  })

  test('same rules retain TradFi identity and disclosed contract cost limits', () => {
    const [row] = adaptGoWatchlist(output([candidate('TSLAUSDT')]), 'tradfi')
    expect(row.market).toBe('tradfi')
    expect(row.cautions.some((note) => note.includes('perpetual contracts'))).toBe(true)
    expect(row.reference?.netRiskReward).toBe(2.32)
  })
})

describe('Go evaluation expiry between scans', () => {
  test('fresh Go expiry overrides a retained entry-confirmed trend without discarding its history', () => {
    const at = Date.parse('2026-09-28T12:15:00Z')
    const expiresAt = at - 1
    const triggerAt = expiresAt - 4 * TIMEFRAME_MILLISECONDS['15m']
    const reason = 'A later closed 15m candle followed through beyond the retest extreme.'
    const result = output([candidate('BTCUSDT')])
    result.result.items = []
    for (const frame of result.scan.series) frame.observedAt = at - 1_000
    // During the five-second delivery grace, Go can retain a three-bar-old
    // confirmed method while the wall-clock plan window has already ended.
    result.result.trends = [{
      symbol: 'BTCUSDT', interval: '1h', direction: 'bullish', status: 'entry_confirmed', price: 102,
      pullbackLevel: 101, distanceATR: 0.5, breakConfirmedAt: triggerAt - TIMEFRAME_MILLISECONDS['15m'],
      triggerClosedAt: triggerAt, plan: plan({status: 'confirmation_expired', expiresAt}), reason,
      next: 'Reassess the current quote and trade plan before entry.', caution: '',
    }]
    const rows = adaptGoWatchlist(result, 'spot')
    const [row] = rows
    expect(isGoWatchlistRowCurrent(row, at)).toBe(true)
    expect(row.status).toBe('waiting')
    expect(row.reference).toMatchObject({statusLabel: 'Confirmation expired', planStatus: 'confirmation_expired', nativeStatus: 'entry_confirmed', expiresAt})
    expect(row.next).toContain('fresh completed-candle trigger')
    expect(row.confirmedAt).toBe(triggerAt)
    expect(row.reason).toBe(reason)
    expect(selectGoWatchlist(rows, at, {stage: 'confirmed'})).toEqual([])
    expect(selectGoWatchlist(rows, at, {stage: 'developing'})[0].lead).toBe(row)
  })

  test('withholds expired entries without inventing a replacement eligibility decision', () => {
    const [row] = adaptGoWatchlist(output([candidate('BTCUSDT')]), 'spot')
    expect(isGoWatchlistRowCurrent(row, NOW)).toBe(true)
    expect(isGoWatchlistRowCurrent(row, NOW + 60_000)).toBe(false)
  })

  test('uses the deployed two-minute receipt window and never accepts future receipts', () => {
    const [row] = adaptGoWatchlist(output([candidate('BTCUSDT', '1h', {status: 'awaiting_trigger', expiresAt: null})]), 'spot')
    expect(isGoWatchlistRowCurrent({...row, updatedAt: NOW - 120_000}, NOW)).toBe(true)
    expect(isGoWatchlistRowCurrent({...row, updatedAt: NOW - 120_001}, NOW)).toBe(false)
    expect(isGoWatchlistRowCurrent({...row, updatedAt: NOW + 5_001}, NOW)).toBe(false)
  })

  test('a new 15m close requires reevaluation after the original five-second boundary grace', () => {
    const [row] = adaptGoWatchlist(output([candidate('BTCUSDT', '1h', {status: 'awaiting_trigger', expiresAt: null})]), 'spot')
    const boundary = Date.parse('2026-09-28T12:15:00Z')
    row.updatedAt = boundary
    expect(isGoWatchlistRowCurrent(row, boundary + 4_999)).toBe(true)
    expect(isGoWatchlistRowCurrent(row, boundary + 5_000)).toBe(false)
  })
})

function chartFixture() {
  const item = candidate('BTCUSDT')
  const result = output([item])
  const histories: GoWatchlistFrameUpdate[] = result.scan.series.map((frame, frameIndex) => {
    const duration = TIMEFRAME_MILLISECONDS[frame.interval]
    const candles: Candle[] = Array.from({length: 12}, (_, index) => {
      const openTime = frame.lastClosedAt + 1 - (12 - index) * duration
      return {openTime, closeTime: openTime + duration - 1, open: 101 + index / 100,
        high: 103 + index / 100, low: 100 + index / 100, close: 102 + index / 100, volume: 100 + index}
    })
    const preview: Candle = {...candles.at(-1)!, openTime: frame.lastClosedAt + 1,
      closeTime: frame.lastClosedAt + duration, high: 120, close: 108 + frameIndex}
    frame.observedAt = NOW - 1_000 - frameIndex * 100
    frame.closedCandles = candles.length
    frame.price = preview.close
    return {symbol: frame.symbol, timeframe: frame.interval as GoWatchlistFrameUpdate['timeframe'],
      candles, preview, receivedAt: frame.observedAt, status: 'ready', error: null}
  })
  const hour = histories.find((history) => history.timeframe === '1h')!
  const pivots = {
    x: {index: 1, time: hour.candles[1].openTime, price: hour.candles[1].low},
    a: {index: 3, time: hour.candles[3].openTime, price: hour.candles[3].high},
    b: {index: 5, time: hour.candles[5].openTime, price: hour.candles[5].low},
    c: {index: 7, time: hour.candles[7].openTime, price: hour.candles[7].high},
    d: {index: 9, time: hour.candles[9].openTime, price: hour.candles[9].low},
  }
  Object.assign(item.setup.pattern, pivots, {
    referenceD: 100.75, detectedAt: hour.candles[8].closeTime, confirmedAt: hour.candles[10].closeTime,
    levelsEstablishedAt: hour.candles[10].closeTime,
  })
  item.setup.price = hour.preview!.close
  item.plan.entry = hour.preview!.close
  return {item, result, histories, hour, pivots}
}

describe('selected Go chart evidence', () => {
  test('retains the actual Go XABCD points and separates plan quote from geometric entry', () => {
    const {item, result, histories, pivots} = chartFixture()
    const evaluation = captureWatchlistEvaluation('scan-exact-harmonic', NOW, histories)
    const [row] = adaptGoWatchlist(result, 'spot', evaluation)
    expect(row.reference).toMatchObject({entry: item.setup.pattern.entry, planEntry: item.plan.entry})
    expect(row.reference?.planEntry).not.toBe(row.reference?.entry)
    expect(row.reference?.chart).toMatchObject({snapshotId: 'scan-exact-harmonic', evaluatedAt: NOW, defaultTimeframe: '1h'})
    expect(row.reference?.chart?.points).toEqual(Object.entries(pivots).map(([name, point]) => ({
      label: name.toUpperCase(), timeframe: '1h', time: point.time, price: point.price,
    })))
    // Pivot timestamps are the source bars' opens, not later detection or
    // confirmation closes and not the current evaluated price.
    expect(row.reference?.chart?.points.at(-1)?.time).toBe(pivots.d.time)
    expect(row.reference?.chart?.points.at(-1)?.price).toBe(pivots.d.price)
  })

  test('a potential harmonic retains XABC without inventing an observed D from referenceD', () => {
    const {item, result, histories} = chartFixture()
    Object.assign(item.setup.pattern, {stage: 'potential', d: null, confirmedAt: 0, referenceD: 100.75})
    item.plan.status = 'awaiting_trigger'
    const [row] = adaptGoWatchlist(result, 'spot', captureWatchlistEvaluation('scan-potential', NOW, histories))
    expect(row.reference?.chart?.points.map((point) => point.label)).toEqual(['X', 'A', 'B', 'C'])
    expect(row.reference?.chart?.points.some((point) => point.price === 100.75)).toBe(false)
  })

  test('keeps the selected evaluated candle publication isolated from subsequent feed mutations', () => {
    const {result, histories, hour} = chartFixture()
    const originalFirst = {...hour.candles[0]}
    const originalPreview = {...hour.preview!}
    const evaluation = captureWatchlistEvaluation('scan-before-socket-update', NOW, histories)
    hour.candles[0].low = 1
    hour.candles.push({...hour.preview!})
    hour.preview!.close = 999
    hour.receivedAt = NOW + 1_000
    histories.pop()
    const [row] = adaptGoWatchlist(result, 'spot', evaluation)
    const chart = row.reference?.chart
    const frame = chart?.frames.find((value) => value.timeframe === '1h')
    expect(chart?.snapshotId).toBe('scan-before-socket-update')
    expect(chart?.evaluatedAt).toBe(NOW)
    expect(chart?.frames).toHaveLength(4)
    expect(frame?.candles).toHaveLength(12)
    expect(frame?.candles[0]).toEqual(originalFirst)
    expect(frame?.preview).toEqual(originalPreview)
    expect(frame?.receivedAt).toBe(result.scan.series.find((value) => value.interval === '1h')!.observedAt)
    expect(frame?.candles).not.toBe(hour.candles)
    expect(frame?.candles[0]).not.toBe(hour.candles[0])
    expect(frame?.preview).not.toBe(hour.preview)
    expect(Object.isFrozen(frame?.candles)).toBe(true)
    expect(Object.isFrozen(frame?.candles[0])).toBe(true)
    expect(Object.isFrozen(frame?.preview)).toBe(true)
  })

  for (const mismatch of ['receipt', 'last closed candle', 'closed candle after evaluation'] as const) {
    test(`does not attach chart candles with a mismatched ${mismatch}`, () => {
      const {result, histories, hour} = chartFixture()
      const evidence = result.scan.series.find((frame) => frame.interval === '1h')!
      if (mismatch === 'receipt') hour.receivedAt++
      else if (mismatch === 'last closed candle') hour.candles.pop()
      else {
        // Receipt and latest-close evidence deliberately match here, so the
        // rejection must come from a completed candle beyond this scan cutoff.
        hour.candles.push({...hour.preview!})
        evidence.lastClosedAt = hour.candles.at(-1)!.closeTime
        evidence.closedCandles = hour.candles.length
      }
      const [row] = adaptGoWatchlist(result, 'spot', captureWatchlistEvaluation(`scan-bad-${mismatch}`, NOW, histories))
      expect(row.reference?.chart?.frames.some((frame) => frame.timeframe === '1h') ?? false).toBe(false)
    })
  }

  test('a future provisional candle is not attached ahead of the evaluated clock', () => {
    const {result, histories, hour} = chartFixture()
    const duration = TIMEFRAME_MILLISECONDS['1h']
    hour.preview!.openTime += duration
    hour.preview!.closeTime += duration
    const [row] = adaptGoWatchlist(result, 'spot', captureWatchlistEvaluation('scan-future-preview', NOW, histories))
    const frame = row.reference?.chart?.frames.find((value) => value.timeframe === '1h')
    expect(frame?.candles).toHaveLength(12)
    expect(frame?.preview).toBeNull()
  })

  test('keeps hourly break and 15m retest/trigger events at their exact Go coordinates', () => {
    const {result, histories, hour} = chartFixture()
    const lower = histories.find((history) => history.timeframe === '15m')!
    const breakAt = hour.candles[8].closeTime
    const retestAt = lower.candles[8].closeTime
    const triggerAt = lower.candles[10].closeTime
    const pullbackLevel = 101.25
    const retestLow = 100.125
    const retestHigh = 105.25
    const triggerPrice = 104.375
    Object.assign(lower.candles[8], {low: retestLow, high: retestHigh})
    Object.assign(lower.candles[10], {close: triggerPrice, high: 106})
    result.result.items = []
    result.result.trends = [{symbol: 'BTCUSDT', interval: '1h', direction: 'bullish', status: 'entry_confirmed',
      price: hour.preview!.close, pullbackLevel, distanceATR: 0.75, breakType: 'BOS', breakConfirmedAt: breakAt,
      retestClosedAt: retestAt, retestLow, retestHigh, triggerClosedAt: triggerAt, triggerPrice,
      plan: plan({entry: hour.preview!.close}), reason: 'Hourly break, then held 15m retest and a later follow-through.',
      next: 'Review the evaluated reference plan.', caution: ''}]
    const [row] = adaptGoWatchlist(result, 'spot', captureWatchlistEvaluation('scan-trend-events', NOW, histories))
    const chart = row.reference?.chart
    expect(chart?.defaultTimeframe).toBe('1h')
    expect(chart?.events.find((event) => event.kind === 'break')).toMatchObject({timeframe: '1h', time: breakAt, price: pullbackLevel})
    expect(chart?.events.find((event) => event.kind === 'retest')).toMatchObject({timeframe: '15m', time: retestAt, low: retestLow, high: retestHigh})
    expect(chart?.events.find((event) => event.kind === 'trigger')).toMatchObject({timeframe: '15m', time: triggerAt, price: triggerPrice})
    expect(chart?.frames.find((frame) => frame.timeframe === '15m')?.candles[10].close).toBe(triggerPrice)
    expect(row.reference).toMatchObject({entry: pullbackLevel, planEntry: hour.preview!.close})
  })
})

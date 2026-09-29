import { describe, expect, test } from 'bun:test'
import { adaptGoWatchlist, isGoWatchlistRowCurrent, selectGoWatchlist } from '../src/lib/goWatchlist'
import type { GoPlan, GoSeries, GoStrategy, GoWatchlistResult } from '../src/lib/goWatchlist'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import { captureWatchlistEvaluation } from '../src/lib/watchlistChart'
import type { GoWatchlistFrameUpdate } from '../src/lib/goWatchlistFeed'
import type { Candle, Timeframe } from '../src/types'
import { ichimokuFixture } from './fixtures/watchlistIchimoku'
import { getGoWatchlistExpectedClose } from '../src/lib/goWatchlistTimeframes'

const NOW = Date.parse('2026-09-28T12:05:00Z')
const LAST_SUNDAY = Date.parse('2026-09-27T23:59:59.999Z')
const PROFILES = [
  ['donchian55_atr_trail', '1d', '55-bar trend breakout'],
  ['donchian55_atr_trail_stoch', '1d', '55-bar breakout · Stochastic'],
  ['donchian55_atr_trail_macd', '1d', '55-bar breakout · MACD'],
  ['donchian55_atr_trail_adx_range', '1d', '55-bar breakout · low ADX'],
  ['cloud_reclaim_volume_2r', '1d', 'Cloud reclaim · volume + 2R cap'],
  ['cloud_reclaim_volume_2r_ema', '1d', 'Cloud reclaim · volume + EMA + 2R cap'],
  ['cloud_reclaim_volume_2r_sma', '1d', 'Cloud reclaim · volume + SMA + 2R cap'],
  ['cloud_reclaim_volume_2r_supertrend', '1d', 'Cloud reclaim · volume + Supertrend + 2R cap'],
  ['cloud_reclaim_volume_2r_ao', '1d', 'Cloud reclaim · volume + AO + 2R cap'],
  ['cloud_reclaim_volume_2r_sma_ema_macd', '1d', 'Cloud reclaim · volume + SMA/EMA/MACD + 2R cap'],
  ['fresh_weekly_range_long', '4h', 'Fresh weekly-level rebound'],
  ['tk_cross_rsi', '1d', 'Tenkan / Kijun cross · RSI'],
] as const

const closeAt = (timeframe: Timeframe) => getGoWatchlistExpectedClose(NOW, timeframe, LAST_SUNDAY)
const plan = (patch: Partial<GoPlan> = {}): GoPlan => ({
  status: 'ready_for_review', entry: 103.625, stop: 97.375, target: 114.875, grossRR: null, netRR: null,
  feeBps: 20, slippageBps: 10, minNetRR: 1, trigger: 'Wait for the next observed opening',
  invalidation: 'Retire if the frozen stop is crossed', management: 'Use the profile paper exit rule',
  expiresAt: NOW + TIMEFRAME_MILLISECONDS['1d'], reasons: [], ...patch,
})
function strategy(symbol: string, family: string, timeframe: Timeframe = '1d', options: {
  opportunity?: Partial<GoStrategy['opportunity']>; plan?: Partial<GoPlan>; eligible?: boolean; status?: string
} = {}): GoStrategy {
  const asOf = closeAt(timeframe)
  return {
    opportunity: {
      id: symbol + ':' + family + ':' + asOf, family, symbol, interval: timeframe, direction: 'bullish',
      state: 'entry_confirmed', asOf, availableAt: asOf - TIMEFRAME_MILLISECONDS[timeframe], triggerAt: asOf,
      level: 101.125, zoneLow: 100.25, zoneHigh: 101.75, entryReference: 101.125, referenceAtr: 2,
      next: 'Wait for the next observed opening', caution: 'No fill is assumed.', reason: 'Frozen source signal',
      sourceStartAt: asOf - 10 * TIMEFRAME_MILLISECONDS[timeframe] + 1, sourceEndAt: asOf,
      ...options.opportunity,
    },
    plan: plan(options.plan), price: 103.625, status: options.status ?? 'ready_for_review',
    eligible: options.eligible ?? true, reason: 'The paper profile passed source checks.',
  }
}
function output(items: GoStrategy[], scope: 'all' | 'ichimoku' = 'all', timeframe?: Timeframe): GoWatchlistResult {
  const unique = new Map(items.map(({opportunity}) => [opportunity.symbol + ':' + opportunity.interval, opportunity]))
  const series: GoSeries[] = [...unique.values()].map((item) => ({
    symbol: item.symbol, interval: item.interval, price: 103.625, observedAt: NOW - 1_000,
    lastClosedAt: closeAt(item.interval), closedCandles: 500, ready: true,
    trend: 'bullish', momentum: 'bullish', internalBias: 'bullish', warnings: [],
  }))
  return {
    version: 'paper-v1-test', now: NOW, maxAgeMs: 120_000, scope, ...(timeframe ? {timeframe} : {}),
    result: {config: {feeBps: 20, slippageBps: 10, minNetRR: 1}, items: [], trends: [], strategies: {items},
      examined: items.length, eligible: items.filter((item) => item.eligible).length, directionFiltered: 0, costFiltered: 0},
    scan: {series, errors: [], progress: {done: series.length, total: series.length}},
  }
}
function history(frame: GoSeries): GoWatchlistFrameUpdate {
  const duration = TIMEFRAME_MILLISECONDS[frame.interval]
  const candles: Candle[] = Array.from({length: 12}, (_, index) => {
    const openTime = frame.lastClosedAt + 1 - (12 - index) * duration
    return {openTime, closeTime: openTime + duration - 1, open: 101 + index / 100,
      high: 104 + index / 100, low: 99 + index / 100, close: 103 + index / 100, volume: 100 + index}
  })
  return {symbol: frame.symbol, timeframe: frame.interval, candles,
    preview: {...candles.at(-1)!, openTime: frame.lastClosedAt + 1, closeTime: frame.lastClosedAt + duration},
    receivedAt: frame.observedAt, status: 'ready', error: null}
}

describe('paper profile Watchlist adapter', () => {
  test('admits all twelve active method IDs on their catalog frames and keeps source order', () => {
    const rows = adaptGoWatchlist(output(PROFILES.map(([family, timeframe]) => strategy('BTCUSDT', family, timeframe))), 'spot')
    expect(rows).toHaveLength(12)
    expect(rows.map((row) => [row.reference?.strategyFamily, row.timeframe, row.name])).toEqual(
      PROFILES.map(([family, timeframe, name]) => [family, timeframe, name + ' · ' + timeframe]))
    expect(rows.every((row) => row.source === 'strategy' && row.reference?.mode === 'Paper research profile')).toBe(true)
    expect(rows.map((row) => row.reference?.requiredTimeframes)).toEqual(PROFILES.map(([, timeframe]) => [timeframe]))
    expect(rows.map((row) => row.reference?.frames.map((frame) => frame.timeframe))).toEqual(PROFILES.map(([, timeframe]) => [timeframe]))
    expect(selectGoWatchlist(rows, NOW)[0].allSetups).toEqual(rows)
  })

  test('ignores old detectors, inactive families, wrong catalog frames and unconfirmed states', () => {
    const result = output([
      strategy('BTCUSDT', 'donchian55_atr_trail'),
      strategy('BTCUSDT', 'tk_cross'),
      strategy('BTCUSDT', 'fibonacci_pullback'),
      strategy('BTCUSDT', 'cloud_reclaim_volume_2r', '4h'),
      strategy('BTCUSDT', 'fresh_weekly_range_long', '1d'),
      strategy('BTCUSDT', 'donchian55_atr_trail', '1d', {opportunity: {id: 'unconfirmed', state: 'awaiting_confirmation'}}),
    ])
    result.result.items = [{setup: {symbol: 'BTCUSDT', interval: '1d', price: 103, lastClosedAt: closeAt('1d'),
      pattern: {id: 'old-harmonic', kind: 'gartley', direction: 'bullish', entry: 101, zone: {low: 100, high: 102}, stage: 'confirmed'},
      decision: {confirmation: {event: null}}}, plan: plan(), mode: 'old', confirmation: true, entryDistanceATR: 1,
      reason: 'Old detector', next: 'Old next', caution: ''}]
    result.result.trends = [{symbol: 'BTCUSDT', interval: '1d', direction: 'bullish', status: 'entry_confirmed', price: 103,
      pullbackLevel: 101, distanceATR: 1, breakConfirmedAt: closeAt('1d'), triggerClosedAt: closeAt('1d'),
      plan: plan(), reason: 'Old trend', next: 'Old next', caution: ''}]
    expect(adaptGoWatchlist(result, 'spot').map((row) => row.reference?.strategyFamily)).toEqual(['donchian55_atr_trail'])
  })

  test('a candidate needs only its own ready source frame', () => {
    const result = output([strategy('BTCUSDT', 'donchian55_atr_trail'),
      strategy('BTCUSDT', 'fresh_weekly_range_long', '4h')])
    result.scan.series[0].ready = false
    result.scan.errors.push({symbol: 'BTCUSDT', interval: '1d', error: 'Daily feed failed'})
    expect(adaptGoWatchlist(result, 'spot').map((row) => row.reference?.strategyFamily)).toEqual(['fresh_weekly_range_long'])
    result.scan.series[0].ready = true
    result.scan.series[1].ready = false
    expect(adaptGoWatchlist(result, 'spot').map((row) => row.reference?.strategyFamily)).toEqual(['donchian55_atr_trail'])
    result.scan.series.splice(0, 1)
    expect(adaptGoWatchlist(result, 'spot')).toEqual([])
  })

  test('duplicate and missing source frames cannot display a plan', () => {
    const result = output([strategy('BTCUSDT', 'tk_cross_rsi')])
    result.scan.series.push({...result.scan.series[0]})
    expect(adaptGoWatchlist(result, 'spot')).toEqual([])
    result.scan.series.length = 0
    expect(adaptGoWatchlist(result, 'spot')).toEqual([])
  })

  test('preserves managed null R/R and target references without inventing a fill or cap', () => {
    const rows = adaptGoWatchlist(output([
      strategy('BTCUSDT', 'donchian55_atr_trail', '1d', {plan: {target: null}}),
      strategy('ETHUSDT', 'cloud_reclaim_volume_2r', '1d', {opportunity: {entryMin: 100.5, entryMax: 104.5}}),
      strategy('SOLUSDT', 'fresh_weekly_range_long', '4h', {opportunity: {entryMin: 101, entryMax: 105},
        plan: {target: 112.125}}),
    ]), 'spot')
    expect(rows.map((row) => [row.target, row.riskReward, row.reference?.netRiskReward])).toEqual([
      [null, null, null], [114.875, null, null], [112.125, null, null],
    ])
    expect(rows.every((row) => row.reference?.entry === 101.125 && row.reference?.planEntry === 103.625
      && row.price === 103.625)).toBe(true)
    expect(rows.map((row) => [row.reference?.entryMin, row.reference?.entryMax])).toEqual([
      [null, null], [100.5, 104.5], [101, 105],
    ])
  })

  test('keeps confirmed source signals with blocked reference plans visible as blocked', () => {
    const item = strategy('BTCUSDT', 'fresh_weekly_range_long', '4h',
      {plan: {status: 'cost_blocked'}, eligible: false, status: 'cost_blocked'})
    const [row] = adaptGoWatchlist(output([item]), 'spot')
    expect(row.status).toBe('blocked')
    expect(row.reference).toMatchObject({nativeStatus: 'cost_blocked', planStatus: 'cost_blocked', statusLabel: 'Cost blocked'})
    expect(row.next).toContain('no opening entry is indicated')
    expect(row.next).not.toContain('Wait for the next observed opening')
    expect(selectGoWatchlist([row], NOW, {stage: 'confirmed'})).toEqual([])
    expect(selectGoWatchlist([row], NOW)[0].lead).toBe(row)
  })

  test('groups every selected asset without a cap and excludes other sources from details', () => {
    const items = Array.from({length: 18}, (_, index) => strategy('COIN' + (18 - index) + 'USDT', 'donchian55_atr_trail'))
    const rows = adaptGoWatchlist(output(items), 'spot')
    const noise = {...rows[0], id: 'old-trend', source: 'trend' as const, direction: 'bearish' as const}
    const inactive = {...rows[0], id: 'inactive-strategy', reference: {...rows[0].reference!, strategyFamily: 'tk_cross'}}
    const instruments = selectGoWatchlist([noise, inactive, ...rows], NOW)
    expect(instruments).toHaveLength(18)
    expect(instruments.map((instrument) => instrument.symbol)).toEqual(rows.map((row) => row.symbol))
    expect(instruments[0].allSetups).toEqual([rows[0]])
    expect(instruments[0].hasMixedDirections).toBe(false)
    expect(selectGoWatchlist([noise, inactive, ...rows], NOW, {source: 'trend'})).toEqual([])
    expect(selectGoWatchlist(rows, NOW, {starredOnly: true, starredSymbols: new Set(['COIN1USDT'])})[0].symbol).toBe('COIN1USDT')
  })

  test('a confirmed secondary profile can lead a filter while all variants stay in review', () => {
    const first = strategy('BTCUSDT', 'donchian55_atr_trail', '1d',
      {plan: {status: 'cost_blocked'}, eligible: false, status: 'cost_blocked'})
    const second = strategy('BTCUSDT', 'cloud_reclaim_volume_2r', '1d', {opportunity: {direction: 'bearish'}})
    const rows = adaptGoWatchlist(output([first, second]), 'spot')
    const [instrument] = selectGoWatchlist(rows, NOW, {stage: 'confirmed', direction: 'bearish'})
    expect(instrument.lead).toBe(rows[1])
    expect(instrument.setups).toEqual([rows[1]])
    expect(instrument.allSetups).toEqual(rows)
    expect(instrument.hasMixedDirections).toBe(true)
  })

  test('source close currency uses the five-second grace and two-minute receipt window', () => {
    const [daily, fourHour] = adaptGoWatchlist(output([
      strategy('BTCUSDT', 'donchian55_atr_trail', '1d', {plan: {expiresAt: null}}),
      strategy('BTCUSDT', 'fresh_weekly_range_long', '4h', {plan: {expiresAt: null}}),
    ]), 'spot')
    const boundary = Date.parse('2026-09-28T16:00:00Z')
    daily.updatedAt = boundary
    fourHour.updatedAt = boundary
    expect(isGoWatchlistRowCurrent(daily, boundary + 5_000)).toBe(true)
    expect(isGoWatchlistRowCurrent(fourHour, boundary + 4_999)).toBe(true)
    expect(isGoWatchlistRowCurrent(fourHour, boundary + 5_000)).toBe(false)
    expect(isGoWatchlistRowCurrent({...daily, updatedAt: NOW - 120_000}, NOW)).toBe(true)
    expect(isGoWatchlistRowCurrent({...daily, updatedAt: NOW - 120_001}, NOW)).toBe(false)
    expect(isGoWatchlistRowCurrent({...daily, updatedAt: NOW + 5_001}, NOW)).toBe(false)
  })

  test('captures the matching source publication and immutable paper signal events', () => {
    const result = output([strategy('BTCUSDT', 'cloud_reclaim_volume_2r_ema')])
    const source = history(result.scan.series[0])
    const unrelated = history({...result.scan.series[0], interval: '4h', lastClosedAt: closeAt('4h')})
    const captured = captureWatchlistEvaluation('paper-source-exact', NOW, [source, unrelated])
    source.candles[0].close = 999
    source.preview!.close = 999
    const [row] = adaptGoWatchlist(result, 'spot', captured)
    expect(row.reference?.chart).toMatchObject({snapshotId: 'paper-source-exact', defaultTimeframe: '1d'})
    expect(row.reference?.chart?.frames.map((frame) => frame.timeframe)).toEqual(['1d'])
    expect(row.reference?.chart?.frames[0].candles[0].close).not.toBe(999)
    expect(row.reference?.chart?.events.find((event) => event.kind === 'trigger')).toMatchObject({
      label: 'Paper signal confirmed', timeframe: '1d', time: closeAt('1d'), price: 101.125,
    })
    expect(row.reference?.chart?.evidence.find((item) => item.label === 'Profile evidence')?.detail).toBe('Frozen source signal')
  })

  test('retains TradFi contract cautions', () => {
    const [row] = adaptGoWatchlist(output([strategy('TSLAUSDT', 'tk_cross_rsi')]), 'tradfi')
    expect(row.market).toBe('tradfi')
    expect(row.cautions.some((note) => note.includes('USDT perpetual contracts'))).toBe(true)
  })
})

describe('independent Ichimoku scope', () => {
  test('every picker timeframe keeps its source-only method outside the paper roster', () => {
    for (const timeframe of Object.keys(TIMEFRAME_MILLISECONDS) as Timeframe[]) {
      const [row] = adaptGoWatchlist(output([strategy('BTCUSDT', 'tk_cross', timeframe)], 'ichimoku', timeframe), 'spot')
      expect(row.timeframe).toBe(timeframe)
      expect(row.status).toBe('confirmed')
      expect(row.reference?.requiredTimeframes).toEqual([timeframe])
      expect(isGoWatchlistRowCurrent(row, NOW)).toBe(true)
      expect(selectGoWatchlist([row], NOW)).toEqual([])
      expect(selectGoWatchlist([row], NOW, {scope: 'ichimoku', timeframe})[0].lead).toBe(row)
    }
  })

  test('preserves exact Ichimoku readings and plan with matching captured candles', () => {
    const result = output([strategy('BTCUSDT', 'tk_cross', '1h', {plan: {grossRR: 2.7, netRR: 2.32}})], 'ichimoku', '1h')
    const source = history(result.scan.series[0])
    const {reading, series} = ichimokuFixture(source.candles)
    Object.assign(result.scan.series[0], {ichimoku: reading, ichimokuSeries: series})
    const before = structuredClone(reading)
    const [row] = adaptGoWatchlist(result, 'spot', captureWatchlistEvaluation('ichimoku-exact', NOW, [source]))
    Object.assign(reading.kijun, {value: 1})
    expect(row.name).toBe('TK cross · 1h')
    expect(row.reference?.netRiskReward).toBe(2.32)
    expect(row.reference?.chart?.frames[0].ichimoku).toEqual(before)
    expect(row.reference?.chart?.frames[0].ichimokuSeries).toEqual(series)
  })

  test('rejects unsupported selected frames and mismatched chart receipts', () => {
    const result = output([strategy('BTCUSDT', 'tk_cross', '1h')], 'ichimoku', '1h')
    const source = history(result.scan.series[0])
    result.scan.series[0].observedAt++
    const [row] = adaptGoWatchlist(result, 'spot', captureWatchlistEvaluation('mismatched-source', NOW, [source]))
    expect(row.reference?.chart?.frames).toEqual([])
    result.timeframe = '6h' as Timeframe
    expect(() => adaptGoWatchlist(result, 'spot')).toThrow('Unsupported Ichimoku timeframe')
  })
})

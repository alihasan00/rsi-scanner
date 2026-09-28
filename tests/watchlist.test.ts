import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { analyzeFibonacci } from '../src/lib/fibonacci'
import { analyzeHarmonics } from '../src/lib/harmonics'
import type { HarmonicSetup } from '../src/lib/harmonics'
import type { StructureLevel, StructureRetest } from '../src/lib/marketStructure'
import { analyzeSignalEvidence, summarizeEvidence } from '../src/lib/signalEvidence'
import type { SignalEvidence } from '../src/lib/signalEvidence'
import { buildWatchlistRows, getWatchlistFreshness, prepareWatchlistRetestTargets, sortWatchlistRows, WATCHLIST_STATUS_LABELS } from '../src/lib/watchlist'
import type { WatchlistInput } from '../src/lib/watchlist'

const START = Date.parse('2026-09-25T00:00:00Z')
const MINUTE = 60_000
const closeAt = (index: number) => START + (index + 1) * MINUTE - 1
const identity = { symbol: 'BTCUSDT', market: 'spot', timeframe: '1m' } as const

function bar(index: number, price = 108, patch: Partial<RsiBar> = {}): RsiBar {
  return { openTime: START + index * MINUTE, closeTime: closeAt(index), open: price, high: price + 0.5,
    low: price - 0.5, close: price, volume: 100, rsi: 50, isClosed: true, ...patch }
}
function evidence(index = 6, direction: SignalEvidence['direction'] = 'bullish', patch: Partial<SignalEvidence> = {}): SignalEvidence {
  return { id: `rsi:${index}:${direction}`, family: 'momentum', source: 'RSI divergence', direction, role: 'trigger',
    availableAt: closeAt(index), ageBars: 0, detail: 'Confirmed price reversal', provenance: ['RSI divergence'], ...patch }
}
function setEvidence(input: WatchlistInput, items: SignalEvidence[]) {
  input.evidence = { ...input.evidence, ...summarizeEvidence(items, input.evidence.asOf!) }
  return input
}
function fixture(): WatchlistInput {
  const bars = Array.from({ length: 8 }, (_, index) => bar(index, index >= 5 ? 103 : 108))
  bars[4] = bar(4, 101, { low: 100, high: 102 })
  const asOf = closeAt(7)
  const fib = analyzeFibonacci([100, 102, 104, 106, 110, 106, 104, 102, 90, 100, 106, 112, 120, 118, 116, 114]
    .map((price, index) => bar(index, price, { low: price - 1, high: price + 1 })))
  if (!fib.setup) throw new Error('The existing Fib engine must produce a fixture plan')
  // Geometry/lifecycles are detector-tested; these boundaries isolate shortlist eligibility.
  fib.setup = { ...fib.setup, id: 'fib-1', direction: 'long', status: 'entered', detectedAt: closeAt(2),
    goldenPocket: { low: 100, high: 102 }, currentStop: 98,
    entries: fib.setup.entries.map((entry) => ({ ...entry, touchedAt: null })),
    targets: fib.setup.targets.map((target, index) => ({ ...target, price: 115 + index * 5, hitAt: null })) }
  fib.setups = [fib.setup]
  fib.lastClosedAt = asOf
  fib.smaConfluence = 'aligned'
  const analysis = analyzeSignalEvidence({ ...identity, bars })
  analysis.structure.atr = 2
  const input: WatchlistInput = {
    ...identity, snapshot: { bars, price: 103, volume: 100, series: bars.map((item) => item.rsi) },
    feed: { state: 'ready', updatedAt: asOf + 1_000, error: null }, now: asOf + 1_000,
    fib, harmonic: { setups: [], closedBarCount: bars.length, lastClosedAt: asOf }, evidence: analysis,
  }
  return setEvidence(input, [evidence()])
}
function harmonic(input: WatchlistInput): HarmonicSetup {
  const setup = analyzeHarmonics([120, 115, 110, 100, 125, 150, 175, 200, 180, 160, 150, 138.2, 150, 160, 170, 176.3924, 170, 165, 160]
    .map((price, index) => bar(index, price, { high: price, low: price }))).setups[0]
  if (!setup) throw new Error('The existing harmonic engine must produce a fixture pattern')
  const result: HarmonicSetup = { ...setup, id: 'harmonic-1', kind: 'gartley', direction: 'bullish', status: 'active', stage: 'zone',
    confirmedAt: closeAt(2), zone: { low: 100, high: 102 }, stopReference: 98, a: { ...setup.a, price: 165 },
    d: { index: 4, time: START + 4 * MINUTE, price: 101 }, confirmedD: null, dConfirmedAt: null }
  input.fib.setup = null
  input.harmonic.setups = [result]
  return result
}
function targetLevel(price = 115): StructureLevel {
  return { id: 'resistance', side: 'high', kind: 'swing', price, low: price, high: price, pivotTimes: [START],
    confirmedAt: closeAt(0), lastConfirmedAt: closeAt(0), status: 'active', sweptAt: null, reclaimedAt: null,
    brokenAt: null, expiredAt: null, supersededBy: null, ageBars: 7, sweepQuality: null, reclaimQuality: null }
}
function retest(input: WatchlistInput): StructureRetest {
  input.fib.setup = null
  const setup: StructureRetest = { id: 'retest-1', eventId: 'break-1', direction: 'bullish', levelPrice: 101,
    band: { low: 100, high: 102 }, breakAt: closeAt(2), retestAt: closeAt(4), confirmedAt: closeAt(6),
    endedAt: closeAt(6), state: 'confirmed', continuationPrice: 102, invalidationPrice: 100, ageBars: 5 }
  input.evidence.structure.retests = [setup]
  input.evidence.structure.levels = [targetLevel()]
  input.retestTargets = { [setup.id]: 115 }
  setEvidence(input, [evidence(6, 'bullish', { id: setup.id, source: 'Retest', family: 'structure' })])
  return setup
}
function mirror(input: WatchlistInput): WatchlistInput {
  const flip = (price: number) => 220 - price
  input.snapshot.bars = input.snapshot.bars.map((item) => ({ ...item, open: flip(item.open), high: flip(item.low), low: flip(item.high), close: flip(item.close) }))
  input.snapshot.price = flip(input.snapshot.price)
  if (input.fib.setup) {
    const setup = input.fib.setup
    setup.direction = 'short'
    setup.goldenPocket = { low: flip(setup.goldenPocket.high), high: flip(setup.goldenPocket.low) }
    setup.currentStop = flip(setup.currentStop)
    setup.targets = setup.targets.map((target) => ({ ...target, price: flip(target.price) }))
  }
  for (const setup of input.harmonic.setups) {
    setup.direction = 'bearish'
    setup.zone = { low: flip(setup.zone.high), high: flip(setup.zone.low) }
    setup.stopReference = flip(setup.stopReference)
    setup.a = { ...setup.a, price: flip(setup.a.price) }
    if (setup.d) setup.d = { ...setup.d, price: flip(setup.d.price) }
  }
  for (const setup of input.evidence.structure.retests) {
    setup.direction = 'bearish'
    setup.band = { low: flip(setup.band.high), high: flip(setup.band.low) }
    setup.levelPrice = flip(setup.levelPrice)
    setup.invalidationPrice = flip(setup.invalidationPrice)
    if (setup.continuationPrice !== null) setup.continuationPrice = flip(setup.continuationPrice)
  }
  input.evidence.structure.levels = input.evidence.structure.levels.map((level) => ({ ...level, side: level.side === 'high' ? 'low' : 'high', price: flip(level.price), low: flip(level.high), high: flip(level.low) }))
  if (input.retestTargets) input.retestTargets = Object.fromEntries(Object.entries(input.retestTargets).map(([key, price]) => [key, price === null ? null : flip(price)]))
  return setEvidence(input, input.evidence.items.map((item) => ({ ...item, direction: item.direction === 'bullish' ? 'bearish' : 'bullish' })))
}

describe('live watchlist eligibility', () => {
  test.each(['bullish', 'bearish'] as const)('%s Fib, harmonic and retest candidates need valid current risk and causal evidence', (direction) => {
    for (const source of ['fib', 'harmonic', 'retest'] as const) {
      const input = fixture()
      if (source === 'harmonic') harmonic(input)
      if (source === 'retest') retest(input)
      if (direction === 'bearish') mirror(input)
      const before = structuredClone(input)
      const row = buildWatchlistRows(input)[0]
      expect(row).toMatchObject({ source, direction, status: 'confirmed', confirmedAt: closeAt(6), conflict: false })
      expect(row.riskReward).toBeGreaterThanOrEqual(1.5)
      expect(row.cautions.join(' ')).toContain('Higher-timeframe context is unchecked')
      expect(row.cautions.join(' ')).toContain('Fees, spread, slippage and funding are excluded')
      expect(input).toEqual(before)
    }
    expect(WATCHLIST_STATUS_LABELS.confirmed).toBe('Trigger confirmed')
  })

  test.each([0, 2, 4])('a trigger on close %s cannot confirm before or during the relevant zone test', (index) => {
    const input = setEvidence(fixture(), [evidence(index)])
    expect(buildWatchlistRows(input)[0].confirmedAt).toBeNull()
    expect(buildWatchlistRows(input)[0].status).not.toBe('confirmed')
  })

  test('all four recent closes are eligible, and old or future timestamps cannot borrow a young age label', () => {
    for (const index of [4, 5, 6, 7]) {
      const input = fixture()
      input.snapshot.bars[3] = bar(3, 101, { low: 100, high: 102 })
      setEvidence(input, [evidence(index, 'bullish', { ageBars: 500 })])
      expect(buildWatchlistRows(input)[0].status).toBe('confirmed')
    }
    for (const index of [3, 8]) {
      const input = fixture()
      input.snapshot.bars[2] = bar(2, 101, { low: 100, high: 102 })
      setEvidence(input, [evidence(index, 'bullish', { ageBars: 0 })])
      expect(buildWatchlistRows(input)[0].status).not.toBe('confirmed')
    }
  })

  test('live candles neither establish a zone test nor provide confirmation', () => {
    const input = fixture()
    input.snapshot.bars[4] = bar(4)
    input.snapshot.bars.push(bar(8, 101, { low: 100, high: 102, isClosed: false }))
    input.snapshot.price = 101
    setEvidence(input, [evidence(8)])
    const row = buildWatchlistRows(input)[0]
    expect(row).toMatchObject({ status: 'testing', confirmedAt: null, asOf: closeAt(7) })
    expect(row.reason).toContain('no completed-candle test')
  })

  test('harmonic D-pivot confirmation remains context, even when recent and inside the zone', () => {
    const input = fixture()
    const setup = harmonic(input)
    setup.confirmedD = { index: 4, time: START + 4 * MINUTE, price: 101 }
    setup.dConfirmedAt = closeAt(7)
    input.snapshot.price = 101
    setEvidence(input, [evidence(7, 'bullish', { id: setup.id, source: 'Harmonic', family: 'location', role: 'context' })])
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'testing', confirmedAt: null })
  })

  test('retests need their own continuation; another RSI or retest trigger does not substitute', () => {
    for (const item of [evidence(), evidence(6, 'bullish', { id: 'another-retest', source: 'Retest', family: 'structure' })]) {
      const input = fixture()
      retest(input)
      setEvidence(input, [item])
      expect(buildWatchlistRows(input)[0].status).not.toBe('confirmed')
    }
    const input = fixture()
    const setup = retest(input)
    setup.retestAt = setup.breakAt
    expect(buildWatchlistRows(input)[0].status).not.toBe('confirmed')
  })

  test('calendar sweeps cannot imply a causal level match, and structure breaks must be on the confirming side', () => {
    const input = fixture()
    setEvidence(input, [evidence(6, 'bullish', { family: 'liquidity', source: 'Calendar sweep' })])
    expect(buildWatchlistRows(input)[0].status).not.toBe('confirmed')
    setEvidence(input, [evidence(6, 'bullish', { id: 'break', family: 'structure', source: 'Price break' })])
    input.evidence.structure.events = [{ id: 'break', type: 'bos', direction: 'bullish', confirmedAt: closeAt(6), levelId: 'level', price: 90, priorTrend: 'neutral', ageBars: 1 }]
    expect(buildWatchlistRows(input)[0].status).not.toBe('confirmed')
    input.evidence.structure.events[0].price = 102
    expect(buildWatchlistRows(input)[0].status).toBe('confirmed')
  })

  test('recent opposing triggers block confirmation, while old opposing momentum does not', () => {
    const input = setEvidence(fixture(), [evidence(), evidence(7, 'bearish')])
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'conflict', conflict: true })
    setEvidence(input, [evidence(), evidence(1, 'bearish')])
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'confirmed', conflict: false })
    input.fib.smaConfluence = 'against'
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'conflict', conflict: true })
  })

  test('distant opposing locations remain context; only a nearby opposing location blocks confirmation', () => {
    const input = fixture()
    const fib = input.fib.setup
    const setup = harmonic(input)
    input.fib.setup = fib
    setup.direction = 'bearish'
    setup.zone = { low: 150, high: 155 }
    setEvidence(input, [evidence(), evidence(2, 'bearish', { id: setup.id, source: 'Harmonic', family: 'location', role: 'context' })])
    let row = buildWatchlistRows(input).find((row) => row.source === 'fib')!
    expect(row).toMatchObject({ status: 'confirmed', conflict: false })
    expect(row.cautions.join(' ')).toContain('away from this zone')
    setup.zone = { low: 103, high: 105 }
    row = buildWatchlistRows(input).find((row) => row.source === 'fib')!
    expect(row).toMatchObject({ status: 'conflict', conflict: true })
  })

  test('an interior interruption cannot borrow a saved location test from before the gap', () => {
    const input = fixture()
    input.fib.setup!.entries[0] = { ...input.fib.setup!.entries[0], price: 101, touchedAt: closeAt(4) }
    input.snapshot.bars[5] = { ...input.snapshot.bars[5], isClosed: false }
    expect(buildWatchlistRows(input)[0].confirmedAt).toBeNull()
  })

  test('same-direction evidence families are deduplicated', () => {
    const input = setEvidence(fixture(), [evidence(), evidence(7), evidence(6, 'bullish', { id: 'line', source: 'RSI trendline' })])
    expect(buildWatchlistRows(input)[0].families).toEqual(['momentum'])
  })

  test.each(['managing', 'runner', 'stopped', 'missed', 'invalidated', 'superseded'] as const)('Fib %s is not a fresh watchlist opportunity', (status) => {
    const input = fixture()
    input.fib.setup!.status = status
    expect(buildWatchlistRows(input)).toEqual([])
  })

  test('stale snapshots and future setups cannot confirm at the current candle', () => {
    const input = fixture()
    input.fib.lastClosedAt = closeAt(6)
    expect(buildWatchlistRows(input)[0].status).toBe('blocked')
    input.fib.lastClosedAt = closeAt(7)
    input.evidence.asOf = closeAt(6)
    expect(buildWatchlistRows(input)[0].status).toBe('blocked')
    input.fib.setup!.detectedAt = closeAt(8)
    expect(buildWatchlistRows(input)).toEqual([])
  })
})

describe('watchlist data freshness and current risk', () => {
  test('a newly received tick does not make old completed candles current', () => {
    const input = fixture()
    expect(getWatchlistFreshness(input)).toBe('fresh')
    input.now = closeAt(7) + MINUTE + 5_001
    input.feed.updatedAt = input.now
    expect(getWatchlistFreshness(input)).toBe('delayed')
    expect(buildWatchlistRows(input)[0].status).toBe('delayed')
  })

  test.each(['loading', 'error', 'old-receipt', 'future-receipt', 'future-candle', 'invalid-quote'] as const)('%s prevents fresh confirmation', (condition) => {
    const input = fixture()
    if (condition === 'loading' || condition === 'error') input.feed.state = condition
    if (condition === 'old-receipt') input.feed.updatedAt = input.now - MINUTE - 1
    if (condition === 'future-receipt') input.feed.updatedAt = input.now + 5_001
    if (condition === 'future-candle') input.now = closeAt(7) - 5_001
    if (condition === 'invalid-quote') input.snapshot.price = NaN
    expect(getWatchlistFreshness(input)).not.toBe('fresh')
    expect(buildWatchlistRows(input)[0].status).toBe('delayed')
  })

  test('wrong interval labels and missing completed history cannot pass freshness checks', () => {
    const input = fixture()
    input.timeframe = '1h'
    expect(getWatchlistFreshness(input)).toBe('delayed')
    input.snapshot.bars = []
    expect(getWatchlistFreshness(input)).toBe('loading')
    expect(buildWatchlistRows(input)).toEqual([])
  })

  test('a frozen confirming candle expires by wall clock even during the close-delivery grace period', () => {
    const input = fixture()
    input.snapshot.bars[3] = bar(3, 101, { low: 100, high: 102 })
    setEvidence(input, [evidence(4)])
    input.now = closeAt(7) + MINUTE + 1_000
    input.feed.updatedAt = input.now
    expect(getWatchlistFreshness(input)).toBe('fresh')
    expect(buildWatchlistRows(input)[0].status).not.toBe('confirmed')
  })

  test.each(['bullish', 'bearish'] as const)('%s live stop/target crossings block readiness without changing lifecycle', (direction) => {
    const input = fixture()
    if (direction === 'bearish') mirror(input)
    const setup = input.fib.setup!
    input.snapshot.price = setup.currentStop
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'blocked', riskReward: null })
    input.snapshot.price = setup.targets[0].price
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'extended', riskReward: null })
    expect(setup.status).toBe('entered')
  })

  test('an observed live wick through the stop blocks a recovered quote, with invalidation winning a target-spanning candle', () => {
    const input = fixture()
    input.snapshot.bars.push(bar(8, 103, { low: 97, high: 116, isClosed: false }))
    expect(buildWatchlistRows(input)[0].status).toBe('blocked')
    input.snapshot.bars[8] = bar(8, 103, { low: 102.5, high: 116, isClosed: false })
    expect(buildWatchlistRows(input)[0].status).toBe('extended')
    expect(input.fib.setup!.status).toBe('entered')
  })

  test('price above a future first target before any zone test does not mean that opportunity was consumed', () => {
    const input = fixture()
    input.fib.setup!.status = 'watching'
    input.snapshot.bars[4] = bar(4)
    input.snapshot.price = 116
    const row = buildWatchlistRows(input)[0]
    expect(row).toMatchObject({ status: 'waiting', confirmedAt: null })
    expect(row.reason).not.toContain('target')
  })

  test.each([NaN, -1, 0, 103, 110])('invalid or wrongly sided stop %s cannot qualify', (stop) => {
    const input = fixture()
    input.fib.setup!.currentStop = stop
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'blocked', riskReward: null })
  })

  test('a low first-target R is disclosed, while a distant quote prevents chasing a past confirmation', () => {
    const input = fixture()
    input.fib.setup!.targets[0].price = 107
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'confirmed', riskReward: 0.8 })
    expect(buildWatchlistRows(input)[0].cautions).toContain('Less than 1R remains to the first target; partial exits and later targets are not modeled here.')
    input.fib.setup!.targets[0].price = 115
    input.snapshot.price = 106
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'extended', riskReward: 1.125 })
    input.fib.setup!.targets[0].price = 160
    expect(buildWatchlistRows(input)[0].status).toBe('extended')
  })

  test('a missing retest target is unavailable rather than an invented R-multiple', () => {
    const input = fixture()
    retest(input)
    input.retestTargets = {}
    input.evidence.structure.levels = []
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'blocked', target: null, riskReward: null })
    input.evidence.structure.levels = [{ ...targetLevel(), confirmedAt: closeAt(5), lastConfirmedAt: closeAt(5) }]
    expect(buildWatchlistRows(input)[0].target).toBeNull()
  })

  test.each(['bullish', 'bearish'] as const)('%s retest cannot recover eligibility after a completed stop or target crossing', (direction) => {
    for (const boundary of ['stop', 'target', 'both'] as const) {
      const input = fixture()
      retest(input)
      input.snapshot.bars[7] = bar(7, 103, { low: boundary === 'target' ? 102 : 99, high: boundary === 'stop' ? 104 : 116 })
      if (direction === 'bearish') mirror(input)
      const row = buildWatchlistRows(input)[0]
      expect(row.status).toBe(boundary === 'target' ? 'extended' : 'blocked')
      expect(input.evidence.structure.retests[0].state).toBe('confirmed')
    }
  })

  test('a target already crossed between the zone test and later confirmation cannot become fresh again', () => {
    const input = fixture()
    retest(input)
    input.snapshot.bars[5] = bar(5, 103, { low: 102, high: 116 })
    expect(buildWatchlistRows(input)[0].status).toBe('extended')
  })

  test('confirmed retests require uninterrupted candle coverage back to their test', () => {
    const input = fixture()
    retest(input)
    input.snapshot.bars = input.snapshot.bars.slice(5)
    expect(buildWatchlistRows(input)[0].status).toBe('blocked')
    expect(buildWatchlistRows(input)[0].reason).toContain('does not cover')
  })

  test('a first target crossed live is not replaced by a farther target', () => {
    const input = fixture()
    retest(input)
    input.evidence.structure.levels.push(targetLevel(130))
    input.snapshot.price = 116
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'extended', target: 115 })
  })

  test('a later equal-high cluster cannot replace the original retest target with farther resistance', () => {
    const highs = [125, 130, 135, 140, 135, 130, 125, 108, 110, 115, 120, 115, 110, 108,
      100, 102, 107, 110, 107, 103, 104, 114, 115, 114.8, 114.6, 114.5, 119.9, 117, 115, 114]
    const bars = highs.map((high, index) => bar(index, high - 0.5, { high, low: index < 21 ? 90 : 108 }))
    const atConfirmation = analyzeSignalEvidence({ ...identity, bars: bars.slice(0, 27) })
    const latest = analyzeSignalEvidence({ ...identity, bars })
    const setup = latest.structure.retests[0]
    expect(setup).toMatchObject({ state: 'confirmed', confirmedAt: closeAt(26) })
    expect(latest.structure.levels.find((level) => level.kind === 'equal')).toMatchObject({ price: 120, confirmedAt: closeAt(29) })
    expect(prepareWatchlistRetestTargets(bars.slice(0, 27), atConfirmation)[setup.id]).toBe(120)
    expect(prepareWatchlistRetestTargets(bars, latest)[setup.id]).toBe(120)
    const input = fixture()
    input.fib.setup = null
    input.snapshot.bars = bars
    input.snapshot.price = bars.at(-1)!.close
    input.evidence = latest
    input.now = closeAt(29) + 1_000
    input.feed.updatedAt = input.now
    expect(buildWatchlistRows(input)[0]).toMatchObject({ source: 'retest', confirmedAt: closeAt(26), target: 120 })
    // The surviving final levels cannot invent a target when the original break prefix is absent.
    expect(prepareWatchlistRetestTargets(bars.slice(22), latest)[setup.id]).toBeNull()
  })

  test('ATR and percentage distances refer to the nearest edge of the setup zone', () => {
    const input = fixture()
    setEvidence(input, [])
    input.snapshot.price = 103
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'approaching', distanceAtr: 0.5 })
    expect(buildWatchlistRows(input)[0].distancePercent).toBeCloseTo(100 / 103)
    input.evidence.structure.atr = null
    expect(buildWatchlistRows(input)[0].status).toBe('waiting')
    input.snapshot.price = 102.2
    expect(buildWatchlistRows(input)[0]).toMatchObject({ status: 'approaching', distanceAtr: null })
  })
})

describe('watchlist identity and ordering', () => {
  test('deduplicates the same source/setup while keeping distinct patterns', () => {
    const input = fixture()
    const setup = harmonic(input)
    input.harmonic.setups = [setup, { ...setup }, { ...setup, id: 'harmonic-2', kind: 'bat' }]
    const rows = buildWatchlistRows(input)
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
  })

  test('identities include market, timeframe and pair, and ordering is deterministic and immutable', () => {
    const confirmed = buildWatchlistRows(fixture())[0]
    const input = fixture()
    input.market = 'tradfi'
    input.symbol = 'XAUUSDT'
    input.feed.state = 'error'
    const delayed = buildWatchlistRows(input)[0]
    expect(delayed.id).toContain('tradfi:1m:XAUUSDT:')
    const rows = [delayed, { ...confirmed, id: `${confirmed.id}:2`, symbol: 'ETHUSDT' }, confirmed]
    const before = [...rows]
    expect(sortWatchlistRows(rows).map((row) => row.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'XAUUSDT'])
    expect(rows).toEqual(before)
    expect(sortWatchlistRows([...rows].reverse())).toEqual(sortWatchlistRows(rows))
  })
})

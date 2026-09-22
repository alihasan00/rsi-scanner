import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { analyzeMarketStructure, createMarketStructureTracker } from '../src/lib/marketStructure'
import type { MarketStructureOptions } from '../src/lib/marketStructure'

function bar(index: number, high: number, close = high - 0.5, low = 7): RsiBar {
  return { openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1, open: close, close, high, low, volume: 10, rsi: 50, isClosed: true }
}
const options: MarketStructureOptions = { pivotBars: 1, atrPeriod: 3, breakBufferAtr: 0, equalToleranceAtr: 0.1, retestToleranceAtr: 0.25 }
const seed = () => [bar(0, 9), bar(1, 10), bar(2, 9)]
const bullishBreak = () => [...seed(), bar(3, 10.7, 10.5, 10.1)]

describe('causal price structure', () => {
  test('strict pivots are unavailable until the right-hand candle closes', () => {
    const bars = seed()
    expect(analyzeMarketStructure(bars.slice(0, 2), options).levels).toHaveLength(0)
    const level = analyzeMarketStructure(bars, options).levels[0]
    expect(level).toMatchObject({ kind: 'swing', side: 'high', price: 10, pivotTimes: [60_000], confirmedAt: bars[2].closeTime, ageBars: 0 })
    expect(analyzeMarketStructure([...bars.slice(0, 2), { ...bars[2], isClosed: false }], options).levels).toHaveLength(0)
  })

  test('the default pivot requires all three later closes', () => {
    const bars = [9, 9.2, 9.4, 10, 9.4, 9.2, 9].map((high, index) => bar(index, high))
    expect(analyzeMarketStructure(bars.slice(0, 6)).levels).toHaveLength(0)
    expect(analyzeMarketStructure(bars).levels[0]).toMatchObject({ price: 10, pivotTimes: [180000], confirmedAt: 419999 })
  })

  test('equal plateaus and outside pivots are not strict directional swings', () => {
    expect(analyzeMarketStructure([bar(0, 9), bar(1, 10), bar(2, 10), bar(3, 9)], options).levels).toHaveLength(0)
    expect(analyzeMarketStructure([bar(0, 9), bar(1, 10, 9, 6), bar(2, 9)], options).levels).toHaveLength(0)
  })

  test('equal clusters appear at the second confirmation and suppress duplicate displayed swings', () => {
    const bars = [...seed(), bar(3, 9.4), bar(4, 9.95), bar(5, 9)]
    const earlier = analyzeMarketStructure(bars.slice(0, 5), options)
    expect(earlier.levels.some((level) => level.kind === 'equal')).toBe(false)
    const analysis = analyzeMarketStructure(bars, options)
    const equal = analysis.levels.find((level) => level.kind === 'equal')!
    expect(equal).toMatchObject({ pivotTimes: [60_000, 240_000], confirmedAt: bars[5].closeTime, price: 10, low: 9.95, high: 10 })
    expect(analysis.levels.filter((level) => level.supersededBy === null && level.side === 'high')).toHaveLength(1)
    expect(earlier.levels[0].supersededBy).toBeNull()
  })

  test('breach, reclaim and closed structural break are distinct observations', () => {
    const breach = analyzeMarketStructure([...seed(), bar(3, 10.5, 10, 9)], options)
    expect(breach.levels[0]).toMatchObject({ status: 'swept', sweptAt: 239999, reclaimedAt: null, brokenAt: null })
    expect(breach.events).toHaveLength(0)
    const reclaimed = analyzeMarketStructure([...seed(), bar(3, 10.5, 9.9, 9)], options)
    expect(reclaimed.levels[0].reclaimedAt).toBe(239999)
    expect(reclaimed.events).toHaveLength(0)
    const broken = analyzeMarketStructure(bullishBreak(), options)
    expect(broken.levels[0]).toMatchObject({ status: 'swept', reclaimedAt: null, brokenAt: 239999 })
    expect(broken.events[0]).toMatchObject({ type: 'bos', direction: 'bullish', confirmedAt: 239999, priorTrend: 'neutral' })
  })

  test('a later strict close back records a reclaim after a prior breach', () => {
    const analysis = analyzeMarketStructure([...seed(), bar(3, 10.5, 10, 9), bar(4, 9.8, 9.6, 9)], options)
    expect(analysis.levels[0].reclaimedAt).toBe(299999)
  })

  test('a close opposite the established structure becomes CHoCH', () => {
    const bars = [bar(0, 9, 8.5, 8), bar(1, 10, 9, 8), bar(2, 9.4, 8.8, 8.5), bar(3, 9.3, 8.7, 8.2), bar(4, 9.4, 8.8, 8.5), bar(5, 10.8, 10.5, 8.5), bar(6, 9, 8, 7.8)]
    const events = analyzeMarketStructure(bars, options).events
    expect(events.map((event) => [event.direction, event.type])).toEqual([['bullish', 'bos'], ['bearish', 'choch']])
  })

  test('break, retest and continuation require separate closed candles', () => {
    const bars = bullishBreak()
    const broken = analyzeMarketStructure(bars, options).retests[0]
    expect(broken.state).toBe('awaiting-retest')
    const touched = [...bars, bar(4, 10.6, 10.3, 10)]
    const retest = analyzeMarketStructure(touched, options).retests[0]
    expect(retest).toMatchObject({ state: 'retested', retestAt: 299999, continuationPrice: 10.6, confirmedAt: null })
    const analysis = analyzeMarketStructure([...touched, bar(5, 11.2, 10.9, 10.4)], options)
    expect(analysis.retests[0]).toMatchObject({ state: 'confirmed', confirmedAt: 359999, endedAt: 359999 })
  })

  test('wick invalidation wins a candle that also crosses continuation', () => {
    const bars = [...bullishBreak(), bar(4, 10.6, 10.3, 10)]
    const setup = analyzeMarketStructure(bars, options).retests[0]
    const analysis = analyzeMarketStructure([...bars, bar(5, 12, 11, setup.invalidationPrice - 0.01)], options)
    expect(analysis.retests[0]).toMatchObject({ state: 'invalidated', confirmedAt: null })
  })

  test('retests and continuations have independent explicit deadlines', () => {
    const bars = [...bullishBreak(), bar(4, 12, 11.8, 11.5), bar(5, 12, 11.8, 11.5), bar(6, 12, 11.8, 11.5)]
    expect(analyzeMarketStructure(bars, { ...options, retestTimeoutBars: 2 }).retests[0].state).toBe('expired')
    const retested = [...bullishBreak(), bar(4, 10.6, 10.3, 10), bar(5, 10.5, 10.3, 10), bar(6, 10.5, 10.3, 10), bar(7, 10.5, 10.3, 10)]
    expect(analyzeMarketStructure(retested, { ...options, continuationTimeoutBars: 2 }).retests[0].state).toBe('expired')
  })

  test('level aging is measured from confirmation and gaps reset context', () => {
    const bars = [...seed(), bar(3, 9), bar(4, 9), bar(5, 9)]
    expect(analyzeMarketStructure(bars, { ...options, maxLevelAgeBars: 2 }).levels[0]).toMatchObject({ status: 'expired', expiredAt: 359999, ageBars: 3 })
    expect(analyzeMarketStructure([...seed(), bar(5, 11)], options).levels).toHaveLength(0)
    expect(analyzeMarketStructure([...seed(), { ...bar(3, 11), isClosed: false }, bar(4, 11)], options).closedBarCount).toBe(1)
  })

  test('tail previews cannot change confirmed events or states', () => {
    const bars = [...bullishBreak(), bar(4, 10.6, 10.3, 10)]
    const result = analyzeMarketStructure(bars, options)
    expect(analyzeMarketStructure([...bars, { ...bar(5, 100, 50, 1), isClosed: false }], options)).toEqual(result)
  })

  test('every prefix observes the same already-confirmed break events', () => {
    const bars = [...bullishBreak(), bar(4, 10.6, 10.3, 10), bar(5, 11.2, 10.9, 10.4), bar(6, 11, 10.7, 10.4)]
    const complete = analyzeMarketStructure(bars, options)
    const withoutAge = (event: (typeof complete.events)[number]) => ({ ...event, ageBars: 0 })
    for (let end = 1; end <= bars.length; end++) {
      const prefix = analyzeMarketStructure(bars.slice(0, end), options)
      expect(prefix.events.map(withoutAge)).toEqual(complete.events.filter((event) => event.confirmedAt <= bars[end - 1].closeTime).map(withoutAge))
    }
  })

  test('rolling snapshots retain levels, ATR, events and corrections through the tracker', () => {
    const tracker = createMarketStructureTracker({ ...options, maxLevelAgeBars: 1000 })
    const bars = [...seed(), ...Array.from({ length: 510 }, (_, index) => bar(index + 3, 9))]
    let result = tracker.update(bars.slice(0, 20))
    for (let end = 21; end <= bars.length; end++) result = tracker.update(bars.slice(Math.max(0, end - 30), end))
    expect(result).toEqual(analyzeMarketStructure(bars, { ...options, maxLevelAgeBars: 1000 }))
    expect(result.levels[0].status).toBe('active')
    const corrected = bars.map((item, index) => index === bars.length - 2 ? { ...item, high: 12, close: 11, open: 11 } : item)
    expect(tracker.update(corrected.slice(-30))).toEqual(analyzeMarketStructure(corrected, { ...options, maxLevelAgeBars: 1000 }))
    expect(tracker.update([bar(1000, 10)]).historyReset).toBe(true)
    tracker.reset()
    expect(tracker.update(seed()).historyReset).toBe(false)
  })

  test('a cached candle cannot fill an explicit interior interruption', () => {
    const tracker = createMarketStructureTracker(options)
    const bars = [...bullishBreak(), bar(4, 10.6, 10.3, 10), bar(5, 11.2, 10.9, 10.4)]
    tracker.update(bars)
    const interrupted = bars.map((item, index) => index === 4 ? { ...item, isClosed: false } : item)
    const result = tracker.update(interrupted)
    expect(result.historyReset).toBe(true)
    expect(result.closedBarCount).toBe(1)
    expect(result.levels).toHaveLength(0)
  })

  test('unchanged completed snapshots and live revisions reuse the previous analysis', () => {
    const tracker = createMarketStructureTracker(options)
    const bars = [...bullishBreak(), bar(4, 10.6, 10.3, 10)]
    const first = tracker.update(bars)
    expect(tracker.update(bars.map((item) => ({ ...item })))).toBe(first)
    expect(tracker.update([...bars.slice(-3), { ...bar(5, 12), isClosed: false }])).toBe(first)
    const corrected = bars.map((item, index) => index === 4 ? { ...item, volume: 11 } : item)
    expect(tracker.update(corrected)).not.toBe(first)
  })

  test('session history caps are explicit and retain more than the configured active lifecycle', () => {
    const short = { ...options, maxLevelAgeBars: 4, volumePeriod: 2, retestTimeoutBars: 2, continuationTimeoutBars: 2 }
    const tracker = createMarketStructureTracker(short, 32)
    const bars = Array.from({ length: 33 }, (_, index) => bar(index, index === 30 ? 10 : 9))
    tracker.update(bars.slice(0, 32))
    const result = tracker.update(bars.slice(-20))
    expect(result.historyReset).toBe(true)
    expect(result.historyResetReason).toBe('history-limit')
    expect(result.closedBarCount).toBe(16)
    expect(result.levels.find((level) => level.pivotTimes[0] === bars[30].openTime)).toMatchObject({ status: 'active', confirmedAt: bars[31].closeTime })
    expect(tracker.update(bars.slice(-10))).toBe(result)
  })

  test('bearish retest and continuation mirror the bullish lifecycle', () => {
    const bars = [...bullishBreak(), bar(4, 10.6, 10.3, 10), bar(5, 11.2, 10.9, 10.4)]
    const mirrored = bars.map((item) => ({ ...item, open: 30 - item.open, high: 30 - item.low, low: 30 - item.high, close: 30 - item.close }))
    const analysis = analyzeMarketStructure(mirrored, options)
    expect(analysis.events[0].direction).toBe('bearish')
    expect(analysis.retests[0]).toMatchObject({ state: 'confirmed', confirmedAt: bars[5].closeTime, direction: 'bearish' })
  })

  test('price scaling preserves levels, event timing and normalized tolerances', () => {
    const bars = [...bullishBreak(), bar(4, 10.6, 10.3, 10), bar(5, 11.2, 10.9, 10.4)]
    const scale = 1000
    const scaled = bars.map((item) => ({ ...item, open: item.open * scale, high: item.high * scale, low: item.low * scale, close: item.close * scale }))
    const original = analyzeMarketStructure(bars, options)
    const actual = analyzeMarketStructure(scaled, options)
    expect(actual.events.map((event) => [event.type, event.direction, event.confirmedAt])).toEqual(original.events.map((event) => [event.type, event.direction, event.confirmedAt]))
    expect(actual.retests[0].state).toBe(original.retests[0].state)
    expect(actual.retests[0].invalidationPrice).toBeCloseTo(original.retests[0].invalidationPrice * scale)
  })

  test('rejects invalid options', () => {
    expect(() => analyzeMarketStructure([], { pivotBars: 0 })).toThrow()
    expect(() => analyzeMarketStructure([], { equalToleranceAtr: -1 })).toThrow()
  })
})

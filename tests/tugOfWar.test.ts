import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import { analyzeTugOfWar, liveTugOfWarPresentation, previewTugOfWar, tugOfWarPresentation } from '../src/lib/tugOfWar'

type Ohlc = [number, number, number, number]

function candle(minute: number, [open, high, low, close]: Ohlc, isClosed = true): RsiBar {
  return { openTime: minute * 60_000, closeTime: (minute + 1) * 60_000 - 1, open, high, low, close, volume: 10, rsi: 50, isClosed }
}

function warmup(count = 20): RsiBar[] {
  return Array.from({ length: count }, (_, index) => candle(index, [100, 100, 100, 100]))
}

function bullishThenTow(): RsiBar[] {
  return [
    ...warmup(),
    candle(20, [100, 140, 100, 135]),
    candle(21, [112, 125, 100, 115]),
    candle(22, [113, 125, 100, 115]),
  ]
}

function reflect(bar: RsiBar): RsiBar {
  return { ...bar, open: 200 - bar.open, high: 200 - bar.low, low: 200 - bar.high, close: 200 - bar.close }
}

describe('analyzeTugOfWar', () => {
  test('converts the same hand-calculated recursive HA candles as the CLI', () => {
    const raw = [
      candle(0, [100, 112, 96, 110]),
      candle(1, [110, 124, 108, 122]),
      candle(2, [90, 96, 80, 84]),
      candle(3, [85, 99, 82, 98]),
    ]
    const before = structuredClone(raw)
    const result = analyzeTugOfWar(raw)

    expect(result.heikinAshi.map((bar) => [bar.open, bar.high, bar.low, bar.close, bar.body, bar.upperWick, bar.lowerWick])).toEqual([
      [105, 112, 96, 104.5, 0.5, 7, 8.5],
      [104.75, 124, 104.75, 116, 11.25, 8, 0],
      [110.375, 110.375, 80, 87.5, 22.875, 0, 7.5],
      [98.9375, 99, 82, 91, 7.9375, 0.0625, 9],
    ])
    // The final tiny upper wick is absent under the 5% screening threshold.
    expect(result.control).toBe('bearish')
    expect(result.heikinAshi.map((bar) => bar.startsNewSegment)).toEqual([true, false, false, false])
    expect(raw).toEqual(before)
  })

  test('counts TOW without treating remembered trend as present control', () => {
    const result = analyzeTugOfWar(bullishThenTow())

    expect(result.control).toBe('tugOfWar')
    expect(result.trend).toBe('bullish')
    expect(result.pendingTowCandles).toBe(2)
    expect(result.confirmation).toBeNull()
    expect(result.isWarmup).toBe(false)
  })

  test('confirms continuations and reversals in both directions using raw close prices', () => {
    for (const startBullish of [true, false]) {
      for (const endBullish of [true, false]) {
        const prefix = startBullish ? bullishThenTow() : bullishThenTow().map(reflect)
        const resolution = candle(23, endBullish ? [115, 150, 115, 145] : [85, 85, 50, 55])
        const result = analyzeTugOfWar([...prefix, resolution])

        expect(result.confirmation).toEqual({
          direction: endBullish ? 'bullish' : 'bearish',
          kind: startBullish === endBullish ? 'continuation' : 'reversal',
          towStartTime: 21 * 60_000,
          towCandleCount: 2,
          confirmedAt: 24 * 60_000 - 1,
          referencePrice: resolution.close,
        })
        expect(result.confirmation?.referencePrice).not.toBe(result.heikinAshi.at(-1)?.close)
        expect(result.control).toBe(endBullish ? 'bullish' : 'bearish')
        expect(result.trend).toBe(result.control)
        expect(result.pendingTowCandles).toBe(0)
      }
    }
  })

  test('a provisional resolution cannot confirm or alter closed analysis', () => {
    const prefix = bullishThenTow()
    const forming = candle(23, [115, 150, 115, 145], false)
    const result = analyzeTugOfWar([...prefix, forming])

    expect(result).toEqual({ ...analyzeTugOfWar(prefix), excludedOpenCandles: 1 })
    expect(result.lastClose).toBe(115)
    expect(result.heikinAshi).toHaveLength(prefix.length)
    expect(analyzeTugOfWar([...prefix, { ...forming, isClosed: true }]).confirmation).not.toBeNull()
  })

  test('does not repeat an earlier confirmation as the latest signal', () => {
    const confirmed = [...bullishThenTow(), candle(23, [115, 150, 115, 145])]
    expect(analyzeTugOfWar(confirmed).confirmation).not.toBeNull()

    const result = analyzeTugOfWar([...confirmed, candle(24, [145, 180, 145, 175])])
    expect(result.control).toBe('bullish')
    expect(result.confirmation).toBeNull()
  })

  test('suppresses the first twenty candles but retains state across the warmup boundary', () => {
    const prefix = [
      ...warmup(17),
      candle(17, [100, 140, 100, 135]),
      candle(18, [112, 125, 100, 115]),
      candle(19, [113, 125, 100, 115]),
    ]
    const warming = analyzeTugOfWar(prefix)
    expect(warming.isWarmup).toBe(true)
    expect(warming.trend).toBe('bullish')
    expect(warming.pendingTowCandles).toBe(2)

    const result = analyzeTugOfWar([...prefix, candle(20, [115, 150, 115, 145])])
    expect(result.isWarmup).toBe(false)
    expect(result.confirmation?.kind).toBe('continuation')

    // Move the entire decision one candle earlier: it resolves during warmup.
    const earlier = prefix.slice(1).map((bar, index) => ({ ...bar, openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1 }))
    const suppressed = analyzeTugOfWar([...earlier, candle(19, [115, 150, 115, 145])])
    expect(suppressed.isWarmup).toBe(true)
    expect(suppressed.confirmation).toBeNull()
    expect(suppressed.trend).toBe('bullish')
    expect(suppressed.pendingTowCandles).toBe(0)
  })

  test('resets HA, warmup, pending TOW, and trend after a history gap', () => {
    const result = analyzeTugOfWar([...bullishThenTow(), candle(24, [200, 210, 190, 200])])

    expect(result.gapCount).toBe(1)
    expect(result.heikinAshi.at(-1)?.open).toBe(200)
    expect(result.heikinAshi.at(-1)?.startsNewSegment).toBe(true)
    expect(result.isWarmup).toBe(true)
    expect(result.segmentCandles).toBe(1)
    expect(result.control).toBe('tugOfWar')
    expect(result.trend).toBeNull()
    expect(result.pendingTowCandles).toBe(1)
    expect(result.confirmation).toBeNull()
  })

  test('resolves a single TOW candle silently under the minimum two-candle filter', () => {
    const prefix = bullishThenTow().slice(0, -1)
    const result = analyzeTugOfWar([...prefix, candle(22, [115, 150, 115, 145])])

    expect(result.control).toBe('bullish')
    expect(result.trend).toBe('bullish')
    expect(result.pendingTowCandles).toBe(0)
    expect(result.confirmation).toBeNull()
  })

  test('skips neutral and weak directional candles without losing or inflating pending TOW', () => {
    const prefix = [
      ...warmup(),
      candle(20, [100, 120, 100, 100]),
      candle(21, [103, 140, 103, 135]),
      candle(22, [112, 125, 100, 115]),
      candle(23, [113, 125, 100, 115]),
    ]
    // Known HA midpoint from the independently hand-calculated CLI fixture.
    const neutral = candle(24, [112.71875, 112.71875, 112.71875, 112.71875])
    const neutralResult = analyzeTugOfWar([...prefix, neutral])
    expect(neutralResult.control).toBe('neutral')
    expect(neutralResult.pendingTowCandles).toBe(2)
    expect(neutralResult.trend).toBe('bullish')
    expect(neutralResult.confirmation).toBeNull()

    const weak = candle(25, [112.71875, 113.71875, 112.71875, 112.71875])
    const weakResult = analyzeTugOfWar([...prefix, neutral, weak])
    expect(weakResult.control).toBe('bullish')
    expect(weakResult.pendingTowCandles).toBe(2)
    expect(weakResult.trend).toBe('bullish')
    expect(weakResult.confirmation).toBeNull()

    const result = analyzeTugOfWar([...prefix, neutral, weak, candle(26, [113, 150, 113, 145])])
    expect(result.confirmation?.kind).toBe('continuation')
    expect(result.confirmation?.towCandleCount).toBe(2)
    expect(result.confirmation?.towStartTime).toBe(22 * 60_000)
  })

  test('a resolution without prior accepted direction is undetermined', () => {
    const result = analyzeTugOfWar([
      ...warmup(),
      candle(20, [100, 110, 90, 100]),
      candle(21, [100, 110, 90, 100]),
      candle(22, [115, 150, 115, 145]),
    ])

    expect(result.confirmation?.kind).toBe('undetermined')
    expect(result.confirmation?.direction).toBe('bullish')
  })

  test('returns an unavailable summary with no closed history', () => {
    for (const bars of [[], [candle(0, [100, 110, 90, 100], false)]]) {
      const result = analyzeTugOfWar(bars)
      expect(result.control).toBeNull()
      expect(result.trend).toBeNull()
      expect(result.confirmation).toBeNull()
      expect(result.lastClosedTime).toBeNull()
      expect(result.lastClose).toBeNull()
      expect(result.heikinAshi).toEqual([])
    }
  })

  test('rejects invalid and overlapping prices before they can produce signals', () => {
    expect(() => analyzeTugOfWar([candle(0, [100, 90, 80, 100])])).toThrow('Invalid tug-of-war candle')
    expect(() => analyzeTugOfWar([candle(0, [100, Infinity, 90, 100])])).toThrow('Invalid tug-of-war candle')
    expect(() => analyzeTugOfWar([candle(0, [100, 110, 90, 100]), candle(0, [100, 110, 90, 100])])).toThrow('chronological')
  })
})

describe('tugOfWarPresentation', () => {
  test('presents data, warmup, pending TOW, and latest confirmation without stale signals', () => {
    expect(tugOfWarPresentation(analyzeTugOfWar([])).tone).toBe('neutral')
    expect(tugOfWarPresentation(analyzeTugOfWar(warmup(5))).label).toBe('Warming up')
    expect(tugOfWarPresentation(analyzeTugOfWar(bullishThenTow()))).toEqual({
      label: 'Tug of war', tone: 'pending', detail: '2 undecided candles · awaiting control',
    })
    const confirmation = analyzeTugOfWar([...bullishThenTow(), candle(23, [90, 95, 50, 55])])
    expect(tugOfWarPresentation(confirmation)).toEqual({
      label: 'Bearish reversal', tone: 'bearish', detail: 'Confirmed on latest close · 2 TOW candles',
    })
  })

  test('does not present a weak directional candle as accepted control', () => {
    const weak = analyzeTugOfWar([...warmup(), candle(20, [100, 120, 100, 100])])
    expect(weak.control).toBe('bullish')
    expect(weak.trend).toBeNull()
    expect(tugOfWarPresentation(weak)).toEqual({
      label: 'Sideways', tone: 'sideways', detail: 'Latest candle lacks a strong enough body',
    })
  })
})

describe('previewTugOfWar', () => {
  test('a live fall changes current control before the candle closes', () => {
    const prefix = [...warmup(), candle(20, [100, 140, 100, 135])]
    const closed = analyzeTugOfWar(prefix)
    const early = candle(21, [110, 110.5, 107, 110], false)
    const falling = candle(21, [110, 110.5, 60, 62], false)

    expect(closed.control).toBe('bullish')
    expect(previewTugOfWar([...prefix, early], closed)?.control).toBe('tugOfWar')
    const preview = previewTugOfWar([...prefix, falling], closed)!
    expect(preview.control).toBe('bearish')
    expect(preview.isBodyQualified).toBe(true)
    expect(preview.heikinAshi.isClosed).toBe(false)
    expect(preview.heikinAshi.open).toBe(109.375)
    expect(preview.openTime).toBe(falling.openTime)
    expect(preview.closeTime).toBe(falling.closeTime)
    expect(preview.possibleResolution).toBeNull()
    expect(liveTugOfWarPresentation(preview)).toEqual({
      label: 'Bearish control', tone: 'bearish', detail: 'Live candle · still forming',
    })
    expect(analyzeTugOfWar([...prefix, falling]).control).toBe('bullish')
  })

  test('includes the open TOW candle once without changing closed pending state', () => {
    const prefix = bullishThenTow()
    const closed = analyzeTugOfWar(prefix)
    const bars = [...prefix, candle(23, [113, 125, 100, 115], false)]
    const preview = previewTugOfWar(bars, closed)!

    expect(preview.control).toBe('tugOfWar')
    expect(preview.pendingTowCandles).toBe(3)
    expect(preview.trend).toBe('bullish')
    expect(preview.possibleResolution).toBeNull()
    expect(previewTugOfWar(bars, closed)?.pendingTowCandles).toBe(3)
    expect(closed.pendingTowCandles).toBe(2)
    expect(liveTugOfWarPresentation(preview)).toEqual({
      label: 'Tug of war', tone: 'pending', detail: 'Live candle · still forming · 3 TOW candles awaiting control',
    })
  })

  test('reports possible continuations and reversals without any confirmation', () => {
    for (const startBullish of [true, false]) {
      for (const endBullish of [true, false]) {
        const prefix = startBullish ? bullishThenTow() : bullishThenTow().map(reflect)
        const raw = candle(23, endBullish ? [115, 150, 115, 145] : [85, 85, 50, 55], false)
        const preview = previewTugOfWar([...prefix, raw])!
        const direction = endBullish ? 'bullish' : 'bearish'
        const kind = startBullish === endBullish ? 'continuation' : 'reversal'

        expect(preview.possibleResolution).toEqual({ direction, kind, towCandleCount: 2 })
        expect(preview.pendingTowCandles).toBe(0)
        expect(preview.trend).toBe(direction)
        expect(preview).not.toHaveProperty('confirmation')
        expect(preview).not.toHaveProperty('confirmedAt')
        expect(preview.possibleResolution).not.toHaveProperty('confirmedAt')
        expect(liveTugOfWarPresentation(preview)).toEqual({
          label: `${endBullish ? 'Bullish' : 'Bearish'} control`,
          tone: direction,
          detail: `Live candle · still forming · possible ${direction} ${kind} after 2 TOW candles`,
        })

        // The same shape becomes confirmation only after the feed closes it.
        const actualClose = analyzeTugOfWar([...prefix, { ...raw, isClosed: true }])
        expect(actualClose.control).toBe(preview.control)
        expect(actualClose.trend).toBe(preview.trend)
        expect(actualClose.pendingTowCandles).toBe(preview.pendingTowCandles)
        expect(actualClose.isWarmup).toBe(preview.isWarmup)
        expect(actualClose.heikinAshi.at(-1)).toEqual({ ...preview.heikinAshi, isClosed: true })
        expect(actualClose.confirmation?.confirmedAt).toBe(raw.closeTime)
      }
    }
  })

  test('resets the live HA seed, pending state, and warmup after a gap', () => {
    const prefix = bullishThenTow()
    const closed = analyzeTugOfWar(prefix)
    const preview = previewTugOfWar([...prefix, candle(24, [200, 210, 190, 200], false)], closed)!

    expect(preview.heikinAshi.open).toBe(200)
    expect(preview.heikinAshi.startsNewSegment).toBe(true)
    expect(preview.isWarmup).toBe(true)
    expect(preview.control).toBe('tugOfWar')
    expect(preview.trend).toBeNull()
    expect(preview.pendingTowCandles).toBe(1)
    expect(preview.possibleResolution).toBeNull()
    expect(liveTugOfWarPresentation(preview).detail).toContain('HA warmup')
    expect(closed.trend).toBe('bullish')
    expect(closed.pendingTowCandles).toBe(2)
  })

  test('weak directional bodies preserve pending TOW without presenting accepted control', () => {
    const prefix = bullishThenTow()
    const closed = analyzeTugOfWar(prefix)
    const previous = closed.heikinAshi.at(-1)!
    const open = (previous.open + previous.close) / 2
    const weak = candle(23, [open, open + 1, open, open], false)
    const preview = previewTugOfWar([...prefix, weak], closed)!

    expect(preview.control).toBe('bullish')
    expect(preview.isBodyQualified).toBe(false)
    expect(preview.pendingTowCandles).toBe(2)
    expect(preview.trend).toBe('bullish')
    expect(preview.possibleResolution).toBeNull()
    expect(liveTugOfWarPresentation(preview)).toEqual({
      label: 'Sideways', tone: 'sideways',
      detail: 'Live candle · still forming · 2 TOW candles awaiting control · body is not strong enough',
    })
  })

  test('keeps frozen closed analysis and source candles unchanged across ticks', () => {
    const prefix = bullishThenTow()
    const closed = analyzeTugOfWar(prefix)
    const before = structuredClone(closed)
    for (const bar of closed.heikinAshi) Object.freeze(bar)
    Object.freeze(closed.heikinAshi)
    Object.freeze(closed)
    const bars = [...prefix, candle(23, [115, 150, 115, 145], false)]
    const barsBefore = structuredClone(bars)
    for (const bar of bars) Object.freeze(bar)
    Object.freeze(bars)

    expect(previewTugOfWar(bars, closed)?.possibleResolution?.kind).toBe('continuation')
    expect(previewTugOfWar(bars, closed)?.possibleResolution?.towCandleCount).toBe(2)
    expect(closed).toEqual(before)
    expect(bars).toEqual(barsBefore)
  })

  test('does not replay older history when a closed analysis is supplied', () => {
    const prefix = bullishThenTow()
    const closed = analyzeTugOfWar(prefix)
    const bars = [...prefix, candle(23, [115, 150, 115, 145], false)]
    const guarded = new Proxy(bars, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) < target.length - 2) {
          throw new Error('Older history was read during a cached live preview')
        }
        return Reflect.get(target, property, receiver)
      },
    })
    expect(previewTugOfWar(guarded, closed)?.possibleResolution?.kind).toBe('continuation')
  })

  test('uses the same warmup boundary and minimum TOW count as closed decisions', () => {
    const prefix = [
      ...warmup(17),
      candle(17, [100, 140, 100, 135]),
      candle(18, [112, 125, 100, 115]),
      candle(19, [113, 125, 100, 115]),
    ]
    expect(previewTugOfWar([...prefix, candle(20, [115, 150, 115, 145], false)])?.possibleResolution?.kind).toBe('continuation')
    const earlier = prefix.slice(1).map((bar, index) => ({ ...bar, openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1 }))
    const warming = previewTugOfWar([...earlier, candle(19, [115, 150, 115, 145], false)])!
    expect(warming.isWarmup).toBe(true)
    expect(warming.possibleResolution).toBeNull()
    const short = previewTugOfWar([...bullishThenTow().slice(0, -1), candle(22, [115, 150, 115, 145], false)])!
    expect(short.possibleResolution).toBeNull()
    expect(short.pendingTowCandles).toBe(0)
  })

  test('seeds an initial open candle but returns null when no current preview exists', () => {
    for (const bars of [[], warmup(), [candle(0, [100, 110, 90, 100], false), candle(1, [100, 110, 90, 100])]]) {
      expect(previewTugOfWar(bars)).toBeNull()
    }
    const preview = previewTugOfWar([candle(0, [100, 110, 90, 100], false)])!
    expect(preview.heikinAshi.open).toBe(100)
    expect(preview.heikinAshi.startsNewSegment).toBe(true)
    expect(preview.isWarmup).toBe(true)
    expect(preview.pendingTowCandles).toBe(1)
    expect(preview.possibleResolution).toBeNull()
  })

  test('still rejects an invalid or overlapping live candle with cached history', () => {
    const prefix = bullishThenTow()
    const closed = analyzeTugOfWar(prefix)
    expect(() => previewTugOfWar([...prefix, candle(23, [100, 90, 80, 100], false)], closed)).toThrow('Invalid tug-of-war candle')
    expect(() => previewTugOfWar([...prefix, candle(22, [100, 110, 90, 100], false)], closed)).toThrow('chronological')
  })
})

import { describe, expect, test } from 'bun:test'
import type { RsiBar } from '../src/types'
import {
  DEFAULT_RSI_TRENDLINE_OPTIONS,
  findRsiTrendlines,
  isVisibleRsiTrendline,
  trendlineRsiAtTime,
} from '../src/lib/rsiTrendlines'
import type { RsiTrendline, RsiTrendlineOptions } from '../src/lib/rsiTrendlines'

const START = 1_700_000_000_000
const PERIOD = 60_000

function bar(index: number, rsi: number, patch: Partial<RsiBar> = {}): RsiBar {
  return {
    openTime: START + index * PERIOD,
    closeTime: START + (index + 1) * PERIOD - 1,
    open: 110, close: 109, low: 105, high: 115, volume: 100,
    rsi, isClosed: true,
    ...patch,
  }
}

/** Anchors 6/16, formed on close 21. Resistance falls by 0.6 RSI per bar. */
function resistance(): RsiBar[] {
  return [45, 52, 56, 60, 65, 70, 80, 72, 68, 64, 62, 65, 67, 68, 69, 70, 74, 68, 66, 64, 62, 60]
    .map((rsi, index) => bar(index, rsi))
}

function mirror(bars: readonly RsiBar[]): RsiBar[] {
  return bars.map((sample) => ({ ...sample, rsi: 100 - sample.rsi }))
}

function support(): RsiBar[] {
  return mirror(resistance())
}

function original(bars: readonly RsiBar[], options: Partial<RsiTrendlineOptions> = {}): RsiTrendline | undefined {
  return findRsiTrendlines(bars, options).find((line) => line.start.time === START + 6 * PERIOD && line.end.time === START + 16 * PERIOD)
}

function appendAboveSupport(bars: RsiBar[], throughIndex: number) {
  while (bars.length <= throughIndex) {
    const index = bars.length
    bars.push(bar(index, Math.min(99, 20 + (index - 6) * 0.6 + 5)))
  }
}

describe('mature same-cycle RSI trendline formation', () => {
  test('publishes conservative, explicitly configurable scanner conventions', () => {
    expect(DEFAULT_RSI_TRENDLINE_OPTIONS).toEqual({
      leftBars: 5, rightBars: 5, minAnchorBars: 5, minAnchorChange: 3,
      minSlope: 0.05, maxSlope: 1.5, touchTolerance: 0.5, breakMargin: 0.5,
      approachDistance: 2, activeBars: 120, brokenRelevanceBars: 12,
    })
  })

  test.each([false, true])('waits for five closed candles after the second strict pivot (support=%p)', (low) => {
    const bars = low ? support() : resistance()
    expect(findRsiTrendlines(bars.slice(0, 21))).toEqual([])
    const line = original(bars)!
    expect(line).toMatchObject({
      kind: low ? 'support' : 'resistance',
      start: { time: bars[6].openTime, rsi: low ? 20 : 80 },
      end: { time: bars[16].openTime, rsi: low ? 26 : 74 },
      formedAt: bars[21].closeTime,
      state: 'formed', touches: 2, brokenAt: null, breakTime: null,
      breakRsi: null, breakGrade: null, resolvedAt: null, warningActive: false,
    })
    expect(isVisibleRsiTrendline(line)).toBe(true)
    bars[21].isClosed = false
    expect(findRsiTrendlines(bars)).toEqual([])
  })

  test('excludes an incomplete cycle at the left edge of retained history', () => {
    expect(findRsiTrendlines(resistance().slice(1))).toEqual([])
    const knownBoundary = resistance()
    knownBoundary[0].rsi = 50
    expect(original(knownBoundary)).toBeDefined()
  })

  test.each([50, 49])('a midline touch/cross between anchors prevents mixing cycles (%p)', (rsi) => {
    const bars = resistance()
    bars[11].rsi = rsi
    expect(findRsiTrendlines(bars)).toEqual([])
  })

  test.each([5, 15, 17])('rejects equal plateaus in either anchor window (%p)', (index) => {
    const bars = resistance()
    bars[index].rsi = index === 5 ? 80 : 74
    expect(original(bars)).toBeUndefined()
  })

  test('requires the first anchor to be the cycle extreme and a mature pivot', () => {
    const bars = resistance()
    bars[1].rsi = 90 // Known extreme has no complete five-bar left window.
    expect(findRsiTrendlines(bars)).toEqual([])
  })

  test('requires meaningful movement and avoids steep lines', () => {
    const flat = resistance().map((sample) => ({ ...sample, rsi: sample.rsi > 50 ? 55 + (sample.rsi - 50) / 10 : 45 }))
    expect(findRsiTrendlines(flat)).toEqual([])
    const steep = [45, 52, 56, 60, 65, 70, 80, 72, 68, 64, 62, 54, 55, 56, 57, 58, 60, 55, 54, 53, 52, 51]
      .map((rsi, index) => bar(index, rsi))
    expect(findRsiTrendlines(steep)).toEqual([])
    expect(findRsiTrendlines(resistance(), { minSlope: 0.7 })).toEqual([])
    expect(findRsiTrendlines(resistance(), { minAnchorBars: 11 })).toEqual([])
  })

  test.each([12, 20, 21])('does not draw through an earlier violation or backfill its break (index=%p)', (index) => {
    const bars = resistance()
    bars[index].rsi = index === 12 ? 78 : 73
    expect(original(bars)).toBeUndefined()
  })

  test('counts a third mature contact without moving the original anchors', () => {
    const bars = resistance()
    ;[61, 62, 64, 66, 68, 65, 64, 63, 61, 59].forEach((rsi) => bars.push(bar(bars.length, rsi)))
    const before = original(bars.slice(0, -1))!
    const after = original(bars)!
    expect(before.touches).toBe(2)
    expect(after.touches).toBe(3)
    expect(after.id).toBe(before.id)
    expect(after.end).toEqual({ time: bars[16].openTime, rsi: 74 })
    expect(after.formedAt).toBe(bars[21].closeTime)
    expect(findRsiTrendlines(bars)).toHaveLength(1)
  })

  test('preserves a superseded ray when a later tangent remains within the original contact tolerance', () => {
    const bars = resistance()
    while (bars.length < 31) bars.push(bar(bars.length, 55))
    const nextContact = [54, 55, 56, 57, 58, 61, 57, 56, 55, 54, 53]
    nextContact.forEach((rsi) => bars.push(bar(bars.length, rsi)))
    const lines = findRsiTrendlines(bars)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ state: 'superseded', brokenAt: null, resolvedAt: bars[41].closeTime })
    expect(lines[1]).toMatchObject({
      state: 'formed', start: { time: bars[6].openTime }, end: { time: bars[36].openTime },
      formedAt: bars[41].closeTime, touches: 3,
    })
    expect(isVisibleRsiTrendline(lines[0])).toBe(false)
    expect(isVisibleRsiTrendline(lines[1])).toBe(true)
  })
})

describe('closed-candle breaks, grading, and warnings', () => {
  test.each([false, true])('moves from formed to approaching to a same-side break (support=%p)', (low) => {
    const bars = resistance()
    bars.push(bar(22, 69))
    const transform = () => low ? mirror(bars) : bars
    expect(original(transform())).toMatchObject({ state: 'approaching', brokenAt: null })
    bars.push(bar(23, 71))
    const line = original(transform())!
    expect(line).toMatchObject({
      state: 'broken', brokenAt: bars[23].closeTime, breakTime: bars[23].openTime,
      breakRsi: low ? 29 : 71, breakGrade: 'same-side',
      resolvedAt: bars[23].closeTime, barsSinceBreak: 0, warningActive: low,
      breakId: `${line.id}:break:${bars[23].openTime}`,
    })
  })

  test('requires more than the break margin, and a trailing live crossing does nothing', () => {
    const bars = resistance()
    const line = original(bars)!
    const ray = trendlineRsiAtTime(line, START + 22 * PERIOD)
    bars.push(bar(22, ray + 0.5))
    expect(original(bars)?.brokenAt).toBeNull()
    bars[22].rsi = ray + 0.6
    bars[22].isClosed = false
    expect(findRsiTrendlines(bars)).toEqual(findRsiTrendlines(bars.slice(0, -1)))
    bars[22].isClosed = true
    expect(original(bars)?.brokenAt).toBe(bars[22].closeTime)
  })

  test.each([false, true])('retains a line across 50 until its ideal break (support=%p)', (low) => {
    const bars = support()
    appendAboveSupport(bars, 59)
    const transform = () => low ? bars : mirror(bars)
    const formed = original(transform())!
    expect(formed.brokenAt).toBeNull()
    expect(isVisibleRsiTrendline(formed)).toBe(true)
    bars.push(bar(60, 51)) // Projected support is 52.4, with RSI still above 50.
    expect(original(transform())).toMatchObject({
      state: 'broken', breakGrade: 'ideal', breakRsi: low ? 51 : 49,
      warningActive: low, brokenAt: bars[60].closeTime,
    })
  })

  test('grades a break exactly at 50 conservatively', () => {
    const bars = support()
    appendAboveSupport(bars, 56)
    bars.push(bar(57, 50)) // Ray = 50.6, so this exceeds the break margin.
    expect(original(bars)).toMatchObject({ state: 'broken', breakGrade: 'same-side', breakRsi: 50 })
  })

  test('reclaim closes remove the bearish warning while retaining the original break', () => {
    const bars = support()
    bars.push(bar(22, 28))
    const broken = original(bars)!
    expect(broken.warningActive).toBe(true)
    bars.push(bar(23, 31, { isClosed: false }))
    expect(original(bars)?.warningActive).toBe(true)
    bars[23].isClosed = true
    const reclaimed = original(bars)!
    expect(reclaimed).toMatchObject({ state: 'broken', warningActive: false, reclaimedAt: bars[23].closeTime, barsSinceBreak: 1 })
    expect(isVisibleRsiTrendline(reclaimed)).toBe(true)
    bars.push(bar(24, 25))
    const crossedAgain = original(bars)!
    expect(crossedAgain.warningActive).toBe(false)
    expect(crossedAgain.breakId).toBe(broken.breakId)
    expect(crossedAgain.brokenAt).toBe(broken.brokenAt)
    expect(crossedAgain.resolvedAt).toBe(broken.resolvedAt)
  })

  test('counts only closed bars toward broken relevance and then preserves the expired event', () => {
    const bars = support()
    bars.push(bar(22, 28))
    for (let index = 23; index <= 33; index++) bars.push(bar(index, 25))
    expect(original(bars)).toMatchObject({ state: 'broken', barsSinceBreak: 11, warningActive: true })
    bars.push(bar(34, 25, { isClosed: false }))
    expect(original(bars)?.state).toBe('broken')
    bars[34].isClosed = true
    const expired = original(bars)!
    expect(expired).toMatchObject({
      state: 'expired', barsSinceBreak: 12, warningActive: false,
      brokenAt: bars[22].closeTime, resolvedAt: bars[22].closeTime,
    })
    expect(isVisibleRsiTrendline(expired)).toBe(false)
  })

  test('an unbroken line expires at its configured active age', () => {
    const bars = support()
    appendAboveSupport(bars, 25)
    expect(original(bars, { activeBars: 5 })?.state).toBe('formed')
    appendAboveSupport(bars, 26)
    expect(original(bars, { activeBars: 5 })).toMatchObject({ state: 'expired', brokenAt: null, resolvedAt: bars[26].closeTime })
  })
})

describe('history continuity and causal records', () => {
  test.each(['gap', 'invalid', 'interior-live'] as const)('interrupts open warnings across %s data and rejects incomplete replacement cycles', (problem) => {
    const bars = support()
    bars.push(bar(22, 28))
    if (problem === 'gap') bars.push(bar(24, 20))
    else bars.push(bar(23, problem === 'invalid' ? Number.NaN : 20, { isClosed: problem !== 'interior-live' }))
    bars.push(bar(problem === 'gap' ? 25 : 24, 20))
    const line = original(bars)!
    expect(line).toMatchObject({ state: 'interrupted', warningActive: false, brokenAt: bars[22].closeTime })
    expect(isVisibleRsiTrendline(line)).toBe(false)
    expect(findRsiTrendlines(bars)).toHaveLength(1)
  })

  test('can start a new complete cycle after a missing-data segment', () => {
    const first = resistance()
    const later = resistance().map((sample) => ({ ...sample, openTime: sample.openTime + 40 * PERIOD, closeTime: sample.closeTime + 40 * PERIOD }))
    const lines = findRsiTrendlines([...first, ...later])
    expect(lines).toHaveLength(2)
    expect(lines[0].state).toBe('interrupted')
    expect(lines[1]).toMatchObject({ state: 'formed', formedAt: later[21].closeTime })
  })

  test('never replaces old anchors with a future cycle extreme', () => {
    const bars = resistance()
    const first = original(bars)!
    bars.push(bar(22, 90))
    for (let index = 23; index <= 28; index++) bars.push(bar(index, 60))
    const later = original(bars)!
    expect(later.id).toBe(first.id)
    expect(later.start).toEqual(first.start)
    expect(later.end).toEqual(first.end)
    expect(later.formedAt).toBe(first.formedAt)
    expect(later.brokenAt).toBe(bars[22].closeTime)
  })

  test('all appended-prefix formations and break events agree with the final history', () => {
    const bars = support()
    appendAboveSupport(bars, 59)
    bars.push(bar(60, 51), bar(61, 54), bar(62, 50))
    const complete = findRsiTrendlines(bars)
    for (let length = 1; length <= bars.length; length++) {
      for (const line of findRsiTrendlines(bars.slice(0, length))) {
        const final = complete.find((item) => item.id === line.id)!
        expect(final).toBeDefined()
        expect(line.start).toEqual(final.start)
        expect(line.end).toEqual(final.end)
        expect(line.formedAt).toBe(final.formedAt)
        expect(line.formedAt).toBeLessThanOrEqual(bars[length - 1].closeTime)
        if (line.brokenAt !== null) {
          expect(line.brokenAt).toBeGreaterThan(line.formedAt)
          expect(line.brokenAt).toBeLessThanOrEqual(bars[length - 1].closeTime)
          expect(line.breakId).toBe(final.breakId)
          expect(line.breakRsi).toBe(final.breakRsi)
          expect(line.breakGrade).toBe(final.breakGrade)
          expect(line.brokenAt).toBe(final.brokenAt)
        }
      }
    }
  })

  test('projects a line by timestamp with anchors far outside the visible range', () => {
    const line = original(resistance())!
    expect(trendlineRsiAtTime(line, line.start.time)).toBe(80)
    expect(trendlineRsiAtTime(line, line.end.time)).toBe(74)
    expect(trendlineRsiAtTime(line, START + 60 * PERIOD)).toBeCloseTo(47.6)
  })

  test.each([
    { leftBars: 0 }, { rightBars: 1.5 }, { activeBars: 0 }, { brokenRelevanceBars: Number.POSITIVE_INFINITY },
    { touchTolerance: -1 }, { breakMargin: 0.2 }, { minSlope: 0 }, { minSlope: 2, maxSlope: 1 },
  ])('rejects invalid options %p', (options) => {
    expect(() => findRsiTrendlines([], options)).toThrow(RangeError)
  })
})

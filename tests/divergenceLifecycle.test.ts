import { describe, expect, test } from 'bun:test'
import { findRsiDivergences } from '../src/lib/divergence'
import {
  DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS,
  findRsiDivergenceSetups,
  isLiveDivergence,
} from '../src/lib/divergenceLifecycle'
import type { DivergenceLifecycleOptions } from '../src/lib/divergenceLifecycle'
import type { RsiBar } from '../src/types'

const MINUTE = 60_000
const START = 1_700_000_000_000
const OPTIONS = { requireBodyAgreement: true, requireSameRsiCycle: true }

function bar(index: number, rsi: number, patch: Partial<RsiBar> = {}): RsiBar {
  return {
    openTime: START + index * MINUTE,
    closeTime: START + (index + 1) * MINUTE - 1,
    open: 110, close: 109, low: 105, high: 115, volume: 100,
    rsi, isClosed: true,
    ...patch,
  }
}

function bullish(following = 0): RsiBar[] {
  const bars = [45, 44, 40, 38, 35, 20, 40, 45, 42, 40, 30].map((rsi, i) => bar(i, rsi))
  bars[5] = bar(5, 20, { open: 104, close: 102, low: 100 })
  bars[10] = bar(10, 30, { open: 98, close: 96, low: 95 })
  if (following > 0) bars.push(bar(11, 35, { open: 95, close: 97, low: 94 }))
  for (let i = 1; i < following; i++) bars.push(bar(11 + i, 42))
  return bars
}

function mirror(bars: RsiBar[]): RsiBar[] {
  return bars.map((b) => ({
    ...b, rsi: 100 - b.rsi, open: 200 - b.open, close: 200 - b.close,
    high: 200 - b.low, low: 200 - b.high,
  }))
}

function firstSetup(bars: readonly RsiBar[], options: Partial<DivergenceLifecycleOptions> = {}) {
  return findRsiDivergenceSetups(bars, { ...OPTIONS, ...options })
    .find((s) => s.end.time === START + 10 * MINUTE)!
}

describe('causal provisional formation', () => {
  test('defaults to a historical 5/5 pivot, a five-candle inclusive candidate, second anchor, and 14 bars', () => {
    expect(DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS).toMatchObject({
      leftBars: 5, rightBars: 5, provisionalBars: 5,
      minBars: 5, maxBars: 60, invalidationAnchor: 'second', expiryBars: 14,
    })
  })

  test.each([false, true])('shows the second pivot at its own close with no right-side lag (bearish=%p)', (bearish) => {
    const bars = bearish ? mirror(bullish()) : bullish()
    expect(findRsiDivergenceSetups(bars.slice(0, -1), OPTIONS)).toEqual([])
    const setup = firstSetup(bars)
    expect(setup).toMatchObject({
      kind: bearish ? 'regular-bearish' : 'regular-bullish',
      state: 'forming', detectedAt: bars[10].closeTime,
      confirmedAt: null, resolvedAt: null, barsElapsed: 0,
      start: { time: bars[5].openTime }, end: { time: bars[10].openTime },
    })
    expect(findRsiDivergences(bars, OPTIONS)).toEqual([])
    bars[10].isClosed = false
    expect(findRsiDivergenceSetups(bars, OPTIONS)).toEqual([])
  })

  test('cannot borrow a first pivot that will only become confirmed in the future', () => {
    const bars = bullish()
    // Current second pivot at index 9 is just four bars after the first.
    bars[9] = { ...bars[10], openTime: bars[9].openTime, closeTime: bars[9].closeTime }
    expect(findRsiDivergenceSetups(bars.slice(0, 10), { ...OPTIONS, minBars: 1 })).toEqual([])
  })

  test('rejects equal plateaus in first-pivot and candidate windows', () => {
    const equalFirst = bullish()
    equalFirst[4].rsi = equalFirst[5].rsi
    expect(firstSetup(equalFirst)).toBeUndefined()
    const equalSecond = bullish()
    equalSecond[9].rsi = equalSecond[10].rsi
    expect(firstSetup(equalSecond)).toBeUndefined()
  })

  test('honours body and same-cycle filters independently', () => {
    const wrongBody = bullish()
    wrongBody[10].open = 108
    wrongBody[10].close = 106
    expect(firstSetup(wrongBody)).toBeUndefined()
    expect(firstSetup(wrongBody, { requireBodyAgreement: false })).toBeDefined()
    const reset = bullish()
    reset[7].rsi = 50
    expect(firstSetup(reset)).toBeUndefined()
    expect(firstSetup(reset, { requireSameRsiCycle: false })).toBeDefined()
  })

  test('does not form an actionable setup whose target was already reached', () => {
    const bars = bullish()
    for (const b of bars) b.rsi += 25
    expect(findRsiDivergenceSetups(bars, { requireSameRsiCycle: false })).toEqual([])
  })

  test('preserves each provisional attempt when the next low harmonises it', () => {
    const bars = bullish(2)
    bars[11].rsi = 29
    bars[12].rsi = 28
    bars[12].low = 93
    bars[12].open = 95
    bars[12].close = 94
    const setups = findRsiDivergenceSetups(bars, OPTIONS)
    expect(setups.map((s) => [s.end.time, s.state])).toEqual([
      [bars[10].openTime, 'harmonised'],
      [bars[11].openTime, 'harmonised'],
      [bars[12].openTime, 'forming'],
    ])
    expect(setups[0].detectedAt).toBe(bars[10].closeTime)
  })
})

describe('next closed candle confirmation and invalidation', () => {
  test.each([false, true])('supports ordinary and strong price confirmation (bearish=%p)', (bearish) => {
    const ordinary = bullish(1)
    const setup = firstSetup(bearish ? mirror(ordinary) : ordinary)
    expect(setup).toMatchObject({
      state: 'confirmed', confirmedAt: ordinary[11].closeTime,
      confirmation: 'ordinary', barsElapsed: 0, resolvedAt: null,
    })
    ordinary[11].close = 99
    expect(firstSetup(bearish ? mirror(ordinary) : ordinary).confirmation).toBe('strong')
    ordinary[11].close = ordinary[10].open
    expect(firstSetup(bearish ? mirror(ordinary) : ordinary).confirmation).toBe('ordinary')
  })

  test.each([false, true])('requires matching colour as well as passing the previous open for strong confirmation (bearish=%p)', (bearish) => {
    const bars = bullish(1)
    bars[11] = bar(11, 35, { open: 102, close: 100, low: 99 })
    expect(firstSetup(bearish ? mirror(bars) : bars)).toMatchObject({
      state: 'unconfirmed', confirmation: null, confirmedAt: null,
      resolutionReason: 'confirmation-missed', resolvedAt: bars[11].closeTime,
    })
  })

  test.each([94, 95])('a wrong-colour/doji next candle closes unconfirmed and cannot confirm later (%p)', (close) => {
    const bars = bullish(2)
    bars[11].close = close
    bars[12].close = 111
    expect(firstSetup(bars)).toMatchObject({ state: 'unconfirmed', resolvedAt: bars[11].closeTime, confirmedAt: null })
  })

  test.each([false, true])('a strict second RSI breach harmonises before colour confirmation (bearish=%p)', (bearish) => {
    const bars = bullish(1)
    bars[11].rsi = 29
    expect(firstSetup(bearish ? mirror(bars) : bars)).toMatchObject({
      state: 'harmonised', confirmedAt: null, resolvedAt: bars[11].closeTime,
      invalidationRsi: bearish ? 70 : 30, resolutionReason: 'rsi-anchor',
    })
    bars[11].rsi = 30
    expect(firstSetup(bearish ? mirror(bars) : bars).state).toBe('confirmed')
  })

  test.each([false, true])('first-pivot anchor gives regular setups room, with equality allowed (bearish=%p)', (bearish) => {
    const bars = bullish(2)
    bars[11].rsi = 29
    bars[12].rsi = 20
    const transform = () => bearish ? mirror(bars) : bars
    expect(firstSetup(transform(), { invalidationAnchor: 'first' })).toMatchObject({
      state: 'confirmed', barsElapsed: 1, invalidationRsi: bearish ? 80 : 20,
    })
    bars[12].rsi = 19
    expect(firstSetup(transform(), { invalidationAnchor: 'first' })).toMatchObject({
      state: 'harmonised', confirmedAt: bars[11].closeTime,
      resolvedAt: bars[12].closeTime, barsElapsed: 1,
    })
  })

  test.each([false, true])('hidden lifecycle always uses second anchor, and remains opt-in (bearish=%p)', (bearish) => {
    const bars = bullish(2)
    bars[10].rsi = 15
    bars[10].low = 101
    bars[10].open = 106
    bars[10].close = 104
    bars[11].rsi = 17
    bars[12].rsi = 14
    // Hidden RSI cannot breach the first pivot until its five right bars closed.
    bars.splice(10, 0, bar(10, 40))
    bars.forEach((b, i) => {
      b.openTime = START + i * MINUTE
      b.closeTime = START + (i + 1) * MINUTE - 1
    })
    const transform = () => bearish ? mirror(bars) : bars
    const options = { ...OPTIONS, includeHidden: true, invalidationAnchor: 'first' as const }
    expect(findRsiDivergenceSetups(transform().slice(0, 13), OPTIONS)).toEqual([])
    expect(findRsiDivergenceSetups(transform().slice(0, 13), options)[0])
      .toMatchObject({ state: 'confirmed', invalidationAnchor: 'second', invalidationRsi: bearish ? 85 : 15 })
    expect(findRsiDivergenceSetups(transform(), options)[0].state).toBe('harmonised')
  })
})

describe('target and 14-candle clock', () => {
  test.each([false, true])('records targets already reached on the confirmation close as age zero (bearish=%p)', (bearish) => {
    const bars = bullish(1)
    bars[11].rsi = 50
    expect(firstSetup(bearish ? mirror(bars) : bars)).toMatchObject({
      state: 'completed', barsElapsed: 0,
      resolvedAt: bars[11].closeTime, confirmedAt: bars[11].closeTime,
    })
  })

  test.each([1, 14])('RSI 50 on post-confirmation candle %p completes', (age) => {
    for (const bearish of [false, true]) {
      const bars = bullish(age + 1)
      bars[11 + age].rsi = 50
      expect(firstSetup(bearish ? mirror(bars) : bars)).toMatchObject({
        state: 'completed', barsElapsed: age, resolvedAt: bars[11 + age].closeTime,
      })
    }
  })

  test('crossing 50 without an exact sample at 50 completes', () => {
    const bars = bullish(2)
    bars[12].rsi = 55
    expect(firstSetup(bars).state).toBe('completed')
    expect(firstSetup(mirror(bars)).state).toBe('completed')
  })

  test('counts only 14 closes after confirmation, then expires without future resurrection', () => {
    const bars = bullish(17)
    expect(firstSetup(bars.slice(0, 25))).toMatchObject({ state: 'confirmed', barsElapsed: 13 })
    expect(firstSetup(bars.slice(0, 26))).toMatchObject({ state: 'expired', barsElapsed: 14, resolvedAt: bars[25].closeTime })
    bars[26].rsi = 55
    expect(firstSetup(bars)).toEqual(firstSetup(bars.slice(0, 26)))
  })

  test('gives anchor breach priority over expiry on candle 14', () => {
    const bars = bullish(15)
    bars[25].rsi = 29
    expect(firstSetup(bars)).toMatchObject({ state: 'harmonised', barsElapsed: 14 })
  })
})

describe('closed-data causality and censoring', () => {
  test('live ticks neither confirm, invalidate, hit the target nor advance the timer', () => {
    const bars = bullish(2)
    for (const rsi of [0, 50, 100]) {
      const preview = { ...bars[12], rsi, isClosed: false }
      expect(findRsiDivergenceSetups([...bars.slice(0, 12), preview], OPTIONS))
        .toEqual(findRsiDivergenceSetups(bars.slice(0, 12), OPTIONS))
      const confirmationPreview = { ...bars[11], rsi, isClosed: false }
      expect(firstSetup([...bars.slice(0, 11), confirmationPreview]).state).toBe('forming')
    }
  })

  test('missing or unfinished interior bars censor an existing setup', () => {
    const bars = bullish(3)
    expect(firstSetup([...bars.slice(0, 12), bars[13]])).toMatchObject({
      state: 'interrupted', resolutionReason: 'data-gap', barsElapsed: 0,
    })
    bars[12].isClosed = false
    expect(firstSetup(bars).state).toBe('interrupted')
  })

  test('malformed final data immediately interrupts instead of leaving a live badge', () => {
    const bars = bullish(2)
    bars[12].rsi = NaN
    expect(firstSetup(bars)).toMatchObject({ state: 'interrupted', resolvedAt: bars[12].closeTime })
  })

  test('out-of-order data interrupts without backdating the resolution before confirmation', () => {
    const bars = bullish(1)
    const interrupted = firstSetup([...bars, bars[0]])
    expect(interrupted.state).toBe('interrupted')
    expect(interrupted.resolvedAt).toBeGreaterThanOrEqual(interrupted.confirmedAt!)
  })

  test('missing first-pivot evidence cannot be borrowed across gaps', () => {
    const bars = bullish()
    expect(findRsiDivergenceSetups([...bars.slice(0, 4), ...bars.slice(5)], OPTIONS)).toEqual([])
  })

  test('prefix replay never backdates formation, rewrites endpoints, or changes terminal outcomes', () => {
    const bars = bullish(17)
    bars[16].rsi = 51
    const all = findRsiDivergenceSetups(bars, OPTIONS)
    for (let length = 0; length <= bars.length; length++) {
      const prefix = bars.slice(0, length)
      const found = findRsiDivergenceSetups(prefix, OPTIONS)
      expect(found.map((s) => s.id)).toEqual(all.filter((s) => s.detectedAt <= (prefix.at(-1)?.closeTime ?? 0)).map((s) => s.id))
      for (const setup of found) {
        const final = all.find((s) => s.id === setup.id)!
        expect([setup.start, setup.end, setup.detectedAt]).toEqual([final.start, final.end, final.detectedAt])
        if (!isLiveDivergence(setup)) expect(setup).toEqual(final)
      }
    }
  })

  test('does not mutate input or options and accepts empty history', () => {
    const bars = bullish(3)
    const original = structuredClone(bars)
    bars.forEach(Object.freeze)
    Object.freeze(bars)
    findRsiDivergenceSetups(bars, Object.freeze(OPTIONS))
    expect(bars).toEqual(original)
    expect(findRsiDivergenceSetups([])).toEqual([])
  })

  test.each([
    { provisionalBars: 1 }, { provisionalBars: 2.5 }, { expiryBars: 0 },
    { expiryBars: Infinity }, { invalidationAnchor: 'third' },
  ])('rejects invalid lifecycle options %p', (options) => {
    expect(() => findRsiDivergenceSetups([], options as Partial<DivergenceLifecycleOptions>)).toThrow()
  })
})

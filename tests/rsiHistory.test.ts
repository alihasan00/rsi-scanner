import { describe, expect, test } from 'bun:test'
import type { Candle } from '../src/types'
import { RSI_LENGTH, seedRsiState, SERIES_CAP } from '../src/lib/rsi'
import {
  recoverRsiHistory,
  RSI_HISTORY_CAP,
  seedRsiHistory,
  snapshotFromRsiHistory,
  updateRsiHistory,
} from '../src/lib/rsiHistory'

function candle(index: number, close = 100 + Math.sin(index / 3) * 10): Candle {
  return {
    openTime: index * 60_000, closeTime: (index + 1) * 60_000 - 1,
    open: 100, high: Math.max(100, close) + 1, low: Math.min(100, close) - 1,
    close, volume: 20,
  }
}

function candles(count: number, start = 0): Candle[] {
  return Array.from({ length: count }, (_, index) => candle(start + index))
}

function seeded(count = 40) {
  const history = seedRsiHistory(candles(count))
  if (!history) throw new Error('Fixture needs sufficient candles')
  return history
}

describe('aligned RSI history', () => {
  test('aligns the first RSI and a capped history with the correct OHLC timestamps', () => {
    const first = seeded(RSI_LENGTH + 1)
    expect(first.closedBars).toHaveLength(1)
    expect(first.closedBars[0].openTime).toBe(candle(RSI_LENGTH).openTime)

    const history = seeded(RSI_HISTORY_CAP + 150)
    const reference = seedRsiState(candles(RSI_HISTORY_CAP + 150).map((bar) => bar.close))
    expect(history.closedBars).toHaveLength(RSI_HISTORY_CAP)
    expect(history.closedBars[0].openTime).toBe(candle(150).openTime)
    expect(history.state).toEqual(reference)
    expect(snapshotFromRsiHistory(history).series).toEqual(reference?.series)
  })

  test('replaces live previews without advancing committed RSI; a final advances exactly once', () => {
    const base = seeded()
    const original = structuredClone(base)
    const first = updateRsiHistory(base, candle(40, 125), false).history
    const second = updateRsiHistory(first, candle(40, 80), false).history
    expect(second.state).toBe(base.state)
    expect(second.closedBars).toBe(base.closedBars)
    expect(second.preview?.isClosed).toBe(false)
    expect(second.preview?.close).toBe(80)
    expect(base).toEqual(original)

    const final = updateRsiHistory(second, candle(40), true).history
    expect(final).toEqual(seeded(41))
    expect(final.preview).toBeNull()
    for (const [bar, isFinal] of [[candle(40), true], [candle(40, 90), false], [candle(39), true]] as const) {
      const duplicate = updateRsiHistory(final, bar, isFinal)
      expect(duplicate.status).toBe('ignored')
      expect(duplicate.history).toBe(final)
    }
  })

  test('a later candle cannot implicitly finalize a missed preview', () => {
    const base = updateRsiHistory(seeded(), candle(40), false).history
    const gap = updateRsiHistory(base, candle(41), false)
    expect(gap.status).toBe('gap')
    expect(gap.history).toBe(base)
    expect(gap.history.preview?.isClosed).toBe(false)
  })

  test('keeps the visible tail aligned when a preview and a final roll the history cap', () => {
    const count = RSI_HISTORY_CAP + 150
    const base = seeded(count)
    const preview = updateRsiHistory(base, candle(count), false).history
    const snapshot = snapshotFromRsiHistory(preview)
    expect(snapshot.bars).toHaveLength(RSI_HISTORY_CAP)
    expect(snapshot.series).toHaveLength(SERIES_CAP)
    expect(snapshot.series).toEqual(snapshot.bars.slice(-SERIES_CAP).map((bar) => bar.rsi))
    expect(snapshot.bars[0].openTime).toBe(candle(151).openTime)
    expect(snapshot.bars.at(-1)?.isClosed).toBe(false)

    const final = snapshotFromRsiHistory(updateRsiHistory(preview, candle(count), true).history)
    expect(final.series).toEqual(snapshot.series)
    expect(final.bars.at(-1)?.isClosed).toBe(true)
    expect(new Set(final.bars.map((bar) => bar.openTime)).size).toBe(final.bars.length)
  })
})

describe('history recovery', () => {
  test('replays recovered closes from the old average and preserves overlapping confirmed bars', () => {
    const count = RSI_HISTORY_CAP + 150
    const previous = seeded(count)
    const recovered = recoverRsiHistory(previous, candles(350, count - 340), candle(count + 10))
    expect(recovered).not.toBeNull()
    const reference = updateRsiHistory(seeded(count + 10), candle(count + 10), false).history
    expect(recovered).toEqual(reference)
    expect(recovered?.closedBars[0]).toBe(previous.closedBars[10])
  })

  test('ignores seed/stream overlap and late finals without double advancing RSI', () => {
    const history = recoverRsiHistory(null, candles(40), candle(40))!
    const oldFinal = updateRsiHistory(history, candle(39), true)
    expect(oldFinal.status).toBe('ignored')
    const final = updateRsiHistory(oldFinal.history, candle(40), true).history
    expect(final).toEqual(seeded(41))
    expect(updateRsiHistory(final, candle(40), true).history).toBe(final)
    expect(recoverRsiHistory(final, candles(39), candle(39))).toBe(final)
  })

  test('starts fresh when the needed candle is older than the available REST window', () => {
    const previous = seeded(40)
    const recent = candles(350, 400)
    const recovered = recoverRsiHistory(previous, recent, candle(750))
    const fresh = recoverRsiHistory(null, recent, candle(750))
    expect(recovered).toEqual(fresh)
    expect(recovered?.closedBars.every((bar) => bar.openTime > candle(39).openTime)).toBe(true)
  })

  test('rejects discontinuous seed data and ignores invalid live values', () => {
    expect(() => seedRsiHistory([...candles(20), candle(21)])).toThrow('Non-contiguous')
    const base = seeded()
    const invalid = updateRsiHistory(base, { ...candle(40), close: Number.NaN }, true)
    expect(invalid.status).toBe('ignored')
    expect(invalid.history).toBe(base)
  })
})

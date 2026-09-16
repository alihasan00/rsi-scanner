import { describe, expect, test } from 'bun:test'
import { strictRsiPivot } from '../src/lib/rsiPivots'

function samples(rsi: number[]) {
  return rsi.map((value) => ({ rsi: value }))
}

describe('strictRsiPivot', () => {
  test('confirms strict extrema with asymmetric left/right windows', () => {
    expect(strictRsiPivot(samples([40, 35, 20, 30]), 2, 2, 1))
      .toEqual({ low: true, high: false })
    expect(strictRsiPivot(samples([60, 65, 80, 70]), 2, 2, 1))
      .toEqual({ low: false, high: true })
  })

  test('checks distant neighbors on both sides, not only adjacent candles', () => {
    for (const rsi of [
      [10, 40, 20, 40, 45],
      [45, 40, 20, 40, 10],
      [90, 60, 80, 60, 55],
      [55, 60, 80, 60, 90],
    ]) {
      expect(strictRsiPivot(samples(rsi), 2, 2, 2))
        .toEqual({ low: false, high: false })
    }
  })

  test('rejects ties anywhere in the confirmation window', () => {
    for (const tie of [0, 1, 3, 4]) {
      const rsi = [40, 35, 20, 30, 45]
      rsi[tie] = 20
      expect(strictRsiPivot(samples(rsi), 2, 2, 2))
        .toEqual({ low: false, high: false })
    }
  })

  test('restricts evidence to its window', () => {
    expect(strictRsiPivot(samples([10, 40, 20, 30, 5]), 2, 1, 1))
      .toEqual({ low: true, high: false })
  })

  test('supports one-sided candidates without borrowing later evidence', () => {
    const bars = samples([45, 40, 30, 20])
    expect(strictRsiPivot(bars, 2, 2, 0)).toEqual({ low: true, high: false })
    expect(strictRsiPivot(bars, 2, 2, 1)).toEqual({ low: false, high: false })
    expect(strictRsiPivot(bars, 0, 0, 2)).toEqual({ low: false, high: true })
  })

  test.each([
    [-1, 1, 1], [3, 1, 1], [1.5, 1, 1], [Number.NaN, 1, 1],
    [0, 1, 1], [2, 1, 1], [1, -1, 1], [1, 1, -1],
    [1, 0.5, 1], [1, 1, 0.5], [1, Infinity, 1], [1, 1, Infinity],
    [1, 0, 0],
  ])('rejects an invalid or unavailable window (%p, %p, %p)', (pivot, left, right) => {
    expect(strictRsiPivot(samples([40, 20, 30]), pivot, left, right))
      .toEqual({ low: false, high: false })
  })
})

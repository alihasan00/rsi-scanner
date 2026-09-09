import { describe, expect, test } from 'bun:test'
import { getRsiState } from '../src/lib/rsiState'

describe('RSI state', () => {
  test.each([
    [0, 'oversold'],
    [29.999, 'oversold'],
    [30, 'oversold'],
    [30.001, 'neutral'],
    [50, 'neutral'],
    [69.999, 'neutral'],
    [70, 'overbought'],
    [70.001, 'overbought'],
    [100, 'overbought'],
  ] as const)('classifies RSI %s as %s', (value, state) => {
    expect(getRsiState(value)).toBe(state)
  })

  test.each([null, undefined, NaN, Infinity, -Infinity, -0.001, 100.001])(
    'does not classify unavailable or invalid RSI %s', (value) => {
      expect(getRsiState(value)).toBeNull()
    },
  )
})

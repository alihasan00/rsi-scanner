import { expect, test } from 'bun:test'
import { isSrContextScopeCurrent } from '../src/lib/srContextScope'
import type { AppView, ScreenerFilterPreferences } from '../src/lib/screenerPreferences'

test('daily feed follows the view, independent of inactive screener filters', () => {
  for (const signal of ['all', 'sr', 'fib', 'harmonic'] as const) {
    const state = { appView: 'watchlist' as const, screenerFilters: { signal }, selectedSymbol: 'BTCUSDT' }
    expect(isSrContextScopeCurrent(state, 'watchlist', ['BTCUSDT', 'ETHUSDT'])).toBe(true)
    expect(isSrContextScopeCurrent(state, 'liquidity', ['BTCUSDT', 'ETHUSDT'])).toBe(false)
    expect(isSrContextScopeCurrent(state, 'selected', ['BTCUSDT'])).toBe(false)
  }
})

test('changing views cancels the old full-universe daily feed', () => {
  for (const appView of ['families', 'scanner'] as const) {
    const state = { appView, screenerFilters: { signal: 'sr' as const }, selectedSymbol: 'BTCUSDT' }
    expect(isSrContextScopeCurrent(state, 'watchlist', ['BTCUSDT', 'ETHUSDT'])).toBe(false)
    expect(isSrContextScopeCurrent(state, 'liquidity', ['BTCUSDT', 'ETHUSDT'])).toBe(appView === 'scanner')
    expect(isSrContextScopeCurrent(state, 'selected', ['BTCUSDT'])).toBe(appView === 'families')
  }
})

test('selected daily scope cannot publish for a closed or changed chart', () => {
  const state: { appView: AppView; screenerFilters: Pick<ScreenerFilterPreferences, 'signal'>; selectedSymbol: string | null } = {
    appView: 'scanner', screenerFilters: { signal: 'all' }, selectedSymbol: 'BTCUSDT',
  }
  expect(isSrContextScopeCurrent(state, 'selected', ['BTCUSDT'])).toBe(true)
  expect(isSrContextScopeCurrent(state, 'selected', ['ETHUSDT'])).toBe(false)
  expect(isSrContextScopeCurrent(state, 'selected', ['BTCUSDT', 'ETHUSDT'])).toBe(false)
  expect(isSrContextScopeCurrent({ ...state, selectedSymbol: null }, 'selected', ['BTCUSDT'])).toBe(false)
})

import type { Timeframe } from '../types'
import { DEFAULT_DIVERGENCE_RECENCY } from './screener'
import type { DivergenceRecency, ScreenerSort } from './screener'
import type { RsiStateFilter } from './rsiState'

export interface ScreenerPreferences {
  search: string
  signal: 'all' | 'divergence'
  divergenceRecency: DivergenceRecency
  rsiState: RsiStateFilter
  starredOnly: boolean
  sort: ScreenerSort
  timeframe: Timeframe
  cardDensity: 'comfortable' | 'compact'
}

export type ScreenerFilterPreferences = Pick<ScreenerPreferences,
  'search' | 'signal' | 'divergenceRecency' | 'rsiState' | 'starredOnly' | 'sort'>

export const DEFAULT_SCREENER_PREFERENCES: Readonly<ScreenerPreferences> = Object.freeze({
  search: '',
  signal: 'all',
  divergenceRecency: DEFAULT_DIVERGENCE_RECENCY,
  rsiState: 'all',
  starredOnly: false,
  sort: 'watchlist',
  timeframe: '15m',
  cardDensity: 'comfortable',
})

const SIGNALS = ['all', 'divergence'] as const
const RECENCIES = [1, 3, 5, 'any'] as const
const RSI_STATES = ['all', 'overbought', 'oversold', 'either', 'neutral'] as const satisfies readonly RsiStateFilter[]
const SORTS = ['watchlist', 'signals', 'change', 'rsi-low', 'rsi-high', 'symbol'] as const satisfies readonly ScreenerSort[]
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '3d', '1w'] as const satisfies readonly Timeframe[]
const DENSITIES = ['comfortable', 'compact'] as const
const SEARCH_KEYS = ['q', 'indicator', 'candles', 'rsi', 'starred', 'sort', 'timeframe', 'density'] as const

function isChoice<T extends string | number>(value: unknown, choices: readonly T[]): value is T {
  return choices.some((choice) => choice === value)
}

/** Keep valid fields from stored data; malformed or obsolete fields use defaults. */
export function restoreScreenerPreferences(input: unknown): ScreenerPreferences {
  const saved = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {}
  const defaults = DEFAULT_SCREENER_PREFERENCES
  return {
    search: typeof saved.search === 'string' ? saved.search : defaults.search,
    signal: isChoice(saved.signal, SIGNALS) ? saved.signal : defaults.signal,
    divergenceRecency: isChoice(saved.divergenceRecency, RECENCIES) ? saved.divergenceRecency : defaults.divergenceRecency,
    rsiState: isChoice(saved.rsiState, RSI_STATES) ? saved.rsiState : defaults.rsiState,
    starredOnly: typeof saved.starredOnly === 'boolean' ? saved.starredOnly : defaults.starredOnly,
    sort: isChoice(saved.sort, SORTS) ? saved.sort : defaults.sort,
    timeframe: isChoice(saved.timeframe, TIMEFRAMES) ? saved.timeframe : defaults.timeframe,
    cardDensity: isChoice(saved.cardDensity, DENSITIES) ? saved.cardDensity : defaults.cardDensity,
  }
}

/** A recognized URL key defines the whole shared view. The first duplicate wins. */
export function readScreenerPreferencesFromSearch(search: string): ScreenerPreferences | null {
  const params = new URLSearchParams(search)
  if (!SEARCH_KEYS.some((key) => params.has(key))) return null
  const candles = params.get('candles')
  return restoreScreenerPreferences({
    search: params.get('q'),
    signal: params.get('indicator'),
    divergenceRecency: candles === '1' ? 1 : candles === '3' ? 3 : candles === '5' ? 5 : candles,
    rsiState: params.get('rsi'),
    starredOnly: params.get('starred') === '1',
    sort: params.get('sort'),
    timeframe: params.get('timeframe'),
    cardDensity: params.get('density'),
  })
}

/** Preserve other query parameters and write one canonical set of screener values. */
export function writeScreenerPreferencesToSearch(search: string, prefs: ScreenerPreferences): string {
  const params = new URLSearchParams(search)
  const current = restoreScreenerPreferences(prefs)
  const defaults = DEFAULT_SCREENER_PREFERENCES
  for (const key of SEARCH_KEYS) params.delete(key)
  // An explicit anchor distinguishes a default shared view from no shared view.
  params.set('timeframe', current.timeframe)
  if (current.search !== defaults.search) params.set('q', current.search)
  if (current.signal !== defaults.signal) params.set('indicator', current.signal)
  if (current.divergenceRecency !== defaults.divergenceRecency) params.set('candles', String(current.divergenceRecency))
  if (current.rsiState !== defaults.rsiState) params.set('rsi', current.rsiState)
  if (current.starredOnly !== defaults.starredOnly) params.set('starred', current.starredOnly ? '1' : '0')
  if (current.sort !== defaults.sort) params.set('sort', current.sort)
  if (current.cardDensity !== defaults.cardDensity) params.set('density', current.cardDensity)
  return `?${params.toString()}`
}

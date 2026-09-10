import type { Timeframe } from '../types'
import { DEFAULT_DIVERGENCE_RECENCY } from './screener'
import type { DivergenceRecency, ScreenerSort } from './screener'
import type { RsiStateFilter } from './rsiState'
import type { ScreenerMarket } from './markets'
import { DEFAULT_FIB_SETTINGS, restoreFibSettings } from './fibPreferences'
import type { FibSettings } from './fibPreferences'
import type { FibStage } from './fibScreener'

export interface ScreenerPreferences {
  market: ScreenerMarket
  search: string
  signal: 'all' | 'divergence' | 'fib'
  divergenceRecency: DivergenceRecency
  fibDirection: 'any' | 'long' | 'short'
  fibStage: FibStage
  fibConfluence: 'any' | 'aligned'
  fibSettings: FibSettings
  rsiState: RsiStateFilter
  starredOnly: boolean
  sort: ScreenerSort
  timeframe: Timeframe
  cardDensity: 'comfortable' | 'compact'
}

export type ScreenerFilterPreferences = Pick<ScreenerPreferences,
  'search' | 'signal' | 'divergenceRecency' | 'fibDirection' | 'fibStage' | 'fibConfluence' | 'rsiState' | 'starredOnly' | 'sort'>

export const DEFAULT_SCREENER_PREFERENCES: Readonly<ScreenerPreferences> = Object.freeze({
  market: 'spot',
  search: '',
  signal: 'all',
  divergenceRecency: DEFAULT_DIVERGENCE_RECENCY,
  fibDirection: 'any',
  fibStage: 'any',
  fibConfluence: 'any',
  fibSettings: DEFAULT_FIB_SETTINGS,
  rsiState: 'all',
  starredOnly: false,
  sort: 'watchlist',
  timeframe: '15m',
  cardDensity: 'comfortable',
})

const SIGNALS = ['all', 'divergence', 'fib'] as const
const RECENCIES = [1, 3, 5, 'any'] as const
const FIB_DIRECTIONS = ['any', 'long', 'short'] as const
const FIB_STAGES = ['any', 'waiting', 'near', 'active', 'pocket'] as const satisfies readonly FibStage[]
const FIB_CONFLUENCES = ['any', 'aligned'] as const
const RSI_STATES = ['all', 'overbought', 'oversold', 'either', 'neutral'] as const satisfies readonly RsiStateFilter[]
const SORTS = ['watchlist', 'signals', 'change', 'rsi-low', 'rsi-high', 'symbol'] as const satisfies readonly ScreenerSort[]
const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '1d', '3d', '1w'] as const satisfies readonly Timeframe[]
const DENSITIES = ['comfortable', 'compact'] as const
const MARKETS = ['spot', 'tradfi'] as const satisfies readonly ScreenerMarket[]
const SEARCH_KEYS = [
  'market', 'q', 'indicator', 'candles', 'rsi', 'starred', 'sort', 'timeframe', 'density',
  'fibSide', 'fibStage', 'fibTrend', 'fibScale', 'fibStop', 'fibTp3', 'fibTp4', 'fibRunner',
] as const

function isChoice<T extends string | number>(value: unknown, choices: readonly T[]): value is T {
  return choices.some((choice) => choice === value)
}

/** Keep valid fields from stored data; malformed or obsolete fields use defaults. */
export function restoreScreenerPreferences(input: unknown): ScreenerPreferences {
  const saved = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {}
  const defaults = DEFAULT_SCREENER_PREFERENCES
  return {
    market: isChoice(saved.market, MARKETS) ? saved.market : defaults.market,
    search: typeof saved.search === 'string' ? saved.search : defaults.search,
    signal: isChoice(saved.signal, SIGNALS) ? saved.signal : defaults.signal,
    divergenceRecency: isChoice(saved.divergenceRecency, RECENCIES) ? saved.divergenceRecency : defaults.divergenceRecency,
    fibDirection: isChoice(saved.fibDirection, FIB_DIRECTIONS) ? saved.fibDirection : defaults.fibDirection,
    fibStage: isChoice(saved.fibStage, FIB_STAGES) ? saved.fibStage : defaults.fibStage,
    fibConfluence: isChoice(saved.fibConfluence, FIB_CONFLUENCES) ? saved.fibConfluence : defaults.fibConfluence,
    fibSettings: restoreFibSettings(saved.fibSettings),
    rsiState: isChoice(saved.rsiState, RSI_STATES) ? saved.rsiState : defaults.rsiState,
    starredOnly: typeof saved.starredOnly === 'boolean' ? saved.starredOnly : defaults.starredOnly,
    sort: isChoice(saved.sort, SORTS) ? saved.sort : defaults.sort,
    timeframe: isChoice(saved.timeframe, TIMEFRAMES) ? saved.timeframe : defaults.timeframe,
    cardDensity: isChoice(saved.cardDensity, DENSITIES) ? saved.cardDensity : defaults.cardDensity,
  }
}

function readNumber(value: string | null): number | undefined {
  // Decimal notation, including exponents emitted by String(number), round trips.
  return value !== null && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)
    ? Number(value) : undefined
}

/** A recognized URL key defines the whole shared view. The first duplicate wins. */
export function readScreenerPreferencesFromSearch(search: string): ScreenerPreferences | null {
  const params = new URLSearchParams(search)
  if (!SEARCH_KEYS.some((key) => params.has(key))) return null
  const candles = params.get('candles')
  return restoreScreenerPreferences({
    market: params.get('market'),
    search: params.get('q'),
    signal: params.get('indicator'),
    divergenceRecency: candles === '1' ? 1 : candles === '3' ? 3 : candles === '5' ? 5 : candles,
    fibDirection: params.get('fibSide'),
    fibStage: params.get('fibStage'),
    fibConfluence: params.get('fibTrend'),
    fibSettings: {
      scale: params.get('fibScale'),
      stopRatio: readNumber(params.get('fibStop')),
      tp3Ratio: readNumber(params.get('fibTp3')),
      tp4Ratio: readNumber(params.get('fibTp4')),
      runnerRatio: readNumber(params.get('fibRunner')),
    },
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
  if (current.market !== defaults.market) params.set('market', current.market)
  if (current.search !== defaults.search) params.set('q', current.search)
  if (current.signal !== defaults.signal) params.set('indicator', current.signal)
  if (current.divergenceRecency !== defaults.divergenceRecency) params.set('candles', String(current.divergenceRecency))
  if (current.fibDirection !== defaults.fibDirection) params.set('fibSide', current.fibDirection)
  if (current.fibStage !== defaults.fibStage) params.set('fibStage', current.fibStage)
  if (current.fibConfluence !== defaults.fibConfluence) params.set('fibTrend', current.fibConfluence)
  if (current.fibSettings.scale !== defaults.fibSettings.scale) params.set('fibScale', current.fibSettings.scale)
  if (current.fibSettings.stopRatio !== defaults.fibSettings.stopRatio) params.set('fibStop', String(current.fibSettings.stopRatio))
  if (current.fibSettings.tp3Ratio !== defaults.fibSettings.tp3Ratio) params.set('fibTp3', String(current.fibSettings.tp3Ratio))
  if (current.fibSettings.tp4Ratio !== defaults.fibSettings.tp4Ratio) params.set('fibTp4', String(current.fibSettings.tp4Ratio))
  if (current.fibSettings.runnerRatio !== defaults.fibSettings.runnerRatio) params.set('fibRunner', String(current.fibSettings.runnerRatio))
  if (current.rsiState !== defaults.rsiState) params.set('rsi', current.rsiState)
  if (current.starredOnly !== defaults.starredOnly) params.set('starred', current.starredOnly ? '1' : '0')
  if (current.sort !== defaults.sort) params.set('sort', current.sort)
  if (current.cardDensity !== defaults.cardDensity) params.set('density', current.cardDensity)
  return `?${params.toString()}`
}

import { describe, expect, test } from 'bun:test'
import { DEFAULT_FIB_SETTINGS, FIB_STOP_RATIOS, FIB_TP3_RATIOS, restoreFibSettings } from '../src/lib/fibPreferences'
import {
  DEFAULT_SCREENER_PREFERENCES,
  readScreenerPreferencesFromSearch,
  restoreScreenerPreferences,
  writeScreenerPreferencesToSearch,
} from '../src/lib/screenerPreferences'
import type { ScreenerPreferences } from '../src/lib/screenerPreferences'

const FIB_VIEW: ScreenerPreferences = {
  ...DEFAULT_SCREENER_PREFERENCES,
  market: 'tradfi',
  signal: 'fib',
  fibDirection: 'short',
  fibStage: 'pocket',
  fibConfluence: 'aligned',
  fibSettings: { scale: 'log', stopRatio: 1.14, tp3Ratio: 0, tp4Ratio: -0.5, runnerRatio: -1 },
  timeframe: '1d',
}

describe('Fib template validation', () => {
  test.each([undefined, null, false, 42, 'log', [], [DEFAULT_FIB_SETTINGS]].map((input) => ({ input })))(
    'missing or malformed settings containers use a safe default template ($input)', ({ input }) => {
      expect(restoreFibSettings(input)).toEqual(DEFAULT_FIB_SETTINGS)
    },
  )

  test('restores supported stop and TP3 choices without coercing invalid field types', () => {
    for (const stopRatio of FIB_STOP_RATIOS) {
      for (const tp3Ratio of FIB_TP3_RATIOS) {
        expect(restoreFibSettings({ ...DEFAULT_FIB_SETTINGS, stopRatio, tp3Ratio })).toEqual({
          ...DEFAULT_FIB_SETTINGS, stopRatio, tp3Ratio,
        })
      }
    }
    expect(restoreFibSettings({
      scale: 'Log', stopRatio: '1.04', tp3Ratio: '-0.236', tp4Ratio: NaN, runnerRatio: -Infinity,
    })).toEqual(DEFAULT_FIB_SETTINGS)
    expect(restoreFibSettings({ scale: 'log', stopRatio: 1, tp3Ratio: -1, tp4Ratio: null, runnerRatio: true })).toEqual({
      ...DEFAULT_FIB_SETTINGS, scale: 'log',
    })
  })

  test('keeps valid settings independently and repairs overlapping extension targets', () => {
    expect(restoreFibSettings({ scale: 'log', stopRatio: 1.04, tp3Ratio: 0, tp4Ratio: 0, runnerRatio: -1 })).toEqual({
      scale: 'log', stopRatio: 1.04, tp3Ratio: 0, tp4Ratio: -0.382, runnerRatio: -1,
    })
    expect(restoreFibSettings({ ...DEFAULT_FIB_SETTINGS, runnerRatio: -0.2 })).toEqual(DEFAULT_FIB_SETTINGS)
    const moved = restoreFibSettings({ ...DEFAULT_FIB_SETTINGS, tp4Ratio: -1 })
    expect(moved.tp4Ratio).toBe(-1)
    expect(moved.runnerRatio).toBeCloseTo(-1.236)
    const extreme = restoreFibSettings({ ...DEFAULT_FIB_SETTINGS, tp4Ratio: -Number.MAX_VALUE })
    expect(extreme).toEqual(DEFAULT_FIB_SETTINGS)
  })

  test('restored preferences own their mutable template instead of sharing input or defaults', () => {
    const saved = Object.freeze({ ...FIB_VIEW, fibSettings: Object.freeze({ ...FIB_VIEW.fibSettings }) })
    const restored = restoreScreenerPreferences(saved)
    expect(restored).toEqual(saved)
    expect(restored.fibSettings).not.toBe(saved.fibSettings)
    restored.fibSettings.scale = 'linear'
    expect(saved.fibSettings.scale).toBe('log')
    const defaults = restoreScreenerPreferences({})
    defaults.fibSettings.stopRatio = 1.272
    expect(DEFAULT_FIB_SETTINGS.stopRatio).toBe(0.92)
  })
})

describe('Fib view sharing', () => {
  test('round trips a complete Fib view and replaces every owned duplicate', () => {
    const old = '?campaign=lesson&fibSide=long&fibSide=any&fibStage=waiting&fibStage=active&fibTrend=any&fibTrend=aligned&fibScale=linear&fibScale=log&fibStop=0.92&fibStop=1.272&fibTp3=-0.236&fibTp3=0&fibTp4=-0.382&fibTp4=-2&fibRunner=-0.618&fibRunner=-3'
    const search = writeScreenerPreferencesToSearch(old, FIB_VIEW)
    const params = new URLSearchParams(search)
    expect(params.get('campaign')).toBe('lesson')
    for (const key of ['fibSide', 'fibStage', 'fibTrend', 'fibScale', 'fibStop', 'fibTp3', 'fibTp4', 'fibRunner']) {
      expect(params.getAll(key)).toHaveLength(1)
    }
    expect(readScreenerPreferencesFromSearch(search)).toEqual(FIB_VIEW)
    expect(writeScreenerPreferencesToSearch(search, FIB_VIEW)).toBe(search)
    expect(writeScreenerPreferencesToSearch(search, DEFAULT_SCREENER_PREFERENCES)).toBe('?campaign=lesson&timeframe=15m')
  })

  test('legacy shared views receive default Fib filters and settings', () => {
    expect(readScreenerPreferencesFromSearch('?indicator=divergence&timeframe=4h')).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, signal: 'divergence', timeframe: '4h',
    })
  })

  test('invalid values restore independently and first duplicate values win', () => {
    expect(readScreenerPreferencesFromSearch('?indicator=fib&fibSide=Long&fibSide=long&fibStage=entered&fibTrend=true&fibScale=LOG&fibStop=1&fibTp3=NaN&fibTp4=Infinity&fibRunner=-Infinity')).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES, signal: 'fib',
    })
    expect(readScreenerPreferencesFromSearch('?fibSide=short&fibSide=long&fibStage=active&fibStage=waiting&fibTrend=aligned&fibScale=log&fibScale=linear&fibStop=1.04&fibStop=1.14&fibTp3=0&fibTp3=-0.236&fibTp4=-0.5&fibRunner=-1')).toEqual({
      ...DEFAULT_SCREENER_PREFERENCES,
      fibDirection: 'short', fibStage: 'active', fibConfluence: 'aligned',
      fibSettings: { scale: 'log', stopRatio: 1.04, tp3Ratio: 0, tp4Ratio: -0.5, runnerRatio: -1 },
    })
  })

  test.each(['0x0', ' ', 'null', 'Infinity', '-Infinity', 'NaN', '0,92'])(
    'malformed numeric URL value %s cannot become a valid template choice', (value) => {
      const query = new URLSearchParams({ fibTp3: value, fibStop: value, fibTp4: value, fibRunner: value })
      expect(readScreenerPreferencesFromSearch(query.toString())).toEqual(DEFAULT_SCREENER_PREFERENCES)
    },
  )
})

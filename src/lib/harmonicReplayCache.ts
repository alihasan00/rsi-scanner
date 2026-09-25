import type { HarmonicAnalysis, HarmonicBar, HarmonicReplayCheckpoint, HarmonicSetup } from './harmonics'
import {
  advanceHarmonicReplay, createHarmonicReplay, HARMONIC_MAX_HISTORY, HARMONIC_MAX_FINISHED, HARMONIC_RATIOS,
  HARMONIC_C_RANGE, narrowButterflyZone, summarizeHarmonicReplay,
} from './harmonics'

export interface HarmonicCheckpointStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface SavedHarmonics {
  version: 1
  identity: string
  /** State immediately before window, including older active setups. */
  baseline: HarmonicReplayCheckpoint
  window: HarmonicBar[]
  /** Exact identities for the bounded production feed, including older correction evidence. */
  source: string[]
  continuity?: HarmonicAnalysis['continuity']
}
interface CachedHarmonics extends SavedHarmonics {
  sourceValues?: Float64Array
  state: HarmonicReplayCheckpoint
  analysis: HarmonicAnalysis
}

const PREFIX = 'rsi-scanner:harmonic-lifecycle:v1:'
const MAX_SAVED = 16
const MAX_STORAGE_CHARACTERS = 1_500_000
const MAX_RECORD_CHARACTERS = 500_000
const MAX_SOURCE_EVIDENCE = 3_000
const BAR_FIELDS = ['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'volume', 'isClosed'] as const
const sameBar = (a: HarmonicBar, b: HarmonicBar) => BAR_FIELDS.every((field) => Object.is(a[field], b[field]))
const candleIdentity = (bar: HarmonicBar) => `${bar.openTime}|${bar.closeTime},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume},${bar.isClosed ? 1 : 0}`
const identityTime = (identity: string) => Number(identity.slice(0, identity.indexOf('|')))
const scalar = (bar: HarmonicBar, field: typeof BAR_FIELDS[number]) => field === 'isClosed' ? Number(bar.isClosed) : bar[field]
function snapshotSource(bars: readonly HarmonicBar[]): Float64Array | undefined {
  if (bars.length > MAX_SOURCE_EVIDENCE) return undefined
  return Float64Array.from(bars.flatMap((bar) => BAR_FIELDS.map((field) => scalar(bar, field))))
}
function sameSource(bars: readonly HarmonicBar[], previous: Float64Array | undefined): boolean {
  return previous?.length === bars.length * BAR_FIELDS.length && bars.every((bar, index) =>
    BAR_FIELDS.every((field, offset) => Object.is(scalar(bar, field), previous[index * BAR_FIELDS.length + offset])))
}
const storageKey = (identity: string) => `${PREFIX}${encodeURIComponent(identity)}`

function browserStorage(): HarmonicCheckpointStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function timestamp(value: unknown): value is number { return finite(value) && Number.isSafeInteger(value) }
function positive(value: unknown): value is number { return finite(value) && value > 0 }
function point(value: unknown): boolean {
  return record(value) && timestamp(value.index) && value.index >= 0 && timestamp(value.time) && value.time >= 0 && positive(value.price)
}
function candle(value: unknown): value is HarmonicBar {
  return record(value) && timestamp(value.openTime) && value.openTime >= 0 && timestamp(value.closeTime) && value.closeTime >= value.openTime
    && positive(value.open) && positive(value.close) && positive(value.high) && positive(value.low)
    && value.low <= Math.min(value.open, value.close) && value.high >= Math.max(value.open, value.close)
    && finite(value.volume) && value.volume >= 0 && value.isClosed === true
}
const closeNumber = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(a), Math.abs(b)) * 1e-12
const band = (value: unknown): value is { low: number; high: number } => record(value)
  && positive(value.low) && positive(value.high) && value.low < value.high
function plan(value: unknown, state: HarmonicReplayCheckpoint): value is HarmonicSetup {
  if (!record(value) || !['gartley', 'bat', 'butterfly'].includes(String(value.kind))
    || !['bullish', 'bearish'].includes(String(value.direction)) || !['forming', 'approaching', 'zone'].includes(String(value.stage))
    || !['active', 'invalidated', 'completed', 'expired', 'superseded'].includes(String(value.status))
    || ![value.x, value.a, value.b, value.c].every(point) || (value.d !== null && !point(value.d))
    || (value.confirmedD !== null && !point(value.confirmedD)) || !timestamp(value.confirmedAt)
    || (value.dConfirmedAt !== null && !timestamp(value.dConfirmedAt)) || (value.endedAt !== null && !timestamp(value.endedAt))
    || (value.lastTouchIndex !== null && !timestamp(value.lastTouchIndex))
    || !band(value.baseZone) || !band(value.zone) || typeof value.zoneNarrowed !== 'boolean'
    || !positive(value.bRatio) || !positive(value.cRatio) || !positive(value.cInvalidation) || !positive(value.stopReference)
    || !Array.isArray(value.dRatioRange) || value.dRatioRange.length !== 2 || !value.dRatioRange.every(positive)) return false
  const setup = value as unknown as HarmonicSetup
  const duration = state.history[0].closeTime - state.history[0].openTime + 1
  const last = state.history.at(-1)!
  const limit = state.offset + state.history.length
  if (setup.id !== `${setup.kind}:${setup.direction}:${setup.x.time}:${setup.a.time}:${setup.b.time}:${setup.c.time}`
    || !(setup.x.index < setup.a.index && setup.a.index < setup.b.index && setup.b.index < setup.c.index)
    || setup.x.index < 3 || setup.c.index + 3 >= limit
    || [setup.x, setup.a, setup.b, setup.c, setup.d, setup.confirmedD].some((anchor) => anchor
      && (anchor.index >= limit || anchor.time !== state.startedAt! + anchor.index * duration))
    || setup.confirmedAt !== setup.c.time + 4 * duration - 1
    || (setup.status === 'active') !== (setup.endedAt === null)
    || (setup.endedAt !== null && (setup.endedAt < setup.confirmedAt || setup.endedAt > last.closeTime
      || (setup.endedAt + 1 - state.startedAt!) % duration !== 0))
    || (setup.stage === 'zone') !== (setup.d !== null)
    || (setup.d === null) !== (setup.lastTouchIndex === null)
    || (setup.d && (setup.d.index <= setup.c.index || setup.d.price < setup.zone.low || setup.d.price > setup.zone.high
      || setup.lastTouchIndex! < setup.d.index || setup.lastTouchIndex! >= limit))
    || (setup.confirmedD === null) !== (setup.dConfirmedAt === null)
    || (setup.confirmedD && (!setup.d || setup.confirmedD.index < setup.d.index || setup.confirmedD.index + 3 >= limit
      || setup.confirmedD.price < setup.zone.low || setup.confirmedD.price > setup.zone.high
      || setup.dConfirmedAt !== setup.confirmedD.time + 4 * duration - 1
      || setup.dConfirmedAt < setup.confirmedAt || setup.dConfirmedAt > (setup.endedAt ?? last.closeTime)))) return false
  const bullish = setup.direction === 'bullish'
  const witnessed = [setup.x, setup.a, setup.b, setup.c, setup.d, setup.confirmedD]
  if (witnessed.some((anchor, index) => {
    if (!anchor || anchor.index < state.offset) return false
    const bar = state.history[anchor.index - state.offset]
    const side = (index === 1 || index === 3) === bullish ? 'high' : 'low'
    const price = index === 4 ? (bullish ? Math.max(bar.low, setup.zone.low) : Math.min(bar.high, setup.zone.high)) : bar[side]
    return anchor.price !== price
  })) return false
  const xa = setup.a.price - setup.x.price
  const ab = setup.a.price - setup.b.price
  const ratios = HARMONIC_RATIOS[setup.kind]
  if ((bullish ? xa <= 0 || ab <= 0 : xa >= 0 || ab >= 0)
    || !closeNumber(setup.bRatio, ab / xa) || !closeNumber(setup.cRatio, (setup.c.price - setup.b.price) / ab)
    || setup.bRatio < ratios.b[0] - 1e-12 || setup.bRatio > ratios.b[1] + 1e-12
    || setup.cRatio < HARMONIC_C_RANGE[0] - 1e-12 || setup.cRatio > HARMONIC_C_RANGE[1] + 1e-12
    || setup.dRatioRange.some((ratio, i) => ratio !== ratios.d[i])) return false
  const projections = ratios.d.map((ratio) => setup.a.price - xa * ratio)
  const baseZone = { low: Math.min(...projections), high: Math.max(...projections) }
  const expected = setup.kind === 'butterfly' ? narrowButterflyZone(baseZone, setup.b.price, setup.c.price)
    : { zone: baseZone, zoneNarrowed: false }
  return closeNumber(setup.baseZone.low, baseZone.low) && closeNumber(setup.baseZone.high, baseZone.high)
    && closeNumber(setup.zone.low, expected.zone.low) && closeNumber(setup.zone.high, expected.zone.high)
    && setup.zoneNarrowed === expected.zoneNarrowed
    && closeNumber(setup.cInvalidation, setup.b.price + ab * HARMONIC_C_RANGE[1])
    && closeNumber(setup.stopReference, setup.kind === 'butterfly' ? (bullish ? setup.zone.low : setup.zone.high) : setup.x.price)
}

/** Saved objects are untrusted input: check shapes, bounds, chronology, ratios and derived levels. */
function usableCheckpoint(value: unknown): value is HarmonicReplayCheckpoint {
  if (!record(value) || value.version !== 1 || !record(value.options) || value.options.expiryMode !== 'fixed'
    || (value.startedAt !== null && (!timestamp(value.startedAt) || value.startedAt < 0))
    || !timestamp(value.offset) || value.offset < 0
    || !Array.isArray(value.history) || value.history.length > HARMONIC_MAX_HISTORY || !value.history.every(candle)
    || !Array.isArray(value.kinds) || value.kinds.length !== value.history.length
    || !value.kinds.every((kind) => kind === null || kind === 'high' || kind === 'low')
    || !record(value.dExtremes)
    || !Array.isArray(value.setups) || value.setups.length > HARMONIC_MAX_FINISHED + HARMONIC_MAX_HISTORY * 3
    || ![null, 'gap', 'invalid'].includes(value.historyIssue as null | string)) return false
  const state = value as unknown as HarmonicReplayCheckpoint
  const history = state.history
  if (!history.length) return state.startedAt === null && state.offset === 0 && state.setups.length === 0 && Object.keys(state.dExtremes).length === 0
  const duration = history[0].closeTime - history[0].openTime + 1
  if (state.startedAt === null || history[0].openTime !== state.startedAt + state.offset * duration
    || history.some((bar, index) => bar.closeTime - bar.openTime + 1 !== duration
      || (index > 0 && bar.openTime !== history[index - 1].closeTime + 1))) return false
  if (!state.setups.every((setup) => plan(setup, state)) || new Set(state.setups.map((setup) => setup.id)).size !== state.setups.length) return false
  const pending = state.setups.filter((setup) => setup.status === 'active' && !setup.confirmedD)
  if (Object.keys(state.dExtremes).length !== pending.length || pending.some((setup) => {
    const extreme = state.dExtremes[setup.id]
    if (!point(extreme) || extreme.index <= setup.c.index || extreme.index >= state.offset + history.length
      || extreme.time !== state.startedAt! + extreme.index * duration) return true
    if (extreme.index >= state.offset && extreme.price !== history[extreme.index - state.offset][setup.direction === 'bullish' ? 'low' : 'high']) return true
    return history.some((bar, index) => index + state.offset > setup.c.index
      && (setup.direction === 'bullish' ? bar.low < extreme.price : bar.high > extreme.price))
  })) return false
  return state.kinds.every((kind, index) => {
    if (kind === null) return true
    if (index < 3 || index + 3 >= history.length) return false
    return history.slice(index - 3, index + 4).every((bar, offset) => offset === 3
      || (kind === 'high' ? bar.high < history[index].high : bar.low > history[index].low))
  })
}

function replay(baseline: HarmonicReplayCheckpoint, history: readonly HarmonicBar[]): CachedHarmonics['state'] {
  const state = structuredClone(baseline)
  for (const bar of history) advanceHarmonicReplay(state, bar)
  return state
}

/**
 * Independent factory supports deterministic reconnect tests and isolated consumers.
 * Persisted identity must include market, timeframe and symbol. At most 16 recent
 * analyses fit a 1.5-million-character storage budget; only closed changes write.
 */
export function createHarmonicAnalysisCache(storageOverride?: HarmonicCheckpointStorage | null) {
  const cache = new Map<string, CachedHarmonics>()
  const storage = () => storageOverride === undefined ? browserStorage() : storageOverride

  function load(identity: string): { saved: SavedHarmonics | null; issue: string | null } {
    try {
      const serialized = storage()?.getItem(storageKey(identity))
      if (!serialized) return { saved: null, issue: null }
      if (serialized.length > MAX_RECORD_CHARACTERS) return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      const saved: unknown = JSON.parse(serialized)
      if (record(saved) && saved.unavailable === true) return { saved: null,
        issue: 'Newer lifecycle evidence could not be saved; rebuilt from available closed candles.' }
      if (record(saved) && saved.evicted === true) return { saved: null,
        issue: 'Older lifecycle evidence exceeded browser storage retention; rebuilt from available closed candles.' }
      if (!record(saved) || saved.version !== 1 || saved.identity !== identity
        || !usableCheckpoint(saved.baseline) || !Array.isArray(saved.window)
        || saved.window.length > HARMONIC_MAX_HISTORY || !saved.window.every(candle)
        || !Array.isArray(saved.source) || saved.source.length > MAX_SOURCE_EVIDENCE
        || !saved.source.every((identity) => typeof identity === 'string' && identity.length <= 256 && identity.indexOf('|') > 0 && timestamp(identityTime(identity)))) return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      if (saved.continuity !== undefined && (!record(saved.continuity)
        || !['restored', 'reset'].includes(String(saved.continuity.state)) || typeof saved.continuity.detail !== 'string'
        || saved.continuity.detail.length > 2_000
        || (saved.continuity.previousSetupId !== null && typeof saved.continuity.previousSetupId !== 'string'))) {
        return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      }
      const window = saved.window as HarmonicBar[]
      const lastBaseline = saved.baseline.history.at(-1)
      if (window.some((bar, index) => index > 0 && (bar.openTime !== window[index - 1].closeTime + 1
          || bar.closeTime - bar.openTime !== window[index - 1].closeTime - window[index - 1].openTime))
        || (lastBaseline && window.length && (window[0].openTime !== lastBaseline.closeTime + 1
          || window[0].closeTime - window[0].openTime !== lastBaseline.closeTime - lastBaseline.openTime))) {
        return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      }
      return { saved: saved as unknown as SavedHarmonics, issue: null }
    } catch { return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' } }
  }

  function save(entry: CachedHarmonics): boolean {
    const key = storageKey(entry.identity)
    const unavailable = () => {
      try {
        const target = storage()
        // An older saved baseline may predate a correction no longer present in
        // the next snapshot. It must not be silently resurrected after a failed write.
        target?.removeItem(key)
        target?.setItem(key, JSON.stringify({ version: 1, unavailable: true, savedAt: Date.now() }))
      } catch { /* Persistence failure is also surfaced in the live analysis. */ }
      return false
    }
    try {
      const target = storage()
      if (!target) return true
      const { version, identity, baseline, window, source } = entry
      if (!entry.analysis.setups.some((setup) => setup.status === 'active') && !entry.analysis.continuity && !entry.state.setups.length) {
        target.removeItem(key)
        return true
      }
      const priority = entry.analysis.setups.some((setup) => setup.status === 'active' && setup.d) ? 2
        : entry.analysis.setups.some((setup) => setup.status === 'active') ? 1 : 0
      // Invalid/interrupted input is reduced to the resulting contiguous suffix
      // before saving, so no unverifiable pre-gap lifecycle survives a reload.
      const payload = JSON.stringify({ version, identity, baseline, window, source, priority, savedAt: Date.now(), continuity: entry.analysis.continuity })
      if (payload.length > MAX_RECORD_CHARACTERS) return unavailable()
      const keys: { key: string; length: number; savedAt: number; evicted: boolean; priority: number }[] = []
      for (let i = 0; i < target.length; i++) {
        const item = target.key(i)
        if (!item?.startsWith(PREFIX) || item === key) continue
        const serialized = target.getItem(item) ?? ''
        let metadata: Record<string, unknown> = {}
        try { const parsed: unknown = JSON.parse(serialized); if (record(parsed)) metadata = parsed } catch { /* Retention also removes malformed records. */ }
        keys.push({ key: item, length: serialized.length,
          savedAt: finite(metadata.savedAt) ? metadata.savedAt : 0, evicted: metadata.evicted === true || metadata.unavailable === true,
          priority: finite(metadata.priority) ? metadata.priority : 0 })
      }
      keys.sort((a, b) => a.priority - b.priority || a.savedAt - b.savedAt)
      let total = payload.length + keys.reduce((sum, item) => sum + item.length, 0)
      const retained = keys.filter((item) => !item.evicted)
      while (retained.length >= MAX_SAVED || total > MAX_STORAGE_CHARACTERS) {
        const oldest = retained.shift()
        if (!oldest) return unavailable()
        if (oldest.priority > priority) {
          target.setItem(key, JSON.stringify({ version: 1, evicted: true, savedAt: Date.now() }))
          return false
        }
        // Keep a small tombstone so a reload reports lost lifecycle evidence
        // instead of silently treating an evicted active setup as never observed.
        const tombstone = JSON.stringify({ version: 1, evicted: true, savedAt: oldest.savedAt })
        target.setItem(oldest.key, tombstone)
        total -= oldest.length - tombstone.length
        oldest.evicted = true
      }
      // Bound even the small retention notices for removed market identities.
      while (keys.length >= 1_000) {
        const oldest = keys.shift()!
        target.removeItem(oldest.key)
      }
      target.setItem(key, payload)
      return true
    } catch { return unavailable() }
  }

  function get(identity: string, bars: readonly HarmonicBar[]): HarmonicAnalysis {
    let end = bars.length
    while (end > 0 && bars[end - 1].isClosed === false) end--
    const incoming = bars.slice(0, end)
    // Loading/empty snapshots must not delete a durable checkpoint. Reset is explicit.
    if (!incoming.length) return summarizeHarmonicReplay(createHarmonicReplay())
    const current = cache.get(identity)
    let previous = current
    let restored = false
    let invalidSaved: string | null = null
    if (!previous) {
      const loaded = load(identity)
      invalidSaved = loaded.issue
      if (loaded.saved) {
        const state = replay(loaded.saved.baseline, loaded.saved.window)
        previous = { ...loaded.saved, state, analysis: { ...summarizeHarmonicReplay(state),
          ...(loaded.saved.continuity ? { continuity: loaded.saved.continuity } : {}) } }
        restored = true
      }
    }
    // Production snapshots contain up to 3,000 closed candles. Preserve their
    // exact correction identities even though the replay window is only 500.
    if (previous && !restored && sameSource(incoming, previous.sourceValues)) return previous.analysis
    let source = incoming.slice(-MAX_SOURCE_EVIDENCE).map(candleIdentity)
    let baseline = createHarmonicReplay()
    let history = incoming
    let continuity: HarmonicAnalysis['continuity']
    let continued = false
    const reset = (detail: string) => {
      continuity = { state: 'reset', detail, previousSetupId: previous?.analysis.setups.find((setup) => setup.status === 'active')?.id ?? current?.analysis.setups.at(-1)?.id ?? null }
    }
    if (invalidSaved) reset(invalidSaved)
    if (previous) {
      const first = incoming[0]
      const last = incoming.at(-1)!
      const previousLast = previous.window.at(-1)
      const start = previous.window.findIndex((bar) => bar.openTime === first.openTime)
      if (previousLast && last.closeTime < previousLast.closeTime) {
        reset('History moved backwards; rebuilt at the supplied historical time.')
      } else if (start >= 0) {
        baseline = structuredClone(previous.baseline)
        continued = true
        history = [...previous.window.slice(0, start), ...incoming]
      } else if (previousLast && first.openTime === previousLast.closeTime + 1) {
        baseline = structuredClone(previous.baseline)
        continued = true
        history = [...previous.window, ...incoming]
      } else if (previousLast && first.openTime > previousLast.closeTime + 1) {
        reset('Reconnect missed closed candles; older setup tracking was interrupted and must be reviewed.')
      } else if (previous.window.length && first.openTime < previous.window[0].openTime) {
        const replayStart = previous.window[0].openTime
        const priorEvidence = new Map(previous.source.map((identity) => [identityTime(identity), identity]))
        const oldPrefix = incoming.filter((bar) => bar.openTime < replayStart)
        const prefixMatches = oldPrefix.every((bar) => priorEvidence.get(bar.openTime) === candleIdentity(bar))
        const validIncoming = incoming.every((bar, index) => candle(bar)
          && (index === 0 || (bar.openTime === incoming[index - 1].closeTime + 1
            && bar.closeTime - bar.openTime === incoming[index - 1].closeTime - incoming[index - 1].openTime)))
        const replayIndex = incoming.findIndex((bar) => bar.openTime === replayStart)
        if (prefixMatches && validIncoming && replayIndex >= 0) {
          baseline = structuredClone(previous.baseline)
          continued = true
          history = incoming.slice(replayIndex)
        } else {
          reset('Earlier closed-candle evidence changed or could not be verified before the replay checkpoint; rebuilt from available evidence.')
        }
      } else {
        reset('Closed-candle history no longer overlaps the checkpoint; rebuilt from available evidence.')
      }
      if (continued) {
        // A shorter reconnect must not discard older exact correction evidence.
        source = [...previous.source.filter((identity) => identityTime(identity) < first.openTime), ...source]
          .slice(-MAX_SOURCE_EVIDENCE)
        if (history.length === previous.window.length && history.every((bar, index) => sameBar(bar, previous!.window[index]))
          && !continuity && !restored) {
          previous.source = source
          previous.sourceValues = snapshotSource(incoming)
          return previous.analysis
        }
      }
    }

    // Move only the baseline; replaying its following window handles corrections
    // without duplicating lifecycle events or retaining mutation from a stale result.
    const excess = Math.max(0, history.length - HARMONIC_MAX_HISTORY)
    for (let i = 0; i < excess; i++) advanceHarmonicReplay(baseline, history[i])
    let window = history.slice(excess).map((bar) => ({
      openTime: bar.openTime, closeTime: bar.closeTime, open: bar.open, high: bar.high,
      low: bar.low, close: bar.close, volume: bar.volume, isClosed: bar.isClosed,
    }))
    let state = replay(baseline, window)
    const analysis = summarizeHarmonicReplay(state)
    if (analysis.historyIssue && previous?.analysis.setups.some((setup) => setup.status === 'active')) {
      reset('Missing or invalid closed candles interrupted the older setup; rebuilt from the contiguous suffix.')
    }
    if (continuity) analysis.continuity = continuity
    else if (continued && previous?.analysis.continuity?.state === 'reset') analysis.continuity = previous.analysis.continuity
    else if (restored) analysis.continuity = {
      state: 'restored', detail: 'Saved harmonic setups restored after matching available closed-candle evidence; earlier candles remain checkpointed.',
      previousSetupId: previous?.analysis.setups.find((setup) => setup.status === 'active')?.id ?? null,
    }
    if (analysis.historyIssue) {
      // A gap inside the correction window invalidates its older prefix. A gap
      // already checkpointed must not discard active setups older than 500 bars.
      if (state.startedAt === null || window.some((bar) => bar.openTime === state.startedAt)) {
        window = state.startedAt === null ? [] : window.filter((bar) => bar.openTime >= state.startedAt!)
        baseline = createHarmonicReplay()
        state = replay(baseline, window)
      } else {
        baseline.historyIssue = null
        state.historyIssue = null
      }
    }
    const entry: CachedHarmonics = { version: 1, identity, baseline, window, source,
      sourceValues: snapshotSource(incoming), state, analysis }
    // Bound in-memory history when market lists/timeframes change.
    if (!cache.has(identity) && cache.size >= 1_000) cache.delete(cache.keys().next().value!)
    cache.set(identity, entry)
    if (!save(entry)) analysis.persistenceIssue = 'unavailable'
    return analysis
  }

  function reset(identity: string): void {
    cache.delete(identity)
    try {
      const target = storage()
      if (!target) return
      const prefix = storageKey(identity)
      const keys = Array.from({ length: target.length }, (_, i) => target.key(i)).filter((key): key is string => key === prefix)
      keys.forEach((key) => target.removeItem(key))
    } catch { /* A later analysis explicitly reports unavailable persistence. */ }
  }
  return { get, reset, clearMemory: () => cache.clear() }
}

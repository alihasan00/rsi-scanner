import type { FibAnalysis, FibBar, FibReplayCheckpoint, FibSetup } from './fibonacci'
import {
  advanceFibReplay, createFibReplay, FIB_DISCOVERY_BARS, isActiveFibSetup, summarizeFibReplay,
} from './fibonacci'
import type { FibSettings } from './fibPreferences'

export interface FibCheckpointStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface SavedFib {
  version: 1
  identity: string
  settingsKey: string
  /** State immediately before window, including any older active plan. */
  baseline: FibReplayCheckpoint
  window: FibBar[]
  /** Exact identities for the bounded production feed, including older correction evidence. */
  source: string[]
  continuity?: FibAnalysis['continuity']
}
interface CachedFib extends SavedFib {
  sourceValues?: Float64Array
  state: FibReplayCheckpoint
  analysis: FibAnalysis
}

const PREFIX = 'rsi-scanner:fib-lifecycle:v1:'
const MAX_SAVED = 16
const MAX_STORAGE_CHARACTERS = 1_500_000
const MAX_RECORD_CHARACTERS = 500_000
const MAX_SOURCE_EVIDENCE = 3_000
const BAR_FIELDS = ['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'volume', 'isClosed'] as const
const settingsIdentity = (settings: FibSettings) => JSON.stringify([
  settings.scale, settings.stopRatio, settings.tp3Ratio, settings.tp4Ratio, settings.runnerRatio,
])
const sameBar = (a: FibBar, b: FibBar) => BAR_FIELDS.every((field) => Object.is(a[field], b[field]))
const candleIdentity = (bar: FibBar) => `${bar.openTime}|${bar.closeTime},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume},${bar.isClosed ? 1 : 0}`
const identityTime = (identity: string) => Number(identity.slice(0, identity.indexOf('|')))
const scalar = (bar: FibBar, field: typeof BAR_FIELDS[number]) => field === 'isClosed' ? Number(bar.isClosed) : bar[field]
function snapshotSource(bars: readonly FibBar[]): Float64Array | undefined {
  if (bars.length > MAX_SOURCE_EVIDENCE) return undefined
  return Float64Array.from(bars.flatMap((bar) => BAR_FIELDS.map((field) => scalar(bar, field))))
}
function sameSource(bars: readonly FibBar[], previous: Float64Array | undefined): boolean {
  return previous?.length === bars.length * BAR_FIELDS.length && bars.every((bar, index) =>
    BAR_FIELDS.every((field, offset) => Object.is(scalar(bar, field), previous[index * BAR_FIELDS.length + offset])))
}
const storageKey = (identity: string, settingsKey: string) => `${PREFIX}${encodeURIComponent(identity)}:${encodeURIComponent(settingsKey)}`

function browserStorage(): FibCheckpointStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function timestamp(value: unknown): value is number { return finite(value) && Number.isSafeInteger(value) }
function positive(value: unknown): value is number { return finite(value) && value > 0 }
function anchor(value: unknown): boolean {
  return record(value) && timestamp(value.index) && value.index >= 0 && timestamp(value.time)
    && positive(value.price) && timestamp(value.confirmedAt)
}
function candle(value: unknown): value is FibBar {
  return record(value) && timestamp(value.openTime) && timestamp(value.closeTime) && value.closeTime >= value.openTime
    && positive(value.open) && positive(value.close) && positive(value.high) && positive(value.low)
    && value.low <= Math.min(value.open, value.close) && value.high >= Math.max(value.open, value.close)
    && finite(value.volume) && value.volume >= 0 && value.isClosed === true
}
function plan(value: unknown): value is FibSetup {
  if (!record(value) || typeof value.id !== 'string' || !['long', 'short'].includes(String(value.direction))
    || !['watching', 'entered', 'managing', 'runner', 'stopped', 'missed', 'invalidated', 'superseded'].includes(String(value.status))
    || !anchor(value.start) || !anchor(value.end) || !timestamp(value.detectedAt) || !timestamp(value.breakAt)
    || (value.resolvedAt !== null && !timestamp(value.resolvedAt))
    || !['linear', 'log'].includes(String(value.scale)) || ![0.92, 1.04, 1.14, 1.272].includes(Number(value.stopRatio))
    || !positive(value.initialStop) || !positive(value.currentStop) || !positive(value.plannedAverage)
    || (value.actualAverage !== null && !positive(value.actualAverage)) || !finite(value.remainingPercent)
    || value.remainingPercent < 0 || value.remainingPercent > 100
    || !record(value.goldenPocket) || !positive(value.goldenPocket.low) || !positive(value.goldenPocket.high)) return false
  return Array.isArray(value.entries) && value.entries.length === 3 && value.entries.every((entry) => record(entry)
    && finite(entry.ratio) && positive(entry.price) && positive(entry.weight)
    && ['pending', 'filled', 'missed', 'cancelled'].includes(String(entry.status))
    && (entry.touchedAt === null || timestamp(entry.touchedAt)) && (entry.filledAt === null || timestamp(entry.filledAt)))
    && Array.isArray(value.targets) && value.targets.length === 5 && value.targets.every((target) => record(target)
      && ['tp1', 'tp2', 'tp3', 'tp4', 'runner'].includes(String(target.id)) && finite(target.ratio)
      && positive(target.price) && finite(target.exitPercent) && (target.hitAt === null || timestamp(target.hitAt)))
    && Array.isArray(value.events) && value.events.length <= 40 && value.events.every((event) => record(event)
      && timestamp(event.time) && typeof event.kind === 'string' && typeof event.detail === 'string')
    && Array.isArray(value.levels) && value.levels.length <= 24 && value.levels.every((level) => record(level)
      && finite(level.ratio) && positive(level.price))
    && Array.isArray(value.unavailableReferenceRatios) && value.unavailableReferenceRatios.length <= 24
    && value.unavailableReferenceRatios.every(finite)
}

/** Stored state is input: reject malformed/version-mismatched checkpoints in full. */
function usableCheckpoint(value: unknown, settings: FibSettings): value is FibReplayCheckpoint {
  if (!record(value) || value.version !== 1 || !record(value.options)
    || settingsIdentity(value.options as unknown as FibSettings) !== settingsIdentity(settings)
    || (value.startedAt !== null && !timestamp(value.startedAt))
    || !timestamp(value.offset) || value.offset < 0
    || !Array.isArray(value.history) || value.history.length > FIB_DISCOVERY_BARS || !value.history.every(candle)
    || !Array.isArray(value.setups) || value.setups.length > FIB_DISCOVERY_BARS || !value.setups.every(plan)
    || (value.high !== null && !anchor(value.high)) || (value.low !== null && !anchor(value.low))
    || !['bullish', 'bearish', 'range', 'insufficient'].includes(String(value.structure))
    || ![null, 'gap', 'invalid'].includes(value.historyIssue as null | string)
    || !Array.isArray(value.consumedOrigins) || value.consumedOrigins.length > FIB_DISCOVERY_BARS
    || !value.consumedOrigins.every((key) => typeof key === 'string' && /^(long|short):\d+$/.test(key))
    || !Array.isArray(value.brokenHighs) || value.brokenHighs.length > FIB_DISCOVERY_BARS || !value.brokenHighs.every(timestamp)
    || !Array.isArray(value.brokenLows) || value.brokenLows.length > FIB_DISCOVERY_BARS || !value.brokenLows.every(timestamp)) return false
  const history = value.history as FibBar[]
  const limit = value.offset + history.length
  for (const candidate of [value.high, value.low]) {
    if (candidate !== null && record(candidate) && Number(candidate.index) >= limit) return false
  }
  if ((value.setups as FibSetup[]).some((setup) => setup.start.index >= limit || setup.end.index >= limit)) return false
  if (history.length && (value.startedAt === null || Number(value.startedAt) > history[0].openTime)) return false
  if (history.some((bar, index) => index > 0 && bar.openTime !== history[index - 1].closeTime + 1)) return false
  if (value.pending !== null) {
    if (!record(value.pending) || !['long', 'short'].includes(String(value.pending.direction))
      || !anchor(value.pending.start) || Number((value.pending.start as Record<string, unknown>).index) >= limit || !timestamp(value.pending.breakAt) || !timestamp(value.pending.endIndex)
      || value.pending.endIndex < value.offset || value.pending.endIndex >= value.offset + history.length
      || (value.pending.durableOrigin !== undefined && typeof value.pending.durableOrigin !== 'boolean')) return false
  }
  return true
}

function replay(baseline: FibReplayCheckpoint, history: readonly FibBar[]): CachedFib['state'] {
  const state = structuredClone(baseline)
  for (const bar of history) advanceFibReplay(state, bar)
  return state
}

/**
 * Independent factory supports deterministic reconnect tests and isolated consumers.
 * Persisted identity must include market, timeframe and symbol. At most 16 recent
 * analyses fit a 1.5-million-character storage budget; only closed changes write.
 */
export function createFibAnalysisCache(storageOverride?: FibCheckpointStorage | null) {
  const cache = new Map<string, CachedFib>()
  const storage = () => storageOverride === undefined ? browserStorage() : storageOverride

  function load(identity: string, settings: FibSettings): { saved: SavedFib | null; issue: string | null } {
    const settingsKey = settingsIdentity(settings)
    try {
      const serialized = storage()?.getItem(storageKey(identity, settingsKey))
      if (!serialized) return { saved: null, issue: null }
      if (serialized.length > MAX_RECORD_CHARACTERS) return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      const saved: unknown = JSON.parse(serialized)
      if (record(saved) && saved.evicted === true) return { saved: null,
        issue: 'Older lifecycle evidence exceeded browser storage retention; rebuilt from available closed candles.' }
      if (!record(saved) || saved.version !== 1 || saved.identity !== identity || saved.settingsKey !== settingsKey
        || !usableCheckpoint(saved.baseline, settings) || !Array.isArray(saved.window)
        || saved.window.length > FIB_DISCOVERY_BARS || !saved.window.every(candle)
        || !Array.isArray(saved.source) || saved.source.length > MAX_SOURCE_EVIDENCE
        || !saved.source.every((identity) => typeof identity === 'string' && identity.length <= 256 && identity.indexOf('|') > 0 && timestamp(identityTime(identity)))) return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      if (saved.continuity !== undefined && (!record(saved.continuity)
        || !['restored', 'reset'].includes(String(saved.continuity.state)) || typeof saved.continuity.detail !== 'string'
        || saved.continuity.detail.length > 2_000
        || (saved.continuity.previousSetupId !== null && typeof saved.continuity.previousSetupId !== 'string'))) {
        return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      }
      const window = saved.window as FibBar[]
      const lastBaseline = saved.baseline.history.at(-1)
      if (window.some((bar, index) => index > 0 && bar.openTime !== window[index - 1].closeTime + 1)
        || (lastBaseline && window.length && window[0].openTime !== lastBaseline.closeTime + 1)) {
        return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' }
      }
      return { saved: saved as unknown as SavedFib, issue: null }
    } catch { return { saved: null, issue: 'Saved lifecycle evidence could not be verified; rebuilt from available closed candles.' } }
  }

  function save(entry: CachedFib): boolean {
    try {
      const target = storage()
      if (!target) return true
      const { version, identity, settingsKey, baseline, window, source } = entry
      const key = storageKey(identity, settingsKey)
      if (!entry.analysis.setup && !entry.state.pending && !entry.analysis.continuity) {
        target.removeItem(key)
        return true
      }
      const setup = entry.analysis.setup
      const priority = setup && isActiveFibSetup(setup) && setup.actualAverage !== null ? 2
        : (setup && isActiveFibSetup(setup)) || entry.state.pending ? 1 : 0
      // Invalid/interrupted input is reduced to the resulting contiguous suffix
      // before saving, so no unverifiable pre-gap lifecycle survives a reload.
      const payload = JSON.stringify({ version, identity, settingsKey, baseline, window, source, priority, savedAt: Date.now(), continuity: entry.analysis.continuity })
      if (payload.length > MAX_RECORD_CHARACTERS) return false
      const keys: { key: string; length: number; savedAt: number; evicted: boolean; priority: number }[] = []
      for (let i = 0; i < target.length; i++) {
        const item = target.key(i)
        if (!item?.startsWith(PREFIX) || item === key) continue
        const serialized = target.getItem(item) ?? ''
        let metadata: Record<string, unknown> = {}
        try { const parsed: unknown = JSON.parse(serialized); if (record(parsed)) metadata = parsed } catch { /* Retention also removes malformed records. */ }
        keys.push({ key: item, length: serialized.length,
          savedAt: finite(metadata.savedAt) ? metadata.savedAt : 0, evicted: metadata.evicted === true,
          priority: finite(metadata.priority) ? metadata.priority : 0 })
      }
      keys.sort((a, b) => a.priority - b.priority || a.savedAt - b.savedAt)
      let total = payload.length + keys.reduce((sum, item) => sum + item.length, 0)
      const retained = keys.filter((item) => !item.evicted)
      while (retained.length >= MAX_SAVED || total > MAX_STORAGE_CHARACTERS) {
        const oldest = retained.shift()
        if (!oldest) return false
        if (oldest.priority > priority) {
          target.setItem(key, JSON.stringify({ version: 1, evicted: true, savedAt: Date.now() }))
          return false
        }
        // Keep a small tombstone so a reload reports lost lifecycle evidence
        // instead of silently treating an evicted active plan as never observed.
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
    } catch { return false }
  }

  function get(identity: string, bars: readonly FibBar[], settings: FibSettings): FibAnalysis {
    let end = bars.length
    while (end > 0 && bars[end - 1].isClosed === false) end--
    const incoming = bars.slice(0, end)
    // Loading/empty snapshots must not delete a durable checkpoint. Reset is explicit.
    if (!incoming.length) return summarizeFibReplay(createFibReplay(settings))
    const settingsKey = settingsIdentity(settings)
    const current = cache.get(identity)
    let previous = current?.settingsKey === settingsKey ? current : undefined
    let restored = false
    let invalidSaved: string | null = null
    if (!previous) {
      const loaded = load(identity, settings)
      invalidSaved = loaded.issue
      if (loaded.saved) {
        const state = replay(loaded.saved.baseline, loaded.saved.window)
        previous = { ...loaded.saved, state, analysis: { ...summarizeFibReplay(state),
          ...(loaded.saved.continuity ? { continuity: loaded.saved.continuity } : {}) } }
        restored = true
      }
    }
    // Production snapshots contain up to 3,000 closed candles. Preserve their
    // exact correction identities even though the replay window is only 500.
    if (previous && !restored && sameSource(incoming, previous.sourceValues)) return previous.analysis
    let source = incoming.slice(-MAX_SOURCE_EVIDENCE).map(candleIdentity)
    let baseline = createFibReplay(settings)
    let history = incoming
    let continuity: FibAnalysis['continuity']
    let continued = false
    const reset = (detail: string) => {
      continuity = { state: 'reset', detail, previousSetupId: previous?.analysis.setup?.id ?? current?.analysis.setup?.id ?? null }
    }
    if (invalidSaved) reset(invalidSaved)
    if (current && current.settingsKey !== settingsKey && !previous && current.state.startedAt !== null && incoming[0].openTime > current.state.startedAt) {
      reset('Settings changed after older evidence left the checkpoint; rebuilt from available closed candles.')
    }
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
        reset('Reconnect missed closed candles; older plan tracking was interrupted and must be reviewed.')
      } else if (previous.window.length && first.openTime < previous.window[0].openTime) {
        const replayStart = previous.window[0].openTime
        const priorEvidence = new Map(previous.source.map((identity) => [identityTime(identity), identity]))
        const oldPrefix = incoming.filter((bar) => bar.openTime < replayStart)
        const prefixMatches = oldPrefix.every((bar) => priorEvidence.get(bar.openTime) === candleIdentity(bar))
        const validIncoming = incoming.every((bar, index) => candle(bar)
          && (index === 0 || bar.openTime === incoming[index - 1].closeTime + 1))
        const replayIndex = incoming.findIndex((bar) => bar.openTime === replayStart)
        if (prefixMatches && validIncoming && replayIndex >= 0) {
          baseline = structuredClone(previous.baseline)
          continued = true
          history = incoming.slice(replayIndex)
        } else if (previous.state.startedAt !== null && first.openTime > previous.state.startedAt) {
          reset('Earlier closed-candle evidence changed or could not be verified before the replay checkpoint; older lifecycle tracking was reset.')
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
    // without duplicating fills/targets or retaining mutation from a stale result.
    const excess = Math.max(0, history.length - FIB_DISCOVERY_BARS)
    for (let i = 0; i < excess; i++) advanceFibReplay(baseline, history[i])
    let window = history.slice(excess).map((bar) => ({
      openTime: bar.openTime, closeTime: bar.closeTime, open: bar.open, high: bar.high,
      low: bar.low, close: bar.close, volume: bar.volume, isClosed: bar.isClosed,
    }))
    let state = replay(baseline, window)
    const analysis = summarizeFibReplay(state)
    if (analysis.historyIssue && previous?.analysis.setup && isActiveFibSetup(previous.analysis.setup)) {
      reset('Missing or invalid closed candles interrupted the older plan; rebuilt from the contiguous suffix.')
    }
    if (continuity) analysis.continuity = continuity
    else if (continued && previous?.analysis.continuity?.state === 'reset') analysis.continuity = previous.analysis.continuity
    else if (restored) analysis.continuity = {
      state: 'restored', detail: 'Saved plan restored after matching available closed-candle evidence; earlier candles remain checkpointed.',
      previousSetupId: previous?.analysis.setup?.id ?? null,
    }
    if (analysis.historyIssue) {
      // Compact after a gap while keeping this result's issue visible.
      window = state.history.map((bar) => ({ ...bar }))
      baseline = createFibReplay(settings)
      state = replay(baseline, window)
    }
    const entry: CachedFib = { version: 1, identity, settingsKey, baseline, window, source,
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
      const prefix = `${PREFIX}${encodeURIComponent(identity)}:`
      const keys = Array.from({ length: target.length }, (_, i) => target.key(i)).filter((key): key is string => !!key?.startsWith(prefix))
      keys.forEach((key) => target.removeItem(key))
    } catch { /* A later analysis explicitly reports unavailable persistence. */ }
  }
  return { get, reset, clearMemory: () => cache.clear() }
}

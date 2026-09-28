import { describe, expect, test } from 'bun:test'
import { buildWatchlistReview } from '../src/lib/watchlistReview'
import type { WatchlistRow } from '../src/lib/watchlist'
import type { WatchlistInstrument } from '../src/lib/watchlistInstruments'
import type { WatchlistChartSnapshot } from '../src/lib/watchlistChart'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import type { Candle } from '../src/types'
import { ichimokuFixture } from './fixtures/watchlistIchimoku'

const EVALUATED_AT = Date.parse('2026-09-28T12:05:00Z')
const COPIED_AT = EVALUATED_AT + 10_000
const FRAME_NAMES = ['15m', '1h', '4h', '1d'] as const

function chart(): WatchlistChartSnapshot {
  const frames = FRAME_NAMES.map((timeframe, frameIndex) => {
    const duration = TIMEFRAME_MILLISECONDS[timeframe]
    const nextOpen = Math.floor(EVALUATED_AT / duration) * duration
    const bar = (index: number): Candle => ({
      openTime: nextOpen - (3 - index) * duration, closeTime: nextOpen - (2 - index) * duration - 1,
      open: 100 + index, high: 110 + index, low: 90 + index, close: 103 + index,
      volume: 842000.125 + frameIndex * 10 + index,
    })
    return { timeframe, receivedAt: EVALUATED_AT - 1_000, lastClosedAt: nextOpen - 1,
      candles: [bar(0), bar(1), bar(2)], preview: bar(3) }
  })
  const hour = frames.find((frame) => frame.timeframe === '1h')!
  return { snapshotId: 'review:BTC:exact-evaluated-input', evaluatedAt: EVALUATED_AT, defaultTimeframe: '1h', frames,
    points: [
      { label: 'X', timeframe: '1h', time: hour.candles[0].openTime, price: 111.125 },
      { label: 'A', timeframe: '1h', time: hour.candles[1].openTime, price: 91.125 },
      { label: 'D', timeframe: '1h', time: hour.candles[2].openTime, price: 101.125 },
    ],
    events: [
      { kind: 'detected', label: 'Setup detected', timeframe: '1h', time: hour.candles[1].closeTime, price: null },
      { kind: 'trigger', label: 'Closed structure confirmation', timeframe: '15m', time: frames[0].lastClosedAt, price: 102.875 },
    ],
    sourceWindow: { timeframe: '1h', startTime: hour.candles[0].openTime, endTime: hour.candles[2].closeTime },
    evidence: [{ label: 'Confirmation evidence', detail: 'A later closed candle crossed the frozen level.', timeframe: '15m', time: frames[0].lastClosedAt }],
    notes: ['The open candle is provisional.'],
  }
}

function fixture() {
  const snapshot = chart()
  const row: WatchlistRow = {
    id: 'spot:1h:BTCUSDT:harmonic:original-gartley', symbol: 'BTCUSDT', market: 'spot', timeframe: '1h',
    source: 'harmonic', name: 'Gartley bullish selected · 1h', direction: 'bullish', status: 'confirmed',
    price: 103.625, zone: { low: 100.25, high: 101.75 }, stop: 97.375, target: 114.875,
    riskReward: 1.8, distancePercent: 2.4, distanceAtr: 0.45, confirmedAt: snapshot.events[1].time,
    asOf: snapshot.frames[1].lastClosedAt, updatedAt: EVALUATED_AT - 1_000,
    reason: 'The selected harmonic has intact source geometry and a completed trigger.',
    next: 'Review the selected reference plan.', cautions: ['No trade was executed.'],
    evidence: [], families: [], conflict: false,
    reference: {
      engineVersion: '0.13.1-test-export', maxAgeMs: 120_000, nativeStatus: 'ready_for_review',
      statusLabel: 'D + 15m confirmed', mode: 'Trend aligned', planStatus: 'ready_for_review',
      netRiskReward: 1.61, feeBps: 20, slippageBps: 10, minNetRR: 1,
      entry: 101.125, planEntry: 102.875, chart: snapshot, distanceLabel: '0.45 ATR from entry',
      expiresAt: EVALUATED_AT + 60_000,
      frames: snapshot.frames.map((frame) => ({ timeframe: frame.timeframe, trend: 'bullish', structure: 'bullish', asOf: frame.lastClosedAt })),
    },
  }
  const opposing: WatchlistRow = {
    ...row, id: 'spot:4h:BTCUSDT:trend:opposing-pullback', timeframe: '4h', source: 'trend',
    name: 'Opposing bearish trend · 4h', direction: 'bearish', status: 'waiting', stop: 123.875, target: 88.375,
    reason: 'An independent bearish thesis remains under observation.',
    reference: { ...row.reference!, entry: 109.125, planEntry: null, chart: undefined,
      nativeStatus: 'waiting_for_retest', statusLabel: 'Waiting for retest', planStatus: 'waiting_for_retest', expiresAt: null },
  }
  const instrument: WatchlistInstrument = {
    id: 'spot:BTCUSDT', symbol: row.symbol, market: row.market, timeframe: row.timeframe,
    lead: row, setups: [row], allSetups: [row, opposing], direction: 'bullish',
    sources: ['harmonic'], status: row.status, hasMixedDirections: true,
  }
  return { row, instrument, copiedAt: COPIED_AT, current: true, snapshotCurrent: true, newerAvailable: false }
}

function readEmbeddedData(html: string): unknown {
  const match = html.match(/<pre\b[^>]*\bid=["']watchlist-review-data["'][^>]*>([\s\S]*?)<\/pre>/i)
  expect(match).not.toBeNull()
  const decoded = match![1].replace(/&(lt|gt|amp|quot|#39);/g, (entity) => ({
    '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'",
  }[entity]!))
  return JSON.parse(decoded)
}

function decodedAttribute(value: string): string {
  return value.replace(/&#(x[\da-f]+|\d+);?/gi, (_, code: string) => String.fromCodePoint(
    code.toLowerCase().startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10),
  )).replace(/&(colon|tab|newline|quot|apos|amp);/gi, (_, name: string) => ({
    colon: ':', tab: '\t', newline: '\n', quot: '"', apos: "'", amp: '&',
  }[name.toLowerCase()]!))
}

function findObject(value: unknown, predicate: (item: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (!Array.isArray(value) && predicate(value as Record<string, unknown>)) return value as Record<string, unknown>
  for (const child of Object.values(value)) {
    const found = findObject(child, predicate)
    if (found) return found
  }
  return undefined
}

function snapshotFrom(html: string): WatchlistChartSnapshot {
  const data = readEmbeddedData(html)
  const found = findObject(data, (item) => item.snapshotId === 'review:BTC:exact-evaluated-input' && Array.isArray(item.frames))
  expect(found).toBeDefined()
  return found as unknown as WatchlistChartSnapshot
}

async function inspectHtml(html: string) {
  const elements: { name: string; attributes: [string, string][] }[] = []
  let style = ''
  const rewriter = new HTMLRewriter()
    .on('*', { element(element) { elements.push({ name: element.tagName.toLowerCase(), attributes: [...element.attributes] }) } })
    .on('style', { text(chunk) { style += chunk.text } })
  await rewriter.transform(new Response(html)).text()
  return { elements, style }
}

describe('saved watchlist review', () => {
  test('includes all captured Ichimoku readings, projection timing and exclusions in text and complete inert HTML', () => {
    const input = fixture()
    const chart = input.row.reference!.chart!
    const source = chart.frames[1]
    const { reading, series } = ichimokuFixture(source.candles)
    Object.assign(source, { ichimoku: reading, ichimokuSeries: series })
    const result = buildWatchlistReview(input, '<svg><title>Ichimoku chart · known forward display</title><path class="is-kijun" d="M1,2 L3,4" stroke="#e46c79"/><polygon class="is-projected" points="1,2 3,4 5,6" stroke-dasharray="3 4"/></svg>')
    expect(result.text).toContain('Captured Ichimoku lecture observations')
    expect(result.text).toContain('97.12345')
    expect(result.text).toContain('94.30345')
    expect(result.text).toContain('Known forward twist')
    expect(result.text).toContain('Excluded geometry')
    expect(result.text).toContain('Chikou is excluded')
    expect(result.text).toContain('No numeric significant-width threshold')
    const captured = snapshotFrom(result.html).frames[1]
    expect(captured.ichimoku).toEqual(reading)
    expect(captured.ichimokuSeries).toEqual(series)
    expect(result.html).toContain('stroke-dasharray="3 4"')
    expect(result.html).toContain('class="is-kijun"')
  })
  test('keeps geometric entry, plan entry and evaluated quote distinct in the written review', () => {
    const input = fixture()
    const { text, html } = buildWatchlistReview(input)
    expect(text).toMatch(/(?:geometric|entry reference|pullback reference)[^\n]*101\.125/i)
    expect(text).toMatch(/plan entry[^\n]*102\.875/i)
    expect(text).toMatch(/evaluated (?:market )?(?:quote|price)[^\n]*103\.625/i)
    expect(text).toContain('97.375')
    expect(text).toContain('114.875')
    expect(text).toContain('1.61')
    expect(snapshotFrom(html)).toEqual(input.row.reference!.chart)
  })

  test('keeps an opposing selected setup separate without averaging its plan into the selected setup', () => {
    const { row, instrument, ...state } = fixture()
    const exported = buildWatchlistReview({ row, instrument, ...state })
    expect(exported.text).toContain(row.name)
    expect(exported.text).toContain(instrument.allSetups[1].name)
    expect(exported.text).toMatch(/bullish/i)
    expect(exported.text).toMatch(/bearish/i)
    expect(exported.text).toMatch(/opposing/i)
    expect(exported.text).toContain('123.875')
    expect(exported.text).toContain('88.375')
    expect(exported.text).toContain('97.375')
    expect(exported.text).toContain('114.875')
    expect(exported.text).not.toContain(String((row.stop! + instrument.allSetups[1].stop!) / 2))
  })

  test('labels a retained but no-longer-selected setup as historical even if its recorded trigger was confirmed', () => {
    const input = fixture()
    input.current = false
    input.snapshotCurrent = false
    const result = buildWatchlistReview(input)
    expect(result.text).toMatch(/no longer[^\n]*(?:current|select)|not[^\n]*current[^\n]*select/i)
    expect(result.text).toMatch(/saved|historical|recorded|at evaluation/i)
    expect(result.text).toContain(input.row.reference!.statusLabel)
    expect(result.text).not.toMatch(/(?:current status|current eligibility|currently)[^\n]*(?:ready for (?:review|entry)|entry confirmed)/i)
  })

  test('distinguishes an aged snapshot and newer publication from an expired entry plan', () => {
    const input = fixture()
    input.snapshotCurrent = false
    input.newerAvailable = true
    input.row.reference!.expiresAt = COPIED_AT - 1
    const result = buildWatchlistReview(input)
    expect(result.text).toMatch(/aged|stale|saved evaluation|older evaluation/i)
    expect(result.text).toMatch(/expir/i)
    expect(result.text).not.toMatch(/(?:current status|current eligibility|currently)[^\n]*(?:ready for (?:review|entry)|entry confirmed)/i)
    expect(findObject(readEmbeddedData(result.html), (item) => item.newerAvailable === true && item.entryWindowExpired === true)).toBeDefined()
  })

  test('identifies a newer evaluation even while the selected snapshot is still within its current window', () => {
    const input = fixture()
    input.newerAvailable = true
    const result = buildWatchlistReview(input)
    expect(result.text).toMatch(/saved evaluation[^\n]*newer evaluation/i)
    expect(snapshotFrom(result.html)).toEqual(input.row.reference!.chart)
  })

  test('expired entry windows cannot be described as the current selection even with affirmative caller flags', () => {
    const input = fixture()
    input.row.reference!.expiresAt = COPIED_AT
    const result = buildWatchlistReview(input)
    expect(result.text).toMatch(/confirmation expired[^\n]*entry window/i)
    expect(result.text).not.toContain('Current selection at export')
    expect(result.text).toContain(input.row.reference!.statusLabel)
  })

  test('is deterministic and does not mutate the selected row, other setups or captured histories', () => {
    const input = fixture()
    const before = structuredClone(input)
    const first = buildWatchlistReview(input, '<svg viewBox="0 0 10 10"><path d="M0 0L10 10" /></svg>')
    const second = buildWatchlistReview(input, '<svg viewBox="0 0 10 10"><path d="M0 0L10 10" /></svg>')
    expect(second).toEqual(first)
    expect(input).toEqual(before)
  })

  test('keeps an oversized snapshot identifier complete in JSON without filling the copied prose with the universe', () => {
    const input = fixture()
    const fullId = `spot:${Array.from({length: 110}, (_, index) => `COIN${index}USDT`).join(',')}:${EVALUATED_AT}:1`
    input.row.reference!.chart = {...input.row.reference!.chart!, snapshotId: fullId}
    const result = buildWatchlistReview(input)
    expect(result.text).not.toContain(fullId)
    expect(result.text).toContain('full snapshot ID in HTML JSON')
    expect(findObject(readEmbeddedData(result.html), (item) => item.snapshotId === fullId && Array.isArray(item.frames))).toBeDefined()
  })

  test('retains all four complete candle histories, previews, events and coordinates in inert HTML data', () => {
    const input = fixture()
    const result = buildWatchlistReview(input)
    const retained = snapshotFrom(result.html)
    expect(retained.frames.map((frame) => frame.timeframe)).toEqual([...FRAME_NAMES])
    expect(retained).toEqual(input.row.reference!.chart)
    expect(retained.frames.every((frame) => frame.candles.length === 3 && frame.preview !== null)).toBe(true)
    expect(result.html).not.toMatch(/<script\b/i)
    expect(result.text).not.toContain('"candles"')
    expect(result.text).not.toContain('"openTime"')
    expect(result.text).not.toContain('"closeTime"')
    expect(result.text).not.toContain('842000.125')
  })

  test('preserves a safe annotated SVG including its exact path, clipping and escaped label text', async () => {
    const markup = '<svg viewBox="0 0 400 200" aria-label="Selected setup"><title>Selected &amp; saved</title><defs><clipPath id="plot"><rect x="1" y="2" width="390" height="180" /></clipPath></defs><g clip-path="url(#plot)" style="fill:#c4a0e4;stroke:rgb(1,2,3);stroke-width:2"><path d="M10 20 L30 40" /><text x="30" y="40">D &lt; target &amp; quote</text></g></svg>'
    const result = buildWatchlistReview(fixture(), markup)
    const { elements } = await inspectHtml(result.html)
    expect(elements.some((element) => element.name === 'svg')).toBe(true)
    expect(elements.some((element) => element.name === 'path' && element.attributes.some(([name, value]) => name === 'd' && value === 'M10 20 L30 40'))).toBe(true)
    expect(elements.some((element) => element.name === 'g' && element.attributes.some(([name, value]) => name === 'clip-path' && value === 'url(#plot)'))).toBe(true)
    expect(result.html).toContain('D &lt; target &amp; quote')
    expect(result.text).toContain('Selected & saved')
  })

  test('keeps hostile symbols, reasons and evidence as text while the embedded JSON round-trips exactly', async () => {
    const input = fixture()
    const hostile = '</pre><img src="https://attacker.invalid/beacon" onerror="alert(1)"><script>alert(2)</script>&lt; " \' &'
    input.row.symbol = hostile
    input.instrument.symbol = hostile
    input.row.reason = hostile
    input.row.reference!.chart = { ...input.row.reference!.chart!, evidence: [{ label: hostile, detail: hostile }], notes: [hostile] }
    const result = buildWatchlistReview(input)
    const retained = snapshotFrom(result.html)
    expect(retained.evidence).toEqual([{ label: hostile, detail: hostile }])
    expect(retained.notes).toEqual([hostile])
    const parsed = await inspectHtml(result.html)
    expect(parsed.elements.some((element) => ['script', 'img', 'iframe', 'object', 'embed'].includes(element.name))).toBe(false)
    expect(parsed.elements.flatMap((element) => element.attributes).some(([name]) => /^on/i.test(name))).toBe(false)
    expect(result.html).toContain('&lt;/pre&gt;')
    expect(result.html).toContain('&amp;lt;')
  })

  test.each([
    '<svg onload="alert(1)"><script>alert(2)</script><path d="M0 0L1 1" onclick="alert(3)" /></svg>',
    '<svg><image href="https://attacker.invalid/remote.svg" /><use xlink:href="//attacker.invalid/remote.svg#x" /><a href="java&#x73;cript:alert(1)"><text>Run</text></a></svg>',
    '<svg><foreignObject><iframe src="https://attacker.invalid/frame"></iframe><img src="https://attacker.invalid/img" onerror="alert(1)"></foreignObject></svg>',
    '<svg><style>@import url(https://attacker.invalid/style); path{fill:url(https://attacker.invalid/paint)}</style><path d="M0 0L1 1" fill="url(https://attacker.invalid/fill)" style="filter:url(https://attacker.invalid/filter)" /></svg>',
    '<svg><a id="x"><text>Run</text></a><animate href="#x" attributeName="href" values="javascript:alert(1)" /><set href="#x" attributeName="onclick" to="alert(1)" /></svg>',
    '<svg></svg><meta http-equiv="refresh" content="0;url=https://attacker.invalid/redirect"><link rel="stylesheet" href="https://attacker.invalid/style"><object data="https://attacker.invalid/object"></object>',
  ])('does not activate scripts, handlers or network content from chart markup %#', async (markup) => {
    const result = buildWatchlistReview(fixture(), markup)
    const { elements, style } = await inspectHtml(result.html)
    const forbidden = ['script', 'iframe', 'object', 'embed', 'link', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set']
    expect(elements.filter((element) => forbidden.includes(element.name))).toEqual([])
    for (const element of elements) {
      for (const [name, value] of element.attributes) {
        expect(name).not.toMatch(/^on/i)
        const decoded = decodedAttribute(value)
        if (['href', 'xlink:href', 'src', 'srcset', 'data', 'action', 'formaction', 'poster', 'background'].includes(name)) {
          expect(decoded).toMatch(/^#[-\w:.]+$/)
        }
        if (['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end'].includes(name)) {
          expect(decoded.replace(/\s/g, '')).not.toMatch(/(?:javascript|vbscript|data):|(?:https?:)?\/\/attacker\.invalid|url\((?!['"]?#)/i)
        }
        if (element.name === 'meta' && name.toLowerCase() === 'http-equiv') expect(value.toLowerCase()).not.toBe('refresh')
      }
    }
    expect(style.replace(/\s/g, '')).not.toMatch(/@import|attacker\.invalid|url\((?!['"]?#)/i)
    expect(snapshotFrom(result.html)).toEqual(fixture().row.reference!.chart)
  })

  test('produces a local HTML filename without path traversal, control characters or markup', () => {
    const input = fixture()
    input.row.symbol = '../..\\BTC/USDT:<bad>\u0000\n'
    input.instrument.symbol = input.row.symbol
    const result = buildWatchlistReview(input)
    expect(result.filename).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/)
    expect(result.filename).not.toContain('..')
    expect(result.filename).not.toMatch(/[\\/:<>"']/)
    expect([...result.filename].some((character) => character.charCodeAt(0) < 32)).toBe(false)
  })
})

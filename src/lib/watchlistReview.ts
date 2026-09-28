import type { WatchlistRow } from './watchlist'
import type { WatchlistInstrument } from './watchlistInstruments'

export interface WatchlistReviewInput {
  row: WatchlistRow
  instrument: WatchlistInstrument
  copiedAt: number
  current: boolean
  snapshotCurrent: boolean
  newerAvailable?: boolean
  chartCaption?: string
}

export interface WatchlistReviewExport { text: string; html: string; filename: string }

const FRAMES = ['15m', '1h', '4h', '1d'] as const
const exact = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'Not established' : String(value)
const validTime = (value: number | null | undefined): value is number => value != null && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime())
const stamp = (value: number | null | undefined) => validTime(value) ? new Date(value).toISOString() : 'Unavailable'
const words = (value: string) => value.replaceAll('_', ' ')
const markdown = (value: unknown) => String(value ?? '').replace(/[\\`*_{}[\]<>|]/g, '\\$&').replace(/\r?\n/g, ' ')
const escapeHtml = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = {'&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"}
    const lower = entity.toLowerCase()
    if (named[lower]) return named[lower]
    const code = lower.startsWith('&#x') ? Number.parseInt(lower.slice(3, -1), 16) : Number.parseInt(lower.slice(2, -1), 10)
    return code > 0 && code <= 0x10_ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\uFFFD'
  })
}

const SVG_TAGS = new Map(['svg', 'g', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse', 'text', 'tspan',
  'defs', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc'].map((name) => [name.toLowerCase(), name]))
const SVG_ATTRIBUTES = new Set(['id', 'class', 'width', 'height', 'x', 'y', 'x1', 'x2', 'cx', 'y1', 'y2', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'transform', 'viewBox', 'preserveAspectRatio', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity',
  'clip-path', 'clip-rule', 'clipPathUnits', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'paint-order', 'vector-effect', 'color', 'offset', 'stop-color', 'stop-opacity', 'gradientUnits', 'gradientTransform', 'spreadMethod',
  'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'data-event-label'])
const STYLE_PROPERTIES = new Set(['background', 'background-color', 'color', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width',
  'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'clip-path',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-anchor', 'dominant-baseline', 'paint-order',
  'vector-effect', 'display', 'visibility', 'overflow'])

function safePresentationValue(value: string): boolean {
  if (/[<>@\\]/.test(value) || /(?:expression|javascript|vbscript|image-set)\s*(?:\(|:)/i.test(value)) return false
  if (/url\s*\(/i.test(value)) return /^url\(\s*["']?#[\w:.-]+["']?\s*\)$/i.test(value)
  return true
}

function safeStyle(value: string): string {
  return value.split(';').flatMap((declaration) => {
    const colon = declaration.indexOf(':')
    if (colon < 0) return []
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const setting = declaration.slice(colon + 1).trim()
    return STYLE_PROPERTIES.has(name) && setting && safePresentationValue(setting) ? [`${name}:${setting}`] : []
  }).join(';')
}

/** Rebuild inert SVG only. Caller styles survive; scripts, handlers and resources do not. */
function sanitizeChart(markup: string | undefined): string {
  if (!markup) return ''
  const tokens = markup.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) ?? []
  let depth = 0
  let opened = false
  const result: string[] = []
  for (const token of tokens) {
    if (token.startsWith('<!--')) continue
    if (!token.startsWith('<')) {
      if (opened && depth > 0) result.push(escapeHtml(decodeXmlText(token)))
      continue
    }
    const matched = /^<\s*(\/?)\s*([\w:-]+)([\s\S]*?)\/?\s*>$/.exec(token)
    if (!matched) continue
    const tag = SVG_TAGS.get(matched[2].toLowerCase())
    if (!tag || !opened && (tag !== 'svg' || matched[1])) continue
    if (matched[1]) {
      result.push(`</${tag}>`)
      if (tag === 'svg' && --depth === 0) return result.join('')
      continue
    }
    const attributes: string[] = []
    const attributePattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
    for (const attribute of matched[3].matchAll(attributePattern)) {
      const name = attribute[1]
      const value = decodeXmlText(attribute[2] ?? attribute[3] ?? attribute[4] ?? '')
      if (name === 'style') {
        const style = safeStyle(value)
        if (style) attributes.push(`style="${escapeHtml(style)}"`)
      } else if (SVG_ATTRIBUTES.has(name) && safePresentationValue(value)) attributes.push(`${name}="${escapeHtml(value)}"`)
    }
    if (tag === 'svg') {
      depth++
      if (!opened) attributes.push('xmlns="http://www.w3.org/2000/svg"')
      opened = true
    }
    result.push(`<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}${/\/\s*>$/.test(token) ? ' /' : ''}>`)
  }
  return ''
}

function summarizeSetup(row: WatchlistRow, selected: WatchlistRow, matchingIds: ReadonlySet<string>) {
  return {
    id: row.id, name: row.name, symbol: row.symbol, market: row.market, source: row.source, timeframe: row.timeframe,
    direction: row.direction, opposing: row.direction !== selected.direction, matchesPinnedFilters: matchingIds.has(row.id),
    recordedStatus: row.status, recordedStatusLabel: row.reference?.statusLabel ?? words(row.status),
    nativeStatus: row.reference?.nativeStatus ?? null, planStatus: row.reference?.planStatus ?? null,
    snapshotId: row.reference?.chart?.snapshotId ?? null, evaluatedAt: row.reference?.chart?.evaluatedAt ?? null,
    geometricEntryReference: row.reference?.entry ?? null, planEntry: row.reference?.planEntry ?? null,
    evaluatedQuote: row.price, zone: row.zone, stop: row.stop, target: row.target,
    grossRR: row.riskReward, netRR: row.reference?.netRiskReward ?? null, reason: row.reason, next: row.next,
  }
}

/** A deterministic review artifact; this does not reassess or upgrade Go eligibility. */
export function buildWatchlistReview(input: WatchlistReviewInput, chartMarkup?: string): WatchlistReviewExport {
  const {row, instrument, copiedAt, current, snapshotCurrent} = input
  const ref = row.reference
  const chart = ref?.chart
  const snapshotLabel = chart?.snapshotId && chart.snapshotId.length > 120
    ? `${ref?.engineVersion ?? 'Go'}@${stamp(chart.evaluatedAt)} (full snapshot ID in HTML JSON)`
    : chart?.snapshotId ?? 'Unavailable'
  const expiresAt = ref?.expiresAt ?? null
  const entryWindowExpired = ref?.planStatus === 'confirmation_expired' || validTime(expiresAt) && copiedAt >= expiresAt
  const exportState = !current ? 'No longer selected — saved evaluation.'
    : !snapshotCurrent ? 'Saved evaluation has aged — current eligibility is not established.'
      : entryWindowExpired ? 'Confirmation expired — the entry window has ended.'
        : input.newerAvailable ? 'Saved evaluation — a newer evaluation is available.'
          : 'Current selection at export — review the recorded snapshot.'
  const matchingIds = new Set(instrument.setups.map((setup) => setup.id))
  const alternatives = [...new Map(instrument.allSetups.filter((setup) => setup.id !== row.id).map((setup) => [setup.id, setup])).values()]
    .map((setup) => summarizeSetup(setup, row, matchingIds))
  const caption = input.chartCaption ?? (chartMarkup?.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ? decodeXmlText(chartMarkup.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)![1].replace(/<[^>]*>/g, '')) : undefined)
  const limitations = [
    'The pasted summary contains no raw candle histories or chart image. The annotated chart and full captured candle frames are in the saved HTML review.',
    'Do not claim to have independently recalculated indicators or validated geometry from summaries alone. Request the HTML snapshot or the required source data for those checks.',
    'The frozen Go classifications are recorded observations, not trade approval, an order fill, a measured win rate or a profitability guarantee.',
    'Costs are model assumptions. Actual fees, funding, borrow, leverage, spread, depth and execution remain unverified.',
    'Alternative setups are the engine-selected observations retained for this asset, not a complete raw detector inventory.',
  ]
  const reviewRequest = 'Independently review this saved setup. Check the supporting and opposing evidence, event timing, invalidation and reward/risk assumptions. Identify errors, missing evidence and reasons to wait or reject it; distinguish what you verified from what you could not verify. Do not rubber-stamp the engine label or treat this request as trade approval.'
  const packet = {
    schema: 'watchlist-setup-review', schemaVersion: 1, exportedAt: copiedAt,
    exportedAtUtc: stamp(copiedAt), reviewRequest,
    identity: {asset: row.symbol, market: row.market, source: row.source, timeframe: row.timeframe, setupId: row.id, instrumentId: instrument.id},
    exportState: {label: exportState, current, snapshotCurrent, newerAvailable: input.newerAvailable ?? false, entryWindowExpired},
    evaluation: {evaluatedAt: chart?.evaluatedAt ?? null, engineVersion: ref?.engineVersion ?? null, snapshotId: chart?.snapshotId ?? null},
    chartCaption: caption ?? null,
    selectedSetup: row,
    instrument: {id: instrument.id, symbol: instrument.symbol, market: instrument.market, hasMixedDirections: instrument.hasMixedDirections,
      selectedSetupId: row.id, leadSetupId: instrument.lead.id, alternatives},
    limitations,
  }
  const lines = [
    `# Independent setup review — ${markdown(row.symbol)} · ${markdown(row.name)}`,
    '', reviewRequest, '',
    `- Exported: ${stamp(copiedAt)}. Evaluated: ${stamp(chart?.evaluatedAt)}.`,
    `- Identity: ${markdown(row.market)} / ${markdown(row.symbol)} / ${markdown(row.source)} / ${markdown(row.timeframe)} / ${markdown(row.direction)}.`,
    `- Setup ID: ${markdown(row.id)}.`,
    `- Engine: ${markdown(ref?.engineVersion ?? 'Unavailable')}. Snapshot: ${markdown(snapshotLabel)}.`,
    `- Method mode: ${markdown(ref?.mode ?? 'Unavailable')}.`,
    ...(caption ? [`- Displayed chart: ${markdown(caption)}.`] : []),
    '', '## State at export', '',
    `- ${exportState}`,
    `- Newer evaluation available: ${input.newerAvailable ? 'yes' : 'no'}.`,
    `- Recorded classification at evaluation: ${markdown(ref?.statusLabel ?? words(row.status))} (${markdown(row.status)}).`,
    `- Recorded method status: ${markdown(ref?.nativeStatus ?? 'Unavailable')}. Plan status: ${markdown(ref?.planStatus ?? 'Unavailable')}.`,
    `- Entry window ends: ${stamp(expiresAt)}${entryWindowExpired ? ' — expired at export' : ''}.`,
    `- Last setup-frame close: ${stamp(row.asOf)}. Oldest data receipt: ${stamp(row.updatedAt)}.`,
    `- Engine receipt freshness allowance: ${exact(ref?.maxAgeMs)} ms; completed-candle currency is checked separately.`,
    '', '## Exact price references · USDT', '',
    '| Reference | Value |', '| --- | --- |',
    `| Geometric entry reference | ${exact(ref?.entry)} |`,
    `| Plan entry / quote used for risk | ${exact(ref?.planEntry)} |`,
    `| Evaluated market quote | ${exact(row.price)} |`,
    `| Zone low | ${exact(row.zone.low)} |`, `| Zone high | ${exact(row.zone.high)} |`,
    `| Invalidation / stop | ${exact(row.stop)} |`, `| Selected first target | ${exact(row.target)} |`,
    `| Gross reward/risk | ${exact(row.riskReward)} |`, `| Net reward/risk after modeled costs | ${exact(ref?.netRiskReward)} |`,
    `| Distance from entry reference, percent | ${exact(row.distancePercent)} |`,
    `| Distance from entry reference, ATR | ${exact(row.distanceAtr)} |`,
    '', `Modeled round-trip costs: ${exact(ref?.feeBps)} bps fees + ${exact(ref?.slippageBps)} bps slippage/spread. Minimum net reward/risk: ${exact(ref?.minNetRR)}R.`,
    'Entry reference, evaluated plan quote and market quote have separate meanings; do not substitute one for another or move the target to improve R/R.',
    '', '## Reason and next checkpoint', '',
    `- Why: ${markdown(row.reason)}`,
    `- Next: ${markdown(row.next)}`,
    `- Recorded trigger: ${stamp(row.confirmedAt)}.`,
    '', '## Four-timeframe context', '',
    '| Frame | Recorded trend | Recorded structure | Last completed candle | Captured closed candles |',
    '| --- | --- | --- | --- | --- |',
    ...FRAMES.map((timeframe) => {
      const frame = ref?.frames.find((item) => item.timeframe === timeframe)
      const captured = chart?.frames.find((item) => item.timeframe === timeframe)
      return `| ${timeframe} | ${markdown(frame?.trend ?? 'Unavailable')} | ${markdown(frame?.structure ?? 'Unavailable')} | ${stamp(frame?.asOf)} | ${captured?.candles.length ?? 'Unavailable'} |`
    }),
    '', '## Recorded geometry and events', '',
    ...(chart?.points.length ? chart.points.map((point) => `- ${markdown(point.label)}: ${exact(point.price)} · ${point.timeframe} candle open ${stamp(point.time)}.`) : ['- No timestamped pivot path was supplied; do not invent missing anchors.']),
    ...(chart?.sourceWindow ? [`- Historical source window: ${chart.sourceWindow.timeframe}, ${stamp(chart.sourceWindow.startTime)} to ${stamp(chart.sourceWindow.endTime)}. Availability is recorded separately in the events.`] : []),
    ...(chart?.events.length ? [...chart.events].sort((a, b) => a.time - b.time).map((event) => `- ${markdown(event.label)} [${event.kind}, ${event.timeframe}]: ${stamp(event.time)}; price ${event.price === null ? 'not supplied' : exact(event.price)}${event.low !== undefined ? `; low ${exact(event.low)}` : ''}${event.high !== undefined ? `; high ${exact(event.high)}` : ''}.`) : ['- No timestamped setup events were supplied.']),
    ...(chart?.notes.map((note) => `- ${markdown(note)}`) ?? []),
    '', '## Evidence and cautions', '',
    ...(chart?.evidence.map((evidence) => `- ${markdown(evidence.label)}${evidence.timeframe ? ` · ${evidence.timeframe}` : ''}${evidence.time !== undefined ? ` · ${stamp(evidence.time)}` : ''}: ${markdown(evidence.detail)}`) ?? []),
    ...row.evidence.map((evidence) => `- ${markdown(evidence.source)} · ${markdown(evidence.family)} · ${markdown(evidence.direction)} · ${stamp(evidence.availableAt)}: ${markdown(evidence.detail)}`),
    ...row.cautions.map((caution) => `- ${markdown(caution)}`),
    '', '## Other selected setups for this asset', '',
    ...(alternatives.length ? alternatives.map((setup) => `- ${setup.opposing ? 'OPPOSING' : 'Same direction'}: ${markdown(setup.name)} · ${setup.timeframe} · ${setup.direction}; recorded ${markdown(setup.recordedStatusLabel)}, plan ${markdown(setup.planStatus ?? 'unavailable')}; entry reference ${exact(setup.geometricEntryReference)}, plan quote ${exact(setup.planEntry)}, stop ${exact(setup.stop)}, target ${exact(setup.target)}, gross R/R ${exact(setup.grossRR)}, net R/R ${exact(setup.netRR)}. ID: ${markdown(setup.id)}.`) : ['- No other engine-selected setups were retained for this asset.']),
    '', '## Review coverage and limits', '', ...limitations.map((limitation) => `- ${limitation}`),
  ]
  const text = lines.join('\n')
  const svg = sanitizeChart(chartMarkup)
  const json = JSON.stringify(packet, null, 2)
  const title = `${row.symbol} · ${row.name}`
  const totalCandles = chart?.frames.reduce((sum, frame) => sum + frame.candles.length, 0) ?? 0
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)} — setup review</title>
<style>
:root{color-scheme:dark;font-family:Arial,Helvetica,sans-serif;background:#121015;color:#e3dce9}*{box-sizing:border-box}body{margin:0;padding:32px 20px}main{max-width:1200px;margin:auto}header{margin-bottom:24px}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:11px;color:#b8a0c9}h1{font-size:30px;letter-spacing:-.04em;margin:8px 0 12px}h2{font-size:18px;margin:0 0 12px}.meta,figcaption,.hint{color:#b4a8be;font-size:13px;line-height:1.7}.state{display:inline-block;border:1px solid #62506f;border-radius:7px;padding:10px 13px;background:#211a28;color:#e3c5f3;font-size:13px}figure{margin:20px 0 28px;padding:16px;border:1px solid #3b3045;border-radius:12px;background:#151417;overflow:auto}figure svg{display:block;width:100%;height:auto;min-width:600px}figcaption{padding-top:12px}section,details{margin:22px 0;padding:22px;border:1px solid #352d3d;border-radius:10px;background:#19151f}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#ddd1e6;user-select:text}details pre{max-height:650px;overflow:auto}summary{cursor:pointer;font-weight:600}footer{color:#93839f;font-size:12px;line-height:1.7;margin:24px 0}@media print{body{background:white;color:black;padding:0}section,details,figure{break-inside:avoid;background:white;color:black}pre,.meta,figcaption,.hint{color:black}details{display:none}}
</style></head><body><main>
<header><p class="eyebrow">Independent setup review</p><h1>${escapeHtml(title)}</h1><p class="meta">Exported ${escapeHtml(stamp(copiedAt))} · Evaluated ${escapeHtml(stamp(chart?.evaluatedAt))} · ${escapeHtml(ref?.engineVersion ?? 'Engine unavailable')}</p><p class="state">${escapeHtml(exportState)}${entryWindowExpired ? ' Entry window expired.' : ''}</p></header>
<figure>${svg || '<p class="hint">The annotated chart was not captured. The available snapshot data is retained below.</p>'}<figcaption>${escapeHtml(caption ?? 'Selected setup at its saved evaluation.')} The chart is a static view; the complete captured timeframes and exact references are in the JSON below.</figcaption></figure>
<section><h2>Copyable review packet</h2><p class="hint">Select and copy this packet for an independent review. Provide this HTML file when candle-level verification is needed.</p><pre id="watchlist-review-text">${escapeHtml(text)}</pre></section>
<details><summary>Complete snapshot JSON · ${chart?.frames.length ?? 0} frames · ${totalCandles} completed candles</summary><p class="hint">Contains the selected setup, all captured candle frames and provisional candles, exact geometry and events, alternative setup summaries, and export state. No live data is fetched by this file.</p><pre id="watchlist-review-data">${escapeHtml(json)}</pre></details>
<footer>Reference analysis only. Recorded confirmations and hypothetical levels are not an order or an executed trade.</footer>
</main></body></html>`
  const safeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'setup'
  const fileTime = validTime(copiedAt) ? new Date(copiedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') : 'undated'
  return {text, html, filename: `watchlist-review-${safeName(row.symbol)}-${safeName(row.timeframe)}-${fileTime}.html`}
}

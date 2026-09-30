import { isTrailingPaperProfile, isOpeningTargetProfile } from '../lib/watchlistPaperPolicy'
import { useRef, useState } from 'react'
import { Button, Modal } from 'antd'
import { ArrowDownOutlined, ArrowUpOutlined, ReloadOutlined } from '@ant-design/icons'
import type { WatchlistInstrument } from '../lib/watchlistInstruments'
import { isGoWatchlistRowCurrent } from '../lib/goWatchlist'
import { WATCHLIST_STATUS_LABELS } from '../lib/watchlist'
import { formatQuotePrice } from '../lib/priceFormatting'
import { buildWatchlistReview } from '../lib/watchlistReview'
import { captureWatchlistChart } from '../lib/watchlistShare'
import { WatchlistSetupChart } from './WatchlistSetupChart'
import { WatchlistReviewActions } from './WatchlistReviewActions'
import type { Timeframe } from '../types'
import { TIMEFRAME_MILLISECONDS } from '../lib/binanceHistory'
import { ICHIMOKU_EXCLUSIONS, ichimokuEvidence } from '../lib/watchlistIchimoku'
import './WatchlistSetupModal.css'

const quote = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'Not established' : formatQuotePrice(value)
const stamp = (value: number | null | undefined) => value == null ? 'Unavailable' : new Date(value).toLocaleString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12: false})
const words = (value: string) => value.replaceAll('_',' ').replace(/^./, (letter) => letter.toUpperCase())

export function WatchlistSetupModal({instrument, latestInstrument, now, onClose, onRefresh}: {
  instrument: WatchlistInstrument; latestInstrument?: WatchlistInstrument; now: number; onClose: () => void; onRefresh: () => void
}) {
  const [setupId,setSetupId] = useState(instrument.lead.id)
  const [inspectedFrame, setInspectedFrame] = useState<{identity: string; timeframe: Timeframe} | null>(null)
  const chartContainer = useRef<HTMLElement>(null)
  const row = instrument.allSetups.find((item) => item.id === setupId) ?? instrument.lead
  const latest = latestInstrument?.allSetups.find((item) => item.id === row.id)
  const ref = row.reference
  const chart = ref?.chart
  const scopedIchimoku = ref?.scope === 'ichimoku'
  const paperProfile = ref?.mode === 'Paper research profile'
  const family = ref?.strategyFamily ?? ''
  const trailingDonchian = paperProfile && isTrailingPaperProfile(family)
  const openingTarget = isOpeningTargetProfile(family ?? '')
  const cappedCloud = paperProfile && family.startsWith('cloud_reclaim_volume_2r')
  const hasOpeningBand = paperProfile && ref?.entryMin != null && ref?.entryMax != null
  const signalZone = row.zone.low === row.zone.high ? quote(row.zone.low) : `${quote(row.zone.low)}–${quote(row.zone.high)}`
  const costDescription = !ref ? '' : paperProfile
    ? `${(ref.feeBps + ref.slippageBps) / 100}% modeled round-trip costs (${ref.feeBps / 100}% fees + ${ref.slippageBps / 100}% slippage). ${openingTarget ? 'The target depends on the unknown raw opening; after-fill R/R is unverified.' : trailingDonchian ? 'The managed exit has no fixed R/R.' : `Fixed-target screening minimum: ${ref.minNetRR}R.`} The source paper account checks the next whole observed 1-minute opening and intervening minutes; this scanner has not verified that path or an opening fill.${hasOpeningBand ? ' The frozen entry band applies after adverse slippage.' : ''}${cappedCloud ? ' A farther cloud target may be capped at net 2R only after the fill and costs are known.' : ''}`
    : `${ref.feeBps / 100}% fees + ${ref.slippageBps / 100}% slippage round trip. Minimum ${ref.minNetRR}R after costs.`
  const contextFrames = scopedIchimoku ? [...new Set([...(ref?.frames.map((frame) => frame.timeframe) ?? []),
    ...(chart?.frames.filter((frame) => frame.candles.length > 0).map((frame) => frame.timeframe) ?? [])])]
    .sort((a, b) => TIMEFRAME_MILLISECONDS[a as Timeframe] - TIMEFRAME_MILLISECONDS[b as Timeframe])
    : ref?.requiredTimeframes?.length ? [...ref.requiredTimeframes] : [row.timeframe]
  const chartIdentity = `${row.id}:${chart?.snapshotId ?? ''}`
  const selectedTimeframe = inspectedFrame?.identity === chartIdentity ? inspectedFrame.timeframe : chart?.defaultTimeframe ?? row.timeframe
  const ichimoku = chart?.frames.find((frame) => frame.timeframe === selectedTimeframe)?.ichimoku
  const ichimokuItems = ichimoku ? ichimokuEvidence(ichimoku) : []
  const primaryLabels = new Set(['Cloud', 'Tenkan / Kijun', 'TK cross', 'PK cross', 'Edge to edge', 'Retracement context'])
  const current = !!latest && isGoWatchlistRowCurrent(latest, now)
  const snapshotCurrent = current && isGoWatchlistRowCurrent(row, now)
  const newer = latest?.reference?.chart?.snapshotId !== undefined && latest.reference.chart.snapshotId !== chart?.snapshotId
  const replacementAvailable = !latest && !!latestInstrument
  const base = instrument.symbol.replace(/USDT$/,'')
  const matchingIds = new Set(instrument.setups.map((item) => item.id))
  const statusLabel = ref?.statusLabel ?? WATCHLIST_STATUS_LABELS[row.status]
  const bullish = row.direction === 'bullish'
  const timeline = [...(chart?.events ?? [])].sort((a,b) => a.time - b.time)
  const supportingEvidence = (chart?.evidence ?? []).filter((item) => !item.timeframe && !['Entry condition','Invalidation'].includes(item.label))
  const createReview = (withChart: boolean) => {
    const copiedAt = Date.now()
    const stillCurrent = !!latest && isGoWatchlistRowCurrent(latest, copiedAt)
    const svg = chartContainer.current?.querySelector<SVGSVGElement>('.watch-setup-chart__canvas') ?? null
    const capturedChart = withChart ? captureWatchlistChart(svg) : undefined
    return buildWatchlistReview({ row, instrument, copiedAt, current: stillCurrent,
      snapshotCurrent: stillCurrent && isGoWatchlistRowCurrent(row, copiedAt), newerAvailable: newer || replacementAvailable,
      chartCaption: capturedChart?.caption ?? svg?.querySelector('title')?.textContent ?? undefined,
    }, capturedChart?.markup)
  }
  return <Modal open onCancel={onClose} footer={null} width="min(1440px, 96vw)" centered destroyOnHidden className="watch-detail" styles={{body:{maxHeight:'calc(94vh - 110px)',overflowY:'auto'}}} title={<div className="watch-detail__title"><div><span className="watch-detail__symbol">{base}<small>/ USDT</small></span><span className="watch-detail__market">{row.market === 'tradfi' ? 'TradFi perpetual' : 'Crypto · Spot'}</span></div><div className="watch-detail__quote"><strong>{quote(row.price)}</strong><span>{paperProfile ? 'Latest completed close · USDT' : 'Evaluated price · USDT'}</span></div></div>}>
    {instrument.allSetups.length > 1 && <div className="watch-detail__setups" role="group" aria-label={`Setups for ${base}`}>{instrument.allSetups.map((setup) => <button type="button" key={setup.id} aria-pressed={setup.id === row.id} className={setup.id === row.id ? 'is-active' : ''} onClick={() => setSetupId(setup.id)}><span>{setup.name}</span><small className={`is-${setup.direction}`}>{setup.direction === 'bullish' ? 'Bullish' : 'Bearish'}{!matchingIds.has(setup.id) && ' · outside filters'}</small></button>)}</div>}
    <WatchlistReviewActions key={`${row.id}:${chart?.snapshotId ?? ''}`} buildReview={createReview} />
    <div className="watch-detail__snapshot" role="status"><span>{!current ? 'This setup is no longer in the current selection. Displaying its saved evaluation.' : !snapshotCurrent ? 'This evaluation has aged. Load the latest check before assessing the setup.' : newer ? 'A newer evaluation is available.' : 'Showing the evaluated setup and its original price references.'}</span>{(newer || replacementAvailable) && <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>{replacementAvailable ? 'View current setup' : 'Load latest'}</Button>}</div>
    <div className="watch-detail__layout"><section ref={chartContainer} className="watch-detail__visual" aria-label="Selected setup chart"><header className="watch-detail__chart-heading"><div><span className="watch-detail__eyebrow">THE SETUP</span><h2>{row.name}</h2></div><div className="watch-detail__badges"><span className={`watch-direction is-${row.direction}`}>{bullish ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{bullish ? 'Bullish' : 'Bearish'}</span><span className={`watch-status is-${row.status}`}><i />{statusLabel}</span></div></header><WatchlistSetupChart key={chartIdentity} row={row} onTimeframeChange={(timeframe) => setInspectedFrame({identity: chartIdentity, timeframe})} />
      <div className={`watch-detail__context${scopedIchimoku || paperProfile ? ' is-selected-frame' : ''}`} aria-label={scopedIchimoku ? 'Captured timeframe context' : paperProfile ? 'Required source timeframe context' : 'Captured timeframe context'}>{contextFrames.map((timeframe) => {
        const frame = ref?.frames.find((item) => item.timeframe === timeframe)
        const role = timeframe === row.timeframe ? paperProfile ? 'source' : 'setup' : 'context'
        return <div key={timeframe}><b>{timeframe}{(scopedIchimoku || paperProfile) && <small> · {role}</small>}</b><span className={`is-${frame?.trend}`}>{frame ? words(frame.trend) : 'Unavailable'} <small>trend</small></span><span className={`is-${frame?.structure}`}>{frame ? words(frame.structure) : 'Unavailable'} <small>structure</small></span></div>
      })}</div>
      {scopedIchimoku && ichimoku && <section className="watch-detail__ichimoku" aria-label={`${selectedTimeframe} captured Ichimoku context`}>
        <header><h3>Ichimoku · {selectedTimeframe}</h3><span>{words(ichimoku.status)} · Closed-candle readings</span></header>
        <dl>{ichimokuItems.filter((item) => primaryLabels.has(item.label)).map((item) => <div key={item.label} className={item.caution ? 'is-caution' : ''}><dt>{item.label}</dt><dd>{item.detail}</dd></div>)}</dl>
        <details><summary>Twists, flat edges, Fibonacci and calculation details</summary><dl>{ichimokuItems.filter((item) => !primaryLabels.has(item.label)).map((item) => <div key={item.label} className={item.caution ? 'is-caution' : ''}><dt>{item.label}</dt><dd>{item.detail}</dd></div>)}</dl>
          <p>{ICHIMOKU_EXCLUSIONS}</p><p>Widths and distances describe the captured chart. “Significant” width and overextension have no numerical threshold in the lecture; an opposite edge or Fib level is a reference, not a guaranteed target.</p>
          {!!ichimoku.conventions?.length && <ul>{ichimoku.conventions.map((convention) => <li key={convention}>{convention}</li>)}</ul>}
        </details>
      </section>}
    </section><aside className="watch-detail__insight"><section><span className="watch-detail__eyebrow">NEXT CHECKPOINT</span><h3>{row.status === 'confirmed' ? paperProfile ? 'Signal confirmed' : 'Trigger confirmed' : row.status === 'blocked' ? paperProfile ? 'Paper plan is blocked' : 'Entry is blocked' : 'What needs to happen'}</h3><p>{row.next}</p></section>
      <section className="watch-detail__why"><h3>Why this setup</h3><p>{row.reason}</p>{instrument.hasMixedDirections && <p className="watch-detail__opposing">This asset also has an opposing setup. Use the setup tabs to compare both directions.</p>}</section>
      <section className="watch-detail__plan"><h3>Price references</h3><dl>
        <div><dt>{paperProfile ? 'Frozen signal close' : row.source === 'trend' ? 'Pullback level' : 'Entry reference'}</dt><dd>{quote(ref?.entry)}</dd></div>
        {paperProfile && <div><dt>Source signal zone</dt><dd>{signalZone}</dd></div>}
        {hasOpeningBand && <div><dt>Frozen slipped-entry band</dt><dd>{quote(ref?.entryMin)}–{quote(ref?.entryMax)}</dd></div>}
        <div className="is-stop"><dt>{paperProfile ? 'Initial stop reference' : 'Invalidation / stop'}</dt><dd>{quote(row.stop)}</dd></div>
        <div className="is-target"><dt>{openingTarget ? 'Target at actual opening' : trailingDonchian ? 'Exit rule' : cappedCloud ? 'Original structural target' : paperProfile ? 'Source target reference' : 'First target'}</dt><dd>{openingTarget ? 'Opening + 2× raw stop distance' : trailingDonchian ? 'ATR trail · no fixed target' : quote(row.target)}</dd></div>
      </dl><div className="watch-detail__rr"><span>{paperProfile ? 'Reference R/R after costs' : 'Reward / risk after costs'}</span><strong>{ref?.netRiskReward != null ? `${ref.netRiskReward.toFixed(2)}R` : 'Not established'}</strong></div><p className="watch-detail__costs">{costDescription}</p></section>
    </aside></div>
    <div className="watch-detail__support"><section><h3>Setup timeline</h3>{timeline.length ? <ul>{timeline.map((event,index) => <li key={`${event.kind}:${index}`}><b>{event.label} · {event.timeframe}</b><span>{stamp(event.time)} UTC{event.price != null ? ` · ${quote(event.price)}` : ''}</span></li>)}</ul> : <p>A completed-candle event has not been established yet.</p>}{supportingEvidence.length > 0 && <ul>{supportingEvidence.map((item,index) => <li key={`${item.label}:${index}`}><b>{item.label}</b><span>{item.detail}</span></li>)}</ul>}</section><section><h3>Keep in mind</h3><ul>{row.cautions.map((note) => <li key={note}>{note}</li>)}</ul></section></div>
    <footer className="watch-detail__footer"><span>Evaluation {stamp(chart?.evaluatedAt ?? row.updatedAt)} UTC · {ref?.mode}</span><span>{ref?.engineVersion} · Reference plan, no trade execution</span></footer>
  </Modal>
}

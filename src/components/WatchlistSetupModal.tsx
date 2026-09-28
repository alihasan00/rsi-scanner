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
import './WatchlistSetupModal.css'

const quote = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'Not established' : formatQuotePrice(value)
const stamp = (value: number | null | undefined) => value == null ? 'Unavailable' : new Date(value).toLocaleString('en-GB',{timeZone:'UTC',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12: false})
const words = (value: string) => value.replaceAll('_',' ').replace(/^./, (letter) => letter.toUpperCase())

export function WatchlistSetupModal({instrument, latestInstrument, now, onClose, onRefresh}: {
  instrument: WatchlistInstrument; latestInstrument?: WatchlistInstrument; now: number; onClose: () => void; onRefresh: () => void
}) {
  const [setupId,setSetupId] = useState(instrument.lead.id)
  const chartContainer = useRef<HTMLElement>(null)
  const row = instrument.allSetups.find((item) => item.id === setupId) ?? instrument.lead
  const latest = latestInstrument?.allSetups.find((item) => item.id === row.id)
  const ref = row.reference
  const chart = ref?.chart
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
  return <Modal open onCancel={onClose} footer={null} width="min(1440px, 96vw)" centered destroyOnHidden className="watch-detail" styles={{body:{maxHeight:'calc(94vh - 110px)',overflowY:'auto'}}} title={<div className="watch-detail__title"><div><span className="watch-detail__symbol">{base}<small>/ USDT</small></span><span className="watch-detail__market">{row.market === 'tradfi' ? 'TradFi perpetual' : 'Crypto · Spot'}</span></div><div className="watch-detail__quote"><strong>{quote(row.price)}</strong><span>Evaluated price · USDT</span></div></div>}>
    {instrument.allSetups.length > 1 && <div className="watch-detail__setups" role="group" aria-label={`Setups for ${base}`}>{instrument.allSetups.map((setup) => <button type="button" key={setup.id} aria-pressed={setup.id === row.id} className={setup.id === row.id ? 'is-active' : ''} onClick={() => setSetupId(setup.id)}><span>{setup.name}</span><small className={`is-${setup.direction}`}>{setup.direction === 'bullish' ? 'Bullish' : 'Bearish'}{!matchingIds.has(setup.id) && ' · outside filters'}</small></button>)}</div>}
    <WatchlistReviewActions key={`${row.id}:${chart?.snapshotId ?? ''}`} buildReview={createReview} />
    <div className="watch-detail__snapshot" role="status"><span>{!current ? 'This setup is no longer in the current selection. Displaying its saved evaluation.' : !snapshotCurrent ? 'This evaluation has aged. Load the latest check before assessing the setup.' : newer ? 'A newer evaluation is available.' : 'Showing the evaluated setup and its original price references.'}</span>{(newer || replacementAvailable) && <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh}>{replacementAvailable ? 'View current setup' : 'Load latest'}</Button>}</div>
    <div className="watch-detail__layout"><section ref={chartContainer} className="watch-detail__visual" aria-label="Selected setup chart"><header className="watch-detail__chart-heading"><div><span className="watch-detail__eyebrow">THE SETUP</span><h2>{row.name}</h2></div><div className="watch-detail__badges"><span className={`watch-direction is-${row.direction}`}>{bullish ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{bullish ? 'Bullish' : 'Bearish'}</span><span className={`watch-status is-${row.status}`}><i />{statusLabel}</span></div></header><WatchlistSetupChart key={`${row.id}:${chart?.snapshotId ?? ''}`} row={row} />
      <div className="watch-detail__context" aria-label="Four-timeframe context">{['15m','1h','4h','1d'].map((timeframe) => {
        const frame = ref?.frames.find((item) => item.timeframe === timeframe)
        return <div key={timeframe}><b>{timeframe}</b><span className={`is-${frame?.trend}`}>{frame ? words(frame.trend) : 'Unavailable'} <small>trend</small></span><span className={`is-${frame?.structure}`}>{frame ? words(frame.structure) : 'Unavailable'} <small>structure</small></span></div>
      })}</div>
    </section><aside className="watch-detail__insight"><section><span className="watch-detail__eyebrow">NEXT CHECKPOINT</span><h3>{row.status === 'confirmed' ? 'Trigger confirmed' : row.status === 'blocked' ? 'Entry is blocked' : 'What needs to happen'}</h3><p>{row.next}</p></section>
      <section className="watch-detail__why"><h3>Why this setup</h3><p>{row.reason}</p>{instrument.hasMixedDirections && <p className="watch-detail__opposing">This asset also has an opposing setup. Use the setup tabs to compare both directions.</p>}</section>
      <section className="watch-detail__plan"><h3>Price references</h3><dl><div><dt>{row.source === 'trend' ? 'Pullback level' : 'Entry reference'}</dt><dd>{quote(ref?.entry)}</dd></div><div className="is-stop"><dt>Invalidation / stop</dt><dd>{quote(row.stop)}</dd></div><div className="is-target"><dt>First target</dt><dd>{quote(row.target)}</dd></div></dl><div className="watch-detail__rr"><span>Reward / risk after costs</span><strong>{ref?.netRiskReward != null ? `${ref.netRiskReward.toFixed(2)}R` : 'Not established'}</strong></div><p className="watch-detail__costs">{ref ? `${ref.feeBps / 100}% fees + ${ref.slippageBps / 100}% slippage round trip. Minimum ${ref.minNetRR}R after costs.` : ''}</p></section>
    </aside></div>
    <div className="watch-detail__support"><section><h3>Setup timeline</h3>{timeline.length ? <ul>{timeline.map((event,index) => <li key={`${event.kind}:${index}`}><b>{event.label} · {event.timeframe}</b><span>{stamp(event.time)} UTC{event.price != null ? ` · ${quote(event.price)}` : ''}</span></li>)}</ul> : <p>A completed-candle event has not been established yet.</p>}{supportingEvidence.length > 0 && <ul>{supportingEvidence.map((item,index) => <li key={`${item.label}:${index}`}><b>{item.label}</b><span>{item.detail}</span></li>)}</ul>}</section><section><h3>Keep in mind</h3><ul>{row.cautions.map((note) => <li key={note}>{note}</li>)}</ul></section></div>
    <footer className="watch-detail__footer"><span>Evaluation {stamp(chart?.evaluatedAt ?? row.updatedAt)} UTC · {ref?.mode}</span><span>{ref?.engineVersion} · Reference plan, no trade execution</span></footer>
  </Modal>
}

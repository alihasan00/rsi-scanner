import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Empty, Input, Pagination, Segmented, Select, Spin, Tag, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import { ArrowRightOutlined, CheckCircleOutlined, ClockCircleOutlined, EyeOutlined, SearchOutlined, StarFilled, StarOutlined, WarningOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import type { MarketUniverse } from '../hooks/useMarketUniverse'
import { useWatchlistRows } from '../hooks/useWatchlistRows'
import type { ScreenerMarket } from '../lib/markets'
import { formatQuotePrice } from '../lib/priceFormatting'
import type { EvidenceFamily } from '../lib/signalEvidence'
import { WATCHLIST_SOURCE_LABELS, WATCHLIST_STATUS_LABELS } from '../lib/watchlist'
import type { WatchlistRow, WatchlistSource, WatchlistStatus } from '../lib/watchlist'
import { useScannerStore } from '../store/scannerStore'
import { PairCollectionPicker } from './PairCollectionPicker'
import { TimeframePicker } from './TimeframePicker'
import './Watchlist.css'

const PAGE_SIZE = 12
const STATUSES: WatchlistStatus[] = ['confirmed', 'testing', 'approaching', 'waiting', 'extended', 'conflict', 'blocked', 'delayed']
const SOURCES: WatchlistSource[] = ['fib', 'harmonic', 'retest']
const FAMILIES: EvidenceFamily[] = ['momentum', 'location', 'liquidity', 'structure', 'higher-timeframe']
const FAMILY_LABELS: Record<EvidenceFamily, string> = {
  momentum: 'Momentum', location: 'Price location', liquidity: 'Liquidity', structure: 'Market structure', 'higher-timeframe': 'Higher timeframe',
}
const STATUS_COLORS: Record<WatchlistStatus, string> = {
  confirmed: 'green', testing: 'purple', approaching: 'blue', waiting: 'default', extended: 'gold', conflict: 'orange', blocked: 'default', delayed: 'gold',
}
const normalizeSearch = (value: string) => value.toUpperCase().replace(/[\s/_-]/g, '')
const priceLabel = (price: number | null) => price !== null && Number.isFinite(price) ? formatQuotePrice(price) : 'Unavailable'
const stamp = (value: number | null) => value === null ? 'Unavailable' : new Date(value).toLocaleString('en-GB', {
  timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}) + ' UTC'

function ageLabel(value: number | null, now: number) {
  if (value === null) return 'No closed-candle trigger'
  const minutes = Math.max(0, Math.floor((now - value) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
  return `${Math.floor(minutes / 1_440)}d ago`
}

function displayStatus(row: WatchlistRow, now: number): WatchlistStatus {
  return row.status === 'delayed' || row.updatedAt === null || now - row.updatedAt > 60_000 ? 'delayed' : row.status
}

function WatchlistCard({ row, now, starred, onStar, onOpen }: {
  row: WatchlistRow; now: number; starred: boolean; onStar: () => void; onOpen: () => void
}) {
  const status = displayStatus(row, now)
  const delayed = status === 'delayed'
  const base = row.symbol.replace(/USDT$/, '')
  const families = FAMILIES.filter((family) => row.evidence.some((item) => item.family === family))
  const distance = row.distancePercent === null ? 'Distance unavailable'
    : row.distancePercent === 0 ? 'Inside zone' : `${row.distancePercent.toFixed(2)}% from zone`

  return <article className={`watchlist-card is-${status}`} aria-label={`${base} ${row.name}`}>
    <div className="watchlist-card__header">
      <div className="watchlist-card__identity"><h3>{base}<small>/ USDT</small></h3><p>{row.name}</p></div>
      <Tooltip title={starred ? `Unstar ${base}` : `Star ${base} in this browser`}>
        <Button type="text" shape="circle" className={`watchlist-card__star${starred ? ' is-starred' : ''}`} icon={starred ? <StarFilled /> : <StarOutlined />} aria-label={`${starred ? 'Unstar' : 'Star'} ${base}`} aria-pressed={starred} onClick={onStar} />
      </Tooltip>
    </div>
    <div className="watchlist-card__tags">
      <Tag className={`watchlist-card__direction is-${row.direction}`}>{row.direction === 'bullish' ? 'Bullish' : 'Bearish'}</Tag>
      <Tag>{WATCHLIST_SOURCE_LABELS[row.source]}</Tag>
      <Tag className="watchlist-card__status" color={STATUS_COLORS[status]}>{WATCHLIST_STATUS_LABELS[status]}</Tag>
    </div>
    <div className="watchlist-card__price-row">
      <div><span className={`watchlist-card__quote-label${delayed ? ' is-delayed' : ''}`}><i aria-hidden="true" />{delayed ? 'Last known quote' : 'Live quote'}</span><strong>{priceLabel(row.price)}</strong></div>
      <div className="watchlist-card__rr"><span>{delayed ? 'Last known gross R/R' : 'Current gross R/R'}</span><strong>{row.riskReward !== null && Number.isFinite(row.riskReward) ? <>{row.riskReward.toFixed(2)}<small>R</small></> : '—'}</strong><small>To first target · before costs</small></div>
    </div>
    <div className="watchlist-card__zone"><div><span>Watch zone</span><strong>{priceLabel(row.zone.low)} <span>–</span> {priceLabel(row.zone.high)}</strong></div><p>{distance}{row.distanceAtr !== null && Number.isFinite(row.distanceAtr) && <span> · {row.distanceAtr.toFixed(2)} ATR</span>}{delayed && <span> · last known</span>}</p></div>
    <dl className="watchlist-card__plan"><div><dt>Invalidation / stop</dt><dd>{priceLabel(row.stop)}</dd></div><div><dt>First target</dt><dd>{priceLabel(row.target)}</dd></div></dl>
    <div className="watchlist-card__explanation"><p><b>Why</b><span>{row.reason}</span></p><p><b>Next</b><span>{delayed ? 'Wait for fresh data, then review the setup again.' : row.next}</span></p></div>
    {row.cautions.length > 0 && <details className="watchlist-card__cautions"><summary><WarningOutlined aria-hidden="true" /> Review notes <span>{row.cautions.length}</span></summary><ul>{row.cautions.map((caution) => <li key={caution}>{caution}</li>)}</ul></details>}
    <div className="watchlist-card__confirmation"><ClockCircleOutlined aria-hidden="true" /><span>{row.confirmedAt === null ? 'Awaiting a closed-candle trigger' : <>{delayed ? 'Previous trigger' : 'Latest closed-candle trigger'} · <time dateTime={new Date(row.confirmedAt).toISOString()} title={stamp(row.confirmedAt)}>{ageLabel(row.confirmedAt, now)}</time></>}</span></div>
    <details className="watchlist-card__details">
      <summary>Evidence & timing <span>{families.length} {families.length === 1 ? 'family' : 'families'}</span></summary>
      <div className="watchlist-card__details-body">
        <p className="watchlist-card__evidence-note">Related observations share a family. Counts are not independent confirmations or a win probability.{row.conflict ? ' Evidence points in both directions.' : ''}</p>
        {families.length > 0 ? families.map((family) => <section className="watchlist-card__evidence" key={family} aria-label={`${FAMILY_LABELS[family]} evidence`}>
          <h4>{FAMILY_LABELS[family]}<span>{row.evidence.filter((item) => item.family === family).length} {row.evidence.filter((item) => item.family === family).length === 1 ? 'observation' : 'observations'}</span></h4>
          <ul>{row.evidence.filter((item) => item.family === family).map((item) => <li key={`${item.source}:${item.id}`}><div><b>{item.source}</b><span className={`is-${item.direction}`}>{item.direction} · {item.role}</span></div><p>{item.detail}</p><small>{item.ageBars === 0 ? 'Latest close' : `${item.ageBars} ${row.timeframe} candles ago`} · {stamp(item.availableAt)}{item.provenance.length > 1 ? ` · ${item.provenance.length} coincident references` : ''}</small></li>)}</ul>
        </section>) : <p className="watchlist-card__evidence-note">No additional directional evidence is available.</p>}
        <dl className="watchlist-card__timestamps"><div><dt>Latest completed candle</dt><dd>{stamp(row.asOf)}</dd></div><div><dt>Trigger confirmed at</dt><dd>{row.confirmedAt === null ? 'Not yet confirmed' : stamp(row.confirmedAt)}</dd></div><div><dt>Market data received</dt><dd>{stamp(row.updatedAt)}</dd></div></dl>
        <p className="watchlist-card__evidence-note">Gross reward/risk uses the displayed quote, stop and first target, before costs. Confirmation records a completed-candle trigger. Open Context to review higher-timeframe evidence.</p>
      </div>
    </details>
    <Button className="watchlist-card__open" block onClick={onOpen}>Open chart & Context<ArrowRightOutlined /></Button>
  </article>
}

export function Watchlist({ universe }: { universe: MarketUniverse }) {
  const { rows, coverage, now } = useWatchlistRows(universe.symbols)
  const { timeframe, starredSymbols, screenerFilters, updateScreenerFilters, setMarket, toggleStarredSymbol, selectSymbol } = useScannerStore(useShallow((state) => ({
    timeframe: state.timeframe, starredSymbols: state.starredSymbols, screenerFilters: state.screenerFilters,
    updateScreenerFilters: state.updateScreenerFilters, setMarket: state.setMarket,
    toggleStarredSymbol: state.toggleStarredSymbol, selectSymbol: state.selectSymbol,
  })))
  const { search, starredOnly } = screenerFilters
  const [direction, setDirection] = useState<'all' | 'bullish' | 'bearish'>('all')
  const [source, setSource] = useState<'all' | WatchlistSource>('all')
  const [status, setStatus] = useState<'all' | WatchlistStatus>('all')
  const [pageState, setPageState] = useState({ key: '', page: 1 })
  const searchRef = useRef<InputRef>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const pageKey = `${universe.market}:${timeframe}:${search}:${starredOnly}:${direction}:${source}:${status}`
  const starred = useMemo(() => new Set(starredSymbols), [starredSymbols])
  const visibleRows = useMemo(() => {
    const query = normalizeSearch(search)
    return rows.filter((row) => (!query || normalizeSearch(row.symbol).includes(query))
      && (!starredOnly || starred.has(row.symbol))
      && (direction === 'all' || row.direction === direction)
      && (source === 'all' || row.source === source)
      && (status === 'all' || displayStatus(row, now) === status))
  }, [rows, search, starredOnly, starred, direction, source, status, now])
  const counts = useMemo(() => {
    const result = { confirmed: 0, developing: 0, review: 0, delayed: 0 }
    for (const row of rows) {
      const current = displayStatus(row, now)
      if (current === 'confirmed') result.confirmed++
      else if (current === 'delayed') result.delayed++
      else if (current === 'testing' || current === 'approaching' || current === 'waiting') result.developing++
      else result.review++
    }
    return result
  }, [rows, now])
  const hasFilters = !!search || starredOnly || direction !== 'all' || source !== 'all' || status !== 'all'
  const page = Math.min(pageState.key === pageKey ? pageState.page : 1, Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE)))
  const partial = universe.status !== 'ready' || coverage.fresh < coverage.total
  const loading = universe.status === 'loading' || coverage.loading > 0
  const initialLoading = loading && !hasFilters && rows.length === 0
  const freshPercent = coverage.total > 0 ? Math.min(100, coverage.fresh / coverage.total * 100) : 0
  const emptyTitle = universe.status === 'error' ? 'Market list unavailable'
    : starredOnly && starredSymbols.length === 0 ? 'No starred pairs yet'
      : hasFilters ? 'No setups match these filters'
        : initialLoading ? 'Building your watchlist'
          : coverage.fresh === 0 && coverage.total > 0 ? 'Waiting for current market data' : 'No active setups to watch'
  const emptyDescription = universe.status === 'error' ? 'Retry the market list to start scanning.'
    : starredOnly && starredSymbols.length === 0 ? 'Switch to All pairs and star a pair to keep it in this browser.'
      : hasFilters ? `Try a different pair, direction or status.${partial ? ' Some pairs are still loading or unavailable.' : ''}`
        : initialLoading ? 'Setups appear as candle histories arrive. The shortlist will update automatically.'
          : partial ? 'The available data has no matching setups. Coverage is incomplete; the list will update as data returns.'
            : 'No active Fib, harmonic or structure retest setups are available on this timeframe.'
  const resetFilters = () => {
    setDirection('all'); setSource('all'); setStatus('all')
    updateScreenerFilters({ search: '', starredOnly: false })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (useScannerStore.getState().selectedSymbol || useScannerStore.getState().settingsOpen) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  return <section className="watchlist" aria-label="Setup watchlist"><div className="watchlist__content">
    <header className="watchlist__hero"><div><span className="watchlist__eyebrow"><EyeOutlined /> FOLLOW THE SETUP</span><h1>Watchlist<span>.</span></h1><p>Fib, harmonic and structure setups, ranked from current market data.</p></div><div className="watchlist__scope"><Segmented<ScreenerMarket> aria-label="Watchlist market" value={universe.market} onChange={(market) => setMarket(market, 'watchlist')} options={[{ value: 'spot', label: 'Crypto' }, { value: 'tradfi', label: 'TradFi' }]} /><div className="watchlist__timeframe"><span>Timeframe</span><TimeframePicker /></div></div></header>
    {universe.market === 'tradfi' && <p className="watchlist__market-note">TradFi uses USDT perpetual contracts tracking equities, ETFs and commodities.</p>}
    <div className="watchlist__coverage" role="status"><div className="watchlist__coverage-heading"><span><Badge status={universe.status === 'error' || coverage.error > 0 ? 'warning' : loading ? 'processing' : partial ? 'warning' : coverage.total > 0 ? 'success' : 'default'} />{universe.status === 'loading' ? 'Discovering markets' : universe.status === 'error' ? 'Market list unavailable' : partial ? 'Partial market coverage' : coverage.total > 0 ? 'Market coverage current' : 'No active markets'}</span><strong>{coverage.fresh}<span> / {coverage.total} pairs fresh</span></strong></div><div className="watchlist__coverage-track" aria-hidden="true"><i style={{ width: `${freshPercent}%` }} /></div><div className="watchlist__coverage-detail"><span>{coverage.loading} loading <i>·</i> {coverage.delayed} delayed <i>·</i> {coverage.error} unavailable</span><span>Coverage includes all pairs, regardless of filters.</span></div></div>
    <div className="watchlist__overview" aria-label="All setup counts before filters">
      <div className="watchlist__metric watchlist__metric--confirmed"><span><CheckCircleOutlined /> Confirmed triggers</span><strong>{counts.confirmed}</strong><small>Completed candles · current data</small></div>
      <div className="watchlist__metric"><span><EyeOutlined /> Developing</span><strong>{counts.developing}</strong><small>Approaching, testing or waiting</small></div>
      <div className="watchlist__metric"><span><WarningOutlined /> Needs review</span><strong>{counts.review}</strong><small>Extended, conflicting or blocked</small></div>
      <div className="watchlist__metric watchlist__metric--delayed"><span><ClockCircleOutlined /> Delayed</span><strong>{counts.delayed}</strong><small>Last known setups · awaiting updates</small></div>
    </div>
    {universe.status === 'error' && <Alert className="watchlist__notice" type="error" showIcon title="Could not load the market list" description={universe.error} action={<Button size="small" onClick={universe.retry}>Retry</Button>} />}
    {coverage.fresh === 0 && (coverage.delayed > 0 || coverage.error > 0) && <Alert className="watchlist__notice" type="warning" showIcon title="Market data is delayed or unavailable" description="The feed retries automatically. Last known setups are marked delayed and excluded from current setup counts." />}
    <Card size="small" className="watchlist__controls"><div className="watchlist__toolbar"><div className="watchlist__search"><label htmlFor="watchlist-search">Find a pair</label><Input ref={searchRef} id="watchlist-search" value={search} onChange={(event) => updateScreenerFilters({ search: event.target.value })} prefix={<SearchOutlined />} suffix={!search && <kbd>/</kbd>} allowClear placeholder={universe.market === 'tradfi' ? 'Search TSLA, NVDA, XAU…' : 'Search BTC, ETH, SOL…'} /></div><div className="watchlist__filter"><label htmlFor="watchlist-direction">Direction</label><Select id="watchlist-direction" value={direction} onChange={setDirection} options={[{ value: 'all', label: 'Both directions' }, { value: 'bullish', label: 'Bullish' }, { value: 'bearish', label: 'Bearish' }]} /></div><div className="watchlist__filter"><label htmlFor="watchlist-source">Setup</label><Select id="watchlist-source" value={source} onChange={setSource} options={[{ value: 'all', label: 'All setups' }, ...SOURCES.map((value) => ({ value, label: WATCHLIST_SOURCE_LABELS[value] }))]} /></div><div className="watchlist__filter"><label htmlFor="watchlist-status">Status</label><Select id="watchlist-status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, ...STATUSES.map((value) => ({ value, label: WATCHLIST_STATUS_LABELS[value] }))]} /></div></div></Card>
    <div className="watchlist__results-heading" ref={resultsRef}><div><h2>Ranked setups <span>{visibleRows.length}</span></h2><p>{new Set(visibleRows.map((row) => row.symbol)).size} pairs{partial ? ' · coverage still partial' : ''} · independent of indicator filters</p></div><PairCollectionPicker starredOnly={starredOnly} starredCount={starredSymbols.length} onChange={(value) => updateScreenerFilters({ starredOnly: value })} /></div>
    {hasFilters && <div className="watchlist__filter-summary"><span>Showing {visibleRows.length} of {rows.length} setups</span><Button type="link" size="small" onClick={resetFilters}>Reset filters</Button></div>}
    {visibleRows.length > 0 ? <><div className="watchlist__grid">{visibleRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((row) => <WatchlistCard key={row.id} row={row} now={now} starred={starred.has(row.symbol)} onStar={() => toggleStarredSymbol(row.symbol)} onOpen={() => selectSymbol(row.symbol)} />)}</div>{visibleRows.length > PAGE_SIZE && <div className="watchlist__pagination"><Pagination current={page} pageSize={PAGE_SIZE} total={visibleRows.length} showSizeChanger={false} onChange={(nextPage) => { setPageState({ key: pageKey, page: nextPage }); resultsRef.current?.scrollIntoView({ block: 'start' }) }} showTotal={(total, range) => `${range[0]}–${range[1]} of ${total} setups`} /></div>}</> : <div className="watchlist__empty"><Empty image={initialLoading ? <Spin size="large" /> : Empty.PRESENTED_IMAGE_SIMPLE} description={<><h3>{emptyTitle}</h3><p>{emptyDescription}</p></>}>{hasFilters && <Button onClick={resetFilters}>Reset filters</Button>}</Empty></div>}
    <footer className="watchlist__footer"><span><StarOutlined /> Stars stay in this browser. The watchlist updates while the app is open.</span><span>Setup tracking only · no execution or saved trade history</span></footer>
  </div></section>
}

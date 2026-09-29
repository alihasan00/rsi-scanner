import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Input, Modal, Segmented, Select } from 'antd'
import type { InputRef } from 'antd'
import { ArrowUpOutlined, ArrowDownOutlined, InfoCircleOutlined, SearchOutlined, SlidersOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import type { MarketUniverse } from '../hooks/useMarketUniverse'
import type { Timeframe } from '../types'
import { useGoWatchlist } from '../hooks/useGoWatchlist'
import type { ScreenerMarket } from '../lib/markets'
import { formatQuotePrice } from '../lib/priceFormatting'
import { WATCHLIST_STATUS_LABELS } from '../lib/watchlist'
import type { WatchlistStatus } from '../lib/watchlist'
import { selectGoWatchlist } from '../lib/goWatchlist'
import type { GoWatchlistScope } from '../lib/goWatchlist'
import type { WatchlistInstrument } from '../lib/watchlistInstruments'
import { useScannerStore } from '../store/scannerStore'
import { PairCollectionPicker } from './PairCollectionPicker'
import { TimeframePicker } from './TimeframePicker'
import { WatchlistSetupChart } from './WatchlistSetupChart'
import { WatchlistSetupModal } from './WatchlistSetupModal'
import './Watchlist.css'

const ICHIMOKU_STATUSES: WatchlistStatus[] = ['confirmed', 'testing', 'approaching', 'waiting', 'blocked']
const PAPER_STATUSES: WatchlistStatus[] = ['confirmed', 'blocked']
type Focus = 'all' | 'confirmed' | 'developing'
const ICHIMOKU_FOCUS_OPTIONS: {value: Focus; label: string}[] = [
  {value: 'all', label: 'Shortlist'}, {value: 'confirmed', label: 'Triggered'}, {value: 'developing', label: 'Developing'},
]
const PAPER_FOCUS_OPTIONS: {value: Focus; label: string}[] = [
  {value: 'all', label: 'All signals'}, {value: 'confirmed', label: 'Triggered'},
]
const quote = (price: number | null) => price === null ? '—' : formatQuotePrice(price)

function InstrumentCard({instrument, starred, ichimoku, onOpen, onStar}: {
  instrument: WatchlistInstrument; starred: boolean; ichimoku: boolean; onOpen: () => void; onStar: () => void
}) {
  const {lead, allSetups, hasMixedDirections} = instrument
  const base = instrument.symbol.replace(/USDT$/, '')
  const family = lead.reference?.strategyFamily
  const missingModeledRR = !ichimoku && lead.reference?.netRiskReward == null
  const trailingDonchian = missingModeledRR && lead.target === null && family?.startsWith('donchian55_atr_trail')
  const cappedCloud = missingModeledRR && family?.startsWith('cloud_reclaim_volume_2r')
  const nextOpenWeekly = missingModeledRR && family === 'fresh_weekly_range_long'
  const rewardLabel = trailingDonchian ? 'Exit rule' : cappedCloud ? 'Exit policy' : nextOpenWeekly ? 'Entry timing'
    : lead.reference?.netRiskReward != null ? 'Reward / risk after costs' : 'Plan status'
  const rewardValue = trailingDonchian ? 'Trailing stop' : cappedCloud ? 'Post-fill 2R cap' : nextOpenWeekly ? 'Next minute open'
    : lead.reference?.netRiskReward != null ? `${lead.reference.netRiskReward.toFixed(2)}R`
    : lead.status === 'blocked' ? 'Blocked' : ichimoku ? 'Developing' : 'Review plan'
  return <article className={`watch-asset is-${lead.direction} is-${lead.status}`}>
    <button type="button" className="watch-asset__hit" onClick={onOpen} aria-label={`Open ${base} setup chart`} aria-haspopup="dialog" />
    <header className="watch-asset__header"><div className="watch-asset__identity"><span className="watch-asset__avatar" aria-hidden="true">{base.slice(0, 2)}</span><div><h3>{base}<small>/ USDT</small></h3><span>{allSetups.length} {allSetups.length === 1 ? 'setup' : 'setups'}{hasMixedDirections && ' · opposing directions'}</span></div></div>
      <Button type="text" className={`watch-asset__star${starred ? ' is-starred' : ''}`} icon={starred ? <StarFilled /> : <StarOutlined />} aria-label={`${starred ? 'Unstar' : 'Star'} ${base}`} aria-pressed={starred} onClick={onStar} />
    </header>
    <div className="watch-asset__thesis"><h4>{lead.name}</h4><span className={`watch-status is-${lead.status}`}><i />{lead.reference?.statusLabel ?? WATCHLIST_STATUS_LABELS[lead.status]}</span></div>
    <WatchlistSetupChart row={lead} compact />
    <div className="watch-asset__figures"><div><span>{ichimoku ? 'Evaluated price' : 'Latest close reference'}</span><strong>{quote(lead.price)}</strong></div><div className="watch-asset__reward"><span>{rewardLabel}</span><strong>{rewardValue}</strong></div></div>
    <footer className="watch-asset__footer"><span className={`watch-direction is-${lead.direction}`}>{lead.direction === 'bullish' ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{lead.direction === 'bullish' ? 'Bullish' : 'Bearish'}</span><span className="watch-asset__checkpoint">{lead.reference?.distanceLabel ?? lead.next}</span><span className="watch-asset__open-hint" aria-hidden="true">↗</span></footer>
  </article>
}

function LoadingCard({remaining}: {remaining: number}) {
  return <article className="watch-loading" role="status" aria-label="Checking more assets">
    <div className="watch-loading__top"><i /><div><b /><span /></div></div><div className="watch-loading__chart"><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /></div>
    <div className="watch-loading__message"><span className="watch-loading__spinner" /><div><strong>Checking more assets</strong><p>{remaining > 0 ? `${remaining} timeframe feeds still being checked` : 'Evaluating the next setups'}<br />Qualifying cards appear as they’re ready.</p></div></div>
  </article>
}

export function Watchlist({universe, scope = 'all', timeframe}: {universe: MarketUniverse; scope?: GoWatchlistScope; timeframe?: Timeframe}) {
  const ichimoku = scope === 'ichimoku'
  const selectedTimeframe = timeframe ?? '1h'
  const {rows, coverage, now, evaluating, error: engineError, feedError, evaluatedAt, version, initialScanComplete, remainingInitialFrames} = useGoWatchlist(universe.symbols, universe.market, scope, timeframe)
  const {starredSymbols, screenerFilters, updateScreenerFilters, setMarket, toggleStarredSymbol} = useScannerStore(useShallow((state) => ({
    starredSymbols: state.starredSymbols, screenerFilters: state.screenerFilters,
    updateScreenerFilters: state.updateScreenerFilters, setMarket: state.setMarket, toggleStarredSymbol: state.toggleStarredSymbol,
  })))
  const {search, starredOnly} = screenerFilters
  const [focus, setFocus] = useState<Focus>('all')
  const [direction, setDirection] = useState<'all' | 'bullish' | 'bearish'>('all')
  const [status, setStatus] = useState<'all' | WatchlistStatus>('all')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [info, setInfo] = useState<'rules' | 'feed' | null>(null)
  const [selected, setSelected] = useState<WatchlistInstrument | null>(null)
  const searchRef = useRef<InputRef>(null)
  const starred = useMemo(() => new Set(starredSymbols), [starredSymbols])
  const options = useMemo(() => ({search, starredOnly, starredSymbols: starred, direction, status, scope, timeframe}), [search, starredOnly, starred, direction, status, scope, timeframe])
  const activeFocus = !ichimoku && focus === 'developing' ? 'all' : focus
  const groups = useMemo(() => ({all: selectGoWatchlist(rows, now, options), confirmed: selectGoWatchlist(rows, now, {...options, stage:'confirmed'}), developing: selectGoWatchlist(rows, now, {...options, stage:'developing'})}), [rows, now, options])
  const visible = groups[activeFocus]
  const latestSelected = useMemo(() => selected ? selectGoWatchlist(rows, now, {...options, search: selected.symbol, stage: activeFocus}).find((item) => item.id === selected.id) : undefined, [rows, now, selected, options, activeFocus])
  const advancedFilterCount = Number(direction !== 'all') + Number(status !== 'all')
  const hasFilters = !!search || starredOnly || advancedFilterCount > 0
  const partial = universe.status !== 'ready' || coverage.fresh < coverage.total
  const streaming = !engineError && universe.status !== 'error' && (universe.status === 'loading' || !initialScanComplete)
  const resetFilters = () => { setDirection('all'); setStatus('all'); updateScreenerFilters({search:'', starredOnly:false}) }
  const emptyTitle = universe.status === 'error' ? 'Market list unavailable' : engineError ? `${ichimoku ? 'Ichimoku' : 'Watchlist'} evaluation unavailable`
    : starredOnly && !starredSymbols.length ? 'Your starred list is empty' : hasFilters ? 'No matching setups' : activeFocus === 'confirmed' ? ichimoku ? 'No confirmed entries right now' : 'No triggered paper signals right now' : ichimoku ? 'No active Ichimoku setups right now' : 'No qualifying paper signals right now'
  const emptyDescription = universe.status === 'error' ? 'Retry the market list to start scanning.' : engineError ?? (starredOnly && !starredSymbols.length ? 'Star an asset to find it here next time it qualifies.' : hasFilters ? 'Try another asset or clear your filters.' : ichimoku ? partial ? `Waiting for usable ${selectedTimeframe} candles.` : `Kijun reclaims, cloud reclaims, TK / PK crosses and cloud edge-to-edge setups appear when ${selectedTimeframe} candles pass the selection rules.` : partial ? 'Some source candles are missing or stale. A paper profile needs current data for its own timeframe.' : 'Paper signals appear after their completed source-candle checks. Each card shows whether its reference plan is reviewable.')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || selected || info) return
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (useScannerStore.getState().selectedSymbol || useScannerStore.getState().settingsOpen) return
      event.preventDefault(); searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selected, info])

  return <section className={`watchlist${ichimoku ? ' is-ichimoku' : ''}`} aria-label={ichimoku ? 'Ichimoku Cloud setups' : 'Setup watchlist'}><div className="watchlist__content">
    <header className="watchlist__hero"><div><span className="watchlist__eyebrow">{ichimoku ? 'ONE INDICATOR, EVERY SETUP' : 'PAPER RESEARCH SIGNALS'}</span><h1>{ichimoku ? 'Ichimoku Cloud' : 'Watchlist'}<span>.</span></h1><p>{ichimoku ? `Kijun and cloud reclaims, TK / PK crosses, and cloud edge-to-edge setups on ${selectedTimeframe} candles.` : 'Twelve active research profiles, each with its own timeframe and exit rule.'}</p></div><div className="watchlist__scope">{!ichimoku && <Segmented<ScreenerMarket> aria-label="Watchlist market" value={universe.market} onChange={(market) => setMarket(market,'watchlist')} options={[{value:'spot',label:'Crypto'},{value:'tradfi',label:'TradFi'}]} />}<span className="watchlist__timeframe">{ichimoku ? <>{selectedTimeframe} setups</> : <>11 daily <i /> 1 four-hour <span>paper profiles</span></>}</span></div></header>
    <div className="watchlist__health"><button onClick={() => setInfo('feed')} className={partial ? 'is-partial' : ''}><i />{universe.status === 'loading' ? 'Finding markets…' : `${coverage.fresh} / ${coverage.total} feeds current`}{streaming ? ' · scanning' : evaluating ? ' · updating' : ''}</button><button onClick={() => setInfo('rules')}><InfoCircleOutlined /> Selection rules</button>{universe.market === 'tradfi' && <span>USDT perpetual contracts</span>}</div>
    {engineError && <Alert className="watchlist__notice" type="error" showIcon title={ichimoku ? 'Ichimoku scan unavailable' : 'Watchlist engine unavailable'} description={engineError} />}
    {universe.status === 'error' && <Alert className="watchlist__notice" type="error" showIcon title="Could not load the market list" description={universe.error} action={<Button size="small" onClick={universe.retry}>Retry</Button>} />}
    <div className="watchlist__toolbar">{ichimoku && <div className="watchlist__timeframes"><span>Timeframe</span><TimeframePicker /></div>}<Input ref={searchRef} aria-label="Find an asset" className="watchlist__search" value={search} onChange={(event) => updateScreenerFilters({search:event.target.value})} prefix={<SearchOutlined />} suffix={!search && <kbd>/</kbd>} allowClear placeholder={universe.market === 'tradfi' ? 'Find TSLA, NVDA, XAU…' : 'Find BTC, ETH, SOL…'} /><PairCollectionPicker starredOnly={starredOnly} starredCount={starredSymbols.length} onChange={(value) => updateScreenerFilters({starredOnly:value})} /><Button className="watchlist__filter-toggle" icon={<SlidersOutlined />} aria-expanded={filtersOpen} aria-controls="watchlist-filters" onClick={() => setFiltersOpen(!filtersOpen)}>Filters{advancedFilterCount ? ` · ${advancedFilterCount}` : ''}</Button></div>
    {filtersOpen && <div className="watchlist__filters" id="watchlist-filters"><div><label htmlFor="watchlist-direction">Direction</label><Select id="watchlist-direction" value={direction} onChange={setDirection} options={[{value:'all',label:'Both directions'},{value:'bullish',label:'Bullish'},{value:'bearish',label:'Bearish'}]} /></div><div><label htmlFor="watchlist-status">Setup status</label><Select id="watchlist-status" value={status} onChange={(value) => {setStatus(value); setFocus('all')}} options={[{value:'all',label:'All statuses'},...(ichimoku ? ICHIMOKU_STATUSES : PAPER_STATUSES).map((value) => ({value,label:WATCHLIST_STATUS_LABELS[value]}))]} /></div></div>}
    <div className="watchlist__navigation"><div className="watchlist__focus" aria-label={ichimoku ? 'Ichimoku groups' : 'Watchlist groups'}>{(ichimoku ? ICHIMOKU_FOCUS_OPTIONS : PAPER_FOCUS_OPTIONS).map((option) => <button key={option.value} aria-pressed={activeFocus === option.value} className={activeFocus === option.value ? 'is-active' : ''} onClick={() => setFocus(option.value)}>{ichimoku && option.value === 'all' ? 'All setups' : option.label}<span>{groups[option.value].length}</span></button>)}</div><span className="watchlist__open-tip">Select a card to explore its setup</span></div>
    {hasFilters && <div className="watchlist__filter-summary"><span>{visible.length} matching assets{search ? ` · “${search}”` : ''}{starredOnly ? ' · starred' : ''}</span><Button type="link" size="small" onClick={resetFilters}>Clear filters</Button></div>}
    {activeFocus !== 'all' && <p className="watchlist__stage-note">{ichimoku ? activeFocus === 'confirmed' ? 'Completed triggers with a reference plan ready for review.' : 'Selected watches still developing. A watch is not an entry.' : 'Completed paper-profile triggers with reference plans for review. No trade is placed here.'}</p>}
    {visible.length > 0 || streaming ? <div className="watchlist__grid" aria-label={ichimoku ? 'Ichimoku assets' : 'Watchlist assets'}>{visible.map((instrument) => <InstrumentCard key={instrument.id} instrument={instrument} starred={starred.has(instrument.symbol)} ichimoku={ichimoku} onOpen={() => setSelected(instrument)} onStar={() => toggleStarredSymbol(instrument.symbol)} />)}{streaming && <LoadingCard remaining={remainingInitialFrames} />}</div>
      : <div className="watchlist__empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><h3>{emptyTitle}</h3><p>{emptyDescription}</p></>}>{hasFilters && <Button onClick={resetFilters}>Clear filters</Button>}</Empty></div>}
    <footer className="watchlist__footer"><span>{ichimoku ? `All active ${selectedTimeframe} Ichimoku setups. One card per asset.` : 'All qualifying paper-profile signals · one card per asset · no shortlist cap.'}</span><span>{evaluating ? 'Evaluating…' : evaluatedAt ? `Evaluated ${Math.max(0,Math.floor((now-evaluatedAt)/1000))}s ago` : ichimoku ? 'Scanning live markets' : 'Checking market candles'} · Stars saved in this browser</span></footer>
  </div>
    {selected && <WatchlistSetupModal instrument={selected} latestInstrument={latestSelected} now={now} onClose={() => setSelected(null)} onRefresh={() => {if(latestSelected) setSelected(latestSelected)}} />}
    <Modal open={info !== null} onCancel={() => setInfo(null)} footer={null} title={info === 'feed' ? 'Market coverage' : ichimoku ? 'Ichimoku selection rules' : 'Selection rules'} className="watchlist-info" width={620}>
      {info === 'feed' ? <><p>{coverage.fresh} of {coverage.total} timeframe feeds current.</p><p>{coverage.loading} being checked · {coverage.delayed} delayed · {coverage.error} unavailable</p>{feedError && <p>{feedError}</p>}<p>{ichimoku ? `Only ${selectedTimeframe} candles are loaded for this scan. These candles drive detection and each setup’s confirmation, invalidation and expiry rules. Missing or stale source data cannot qualify. The feed retries automatically.` : 'Each paper profile uses its own source candles: daily for eleven profiles and 4h for the fresh weekly rebound. Missing or stale source data cannot qualify. The feed retries automatically.'}</p></> : ichimoku ? <><p>Only Kijun reclaims, cloud reclaims, TK crosses, PK crosses and cloud edge-to-edge setups appear here. The selected {selectedTimeframe} candles drive detection. All active setups on that timeframe are grouped by asset, without a display cap.</p><p>Only the selected candle history is fetched. Each setup’s algorithm uses those same candles for its trigger, invalidation and expiry checks.</p><p>Crosses need the lecture’s cloud context and a Kijun retest. Setups retain their completed-candle confirmation, invalidation and lifecycle checks. Developing or blocked setups are not confirmed entries.</p><p>Modeled costs are 0.20% fees + 0.10% slippage round trip, with a minimum 1R after costs. An entry needs fresh candles on the selected timeframe.</p><p>These are screening references. Actual costs, liquidity and profitability remain unverified.</p><small>{version ? `Rules: ${version}` : 'Loading rule version…'}</small></> : <><p>The Watchlist screens twelve active paper-research profiles: four daily Donchian 55 breakouts, six daily cloud reclaims with volume and trend filters, one daily TK cross with RSI, and one 4h fresh weekly rebound. Each signal uses its own source timeframe. An asset can carry multiple independent signals, and there is no fixed asset cap.</p><p>The browser keeps up to 500 completed candles per source frame. The crypto project can use longer stored history; that can change indicator values and even the latest profile signal.</p><p>Each card has a completed source-candle signal and shows whether its reference plan passed screening. In the source paper account, all twelve profiles enter at the next whole observed 1-minute opening after the signal is observed. Donchian has an initial stop and a trailing exit, with no fixed profit target. The cloud chart shows its original structural target; a farther exit target may be capped at net 2R after the actual slipped entry and costs are known. This scanner does not check intervening one-minute candles or verify a fill.</p><p>Modeled round-trip costs are 0.20% fees + 0.10% slippage (0.30% total). These profiles are research candidates, and past results do not establish future profitability. This Watchlist does not place or track paper or live orders.</p>{universe.market === 'tradfi' && <p>Application to TradFi perpetual contracts has not been separately validated by the crypto research.</p>}<small>{version ? `Rules: ${version}` : 'Loading rule version…'}</small></>}
    </Modal>
  </section>
}

import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Badge, Button, Card, Empty, Input, Modal, Segmented, Select, Tag, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import { AppstoreOutlined, BarsOutlined, InfoCircleOutlined, SearchOutlined, SlidersOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import type { MarketUniverse } from '../hooks/useMarketUniverse'
import { useNearViewport } from '../hooks/useNearViewport'
import type { ScreenerRow } from '../lib/screener'
import type { LiquidityLevel } from '../lib/liquidityLevels'
import { filterLiquidityRows, levelDistancePercent, liquidityEventLabel, makeLiquidityRow, nearbyLiquidityLevels } from '../lib/liquidityScreener'
import type { LiquidityRow } from '../lib/liquidityScreener'
import { formatQuotePrice } from '../lib/priceFormatting'
import type { ScreenerFilterPreferences } from '../lib/screenerPreferences'
import { useScannerStore } from '../store/scannerStore'
import { getSrContext, getSrContextVersion, subscribeAllSrContexts } from '../store/srContextStore'
import { TimeframePicker } from './TimeframePicker'
import { ScreenerFiltersModal } from './ScreenerFiltersModal'
import { LiquidityChart } from './LiquidityChart'
import { LiquidityGuide } from './LiquidityGuide'
import { PairCollectionPicker } from './PairCollectionPicker'
import './Liquidity.css'

function LevelReadout({ level, side, price, loading }: { level: LiquidityLevel | null; side: 'support' | 'resistance'; price: number; loading: string | null }) {
  return <div className={`liquidity-level is-${side}`}>
    <span className="liquidity-level__side">{side === 'support' ? 'Support below' : 'Resistance above'}</span>
    <strong>{loading ? 'Loading…' : level ? formatQuotePrice(level.price) : '—'}</strong>
    <span className="liquidity-level__source">{loading ?? (level ? level.label : 'No level in this history')}</span>
    <span className="liquidity-level__distance">{level && Number.isFinite(levelDistancePercent(level, price)) ? `${levelDistancePercent(level, price).toFixed(2)}% away` : ' '}</span>
  </div>
}

const LiquidityCard = memo(function LiquidityCard({ data, starred, delayed }: { data: LiquidityRow; starred: boolean; delayed: boolean }) {
  const { row, context, history } = data
  const { ref, isNearViewport } = useNearViewport<HTMLDivElement>()
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const toggleStarredSymbol = useScannerStore((state) => state.toggleStarredSymbol)
  const status = liquidityEventLabel(context)
  const dataError = history.status === 'error' || row.feed.state === 'error'
  const priceReady = row.snapshot.price > 0
  const loading = history.status === 'loading' ? 'Fetching daily history' : !priceReady ? 'Waiting for live price' : null
  return <div ref={ref} className="screener-card-shell">
    <Card size="small" className="screener-card liquidity-card" styles={{ body: { padding: 0 } }}>
      <div className="screener-card__chart-heading">
        <h3 className="screener-card__symbol">{row.symbol.replace(/USDT$/, '')}<span>/ USDT</span></h3>
        <span className="liquidity-card__price">{priceReady ? formatQuotePrice(row.snapshot.price) : '—'}</span>
        <Button type="text" size="small" className="screener-card__star" icon={starred ? <StarFilled /> : <StarOutlined />} aria-label={`${starred ? 'Unstar' : 'Star'} ${row.symbol}`} aria-pressed={starred} onClick={() => toggleStarredSymbol(row.symbol)} />
      </div>
      <button type="button" className="screener-card__chart-button liquidity-card__open" aria-label={`Open ${row.symbol} support and resistance details`} onClick={() => selectSymbol(row.symbol)}>
        {isNearViewport ? <LiquidityChart bars={row.snapshot.bars} levels={nearbyLiquidityLevels(context)} price={row.snapshot.price} compact /> : <div className="liquidity-card__chart-placeholder" />}
        <div className="liquidity-card__levels">
          <LevelReadout side="support" level={context.support} price={row.snapshot.price} loading={loading} />
          <LevelReadout side="resistance" level={context.resistance} price={row.snapshot.price} loading={loading} />
        </div>
        {context.atPrice.length > 0 && <div className="liquidity-card__at-price">At {context.atPrice.map((level) => level.label).join(' / ')}</div>}
        <div className={`liquidity-card__reaction is-${dataError || delayed ? 'forming' : status.tone}`}>
          <span className="liquidity-card__dot" aria-hidden="true" />
          <span>{dataError ? 'Data interrupted · checking again' : delayed ? 'Updates delayed · last known levels' : loading ? 'Building liquidity map…' : status.text}</span>
          <span className="liquidity-card__arrow" aria-hidden="true">↗</span>
        </div>
      </button>
    </Card>
  </div>
})

export function LiquidityScreener({ universe, rows, now }: { universe: MarketUniverse; rows: readonly ScreenerRow[]; now: number }) {
  const { timeframe, filters, starredSymbols, density, setDensity, updateFilters, resetFilters } = useScannerStore(useShallow((state) => ({
    timeframe: state.timeframe, filters: state.screenerFilters, starredSymbols: state.starredSymbols,
    density: state.cardDensity, setDensity: state.setCardDensity,
    updateFilters: state.updateScreenerFilters, resetFilters: state.resetScreenerFilters,
  })))
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const searchRef = useRef<InputRef>(null)
  const subscribe = useCallback((notify: () => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = subscribeAllSrContexts(() => {
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; notify() }, 500)
    })
    return () => { stop(); if (timer !== undefined) clearTimeout(timer) }
  }, [])
  const version = useSyncExternalStore(subscribe, getSrContextVersion, getSrContextVersion)
  const liquidityRows = useMemo(() => rows.map((row) => makeLiquidityRow(row, getSrContext(row.symbol), filters.srSource, timeframe)),
    [rows, filters.srSource, timeframe, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => filterLiquidityRows(liquidityRows, filters, starredSymbols), [liquidityRows, filters, starredSymbols])
  const ready = liquidityRows.filter((row) => row.history.status === 'ready').length
  const failed = liquidityRows.filter((row) => row.history.status === 'error' || row.row.feed.state === 'error').length
  const isDelayed = (row: ScreenerRow) => row.feed.updatedAt !== null && now - row.feed.updatedAt > 60_000
  const delayed = visible.filter((row) => isDelayed(row.row)).length
  const confirmed = visible.filter((row) => row.history.status === 'ready' && row.row.feed.state === 'ready' && row.context.events.some((event) => event.state === 'confirmed')).length
  const activeFilterCount = Number(filters.srSource !== 'all') + Number(filters.srSignal !== 'all')
  const intraday = !['1d', '3d', '1w'].includes(timeframe)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || filtersOpen || guideOpen) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const state = useScannerStore.getState()
      if (state.selectedSymbol || state.settingsOpen) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [filtersOpen, guideOpen])

  return <>
    <div className="liquidity-intro">
      <p>Find the next level. Watch for a sweep and a close back inside.</p>
      <Button type="text" size="small" icon={<InfoCircleOutlined />} onClick={() => setGuideOpen(true)}>How to read this</Button>
    </div>
    <div className="liquidity-scope"><span>Calendar liquidity</span> Monday body · previous week · previous month <span className="liquidity-scope__manual">Fib & volume-profile confluence requires manual review.</span></div>
    <Card className="screener__controls" size="small">
      <div className="screener__toolbar">
        <div className="screener__search"><label htmlFor="liquidity-search">Find a pair</label><Input id="liquidity-search" ref={searchRef} value={filters.search} onChange={(event) => updateFilters({ search: event.target.value })} prefix={<SearchOutlined />} suffix={!filters.search && <kbd>/</kbd>} allowClear placeholder={universe.market === 'tradfi' ? 'Search TSLA, NVDA, XAU…' : 'Search BTC, ETH, SOL…'} aria-label="Search support and resistance pairs" /></div>
        <Button className="screener__filters-trigger" icon={<SlidersOutlined />} aria-label={activeFilterCount ? `Filters (${activeFilterCount} active)` : 'Filters'} aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>Filters{activeFilterCount > 0 && <span className="screener__filter-count">{activeFilterCount}</span>}</Button>
        <div className="screener__timeframes"><span>Reaction timeframe</span><TimeframePicker /></div>
      </div>
    </Card>
    {filtersOpen && <ScreenerFiltersModal initialFilters={filters} onApply={updateFilters} onClear={resetFilters} onClose={() => setFiltersOpen(false)} />}
    <div className="screener__results-bar">
      <span className="screener__collection-label">{filters.starredOnly ? <><StarOutlined /> Starred pairs</> : 'Liquidity map'} <span>{visible.length}</span><Tag className="liquidity-sweep-count">{confirmed} with recent sweeps</Tag></span>
      <div className="screener__result-controls">
        <Select<ScreenerFilterPreferences['srSort']> aria-label="Sort liquidity pairs" className="screener__sort" value={filters.srSort} onChange={(srSort) => updateFilters({ srSort })} options={[{ value: 'watchlist', label: 'Watchlist order' }, { value: 'nearest', label: 'Nearest level' }, { value: 'signals', label: 'Recent sweeps' }, { value: 'symbol', label: 'Name: A to Z' }]} variant="borderless" />
        <Segmented className="screener__density" aria-label="Card size" value={density} onChange={setDensity} options={[{ value: 'comfortable', label: <Tooltip title="Comfortable cards"><AppstoreOutlined aria-label="Comfortable cards" /></Tooltip> }, { value: 'compact', label: <Tooltip title="Compact cards"><BarsOutlined aria-label="Compact cards" /></Tooltip> }]} />
        <PairCollectionPicker starredOnly={filters.starredOnly} starredCount={starredSymbols.length} onChange={(starredOnly) => updateFilters({ starredOnly })} />
      </div>
    </div>
    {(activeFilterCount > 0 || filters.starredOnly || filters.search || filters.srSort !== 'watchlist') && <div className="screener__active-filters"><span>Showing {visible.length} of {rows.length} pairs{filters.srSignal === 'near' ? ' · within 0.5% of a level' : filters.srSignal !== 'all' ? ' · sweeps in the latest 3 closed candles' : ''}{filters.srSource !== 'all' ? ` · ${filters.srSource === 'monday' ? 'Monday body' : `previous ${filters.srSource}`}` : ''}</span><Button type="link" size="small" onClick={resetFilters}>Reset filters</Button></div>}
    {!intraday && <p className="liquidity-timeframe-note">Monday’s body range is an intraday level. Choose an hourly or minute timeframe to see it.</p>}
    {universe.status === 'error' && <Alert className="screener__notice" type="error" showIcon title="TradFi market list unavailable" description={universe.error} action={<Button onClick={universe.retry}>Retry</Button>} />}
    {failed > 0 && <Alert className="screener__notice" type="warning" showIcon title={`Data interrupted for ${failed} ${failed === 1 ? 'pair' : 'pairs'}`} description="Retrying automatically. Confirmed-sweep filters exclude pairs with interrupted data." />}
    {delayed > 0 && <Alert className="screener__notice" type="warning" showIcon title={`Price updates delayed for ${delayed} ${delayed === 1 ? 'pair' : 'pairs'}`} description="These cards show the last received prices and candles. Check for fresh updates before interpreting a reaction." />}
    {universe.status === 'loading' ? <Card className="screener__empty"><p role="status">Loading Binance TradFi contracts…</p></Card> : universe.status === 'error' ? null : visible.length > 0 ? <div className={`screener__grid liquidity-grid is-${density}`}>{visible.map((row) => <LiquidityCard key={`${universe.market}:${timeframe}:${row.row.symbol}`} data={row} starred={starredSymbols.includes(row.row.symbol)} delayed={isDelayed(row.row)} />)}</div> : ready < rows.length && failed < rows.length ? <Card className="screener__empty"><p role="status">Building calendar levels… {ready} of {rows.length} pairs ready.</p></Card> : <Card className="screener__empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><h2>{filters.starredOnly && !starredSymbols.length ? 'Keep your favorites close' : rows.length ? 'No pairs match these filters' : 'No active markets'}</h2><p>{filters.srSource === 'monday' && !intraday ? 'Switch to an intraday timeframe to see Monday levels.' : filters.starredOnly && !starredSymbols.length ? 'Star a card to build your own watchlist.' : 'Broaden the source or sweep filter, or try a different pair.'}</p></>}><Button onClick={() => setFiltersOpen(true)}>Edit filters</Button><Button type="primary" onClick={resetFilters}>Reset filters</Button></Empty></Card>}
    <footer className="screener__footer"><Badge status={failed || delayed ? 'warning' : ready ? 'success' : 'default'} text={`${ready} / ${rows.length} calendar maps ready`} /><span>Nearby levels use live price · sweeps need a close</span><span>Levels & candle times in UTC</span></footer>
    <Modal open={guideOpen} onCancel={() => setGuideOpen(false)} footer={<Button onClick={() => setGuideOpen(false)}>Got it</Button>} title="Reading support & resistance" width={660}><LiquidityGuide /></Modal>
  </>
}

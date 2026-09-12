import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Empty, Input, Modal, Segmented, Select, Tag, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import { AppstoreOutlined, BarsOutlined, InfoCircleOutlined, SearchOutlined, SlidersOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import type { MarketUniverse } from '../hooks/useMarketUniverse'
import { useNearViewport } from '../hooks/useNearViewport'
import type { ScreenerRow } from '../lib/screener'
import type { ScreenerFilterPreferences } from '../lib/screenerPreferences'
import { HARMONIC_COLORS, HARMONIC_NAMES, HARMONIC_STAGES, makeHarmonicRows } from '../lib/harmonicRows'
import type { HarmonicRow } from '../lib/harmonicRows'
import { getHarmonicLiveContext } from '../lib/harmonics'
import { formatQuotePrice } from '../lib/priceFormatting'
import { useScannerStore } from '../store/scannerStore'
import { HarmonicChart } from './HarmonicChart'
import { HarmonicGuide } from './HarmonicGuide'
import { TimeframePicker } from './TimeframePicker'
import { PairCollectionPicker } from './PairCollectionPicker'
import { ScreenerFiltersModal } from './ScreenerFiltersModal'
import './ScreenerCard.css'
import './Harmonic.css'

const HarmonicCard = memo(function HarmonicCard({ data, starred, delayed }: { data: HarmonicRow; starred: boolean; delayed: boolean }) {
  const { row, setup } = data
  const { ref, isNearViewport } = useNearViewport<HTMLDivElement>()
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const toggleStarredSymbol = useScannerStore((state) => state.toggleStarredSymbol)
  const lastBar = row.snapshot.bars.at(-1)
  const live = getHarmonicLiveContext(setup, row.snapshot.price, lastBar?.isClosed === false ? lastBar : undefined)
  const interrupted = row.feed.state === 'error' || delayed
  const liveLabel = interrupted ? 'Updates delayed · last known setup' : live.invalidated ? 'Live boundary break · provisional'
    : live.inZone ? 'Live price in D zone' : Number.isFinite(live.distancePercent) ? `${live.distancePercent.toFixed(2)}% to D zone` : 'Waiting for price'
  return <div ref={ref} className="screener-card-shell">
    <Card size="small" className="screener-card harmonic-card" styles={{ body: { padding: 0 } }}>
      <div className="screener-card__chart-heading">
        <h3 className="screener-card__symbol">{row.symbol.replace(/USDT$/, '')}<span>/ USDT</span></h3>
        <span className="harmonic-card__price">{formatQuotePrice(row.snapshot.price)}</span>
        <Button type="text" size="small" className="screener-card__star" icon={starred ? <StarFilled /> : <StarOutlined />} aria-label={`${starred ? 'Unstar' : 'Star'} ${row.symbol}`} aria-pressed={starred} onClick={() => toggleStarredSymbol(row.symbol)} />
      </div>
      <button type="button" className="screener-card__chart-button harmonic-card__open" aria-label={`Open ${row.symbol} ${setup.direction} ${HARMONIC_NAMES[setup.kind]} pattern`} onClick={() => selectSymbol(row.symbol)}>
        <div className="harmonic-card__pattern"><strong style={{ color: HARMONIC_COLORS[setup.kind] }}>{HARMONIC_NAMES[setup.kind]}</strong><span className={`is-${setup.direction}`}>{setup.direction === 'bullish' ? '↗ Bullish' : '↘ Bearish'}</span><span>{HARMONIC_STAGES[setup.stage]}</span></div>
        {isNearViewport ? <HarmonicChart bars={row.snapshot.bars} setup={setup} price={row.snapshot.price} compact /> : <div className="harmonic-card__placeholder" />}
        <div className="harmonic-card__zone"><span>D zone</span><strong>{formatQuotePrice(setup.zone.low)} – {formatQuotePrice(setup.zone.high)}</strong></div>
        <div className={`harmonic-card__status${interrupted || live.invalidated ? ' is-warning' : live.inZone ? ' is-zone' : ''}`}><span>{liveLabel}</span><span aria-hidden="true">↗</span></div>
      </button>
    </Card>
  </div>
})

export function HarmonicScreener({ universe, rows, now }: { universe: MarketUniverse; rows: readonly ScreenerRow[]; now: number }) {
  const { timeframe, filters, starredSymbols, density, setDensity, updateFilters, resetFilters } = useScannerStore(useShallow((state) => ({
    timeframe: state.timeframe, filters: state.screenerFilters, starredSymbols: state.starredSymbols,
    density: state.cardDensity, setDensity: state.setCardDensity, updateFilters: state.updateScreenerFilters, resetFilters: state.resetScreenerFilters,
  })))
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const searchRef = useRef<InputRef>(null)
  const visible = useMemo(() => makeHarmonicRows(rows, filters, starredSymbols), [rows, filters, starredSymbols])
  const loaded = rows.filter((row) => row.snapshot.bars.length > 0).length
  const failed = rows.filter((row) => row.feed.state === 'error').length
  const delayed = rows.filter((row) => row.feed.updatedAt !== null && now - row.feed.updatedAt > 60_000).length
  const activeFilterCount = Number(filters.harmonicPattern !== 'all') + Number(filters.harmonicDirection !== 'any') + Number(filters.harmonicStage !== 'all')
  const inZone = visible.filter(({ setup, row }) => {
    const lastBar = row.snapshot.bars.at(-1)
    return getHarmonicLiveContext(setup, row.snapshot.price, lastBar?.isClosed === false ? lastBar : undefined).inZone
      && row.feed.state === 'ready' && row.feed.updatedAt !== null && now - row.feed.updatedAt <= 60_000
  }).length
  const isLoading = loaded + rows.filter((row) => row.snapshot.bars.length === 0 && row.feed.state === 'error').length < rows.length

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
    <div className="harmonic-intro"><p>Spot the shape. Wait for price to reach the reversal zone.</p><Button type="text" size="small" icon={<InfoCircleOutlined />} onClick={() => setGuideOpen(true)}>How to read this</Button></div>
    <Card className="screener__controls" size="small"><div className="screener__toolbar">
      <div className="screener__search"><label htmlFor="harmonic-search">Find a pair</label><Input id="harmonic-search" ref={searchRef} value={filters.search} onChange={(event) => updateFilters({ search: event.target.value })} prefix={<SearchOutlined />} suffix={!filters.search && <kbd>/</kbd>} allowClear placeholder={universe.market === 'tradfi' ? 'Search TSLA, NVDA, XAU…' : 'Search BTC, ETH, SOL…'} aria-label="Search harmonic pairs" /></div>
      <Button className="screener__filters-trigger" icon={<SlidersOutlined />} aria-label={activeFilterCount ? `Filters (${activeFilterCount} active)` : 'Filters'} aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(true)}>Filters{activeFilterCount > 0 && <span className="screener__filter-count">{activeFilterCount}</span>}</Button>
      <div className="screener__timeframes"><span>Timeframe</span><TimeframePicker /></div>
    </div></Card>
    {filtersOpen && <ScreenerFiltersModal initialFilters={filters} onApply={updateFilters} onClear={resetFilters} onClose={() => setFiltersOpen(false)} />}
    <div className="screener__results-bar">
      <span className="screener__collection-label">{filters.starredOnly ? <><StarOutlined /> Starred patterns</> : 'Harmonic patterns'} <span role="status">{visible.length}</span><Tag>{inZone} in D zone now</Tag></span>
      <div className="screener__result-controls">
        <Select<ScreenerFilterPreferences['harmonicSort']> aria-label="Sort harmonic pairs" className="screener__sort" value={filters.harmonicSort} onChange={(harmonicSort) => updateFilters({ harmonicSort })} options={[{ value: 'watchlist', label: 'Watchlist order' }, { value: 'nearest', label: 'Nearest D zone' }, { value: 'symbol', label: 'Name: A to Z' }]} variant="borderless" />
        <Segmented className="screener__density" aria-label="Card size" value={density} onChange={setDensity} options={[{ value: 'comfortable', label: <Tooltip title="Comfortable cards"><AppstoreOutlined aria-label="Comfortable cards" /></Tooltip> }, { value: 'compact', label: <Tooltip title="Compact cards"><BarsOutlined aria-label="Compact cards" /></Tooltip> }]} />
        <PairCollectionPicker starredOnly={filters.starredOnly} starredCount={starredSymbols.length} onChange={(starredOnly) => updateFilters({ starredOnly })} />
      </div>
    </div>
    {(activeFilterCount > 0 || filters.search || filters.starredOnly || filters.harmonicSort !== 'watchlist') && <div className="screener__active-filters"><span>{visible.length} matching pairs{filters.harmonicPattern !== 'all' ? ` · ${HARMONIC_NAMES[filters.harmonicPattern]}` : ''}{filters.harmonicDirection !== 'any' ? ` · ${filters.harmonicDirection}` : ''}{filters.harmonicStage !== 'all' ? ` · ${HARMONIC_STAGES[filters.harmonicStage]}` : ''}</span><Button type="link" size="small" onClick={resetFilters}>Reset filters</Button></div>}
    {universe.status === 'error' && <Alert className="screener__notice" type="error" showIcon title="TradFi market list unavailable" description={universe.error} action={<Button onClick={universe.retry}>Retry</Button>} />}
    {(failed > 0 || delayed > 0) && <Alert className="screener__notice" type="warning" showIcon title="Some market updates are delayed" description={`${failed} pairs reconnecting · ${delayed} delayed. Available patterns continue updating; affected cards show their last known setup.`} />}
    {universe.status === 'loading' ? <Card className="screener__empty"><p role="status">Loading Binance TradFi contracts…</p></Card> : universe.status === 'error' ? null : visible.length > 0 ? <div className={`screener__grid harmonic-grid is-${density}`}>{visible.map((data) => <HarmonicCard key={`${universe.market}:${timeframe}:${data.row.symbol}`} data={data} starred={starredSymbols.includes(data.row.symbol)} delayed={data.row.feed.updatedAt !== null && now - data.row.feed.updatedAt > 60_000} />)}</div>
      : isLoading ? <Card className="screener__empty"><p role="status">Scanning closed candles for harmonics… {loaded} of {rows.length} pairs loaded.</p></Card>
        : <Card className="screener__empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<><h2>{filters.starredOnly && !starredSymbols.length ? 'Keep your favorites close' : !rows.length ? 'No active markets' : failed === rows.length ? 'Market data unavailable' : 'No matching harmonic patterns'}</h2><p>{filters.starredOnly && !starredSymbols.length ? 'Star cards in any tab to build your watchlist.' : 'Try another timeframe or broaden the pattern and stage filters. New setups appear as swings confirm.'}</p></>}><Button onClick={() => setFiltersOpen(true)}>Edit filters</Button><Button type="primary" onClick={resetFilters}>Reset filters</Button></Empty></Card>}
    <footer className="screener__footer"><Badge status={failed || delayed ? 'warning' : loaded ? 'success' : 'default'} text={`${loaded} / ${rows.length} pairs scanned`} /><span>Pattern stages use closed candles · proximity uses live price</span><span>Linear price · UTC</span></footer>
    <Modal open={guideOpen} onCancel={() => setGuideOpen(false)} footer={<Button onClick={() => setGuideOpen(false)}>Got it</Button>} title="Reading harmonic patterns" width={700}><HarmonicGuide /></Modal>
  </>
}

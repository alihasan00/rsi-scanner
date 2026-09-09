import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Empty, Input, Segmented, Select, Statistic, Tag, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import { AppstoreOutlined, BarsOutlined, SearchOutlined, SlidersOutlined, StarOutlined, SwapOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import { useScreenerRows } from '../hooks/useScreenerRows'
import type { MarketUniverse } from '../hooks/useMarketUniverse'
import { candleChange, DEFAULT_DIVERGENCE_RECENCY, filterDivergenceSetups, filterScreenerRows } from '../lib/screener'
import type { ScreenerSort } from '../lib/screener'
import { useScannerStore } from '../store/scannerStore'
import { TimeframePicker } from './TimeframePicker'
import { ScreenerCard } from './ScreenerCard'
import { DIVERGENCE_RECENCY_OPTIONS, RSI_FILTER_OPTIONS } from '../lib/screenerFilterOptions'
import { ScreenerFiltersModal } from './ScreenerFiltersModal'
import './ScreenerGrid.css'

const DELAYED_AFTER_MS = 60_000
const SORT_OPTIONS = [
  { value: 'watchlist', label: 'Watchlist order' },
  { value: 'signals', label: 'Active signals' },
  { value: 'change', label: 'Candle change' },
  { value: 'rsi-low', label: 'RSI: low to high' },
  { value: 'rsi-high', label: 'RSI: high to low' },
  { value: 'symbol', label: 'Name: A to Z' },
]

export function ScreenerGrid({ universe }: { universe: MarketUniverse }) {
  const { market, symbols, status: universeStatus } = universe
  const { timeframe, starredSymbols, cardDensity, setCardDensity, screenerFilters, updateScreenerFilters, resetScreenerFilters } = useScannerStore(useShallow((state) => ({
    timeframe: state.timeframe,
    starredSymbols: state.starredSymbols,
    cardDensity: state.cardDensity,
    setCardDensity: state.setCardDensity,
    screenerFilters: state.screenerFilters,
    updateScreenerFilters: state.updateScreenerFilters,
    resetScreenerFilters: state.resetScreenerFilters,
  })))
  const rows = useScreenerRows(symbols)
  const { search, signal, divergenceRecency, rsiState, starredOnly, sort } = screenerFilters
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const searchRef = useRef<InputRef>(null)
  const scrollRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(interval)
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      if (filtersOpen || useScannerStore.getState().selectedSymbol || useScannerStore.getState().settingsOpen) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [filtersOpen])
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [timeframe])

  const visibleRows = useMemo(() => filterScreenerRows(rows, {
    search, signal, divergenceRecency, rsiState, starredOnly, starredSymbols, sort,
  }), [rows, search, signal, divergenceRecency, rsiState, starredOnly, starredSymbols, sort])
  const usesDivergenceRecency = signal === 'divergence'
  const recencyLabel = DIVERGENCE_RECENCY_OPTIONS.find((option) => option.value === divergenceRecency)!.label
  const loadedRows = rows.filter((row) => row.snapshot.bars.length > 0)
  const divergenceCount = loadedRows.filter((row) => filterDivergenceSetups(
    row.analysis.divergences, usesDivergenceRecency ? divergenceRecency : 'any',
  ).length > 0).length
  const failedCount = rows.filter((row) => row.feed.state === 'error').length
  const delayed = loadedRows.filter((row) => row.feed.updatedAt !== null && now - row.feed.updatedAt > DELAYED_AFTER_MS).length
  const advancing = loadedRows.filter((row) => (candleChange(row.snapshot) ?? 0) > 0).length
  const declining = loadedRows.filter((row) => (candleChange(row.snapshot) ?? 0) < 0).length
  const activeFilterCount = Number(signal !== 'all') + Number(rsiState !== 'all') + Number(starredOnly)
  const hasFilters = !!search || activeFilterCount > 0 || sort !== 'watchlist' || divergenceRecency !== DEFAULT_DIVERGENCE_RECENCY
  const rsiFilterLabel = RSI_FILTER_OPTIONS.find((option) => option.value === rsiState)!.label
  const feedLabel = universeStatus === 'loading' ? 'Loading TradFi markets'
    : universeStatus === 'error' ? 'Market list unavailable'
      : rows.length === 0 ? 'No active markets'
        : failedCount ? `${failedCount} ${failedCount === 1 ? 'pair' : 'pairs'} reconnecting`
    : delayed ? `${delayed} ${delayed === 1 ? 'pair' : 'pairs'} delayed`
      : loadedRows.length === rows.length ? 'Market data connected' : `Loading ${loadedRows.length} / ${rows.length} pairs`

  return (
    <section className="screener" ref={scrollRef} aria-label="Market screener">
      <div className="screener__content">
        {market === 'tradfi' && <p className="screener__market-description"><strong>TradFi</strong> USDT perpetual contracts tracking equities, ETFs, and commodities.</p>}
        <div className="screener__overview" aria-label="Watchlist overview">
          <Card size="small" className="screener-stat">
            <span className="screener-stat__icon"><AppstoreOutlined /></span>
            <Statistic title="Pairs tracked" value={rows.length} />
            <div className="screener-stat__detail"><Tag>{loadedRows.length} loaded</Tag><span>{advancing} up <span aria-hidden="true">·</span> {declining} down this candle</span></div>
          </Card>
          <Card size="small" className="screener-stat">
            <span className="screener-stat__icon"><SwapOutlined /></span>
            <Statistic title="RSI divergences" value={divergenceCount} formatter={(value) => String(value).padStart(2, '0')} />
            <div className="screener-stat__detail"><Tag className="screener__brand-tag">RSI 14</Tag><span>{usesDivergenceRecency && divergenceRecency !== 'any' ? `Active pairs · ${recencyLabel.toLowerCase()}` : 'Pairs with an active divergence'}</span></div>
          </Card>
        </div>

        <Card className="screener__controls" size="small">
          <div className="screener__toolbar">
            <div className="screener__search">
              <label htmlFor="pair-search">Find a pair</label>
              <Input id="pair-search" ref={searchRef} value={search} onChange={(event) => updateScreenerFilters({ search: event.target.value })} prefix={<SearchOutlined />} suffix={!search && <kbd>/</kbd>} allowClear placeholder={market === 'tradfi' ? 'Search TSLA, NVDA, XAU…' : 'Search BTC, ETH, SOL…'} aria-label="Search pairs" />
            </div>
            <Button
              className="screener__filters-trigger"
              icon={<SlidersOutlined />}
              aria-label={activeFilterCount ? `Filters (${activeFilterCount} active)` : 'Filters'}
              aria-haspopup="dialog"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen(true)}
            >
              Filters
              {activeFilterCount > 0 && <span className="screener__filter-count" aria-hidden="true">{activeFilterCount}</span>}
            </Button>
            <div className="screener__timeframes"><span>Timeframe</span><TimeframePicker /></div>
          </div>
        </Card>

        {filtersOpen && <ScreenerFiltersModal
          initialFilters={screenerFilters}
          starredCount={starredSymbols.length}
          onApply={updateScreenerFilters}
          onClear={resetScreenerFilters}
          onClose={() => setFiltersOpen(false)}
        />}

        <div className="screener__results-bar">
          <span className="screener__collection-label">{starredOnly ? <><StarOutlined /> Starred pairs</> : 'All pairs'} <span>{starredOnly ? starredSymbols.length : rows.length}</span></span>
          <div className="screener__result-controls">
            <span className="screener__result-count" role="status">{visibleRows.length} {visibleRows.length === 1 ? 'pair' : 'pairs'}</span>
            <Select<ScreenerSort> aria-label="Sort pairs" className="screener__sort" value={sort} onChange={(sort) => updateScreenerFilters({ sort })} options={SORT_OPTIONS} variant="borderless" />
            <Segmented className="screener__density" aria-label="Card size" value={cardDensity} onChange={setCardDensity} options={[
              { value: 'comfortable', label: <Tooltip title="Comfortable cards"><AppstoreOutlined aria-label="Comfortable cards" /></Tooltip> },
              { value: 'compact', label: <Tooltip title="Compact cards"><BarsOutlined aria-label="Compact cards" /></Tooltip> },
            ]} />
          </div>
        </div>
        {hasFilters && (
          <div className="screener__active-filters">
            <span>Showing {visibleRows.length} of {rows.length} pairs{usesDivergenceRecency ? ` · RSI divergences · ${recencyLabel.toLowerCase()}` : ''}{rsiState !== 'all' ? ` · ${rsiFilterLabel}` : ''}</span>
            <Button type="link" size="small" onClick={resetScreenerFilters}>Reset filters</Button>
          </div>
        )}
        {universeStatus === 'error' && <Alert className="screener__notice" type="error" showIcon title="TradFi market list unavailable" description={universe.error} action={<Button onClick={universe.retry}>Retry</Button>} />}
        {failedCount > 0 && <Alert className="screener__notice" type="warning" showIcon title={`Market data unavailable for ${failedCount} ${failedCount === 1 ? 'pair' : 'pairs'}`} description="Retrying automatically. Available charts continue updating." />}
        {universeStatus === 'loading' ? (
          <Card className="screener__empty"><p role="status">Loading Binance TradFi contracts…</p></Card>
        ) : universeStatus === 'error' ? null : rows.length === 0 ? (
          <Card className="screener__empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No active USDT TradFi contracts are currently available."><Button onClick={universe.retry}>Refresh markets</Button></Empty></Card>
        ) : visibleRows.length ? (
          <div className={`screener__grid is-${cardDensity}`}>
            {visibleRows.map((row) => <ScreenerCard key={`${market}:${timeframe}:${row.symbol}`} row={row} timeframe={timeframe} starred={starredSymbols.includes(row.symbol)} stale={row.feed.updatedAt !== null && now - row.feed.updatedAt > DELAYED_AFTER_MS} matchingDivergences={usesDivergenceRecency ? filterDivergenceSetups(row.analysis.divergences, divergenceRecency) : undefined} />)}
          </div>
        ) : (
          <Card className="screener__empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={
              <><h2>{starredOnly && starredSymbols.length === 0 ? 'Keep your favorites close' : 'No pairs match these filters'}</h2><p>{starredOnly && starredSymbols.length === 0 ? 'Star a card to build your own focused watchlist.' : rsiState !== 'all' ? 'Try another RSI state or broaden your other filters.' : usesDivergenceRecency && divergenceRecency !== 'any' ? 'Try a wider candle window or Any age to find older active divergences.' : 'Try another pair or indicator.'}</p></>
            }><Button onClick={() => setFiltersOpen(true)}>Edit filters</Button><Button type="primary" onClick={resetScreenerFilters}>Show all pairs</Button></Empty>
          </Card>
        )}
        <footer className="screener__footer"><Badge status={universeStatus === 'error' || failedCount || delayed ? 'warning' : loadedRows.length ? 'success' : 'default'} text={feedLabel} /><span>Divergence setups update on candle closes</span><span>Live candles are provisional <span aria-hidden="true">·</span> All times UTC</span></footer>
      </div>
    </section>
  )
}

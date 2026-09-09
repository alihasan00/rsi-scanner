import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Cascader, Empty, Input, Segmented, Select, Statistic, Tag, Tooltip } from 'antd'
import type { InputRef } from 'antd'
import { AppstoreOutlined, BarsOutlined, SearchOutlined, StarOutlined, SwapOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import { useScreenerRows } from '../hooks/useScreenerRows'
import { candleChange, DEFAULT_DIVERGENCE_RECENCY, filterDivergenceSetups, filterScreenerRows } from '../lib/screener'
import type { DivergenceRecency, ScreenerSort } from '../lib/screener'
import type { ScreenerFilterPreferences } from '../lib/screenerPreferences'
import { useScannerStore } from '../store/scannerStore'
import { TimeframePicker } from './TimeframePicker'
import { ScreenerCard } from './ScreenerCard'
import './ScreenerGrid.css'

const DELAYED_AFTER_MS = 60_000
interface IndicatorOption {
  value: ScreenerFilterPreferences['signal'] | DivergenceRecency
  label: string
  children?: IndicatorOption[]
}
const DIVERGENCE_RECENCY_OPTIONS: IndicatorOption[] = [
  { value: 1, label: 'Latest closed candle' },
  { value: 3, label: 'Latest 3 closed candles' },
  { value: 5, label: 'Latest 5 closed candles' },
  { value: 'any', label: 'Any age' },
]
const SIGNAL_OPTIONS: IndicatorOption[] = [
  { value: 'all', label: 'All indicators' },
  { value: 'divergence', label: 'RSI divergences', children: DIVERGENCE_RECENCY_OPTIONS },
]
const SORT_OPTIONS = [
  { value: 'watchlist', label: 'Watchlist order' },
  { value: 'signals', label: 'Active signals' },
  { value: 'change', label: 'Candle change' },
  { value: 'rsi-low', label: 'RSI: low to high' },
  { value: 'rsi-high', label: 'RSI: high to low' },
  { value: 'symbol', label: 'Name: A to Z' },
]

export function ScreenerGrid() {
  const { timeframe, starredSymbols, cardDensity, setCardDensity, screenerFilters, updateScreenerFilters, resetScreenerFilters } = useScannerStore(useShallow((state) => ({
    timeframe: state.timeframe,
    starredSymbols: state.starredSymbols,
    cardDensity: state.cardDensity,
    setCardDensity: state.setCardDensity,
    screenerFilters: state.screenerFilters,
    updateScreenerFilters: state.updateScreenerFilters,
    resetScreenerFilters: state.resetScreenerFilters,
  })))
  const rows = useScreenerRows()
  const { search, signal, divergenceRecency, starredOnly, sort } = screenerFilters
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
      if (useScannerStore.getState().selectedSymbol || useScannerStore.getState().settingsOpen) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }) }, [timeframe])

  const visibleRows = useMemo(() => filterScreenerRows(rows, {
    search, signal, divergenceRecency, starredOnly, starredSymbols, sort,
  }), [rows, search, signal, divergenceRecency, starredOnly, starredSymbols, sort])
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
  const hasFilters = !!search || signal !== 'all' || starredOnly || sort !== 'watchlist' || divergenceRecency !== DEFAULT_DIVERGENCE_RECENCY
  const feedLabel = failedCount ? `${failedCount} ${failedCount === 1 ? 'pair' : 'pairs'} reconnecting`
    : delayed ? `${delayed} ${delayed === 1 ? 'pair' : 'pairs'} delayed`
      : loadedRows.length === rows.length ? 'Market data connected' : `Loading ${loadedRows.length} / ${rows.length} pairs`

  return (
    <section className="screener" ref={scrollRef} aria-labelledby="screener-title">
      <div className="screener__content">
        <div className="screener__heading">
          <div>
            <div className="screener__eyebrow">A CLEARER VIEW OF THE MARKET</div>
            <h1 id="screener-title">Market screener</h1>
            <p>Price action and RSI divergences. Find recent setups across the market.</p>
          </div>
          <div className="screener__feed">
            <Badge status={failedCount || delayed ? 'warning' : loadedRows.length ? 'success' : 'default'} text={feedLabel} />
            <span>Binance Spot <span aria-hidden="true">·</span> USDT pairs</span>
          </div>
        </div>

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
              <Input id="pair-search" ref={searchRef} value={search} onChange={(event) => updateScreenerFilters({ search: event.target.value })} prefix={<SearchOutlined />} suffix={!search && <kbd>/</kbd>} allowClear placeholder="Search BTC, ETH, SOL…" aria-label="Search pairs" />
            </div>
            <div className="screener__filter">
              <label htmlFor="indicator-filter">Indicator</label>
              <Cascader<IndicatorOption>
                id="indicator-filter"
                aria-label="Filter by indicator"
                value={signal === 'divergence' ? [signal, divergenceRecency] : [signal]}
                options={SIGNAL_OPTIONS}
                changeOnSelect
                allowClear={false}
                displayRender={(labels) => labels[0]}
                classNames={{ popup: { root: 'screener__indicator-menu' } }}
                onChange={(value) => {
                  const nextSignal = value[0]
                  if (nextSignal !== 'all' && nextSignal !== 'divergence') return
                  const recency = value[1]
                  updateScreenerFilters({
                    signal: nextSignal,
                    divergenceRecency: recency === 1 || recency === 3 || recency === 5 || recency === 'any' ? recency : divergenceRecency,
                  })
                }}
              />
            </div>
            <div className="screener__timeframes"><span>Timeframe</span><TimeframePicker /></div>
          </div>
          {usesDivergenceRecency && (
            <p className="screener__filter-help">
              Age starts at the confirmation close. Newly forming setups await confirmation. Older active divergences remain on the charts.
            </p>
          )}
        </Card>

        <div className="screener__results-bar">
          <Segmented
            aria-label="Pair collection"
            value={starredOnly ? 'starred' : 'all'}
            onChange={(value) => updateScreenerFilters({ starredOnly: value === 'starred' })}
            options={[
              { value: 'all', label: <span className="screener__collection-label">All pairs <span>{rows.length}</span></span> },
              { value: 'starred', label: <span className="screener__collection-label"><StarOutlined /> Starred <span>{starredSymbols.length}</span></span> },
            ]}
          />
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
            <span>Showing {visibleRows.length} of {rows.length} pairs{usesDivergenceRecency ? ` · RSI divergences · ${recencyLabel.toLowerCase()}` : ''}</span>
            <Button type="link" size="small" onClick={resetScreenerFilters}>Reset filters</Button>
          </div>
        )}
        {failedCount > 0 && <Alert className="screener__notice" type="warning" showIcon title={`Market data unavailable for ${failedCount} ${failedCount === 1 ? 'pair' : 'pairs'}`} description="Retrying automatically. Available charts continue updating." />}
        {visibleRows.length ? (
          <div className={`screener__grid is-${cardDensity}`}>
            {visibleRows.map((row) => <ScreenerCard key={`${timeframe}:${row.symbol}`} row={row} timeframe={timeframe} starred={starredSymbols.includes(row.symbol)} stale={row.feed.updatedAt !== null && now - row.feed.updatedAt > DELAYED_AFTER_MS} matchingDivergences={usesDivergenceRecency ? filterDivergenceSetups(row.analysis.divergences, divergenceRecency) : undefined} />)}
          </div>
        ) : (
          <Card className="screener__empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={
              <><h2>{starredOnly && starredSymbols.length === 0 ? 'Keep your favorites close' : 'No pairs match these filters'}</h2><p>{starredOnly && starredSymbols.length === 0 ? 'Star a card to build your own focused watchlist.' : usesDivergenceRecency && divergenceRecency !== 'any' ? 'Try a wider candle window or Any age to find older active divergences.' : 'Try another pair or indicator.'}</p></>
            }><Button type="primary" onClick={resetScreenerFilters}>Show all pairs</Button></Empty>
          </Card>
        )}
        <footer className="screener__footer"><span>Divergence setups update on candle closes</span><span>Live candles are provisional <span aria-hidden="true">·</span> All times UTC</span></footer>
      </div>
    </section>
  )
}

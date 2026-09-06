import type React from 'react'
import { Button, Input, Segmented, Select, Tooltip } from 'antd'
import { AppstoreOutlined, BarsOutlined, InfoCircleOutlined, SearchOutlined } from '@ant-design/icons'
import { useShallow } from 'zustand/react/shallow'
import { hasActiveFilters } from '../lib/supportResistanceFilters'
import { useScannerStore } from '../store/scannerStore'
import type { SupportResistanceBreakFilter, SupportResistanceSort, SupportResistanceView, Timeframe } from '../types'

const METHOD_DESCRIPTION = 'Levels come from price swing highs and lows within the latest 300 closed candles. Each swing needs 3 closed candles on both sides, so confirmation takes 3 candles. Swings within 0.1% of a surviving level merge into one zone, and touches count the merged swings. The main support is at or below live price; resistance is at or above it. Price above resistance appears as a breakout awaiting confirmation; price below support appears as a breakdown awaiting confirmation. Only a close more than 0.1% beyond a zone retires it. Returning to the zone or its original side clears the pending break. A broken zone does not automatically switch roles. Trend follows the latest two highs and two lows: both rising means uptrend, both falling means downtrend, and mixed or equal swings mean sideways.'

const BREAK_OPTIONS: { value: SupportResistanceBreakFilter; label: string }[] = [
  { value: 'all', label: 'All levels' },
  { value: 'breakouts', label: 'Pending breakouts only' },
  { value: 'breakdowns', label: 'Pending breakdowns only' },
  { value: 'either', label: 'Both pending directions' },
]

const SIDE_OPTIONS = [
  { value: 'any', label: 'Either level' },
  { value: 'support', label: 'Support' },
  { value: 'resistance', label: 'Resistance' },
]

const DISTANCE_OPTIONS = [
  { value: -1, label: 'Any distance' },
  { value: 0.25, label: 'Within 0.25%' },
  { value: 0.5, label: 'Within 0.5%' },
  { value: 1, label: 'Within 1%' },
  { value: 2, label: 'Within 2%' },
  { value: 5, label: 'Within 5%' },
]

const TREND_OPTIONS = [
  { value: 'any', label: 'Any trend' },
  { value: 'uptrend', label: 'Uptrend' },
  { value: 'downtrend', label: 'Downtrend' },
  { value: 'sideways', label: 'Sideways' },
]

const TOUCH_OPTIONS = [
  { value: 1, label: 'Any touches' },
  { value: 2, label: '2+ touches' },
  { value: 3, label: '3+ touches' },
]

const SORT_OPTIONS: { value: SupportResistanceSort; label: string }[] = [
  { value: 'symbol', label: 'Sort: list order' },
  { value: 'nearest', label: 'Sort: nearest level' },
  { value: 'support', label: 'Sort: closest support' },
  { value: 'resistance', label: 'Sort: closest resistance' },
]

const VIEW_OPTIONS: { value: SupportResistanceView; label: string; icon: React.ReactNode }[] = [
  { value: 'cards', label: 'Cards', icon: <AppstoreOutlined /> },
  { value: 'list', label: 'List', icon: <BarsOutlined /> },
]

interface SupportResistanceToolbarProps {
  timeframe: Timeframe
  matchCount: number
  totalCount: number
  search: string
  onSearchChange: (search: string) => void
}

export function SupportResistanceToolbar({
  timeframe, matchCount, totalCount, search, onSearchChange,
}: SupportResistanceToolbarProps) {
  const {
    view, setView, sort, setSort, filters, updateFilters, resetFilters,
  } = useScannerStore(useShallow((state) => ({
    view: state.supportResistanceView,
    setView: state.setSupportResistanceView,
    sort: state.supportResistanceSort,
    setSort: state.setSupportResistanceSort,
    filters: state.supportResistanceFilters,
    updateFilters: state.updateSupportResistanceFilters,
    resetFilters: state.resetSupportResistanceFilters,
  })))
  const filtersActive = hasActiveFilters(filters)

  return (
    <div className="sr-toolbar">
      <div className="sr-toolbar__row">
        <div className="sr-toolbar__summary">
          <h2>
            Market levels
            <span>{matchCount === totalCount ? `${totalCount} pairs` : `${matchCount} of ${totalCount} pairs`}</span>
          </h2>
          <div className="sr-toolbar__method">
            <span>Nearest confirmed levels · {timeframe} candles</span>
            <Tooltip title={METHOD_DESCRIPTION} trigger={['hover', 'focus']}>
              <button type="button" className="sr-toolbar__info" aria-label="How support, resistance, and trend are calculated">
                <InfoCircleOutlined />
              </button>
            </Tooltip>
          </div>
        </div>
        <div className="sr-toolbar__controls">
          <Input
            className="sr-toolbar__search"
            prefix={<SearchOutlined aria-hidden="true" />}
            placeholder="Search pairs"
            aria-label="Search support and resistance pairs"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            allowClear
          />
          <Segmented<SupportResistanceView>
            aria-label="View"
            value={view}
            onChange={setView}
            options={VIEW_OPTIONS}
          />
        </div>
      </div>

      <div className="sr-toolbar__row sr-toolbar__filters" role="group" aria-label="Level filters">
        <Select
          aria-label="Level side"
          value={filters.side}
          onChange={(side) => updateFilters({ side })}
          options={SIDE_OPTIONS}
          popupMatchSelectWidth={false}
        />
        <Select
          aria-label="Maximum distance from price"
          value={filters.maxDistancePercent ?? -1}
          onChange={(value) => updateFilters({ maxDistancePercent: value < 0 ? null : value })}
          options={DISTANCE_OPTIONS}
          popupMatchSelectWidth={false}
        />
        <Select
          aria-label="Trend"
          value={filters.trend}
          onChange={(trend) => updateFilters({ trend })}
          options={TREND_OPTIONS}
          popupMatchSelectWidth={false}
        />
        <Select
          aria-label="Minimum touches"
          value={filters.minTouches}
          onChange={(minTouches) => updateFilters({ minTouches })}
          options={TOUCH_OPTIONS}
          popupMatchSelectWidth={false}
        />
        <Tooltip title="Breakouts are moves above resistance; breakdowns are moves below support. Both await a candle close more than 0.1% beyond the crossed level. Side, distance, and touch filters must match the same pending break. Sorting still uses the main support and resistance levels." trigger={['hover', 'focus']}>
          <Select<SupportResistanceBreakFilter>
            aria-label="Break direction"
            value={filters.breakFilter}
            onChange={(breakFilter) => updateFilters({ breakFilter, side: 'any' })}
            options={BREAK_OPTIONS}
            popupMatchSelectWidth={false}
          />
        </Tooltip>
        <Select<SupportResistanceSort>
          aria-label="Sort order"
          className="sr-toolbar__sort"
          value={sort}
          onChange={setSort}
          options={SORT_OPTIONS}
          popupMatchSelectWidth={false}
        />
        {filtersActive && (
          <Button type="link" size="small" onClick={resetFilters} className="sr-toolbar__reset">
            Reset filters
          </Button>
        )}
      </div>
    </div>
  )
}

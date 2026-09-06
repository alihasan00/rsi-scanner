import { Fragment } from 'react'
import { describeLevelDistance, formatQuotePrice } from '../lib/priceFormatting'
import type { SupportResistanceLevel } from '../lib/supportResistance'
import type { SupportResistanceRow } from '../lib/supportResistanceFilters'
import { useScannerStore } from '../store/scannerStore'
import type { SupportResistanceSort } from '../types'
import { SupportResistanceBreakouts, SupportResistanceBreakoutTitle } from './SupportResistanceBreakouts'
import './SupportResistanceTable.css'

const TREND_LABELS = {
  uptrend: 'Uptrend',
  downtrend: 'Downtrend',
  sideways: 'Sideways',
  unknown: 'Unknown',
} as const

interface LevelCellsProps {
  kind: 'support' | 'resistance'
  level: SupportResistanceLevel | null
  price: number
}

function LevelCells({ kind, level, price }: LevelCellsProps) {
  if (!level) {
    return (
      <>
        <td className="sr-table__muted">—</td>
        <td className="sr-table__muted">No confirmed level</td>
      </>
    )
  }
  return (
    <>
      <td className={`sr-table__price sr-table__price--${kind}`} title={`${level.price} USDT`}>
        {formatQuotePrice(level.price)}
      </td>
      <td className="sr-table__detail">
        <span>{describeLevelDistance(level.price, price)}</span>
        <span className="sr-table__muted">
          {level.touches} {level.touches === 1 ? 'touch' : 'touches'}
        </span>
      </td>
    </>
  )
}

interface SortHeaderProps {
  label: string
  sortKey: SupportResistanceSort
  activeSort: SupportResistanceSort
  onSort: (sort: SupportResistanceSort) => void
  colSpan?: number
}

function SortHeader({ label, sortKey, activeSort, onSort, colSpan }: SortHeaderProps) {
  const active = activeSort === sortKey
  return (
    <th scope="col" colSpan={colSpan} aria-sort={active ? 'ascending' : 'none'}>
      <button
        type="button"
        className={`sr-table__sort${active ? ' sr-table__sort--active' : ''}`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <span aria-hidden="true">{active ? ' ↑' : ''}</span>
      </button>
    </th>
  )
}

interface SupportResistanceTableProps {
  rows: readonly SupportResistanceRow[]
}

export function SupportResistanceTable({ rows }: SupportResistanceTableProps) {
  const sort = useScannerStore((state) => state.supportResistanceSort)
  const setSort = useScannerStore((state) => state.setSupportResistanceSort)

  return (
    <div className="sr-table__wrap">
      <table className="sr-table">
        <thead>
          <tr>
            <SortHeader label="Pair" sortKey="symbol" activeSort={sort} onSort={setSort} />
            <th scope="col">Price</th>
            <th scope="col">Trend</th>
            <SortHeader label="Support" sortKey="support" activeSort={sort} onSort={setSort} colSpan={2} />
            <SortHeader label="Resistance" sortKey="resistance" activeSort={sort} onSort={setSort} colSpan={2} />
            <th scope="col" className="sr-table__breakouts"><SupportResistanceBreakoutTitle /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ symbol, snapshot }) => {
            const ready = snapshot.hasData && snapshot.price > 0
            return (
              <tr key={symbol}>
                <th scope="row" className="sr-table__symbol">
                  {symbol.replace(/USDT$/, '')}<span>/USDT</span>
                </th>
                {ready ? (
                  <Fragment>
                    <td className="sr-table__price" title={`${snapshot.price} USDT`}>{formatQuotePrice(snapshot.price)}</td>
                    <td className={`sr-table__trend sr-table__trend--${snapshot.trend}`}>{TREND_LABELS[snapshot.trend]}</td>
                    <LevelCells kind="support" level={snapshot.support} price={snapshot.price} />
                    <LevelCells kind="resistance" level={snapshot.resistance} price={snapshot.price} />
                    <td className="sr-table__breakouts">
                      {snapshot.pendingBreakouts.length > 0 ? (
                        <SupportResistanceBreakouts pendingBreakouts={snapshot.pendingBreakouts} currentPrice={snapshot.price} compact />
                      ) : <span className="sr-table__muted">—</span>}
                    </td>
                  </Fragment>
                ) : (
                  <td colSpan={7} className="sr-table__muted">Loading…</td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

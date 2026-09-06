import { useMemo, useState } from 'react'
import { Button } from 'antd'
import { useSupportResistanceRows } from '../hooks/useSupportResistanceRows'
import { hasActiveFilters, matchesFilters, sortRows } from '../lib/supportResistanceFilters'
import { SYMBOLS } from '../lib/symbols'
import { useScannerStore } from '../store/scannerStore'
import { SupportResistanceCard } from './SupportResistanceCard'
import { SupportResistanceTable } from './SupportResistanceTable'
import { SupportResistanceToolbar } from './SupportResistanceToolbar'
import './SupportResistanceGrid.css'

export function SupportResistanceGrid() {
  const timeframe = useScannerStore((state) => state.timeframe)
  const view = useScannerStore((state) => state.supportResistanceView)
  const sort = useScannerStore((state) => state.supportResistanceSort)
  const filters = useScannerStore((state) => state.supportResistanceFilters)
  const resetFilters = useScannerStore((state) => state.resetSupportResistanceFilters)
  const [search, setSearch] = useState('')

  const searchedSymbols = useMemo(() => {
    const query = search.trim().replace(/[\s/-]/g, '').toUpperCase()
    return SYMBOLS.filter((symbol) => symbol.includes(query))
  }, [search])

  // Cards in list order with no filters need no market-wide updates; each
  // card already follows its own symbol.
  const filtersActive = hasActiveFilters(filters)
  const needsLiveRows = view === 'list' || filtersActive || sort !== 'symbol'
  const rows = useSupportResistanceRows(searchedSymbols, needsLiveRows)
  const visibleRows = useMemo(
    () => sortRows(rows.filter((row) => matchesFilters(row.snapshot, filters)), sort),
    [rows, filters, sort],
  )

  return (
    <section className="sr-scanner" aria-label="Support and resistance scanner">
      <SupportResistanceToolbar
        timeframe={timeframe}
        matchCount={visibleRows.length}
        totalCount={SYMBOLS.length}
        search={search}
        onSearchChange={setSearch}
      />

      {visibleRows.length === 0 ? (
        <div className="sr-scanner__empty" role="status">
          <strong>No matching pairs</strong>
          {filtersActive ? (
            <>
              <span>No pair meets the current level filters right now.</span>
              <Button size="small" onClick={resetFilters}>Reset filters</Button>
            </>
          ) : (
            <span>Try a symbol such as BTC or ETH.</span>
          )}
        </div>
      ) : view === 'list' ? (
        <SupportResistanceTable rows={visibleRows} />
      ) : (
        <div className="sr-scanner__grid">
          {visibleRows.map(({ symbol }) => (
            <SupportResistanceCard key={symbol} symbol={symbol} timeframe={timeframe} />
          ))}
        </div>
      )}
    </section>
  )
}

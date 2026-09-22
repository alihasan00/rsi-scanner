import { useMemo, useState } from 'react'
import type { RsiBar, Timeframe } from '../types'
import { createMarketStructureTracker } from '../lib/marketStructure'
import { getNormalizedDistance } from '../lib/volatility'
import './MarketStructurePanel.css'

function priceText(price: number): string {
  return price.toLocaleString(undefined, { maximumSignificantDigits: 7 })
}

function ageText(age: number): string {
  return age === 0 ? 'latest close' : `${age} candles ago`
}

export function MarketStructurePanel({ bars, price, timeframe, identity = '' }: { bars: readonly RsiBar[]; price: number; timeframe: Timeframe; identity?: string }) {
  const scoped = useMemo(() => ({ identity, timeframe, tracker: createMarketStructureTracker() }), [identity, timeframe])
  const analysis = useMemo(() => scoped.tracker.update(bars), [scoped, bars])
  const [filter, setFilter] = useState<'active' | 'swept' | 'all'>('active')
  const levels = analysis.levels.filter((level) => level.supersededBy === null && (filter === 'all' || level.status === filter))
    .sort((first, second) => Math.abs(first.price - price) - Math.abs(second.price - price)).slice(0, 6)
  const recentEvents = analysis.events.filter((event) => event.ageBars <= 30).slice(-3).reverse()
  const liveRetests = analysis.retests.filter((retest) => retest.state === 'awaiting-retest' || retest.state === 'retested' || retest.ageBars <= 12).slice(-3).reverse()
  return <section className="market-structure" aria-label="Price structure and volatility">
    <div className="market-structure__header">
      <strong>Price structure · {timeframe}</strong>
      <span className={`market-structure__trend is-${analysis.trend}`}>{analysis.trend === 'neutral' ? 'No confirmed direction' : `${analysis.trend} structure`}</span>
    </div>
    <div className="market-structure__metrics">
      <span title="Wilder average true range from completed candles. Missing intervals restart the calculation.">ATR (14): <b>{analysis.atr === null ? 'warming up' : priceText(analysis.atr)}</b></span>
      <span title="Latest completed candle's volume divided by the preceding 20-candle average.">Relative volume: <b>{analysis.relativeVolume === null ? 'unavailable' : `${analysis.relativeVolume.toFixed(2)}×`}</b></span>
      <span>Closed candles only</span>
    </div>
    <div className="market-structure__filters" role="group" aria-label="Structure level visibility">
      {(['active', 'swept', 'all'] as const).map((value) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'active' ? 'Untouched levels' : value === 'swept' ? 'Swept levels' : 'All levels'}</button>)}
    </div>
    {levels.length === 0 ? <p className="market-structure__empty">No {filter === 'active' ? 'untouched' : filter === 'swept' ? 'swept' : 'confirmed'} levels in the available history.</p>
      : <div className="market-structure__table" role="table" aria-label="Nearest confirmed swing levels">
        <div className="market-structure__row is-heading" role="row"><span role="columnheader">Nearest levels</span><span role="columnheader">Distance</span><span role="columnheader">State</span></div>
        {levels.map((level) => {
          const distance = getNormalizedDistance(price, level.price, analysis.atr)
          const quality = level.sweepQuality
          const reclaim = level.reclaimQuality ?? quality
          const measured = quality ? `Penetration ${quality.penetrationAtr?.toFixed(2) ?? '—'} ATR · close back ${reclaim?.closeBackAtr?.toFixed(2) ?? '—'} ATR · wick ${quality.wickFraction === null ? '—' : `${(quality.wickFraction * 100).toFixed(0)}%`} · volume ${quality.relativeVolume?.toFixed(2) ?? '—'}×` : ''
          return <div className="market-structure__row" role="row" key={level.id} title={`Confirmed ${new Date(level.confirmedAt).toISOString()}; last touch confirmed ${ageText(level.ageBars)}.${measured}`}>
            <span role="cell">{level.kind === 'equal' ? `Equal ${level.side === 'high' ? 'highs' : 'lows'} (${level.pivotTimes.length})` : `Swing ${level.side}`} <b>{priceText(level.price)}</b></span>
            <span role="cell">{Number.isFinite(distance.percent) ? `${distance.percent.toFixed(2)}%` : '—'} · {distance.atr === null ? 'ATR —' : `${distance.atr.toFixed(2)} ATR`}</span>
            <span role="cell">{level.status === 'expired' ? 'Expired' : level.reclaimedAt !== null ? 'Swept + reclaimed' : level.brokenAt !== null ? 'Closed break' : level.status === 'swept' ? 'Breach only' : 'Untouched'}</span>
            {quality && <span className="market-structure__quality" role="cell">{measured}</span>}
          </div>
        })}
      </div>}
    {(recentEvents.length > 0 || liveRetests.length > 0) && <div className="market-structure__events">
      {recentEvents.map((event) => <span key={event.id} className={`market-structure__event is-${event.direction}`} title={event.type === 'choch' ? 'Change of character: a closed break opposite the previous structure direction.' : 'Break of structure: a closed break in the current or initial structure direction.'}>{event.direction} {event.type === 'bos' ? 'BOS' : 'CHoCH'} · {ageText(event.ageBars)}</span>)}
      {liveRetests.map((retest) => <span key={retest.id} className="market-structure__retest" title={`Break at ${priceText(retest.levelPrice)}. Retest band ${priceText(retest.band.low)}–${priceText(retest.band.high)}. A wick beyond ${priceText(retest.invalidationPrice)} invalidates. Retest timeout: 12 candles; continuation timeout: 8 candles after the retest.`}>{retest.direction} · {retest.state === 'awaiting-retest' ? 'waiting for retest' : retest.state === 'retested' ? 'retest held; awaiting continuation' : retest.state === 'confirmed' ? 'continuation confirmed' : `retest ${retest.state}`}</span>)}
    </div>}
    {analysis.historyReset && <p className="market-structure__note">{analysis.historyResetReason === 'history-limit'
      ? `Session history limit reached; structure and ATR were recalculated from the newest ${analysis.closedBarCount.toLocaleString()} completed candles.`
      : 'History was interrupted; structure restarted from the available completed candles.'}</p>}
    <p className="market-structure__note">Swings wait for 3 later closes. Equal levels group within 0.10 ATR; price-percent fallback is 0.05% during warmup. A breach alone is not a reclaim. Distances use the latest price and completed ATR.</p>
  </section>
}

import { useMemo, useState } from 'react'
import { Alert, Button, Segmented } from 'antd'
import type { RsiBar, Timeframe } from '../types'
import { useSrContext } from '../hooks/useSrContext'
import { advanceLiquidityMap, analyzeLiquidity, visibleLiquidityLevels } from '../lib/liquidityLevels'
import { LIQUIDITY_SOURCE_LABELS, levelDistancePercent, nearbyLiquidityLevels } from '../lib/liquidityScreener'
import { formatQuotePrice } from '../lib/priceFormatting'
import { LiquidityChart } from './LiquidityChart'
import { LiquidityGuide } from './LiquidityGuide'
import './Liquidity.css'

const date = (time: number) => new Date(time).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
const timestamp = (time: number) => new Date(time).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export function LiquidityDetails({ symbol, bars, price, timeframe }: { symbol: string; bars: readonly RsiBar[]; price: number; timeframe: Timeframe }) {
  const history = useSrContext(symbol)
  const [chartMode, setChartMode] = useState<'nearby' | 'all'>('nearby')
  const [showGuide, setShowGuide] = useState(false)
  const map = useMemo(() => history.map ? advanceLiquidityMap(history.map, bars, timeframe) : null, [history.map, bars, timeframe])
  const levels = useMemo(() => map ? visibleLiquidityLevels(map, timeframe) : [], [map, timeframe])
  const context = useMemo(() => map ? analyzeLiquidity(map, bars, price, timeframe) : null, [map, bars, price, timeframe])
  const chartLevels = context ? nearbyLiquidityLevels(context) : []
  const sortedLevels = [...levels].sort((a, b) => b.price - a.price)
  const events = context?.events ?? []

  return <div className="liquidity-details">
    <div className="liquidity-details__heading"><p>Calendar liquidity <span>·</span> {timeframe} reactions <span>·</span> UTC</p><Segmented<'nearby' | 'all'> aria-label="Liquidity chart levels" value={chartMode} onChange={setChartMode} options={[{ value: 'nearby', label: 'Nearby levels' }, { value: 'all', label: 'All levels' }]} /></div>
    {history.status === 'loading' && <p role="status" className="liquidity-timeframe-note">Loading completed daily candles for this pair…</p>}
    {history.status === 'error' && <Alert type="warning" showIcon title="Daily history interrupted" description={history.error ?? 'Retrying automatically.'} />}
    <LiquidityChart bars={bars} levels={chartMode === 'all' ? levels : chartLevels} price={price} />
    <p className="liquidity-details__caption">Below price: potential support. Above price: potential resistance. Live crossings change the role; a candle close confirms a sweep.</p>

    <div className="liquidity-details__section-heading"><h3>Recent reactions</h3><span>Latest 3 closed candles + forming candle</span></div>
    {events.length ? <div className="liquidity-events">{events.map((event) => <div className={`liquidity-event is-${event.state === 'forming' ? 'forming' : event.direction}`} key={`${event.level.id}:${event.openTime}:${event.direction}`}>
      <span><strong>{event.direction === 'bullish' ? 'Bullish' : 'Bearish'} sweep{event.state === 'forming' ? ' forming' : ''}</strong><small>{event.level.label} · {formatQuotePrice(event.level.price)}</small></span>
      <span><strong>{event.state === 'confirmed' ? 'Closed back inside' : 'Awaiting candle close'}</strong><small>{timestamp(event.openTime)} UTC · {event.state === 'forming' ? 'provisional' : event.barsAgo === 0 ? 'latest close' : `${event.barsAgo} ${event.barsAgo === 1 ? 'close' : 'closes'} ago`}</small></span>
    </div>)}</div> : <p className="liquidity-details__empty">No sweep in the latest 3 closed candles. A touch alone does not qualify.</p>}

    <div className="liquidity-details__section-heading"><h3>Calendar levels</h3><span>USDT · completed periods only</span></div>
    <div className="liquidity-table-wrap"><table className="liquidity-table"><caption className="liquidity-sr-only">{symbol} calendar levels, their source periods, current roles and distance from price</caption><thead><tr><th>Level / period</th><th>Price</th><th>Current role</th><th>Distance</th></tr></thead><tbody>
      {sortedLevels.map((level) => <tr key={level.id}>
        <td><strong>{level.label}</strong><small>{LIQUIDITY_SOURCE_LABELS[level.source]} · {date(level.periodStart)}{level.source !== 'monday' ? ` – ${date(level.periodEnd - 1)}` : ''}</small></td>
        <td className="liquidity-table__number">{formatQuotePrice(level.price)}</td>
        <td className={price <= 0 ? '' : level.price < price ? 'is-support' : level.price > price ? 'is-resistance' : 'is-at-price'}>{price <= 0 ? 'Waiting for price' : level.price < price ? 'Support below' : level.price > price ? 'Resistance above' : 'At price'}</td>
        <td className="liquidity-table__number">{price > 0 ? `${levelDistancePercent(level, price).toFixed(2)}%` : '—'}</td>
      </tr>)}
      {!sortedLevels.length && <tr><td colSpan={4}>{history.status === 'loading' ? 'Waiting for daily history…' : 'No complete calendar periods available for this timeframe.'}</td></tr>}
    </tbody></table></div>
    {history.map && history.map.warnings.length > 0 && <div className="liquidity-details__warnings">{history.map.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
    <p className="liquidity-details__caption">Monday is the daily candle body, with a midpoint; it appears on intraday charts only. Week and month include open, high, low and close.</p>
    <Button type="link" className="liquidity-details__guide-toggle" onClick={() => setShowGuide(!showGuide)} aria-expanded={showGuide}>{showGuide ? 'Hide reading guide' : 'How this relates to the lecture'}</Button>
    {showGuide && <LiquidityGuide />}
    <p className="liquidity-details__scope">Fib + volume profile, VSA confluence and 4h boxes require manual review. Calendar liquidity alone is not a trade plan.</p>
  </div>
}

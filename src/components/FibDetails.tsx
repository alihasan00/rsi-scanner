import { Tag } from 'antd'
import { getFibLiveContext, isActiveFibSetup } from '../lib/fibonacci'
import type { FibAnalysis } from '../lib/fibonacci'
import { FIB_STATUS_LABELS } from '../lib/fibScreener'
import { formatQuotePrice } from '../lib/priceFormatting'
import { FibSettingsPanel } from './FibSettingsPanel'
import './Fibonacci.css'

function utc(time: number): string {
  return new Date(time).toLocaleString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function FibDetails({ analysis, price, live, market }: { analysis: FibAnalysis; price: number; live: boolean; market: 'spot' | 'tradfi' }) {
  const setup = analysis.setup
  const context = getFibLiveContext(setup, price)
  if (!setup) return <div className="fib-details">
    <div className="fib-details__empty"><strong>{analysis.pendingDirection ? 'Waiting for a mature retracement' : 'Waiting for a fresh structure break'}</strong><p>A Fib setup needs significant swings, a close beyond structure, and three closed candles to confirm the ending swing. {analysis.closedBars} closed candles available.</p></div>
    <FibSettingsPanel />
  </div>
  const active = isActiveFibSetup(setup)
  const average = setup.actualAverage ?? setup.plannedAverage
  const risk = Math.abs(average - setup.initialStop)
  const sign = setup.direction === 'long' ? 1 : -1
  const entryLabels = { pending: 'Pending', filled: 'Reached', missed: 'Before confirmation', cancelled: 'Cancelled' }
  const stopAfter = [average, setup.targets[0].price, setup.targets[1].price, setup.targets[2].price, setup.targets[3].price]
  return <div className="fib-details">
    <div className="fib-details__heading">
      <div><Tag color={setup.direction === 'long' ? 'green' : 'red'}>{setup.direction === 'long' ? 'Long' : 'Short'} setup</Tag><Tag>{FIB_STATUS_LABELS[setup.status]}</Tag>{context?.inGoldenPocket && active && <Tag color="gold">In golden pocket{live ? ' · live' : ''}</Tag>}</div>
      <span>{analysis.sma200 === null ? 'SMA 200 · needs more history' : `SMA 200 · ${analysis.smaConfluence === 'aligned' ? 'aligned' : analysis.smaConfluence === 'against' ? 'opposing' : 'neutral'}`}</span>
    </div>
    {!active && <p className="fib-help">This setup has ended. Its levels remain for reference; a used pocket is not a fresh entry.</p>}
    <div className="fib-details__metrics">
      <div><span>Golden pocket</span><strong>{formatQuotePrice(setup.goldenPocket.low)} – {formatQuotePrice(setup.goldenPocket.high)}</strong><small>0.618–0.666</small></div>
      <div><span>{setup.actualAverage === null ? 'Planned average · all entries' : 'Model average · reached entries'}</span><strong>{formatQuotePrice(average)}</strong><small>20 / 30 / 50 quote allocation</small></div>
      <div><span>{active ? 'Current model stop' : 'Final model stop'}</span><strong className="fib-negative">{formatQuotePrice(setup.currentStop)}</strong><small>Initial {formatQuotePrice(setup.initialStop)} · {setup.stopRatio}</small></div>
      <div><span>Model position remaining</span><strong>{setup.actualAverage === null ? 'Not entered' : `${setup.remainingPercent}%`}</strong><small>Of the entered position</small></div>
    </div>
    <div className="fib-details__tables">
      <div className="fib-table-wrap"><table className="fib-table"><caption>Scaled entries</caption><thead><tr><th>Entry</th><th>Price · USDT</th><th>Budget</th><th>State</th></tr></thead><tbody>
        {setup.entries.map((entry, index) => <tr key={entry.ratio}><td>E{index + 1}<small>{entry.ratio}</small></td><td>{formatQuotePrice(entry.price)}</td><td>{entry.weight}%</td><td>{entryLabels[entry.status]}{entry.filledAt !== null && <small>{utc(entry.filledAt)} UTC</small>}</td></tr>)}
      </tbody></table></div>
      <div className="fib-table-wrap"><table className="fib-table"><caption>Targets & stop progression</caption><thead><tr><th>Target</th><th>Price · USDT</th><th>Exit</th><th>R*</th><th>Move stop to</th></tr></thead><tbody>
        {setup.targets.map((target, index) => <tr key={target.id} className={target.hitAt !== null ? 'fib-table__reached' : ''}><td>{target.id === 'runner' ? 'Runner' : target.id.toUpperCase()}<small>{target.ratio}{target.hitAt !== null ? ' · reached' : ''}</small></td><td>{formatQuotePrice(target.price)}</td><td>{target.id === 'runner' ? 'Keep 10%' : `${target.exitPercent}%`}</td><td>{risk > 0 ? `${(sign * (target.price - average) / risk).toFixed(2)}R` : '—'}</td><td>{formatQuotePrice(stopAfter[index])}<small>{index === 0 ? 'Average entry' : `TP${index}`}</small></td></tr>)}
      </tbody></table></div>
    </div>
    <p className="fib-help">*R uses the {setup.actualAverage === null ? 'planned all-entry' : 'reached-entry'} average and initial stop. Touches are modeled from closed candle ranges, with conservative ordering when the path is unknown. Fees and slippage are excluded. Pending entries cancel after TP1. No orders are placed.{market === 'spot' && setup.direction === 'short' ? ' A short setup describes bearish structure; this market feed is Spot.' : ''}</p>
    <div className="fib-details__anchors"><span>Origin {formatQuotePrice(setup.start.price)} · {utc(setup.start.time)} UTC</span><span>Extreme {formatQuotePrice(setup.end.price)} · {utc(setup.end.time)} UTC</span><span>Confirmed {utc(setup.detectedAt)} UTC</span></div>
    <details className="fib-reference"><summary>Reference grid & recent setup events</summary>
      <p className="fib-help">The full enabled screenshot grid, plus the selected stop and targets. Levels beyond the price range are reference levels, not extra orders.</p>
      <div className="fib-reference__grid">{setup.levels.map((level) => <div key={level.ratio}><span>{level.ratio}</span><strong>{formatQuotePrice(level.price)}</strong></div>)}{setup.unavailableReferenceRatios.map((ratio) => <div key={ratio}><span>{ratio}</span><strong>Unavailable</strong></div>)}</div>
      {setup.unavailableReferenceRatios.length > 0 && <p className="fib-help">{setup.unavailableReferenceRatios.join(', ')} {setup.unavailableReferenceRatios.length === 1 ? 'does' : 'do'} not produce a finite positive price with these anchors and scale.</p>}
      <ol className="fib-events">{setup.events.slice(-8).map((event, index) => <li key={`${event.time}:${index}`}><time>{utc(event.time)} UTC</time><span>{event.detail}</span></li>)}</ol>
    </details>
    <FibSettingsPanel />
  </div>
}

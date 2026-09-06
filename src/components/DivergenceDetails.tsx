import { DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS, isLiveDivergence } from '../lib/divergenceLifecycle'
import type { DivergenceLifecycleOptions, DivergenceSetup } from '../lib/divergenceLifecycle'
import {
  DIVERGENCE_LABELS,
  divergenceResolution,
  divergenceStatus,
  formatSignalPrice,
  formatSignalTime,
} from '../lib/divergencePresentation'
import type { RsiBar } from '../types'

interface DivergenceDetailsProps {
  signals: readonly DivergenceSetup[]
  bars: readonly RsiBar[]
  includeHidden: boolean
  requireBodyAgreement: boolean
  requireSameRsiCycle: boolean
  invalidationAnchor: DivergenceLifecycleOptions['invalidationAnchor']
}

function SignalTime({ time }: { time: number | null }) {
  return time === null ? <span>—</span> : (
    <time dateTime={new Date(time).toISOString()}>{formatSignalTime(time)}</time>
  )
}

export function DivergenceDetails({
  signals, bars, includeHidden, requireBodyAgreement, requireSameRsiCycle, invalidationAnchor,
}: DivergenceDetailsProps) {
  const { leftBars, rightBars, provisionalBars, minBars, maxBars, expiryBars } = DEFAULT_DIVERGENCE_LIFECYCLE_OPTIONS
  const liveCount = signals.filter(isLiveDivergence).length
  const closedCount = bars.filter((bar) => bar.isClosed).length
  const barIndexes = new Map(bars.map((bar, index) => [bar.openTime, index]))
  const filters = [
    requireBodyAgreement && 'Wick and body agreement',
    requireSameRsiCycle && 'One RSI 50 cycle',
  ].filter(Boolean)
  return (
    <section className="divergence-details" aria-label="Divergence setups and outcomes">
      <div className="divergence-details__heading">
        <strong>Setups and outcomes</strong>
        <span className="divergence-details__counts">{liveCount} live · {signals.length - liveCount} resolved</span>
      </div>
      <p className="divergence-details__note">
        Retained-candle log: {closedCount.toLocaleString()} closed candles. Reloading or changing
        filters rebuilds this log. Pivot times are candle opens; detected, confirmed, and
        resolved times are candle closes. All times are UTC.
      </p>
      <details className="divergence-details__rules">
        <summary>Detection and confirmation rules</summary>
        <p className="divergence-details__note">
          First pivot: {leftBars} candles left / {rightBars} right, fully confirmed. Second pivot:
          the strict RSI low or high of the last {provisionalBars} closed candles, including itself,
          detected at its own close. Pivots are {minBars}–{maxBars} candles apart.
        </p>
        <p className="divergence-details__note">
          Only the next candle can confirm: green for bullish, red for bearish. A close beyond
          the second pivot candle’s open is strong confirmation. Wrong colour or a doji ends
          the setup as unconfirmed. A strict RSI breach of the {invalidationAnchor} pivot ends
          regular setups as harmonised; an equal RSI does not invalidate.
        </p>
        <p className="divergence-details__note">
          Confirmation starts at 0/{expiryBars}. The following {expiryBars} closed candles count
          toward expiry; touching or crossing RSI 50 completes the setup, including on the last
          allowed candle. A target reached at confirmation is logged separately in the backtest.
          Missing or invalid candle data interrupts a live setup.
        </p>
        {includeHidden && (
          <p className="divergence-details__note">
            Hidden patterns are an optional extension and always use their second pivot as
            the RSI invalidation anchor.
          </p>
        )}
      </details>
      <p className="divergence-details__note">
        <strong>Lecture filters:</strong> {filters.length ? filters.join(' · ') : 'Off'}
        {' · '}Regular invalidation: {invalidationAnchor} pivot
      </p>
      {signals.length === 0 ? (
        <p className="divergence-details__empty">No divergence setups match the current filters in retained history.</p>
      ) : (
        <div className="divergence-details__scroll" tabIndex={0} role="region" aria-label="Retained divergence setup log">
          <table className="divergence-details__table">
            <thead>
              <tr>
                <th scope="col">Setup</th>
                <th scope="col">State / outcome</th>
                <th scope="col">Price at pivots</th>
                <th scope="col">RSI at pivots</th>
                <th scope="col">Pivot candles (UTC)</th>
                <th scope="col">Detected (UTC)</th>
                <th scope="col">Confirmed (UTC)</th>
                <th scope="col">Resolved (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {[...signals].reverse().map((signal) => {
                const bullish = signal.kind.endsWith('bullish')
                const priceChange = (signal.end.price / signal.start.price - 1) * 100
                const rsiChange = signal.end.rsi - signal.start.rsi
                const firstIndex = barIndexes.get(signal.start.time)
                const secondIndex = barIndexes.get(signal.end.time)
                const between = firstIndex !== undefined && secondIndex !== undefined
                  ? bars.slice(firstIndex, secondIndex + 1) : []
                const first = between[0]
                const second = between.at(-1)
                const bodyEdge = bullish ? Math.min : Math.max
                return (
                  <tr key={signal.id}>
                    <th scope="row">
                      <span className={bullish ? 'is-bullish' : 'is-bearish'}>
                        {DIVERGENCE_LABELS[signal.kind]}
                      </span>
                      {signal.kind.startsWith('hidden') && <small>Optional extension</small>}
                    </th>
                    <td className="divergence-details__outcome">
                      <span className={`divergence-details__state is-${signal.state}`}>{divergenceStatus(signal)}</span>
                      <small>{divergenceResolution(signal)}</small>
                      <small>Invalidates {bullish ? 'below' : 'above'} RSI {signal.invalidationRsi.toFixed(2)} ({signal.invalidationAnchor} pivot)</small>
                    </td>
                    <td>
                      {formatSignalPrice(signal.start.price)} → {formatSignalPrice(signal.end.price)}
                      <small>Wick {bullish ? 'lows' : 'highs'} · {priceChange > 0 ? '+' : ''}{priceChange.toFixed(2)}%</small>
                      {first && second && (
                        <small>
                          Body {bullish ? 'lows' : 'highs'}: {formatSignalPrice(bodyEdge(first.open, first.close))}
                          {' → '}{formatSignalPrice(bodyEdge(second.open, second.close))}
                        </small>
                      )}
                    </td>
                    <td>
                      {signal.start.rsi.toFixed(2)} → {signal.end.rsi.toFixed(2)}
                      <small>{rsiChange > 0 ? '+' : ''}{rsiChange.toFixed(2)} points</small>
                      {between.length > 0 && (
                        <small>
                          Between pivots: {Math.min(...between.map((bar) => bar.rsi)).toFixed(2)}
                          {'–'}{Math.max(...between.map((bar) => bar.rsi)).toFixed(2)}
                        </small>
                      )}
                    </td>
                    <td>
                      <SignalTime time={signal.start.time} />
                      <small>→ <SignalTime time={signal.end.time} /></small>
                    </td>
                    <td><SignalTime time={signal.detectedAt} /></td>
                    <td>
                      <SignalTime time={signal.confirmedAt} />
                      {signal.confirmation && <small>{signal.confirmation === 'strong' ? 'Strong' : 'Ordinary'} confirmation</small>}
                    </td>
                    <td><SignalTime time={signal.resolvedAt} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

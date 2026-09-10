import { memo } from 'react'
import { ArrowRightOutlined, StarFilled, StarOutlined, WarningOutlined } from '@ant-design/icons'
import { Button, Card, Tooltip } from 'antd'
import { useNearViewport } from '../hooks/useNearViewport'
import type { DivergenceSetup } from '../lib/divergenceLifecycle'
import { DIVERGENCE_LABELS, formatSignalTime } from '../lib/divergencePresentation'
import type { ScreenerRow } from '../lib/screener'
import { getRsiState, RSI_STATE_LABELS } from '../lib/rsiState'
import { useScannerStore } from '../store/scannerStore'
import type { Timeframe } from '../types'
import { ScreenerChart } from './ScreenerChart'
import { FibChart } from './FibChart'
import { formatQuotePrice } from '../lib/priceFormatting'
import './ScreenerCard.css'

interface Props {
  row: ScreenerRow; timeframe: Timeframe; starred: boolean; stale: boolean
  matchingDivergences?: readonly DivergenceSetup[]
  showFib?: boolean
}

function ScreenerCardImpl({ row, timeframe, starred, stale, matchingDivergences, showFib = false }: Props) {
  const { symbol, snapshot, analysis, feed } = row
  const { ref, isNearViewport } = useNearViewport<HTMLElement>()
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const toggleStarredSymbol = useScannerStore((state) => state.toggleStarredSymbol)
  const base = symbol.replace(/USDT$/, '')
  const latestBar = snapshot.bars.at(-1)
  const fib = row.fib?.setup ?? null
  const fibTrend = fib ? fib.direction === 'long' ? 'Uptrend' : 'Downtrend' : null
  const rsiState = getRsiState(latestBar?.rsi)
  const rsiDescription = latestBar && rsiState
    ? `RSI ${latestBar.rsi.toFixed(1)}, ${RSI_STATE_LABELS[rsiState].toLowerCase()}${latestBar.isClosed ? '' : ', provisional live candle'}.`
    : 'RSI unavailable.'
  const fibDescription = `${fibTrend ? `${fibTrend}. ` : ''}Raw price candles${latestBar?.isClosed === false ? '; the hollow latest candle is provisional' : ''}.`
  const feedError = feed.state === 'error'
  const feedWarning = feedError ? 'Data unavailable · retrying' : stale ? 'Updates delayed' : null
  const latestDivergence = matchingDivergences?.reduce<DivergenceSetup | undefined>((latest, setup) => (
    !latest || (setup.confirmedAt ?? setup.detectedAt) >= (latest.confirmedAt ?? latest.detectedAt) ? setup : latest
  ), undefined)
  const divergenceAge = !latestDivergence ? null : latestDivergence.state === 'forming' ? 'Awaiting confirmation'
    : latestDivergence.barsElapsed === 0 ? 'Confirmed · latest close'
      : `Confirmed · ${latestDivergence.barsElapsed} ${latestDivergence.barsElapsed === 1 ? 'candle' : 'candles'} ago`

  return (
    <article ref={ref} className="screener-card-shell" aria-label={`${base} market card`}>
      <Card className="screener-card" styles={{ body: { padding: 0 } }}>
        <div className="screener-card__chart-heading">
          <h2 className="screener-card__symbol" title={`${base} / USDT`}>{base}<span>/ USDT</span></h2>
          {showFib && <span className="fib-card-price" title={latestBar?.isClosed ? 'Latest closed price · USDT' : 'Live price · USDT'}>{formatQuotePrice(snapshot.price)}</span>}
          {feedWarning && (
            <Tooltip title={feedError ? feed.error ?? feedWarning : feedWarning}>
              <span className="screener-card__warning" role="img" aria-label={feedWarning} tabIndex={0}>
                <WarningOutlined aria-hidden="true" />
              </span>
            </Tooltip>
          )}
          <Tooltip title={starred ? `Remove ${base} from favorites` : `Add ${base} to favorites`}>
            <Button
              type="text"
              shape="circle"
              className="screener-card__star"
              icon={starred ? <StarFilled /> : <StarOutlined />}
              aria-label={`${starred ? 'Unstar' : 'Star'} ${base}`}
              aria-pressed={starred}
              onClick={() => toggleStarredSymbol(symbol)}
            />
          </Tooltip>
        </div>
        {!showFib && latestDivergence && (
          <div className="screener-card__divergence" aria-label="Matching RSI divergence">
            <span className={latestDivergence.kind.endsWith('bullish') ? 'is-bullish' : 'is-bearish'}>
              {DIVERGENCE_LABELS[latestDivergence.kind]}
            </span>
            <Tooltip title={`${latestDivergence.state === 'forming' ? 'Detected' : 'Confirmed'} ${formatSignalTime(latestDivergence.confirmedAt ?? latestDivergence.detectedAt)} UTC${matchingDivergences && matchingDivergences.length > 1 ? ` · ${matchingDivergences.length} matching setups; showing the latest` : ''}`} trigger={['hover', 'focus']}>
              <span className="screener-card__divergence-age" tabIndex={0}>{divergenceAge}</span>
            </Tooltip>
          </div>
        )}
        {showFib && fibTrend && <div className={`fib-card-trend ${fib?.direction === 'long' ? 'is-uptrend' : 'is-downtrend'}`}>{fibTrend}</div>}
        <button type="button" className="screener-card__chart-button" aria-label={`Open ${base} ${showFib ? 'Fib details' : 'chart'}. ${showFib ? fibDescription : rsiDescription}`} onClick={() => selectSymbol(symbol)}>
          {showFib ? <FibChart symbol={symbol} bars={snapshot.bars} setup={fib} compact active={isNearViewport} /> : <ScreenerChart symbol={symbol} timeframe={timeframe} bars={snapshot.bars} divergences={analysis.divergences} active={isNearViewport} />}
          <span className="screener-card__chart-hint">Explore chart <ArrowRightOutlined /></span>
        </button>
      </Card>
    </article>
  )
}
export const ScreenerCard = memo(ScreenerCardImpl)

import { memo } from 'react'
import { ArrowRightOutlined, StarFilled, StarOutlined, WarningOutlined } from '@ant-design/icons'
import { Button, Card, Tooltip } from 'antd'
import { useNearViewport } from '../hooks/useNearViewport'
import type { DivergenceSetup } from '../lib/divergenceLifecycle'
import { DIVERGENCE_LABELS, formatSignalTime } from '../lib/divergencePresentation'
import type { ScreenerRow } from '../lib/screener'
import { useScannerStore } from '../store/scannerStore'
import type { Timeframe } from '../types'
import { ScreenerChart } from './ScreenerChart'
import './ScreenerCard.css'

interface Props {
  row: ScreenerRow; timeframe: Timeframe; starred: boolean; stale: boolean
  matchingDivergences?: readonly DivergenceSetup[]
}

function ScreenerCardImpl({ row, timeframe, starred, stale, matchingDivergences }: Props) {
  const { symbol, snapshot, analysis, feed } = row
  const { ref, isNearViewport } = useNearViewport<HTMLElement>()
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const toggleStarredSymbol = useScannerStore((state) => state.toggleStarredSymbol)
  const base = symbol.replace(/USDT$/, '')
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
        {latestDivergence && (
          <div className="screener-card__divergence" aria-label="Matching RSI divergence">
            <span className={latestDivergence.kind.endsWith('bullish') ? 'is-bullish' : 'is-bearish'}>
              {DIVERGENCE_LABELS[latestDivergence.kind]}
            </span>
            <Tooltip title={`${latestDivergence.state === 'forming' ? 'Detected' : 'Confirmed'} ${formatSignalTime(latestDivergence.confirmedAt ?? latestDivergence.detectedAt)} UTC${matchingDivergences && matchingDivergences.length > 1 ? ` · ${matchingDivergences.length} matching setups; showing the latest` : ''}`} trigger={['hover', 'focus']}>
              <span className="screener-card__divergence-age" tabIndex={0}>{divergenceAge}</span>
            </Tooltip>
          </div>
        )}
        <button type="button" className="screener-card__chart-button" aria-label={`Open ${base} chart`} onClick={() => selectSymbol(symbol)}>
          <ScreenerChart symbol={symbol} timeframe={timeframe} bars={snapshot.bars} divergences={analysis.divergences} active={isNearViewport} />
          <span className="screener-card__chart-hint">Explore chart <ArrowRightOutlined /></span>
        </button>
      </Card>
    </article>
  )
}
export const ScreenerCard = memo(ScreenerCardImpl)

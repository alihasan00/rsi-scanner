import { memo } from 'react'
import { ArrowRightOutlined, FallOutlined, MinusOutlined, RiseOutlined, StarFilled, StarOutlined, SwapOutlined, WarningOutlined } from '@ant-design/icons'
import { Button, Card, Tag, Tooltip } from 'antd'
import { useNearViewport } from '../hooks/useNearViewport'
import type { ScreenerRow } from '../lib/screener'
import { liveTugOfWarPresentation, tugOfWarPresentation } from '../lib/tugOfWar'
import { useScannerStore } from '../store/scannerStore'
import type { Timeframe } from '../types'
import { ScreenerChart } from './ScreenerChart'
import './ScreenerCard.css'

interface Props { row: ScreenerRow; timeframe: Timeframe; starred: boolean; stale: boolean }

const SIGNAL_ICONS = {
  bullish: <RiseOutlined />,
  bearish: <FallOutlined />,
  sideways: <MinusOutlined />,
  pending: <SwapOutlined />,
  neutral: undefined,
}

function ScreenerCardImpl({ row, timeframe, starred, stale }: Props) {
  const { symbol, snapshot, analysis, feed, preview } = row
  const { ref, isNearViewport } = useNearViewport<HTMLElement>()
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const toggleStarredSymbol = useScannerStore((state) => state.toggleStarredSymbol)
  const base = symbol.replace(/USDT$/, '')
  const feedError = feed.state === 'error'
  const feedWarning = feedError ? 'Data unavailable · retrying' : stale ? 'Updates delayed' : null
  const tugOfWar = preview ? liveTugOfWarPresentation(preview) : tugOfWarPresentation(analysis.tugOfWar)
  const signalLabel = tugOfWar.tone === 'bullish' ? 'Bullish trend' : tugOfWar.tone === 'bearish' ? 'Bearish trend' : tugOfWar.label
  const signalDetail = `Tug of War · ${tugOfWar.label} · ${tugOfWar.detail}`

  return (
    <article ref={ref} className="screener-card-shell" aria-label={`${base} market card`}>
      <Card className="screener-card" styles={{ body: { padding: 0 } }}>
        <div className="screener-card__chart-heading">
          <h2 className="screener-card__symbol" title={`${base} / USDT`}>{base}<span>/ USDT</span></h2>
          <Tooltip title={signalDetail} trigger={['hover', 'focus']}>
            <Tag
              className={`screener-card__signal screener-card__signal--${tugOfWar.tone}`}
              icon={SIGNAL_ICONS[tugOfWar.tone]}
              tabIndex={0}
              aria-label={`${signalLabel}. ${signalDetail}`}
            >
              {signalLabel}
            </Tag>
          </Tooltip>
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
        <button type="button" className="screener-card__chart-button" aria-label={`Open ${base} chart`} onClick={() => selectSymbol(symbol)}>
          <ScreenerChart symbol={symbol} timeframe={timeframe} bars={snapshot.bars} divergences={analysis.divergences} active={isNearViewport} />
          <span className="screener-card__chart-hint">Explore chart <ArrowRightOutlined /></span>
        </button>
      </Card>
    </article>
  )
}
export const ScreenerCard = memo(ScreenerCardImpl)

import { memo } from 'react'
import { useNearViewport } from '../hooks/useNearViewport'
import { useSupportResistanceData } from '../hooks/useSupportResistanceData'
import { describeLevelDistance, formatQuotePrice } from '../lib/priceFormatting'
import type { NearestLevel } from '../lib/supportResistance'
import type { Timeframe } from '../types'
import './SupportResistanceCard.css'

interface SupportResistanceCardProps {
  symbol: string
  timeframe: Timeframe
}

const TREND_LABELS = {
  uptrend: 'Uptrend',
  downtrend: 'Downtrend',
  sideways: 'Sideways',
  unknown: 'Unknown',
} as const

const TREND_ICONS = { uptrend: '↗', downtrend: '↘', sideways: '↔', unknown: '—' } as const

interface LevelRowProps {
  kind: 'support' | 'resistance'
  level: NearestLevel | null
  currentPrice: number
  loading: boolean
}

function LevelRow({ kind, level, currentPrice, loading }: LevelRowProps) {
  const label = kind === 'support' ? 'Support' : 'Resistance'
  const testing = !loading && level?.testing === true

  return (
    <div className={`sr-card__level sr-card__level--${kind}${testing ? ' sr-card__level--testing' : ''}`}>
      <div className="sr-card__level-heading">
        <span className="sr-card__level-label"><span aria-hidden="true" />{label}</span>
        {level && !loading && (
          <span className="sr-card__touches">{level.touches} {level.touches === 1 ? 'touch' : 'touches'}</span>
        )}
      </div>
      <div className="sr-card__level-value" title={level && !loading ? `${level.price} USDT` : undefined}>
        {loading ? <span className="sr-card__placeholder">Loading…</span> : (
          level ? <>{formatQuotePrice(level.price)} <span className="sr-card__quote">USDT</span></> : '—'
        )}
      </div>
      <div className="sr-card__distance">
        {loading ? 'Awaiting candles' : level ? (
          <>
            {describeLevelDistance(level.price, currentPrice)}
            {testing && (
              <span
                className="sr-card__testing"
                title="Price is beyond this level, but no candle has closed past it yet."
              >
                Testing
              </span>
            )}
          </>
        ) : 'No confirmed level'}
      </div>
    </div>
  )
}

function SupportResistanceCardImpl({ symbol, timeframe }: SupportResistanceCardProps) {
  const { ref, isNearViewport } = useNearViewport<HTMLElement>()
  const { price, hasData, trend: liveTrend, support, resistance } = useSupportResistanceData(symbol, isNearViewport)
  const hasPrice = Number.isFinite(price) && price > 0
  const loading = !hasData || !hasPrice
  const formattedPrice = formatQuotePrice(price)
  const trend = loading ? 'unknown' : liveTrend

  return (
    <article ref={ref} className="sr-card" aria-label={`${symbol} support and resistance`}>
      <div className="sr-card__heading">
        <h3 className="sr-card__symbol">{symbol.replace(/USDT$/, '')}<span>/USDT</span></h3>
        <span className="sr-card__timeframe">{timeframe}</span>
      </div>

      <div className="sr-card__trend-row">
        <span className="sr-card__caption">Trend</span>
        <span className={`sr-card__trend sr-card__trend--${trend}`}>
          <span aria-hidden="true">{TREND_ICONS[trend]}</span>
          {loading ? 'Loading…' : TREND_LABELS[trend]}
          {!loading && trend === 'unknown' && <span className="sr-card__trend-note">· Awaiting swings</span>}
        </span>
      </div>

      <div className="sr-card__current-price">
        <span className="sr-card__caption">Current price</span>
        <div
          className={`sr-card__price${formattedPrice.length > 14 ? ' sr-card__price--small' : ''}`}
          title={hasPrice ? `${price} USDT` : undefined}
        >
          {hasPrice ? <>{formattedPrice}<span className="sr-card__quote">USDT</span></> : (
            <span className="sr-card__placeholder">Loading…</span>
          )}
        </div>
      </div>

      <div className="sr-card__levels">
        <LevelRow kind="resistance" level={resistance} currentPrice={price} loading={loading} />
        <LevelRow kind="support" level={support} currentPrice={price} loading={loading} />
      </div>
    </article>
  )
}

export const SupportResistanceCard = memo(SupportResistanceCardImpl)

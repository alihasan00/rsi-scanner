import { InfoCircleOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { describeLevelDistance, formatQuotePrice } from '../lib/priceFormatting'
import type { PendingBreakout } from '../lib/supportResistance'
import './SupportResistanceBreakouts.css'

const CONFIRMATION_DESCRIPTION = 'Price is beyond this zone. Confirmation requires a candle close more than 0.1% beyond it; a close inside or exactly at that buffer leaves the zone active. Returning to the zone or its original side clears the pending breakout. A confirmed break retires the zone without automatically switching its support/resistance role.'

export function SupportResistanceBreakoutTitle() {
  return (
    <div className="sr-breakouts__heading">
      <span>Breakout awaiting confirmation</span>
      <Tooltip title={CONFIRMATION_DESCRIPTION} trigger={['hover', 'focus']}>
        <button
          type="button"
          className="sr-breakouts__info"
          aria-label="How a pending breakout is confirmed"
        >
          <InfoCircleOutlined />
        </button>
      </Tooltip>
    </div>
  )
}

interface SupportResistanceBreakoutsProps {
  pendingBreakouts: readonly PendingBreakout[]
  currentPrice: number
  compact?: boolean
}

export function SupportResistanceBreakouts({
  pendingBreakouts, currentPrice, compact = false,
}: SupportResistanceBreakoutsProps) {
  if (pendingBreakouts.length === 0) return null

  return (
    <div className={`sr-breakouts${compact ? ' sr-breakouts--compact' : ''}`}>
      {!compact && <SupportResistanceBreakoutTitle />}
      <ul className="sr-breakouts__list" aria-label="Pending breakouts">
        {pendingBreakouts.map((level) => (
          <li key={level.kind} className="sr-breakouts__level">
            <div className="sr-breakouts__level-heading">
              <span className="sr-breakouts__kind">
                {level.kind === 'support' ? 'Support' : 'Resistance'} crossed
              </span>
              <span className="sr-breakouts__price" title={`${level.price} USDT`}>
                {formatQuotePrice(level.price)} <span className="sr-breakouts__quote">USDT</span>
              </span>
            </div>
            <div className="sr-breakouts__details">
              <span>{describeLevelDistance(level.price, currentPrice)}</span>
              <span>{level.touches} {level.touches === 1 ? 'touch' : 'touches'}</span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

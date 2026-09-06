import { InfoCircleOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'
import { describeLevelDistance, formatQuotePrice } from '../lib/priceFormatting'
import type { PendingLevelBreak } from '../lib/supportResistance'
import { useScannerStore } from '../store/scannerStore'
import './SupportResistanceBreakouts.css'

const BREAK_PRESENTATION = {
  resistance: {
    label: 'Breakout',
    direction: 'breakout',
    crossedLabel: 'Resistance crossed',
    description: 'Price is above resistance. Breakout confirmation requires a candle close more than 0.1% above this level; a close inside or exactly at that buffer leaves the zone active. Returning to resistance or below it clears the pending breakout. A confirmed breakout retires the zone without automatically turning it into support.',
  },
  support: {
    label: 'Breakdown',
    direction: 'breakdown',
    crossedLabel: 'Support crossed',
    description: 'Price is below support. Breakdown confirmation requires a candle close more than 0.1% below this level; a close inside or exactly at that buffer leaves the zone active. Returning to support or above it clears the pending breakdown. A confirmed breakdown retires the zone without automatically turning it into resistance.',
  },
} as const

interface SupportResistanceBreakoutTitleProps {
  kind: PendingLevelBreak['kind']
  compact?: boolean
}

export function SupportResistanceBreakoutTitle({ kind, compact = false }: SupportResistanceBreakoutTitleProps) {
  const { label, direction, description } = BREAK_PRESENTATION[kind]
  return (
    <div className="sr-breakouts__heading">
      <span>{compact ? label : `${label} awaiting confirmation`}</span>
      <Tooltip title={description} trigger={['hover', 'focus']}>
        <button
          type="button"
          className="sr-breakouts__info"
          aria-label={`How a pending ${direction} is confirmed`}
        >
          <InfoCircleOutlined aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  )
}

interface SupportResistanceBreakoutsProps {
  pendingBreaks: readonly PendingLevelBreak[]
  currentPrice: number
  compact?: boolean
}

export function SupportResistanceBreakouts({
  pendingBreaks, currentPrice, compact = false,
}: SupportResistanceBreakoutsProps) {
  const breakFilter = useScannerStore((state) => state.supportResistanceFilters.breakFilter)
  const visibleBreaks = pendingBreaks.filter((level) => (
    breakFilter === 'breakouts' ? level.kind === 'resistance'
      : breakFilter === 'breakdowns' ? level.kind === 'support'
        : true
  ))
  if (visibleBreaks.length === 0) return null

  return (
    <div className={`sr-breakouts${compact ? ' sr-breakouts--compact' : ''}`}>
      {(['resistance', 'support'] as const).map((kind) => {
        const levels = visibleBreaks.filter((level) => level.kind === kind)
        if (levels.length === 0) return null
        const { direction, crossedLabel } = BREAK_PRESENTATION[kind]
        return (
          <div key={kind} className={`sr-breakouts__group sr-breakouts__group--${direction}`}>
            <SupportResistanceBreakoutTitle kind={kind} compact={compact} />
            <ul className="sr-breakouts__list" aria-label={`Pending ${direction}s`}>
              {levels.map((level) => (
                <li key={level.price} className="sr-breakouts__level">
                  <div className="sr-breakouts__level-heading">
                    <span className="sr-breakouts__kind">{crossedLabel}</span>
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
      })}
    </div>
  )
}

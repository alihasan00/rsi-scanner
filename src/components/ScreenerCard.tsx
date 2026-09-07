import { memo } from 'react'
import { ArrowUpOutlined, ArrowDownOutlined, ArrowRightOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { Avatar, Badge, Button, Card, Tag, Tooltip, Typography } from 'antd'
import { useNearViewport } from '../hooks/useNearViewport'
import { candleChange } from '../lib/screener'
import type { ScreenerRow } from '../lib/screener'
import { liveTugOfWarPresentation, tugOfWarPresentation } from '../lib/tugOfWar'
import { formatQuotePrice } from '../lib/priceFormatting'
import { DIVERGENCE_LABELS, divergenceStatus } from '../lib/divergencePresentation'
import { useScannerStore } from '../store/scannerStore'
import type { Timeframe } from '../types'
import { ScreenerChart } from './ScreenerChart'
import './ScreenerCard.css'

const COIN_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', BNB: 'BNB', DOGE: 'Dogecoin',
  ZEC: 'Zcash', BCH: 'Bitcoin Cash', SUI: 'Sui', PAXG: 'PAX Gold', ENA: 'Ethena', ADA: 'Cardano',
  LINK: 'Chainlink', UNI: 'Uniswap', AVAX: 'Avalanche', TRX: 'TRON', LTC: 'Litecoin', NEAR: 'NEAR Protocol',
  FIL: 'Filecoin', AAVE: 'Aave', DOT: 'Polkadot', TAO: 'Bittensor', APT: 'Aptos', ARB: 'Arbitrum',
  XLM: 'Stellar', ICP: 'Internet Computer', HBAR: 'Hedera', ETC: 'Ethereum Classic', ATOM: 'Cosmos',
  INJ: 'Injective', RENDER: 'Render', SHIB: 'Shiba Inu', PEPE: 'Pepe', ALGO: 'Algorand',
}
const COIN_MARKS: Record<string, string> = { BTC: '₿', ETH: 'Ξ', SOL: '≋', XRP: '×', DOGE: 'Ð', LTC: 'Ł' }

interface Props { row: ScreenerRow; timeframe: Timeframe; starred: boolean; stale: boolean }

function ScreenerCardImpl({ row, timeframe, starred, stale }: Props) {
  const { symbol, snapshot, analysis, feed } = row
  const { ref, isNearViewport } = useNearViewport<HTMLElement>()
  const selectSymbol = useScannerStore((state) => state.selectSymbol)
  const toggleStarredSymbol = useScannerStore((state) => state.toggleStarredSymbol)
  const base = symbol.replace(/USDT$/, '')
  const loaded = snapshot.bars.length > 0
  const change = candleChange(snapshot)
  const rsi = snapshot.series.at(-1)
  const divergence = analysis.divergences.at(-1)
  const preview = row.preview
  const tow = preview ? liveTugOfWarPresentation(preview) : tugOfWarPresentation(analysis.tugOfWar)
  const towDetail = !preview ? tow.detail
    : preview.isWarmup ? 'Live shape · HA warming up'
      : preview.possibleResolution ? `Possible ${preview.possibleResolution.kind === 'undetermined' ? 'resolution' : preview.possibleResolution.kind} · awaiting close`
        : preview.control === 'tugOfWar' ? `${preview.pendingTowCandles - 1} closed + live candle`
          : preview.pendingTowCandles > 0 ? `${preview.pendingTowCandles} closed candles · awaiting control`
          : 'Live candle · still forming'
  const divTone = divergence ? divergence.kind.endsWith('bullish') ? 'bullish' : 'bearish' : 'neutral'
  const lastClosed = analysis.tugOfWar.lastClosedTime
  const time = lastClosed === null ? null : new Date(lastClosed).toISOString().slice(11, 16)
  const divLabel = divergence ? DIVERGENCE_LABELS[divergence.kind] : loaded ? 'No divergence' : 'Waiting for data'
  const divDetail = divergence ? divergenceStatus(divergence) + (analysis.divergences.length > 1 ? ` · +${analysis.divergences.length - 1} more` : '') : loaded ? 'No active setup' : 'RSI (14)'
  const feedError = feed.state === 'error'
  const feedLabel = feedError ? 'Data unavailable · retrying' : stale ? 'Updates delayed' : time ? `Closed ${time} UTC` : 'Connecting…'
  const feedDetail = feed.error ?? (lastClosed === null ? 'Waiting for the first closed candle' : `Last closed candle: ${new Date(lastClosed).toISOString()}`)

  return (
    <article ref={ref} className="screener-card-shell" aria-label={`${base} market card`}>
      <Card
        className={`screener-card${starred ? ' is-starred' : ''}`}
        styles={{ body: { padding: 0 } }}
        cover={(
          <div className="screener-card__visual">
            <div className="screener-card__chart-heading">
              <Tag className="screener-card__interval">{timeframe}</Tag>
              <Typography.Text className="screener-card__chart-label">Price + RSI</Typography.Text>
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
          </div>
        )}
      >
        <div className="screener-card__body">
          <div className="screener-card__identity">
            <Avatar size={38} className="screener-card__coin" aria-hidden="true">{COIN_MARKS[base] ?? base.slice(0, 1)}</Avatar>
            <div className="screener-card__name">
              <Typography.Title level={2}>{base}<Typography.Text>/ USDT</Typography.Text></Typography.Title>
              <Typography.Text className="screener-card__coin-name">{COIN_NAMES[base] ?? base}</Typography.Text>
            </div>
          </div>
          <div className="screener-card__quote">
            <Typography.Text strong className="screener-card__price">{loaded ? formatQuotePrice(snapshot.price) : '—'}</Typography.Text>
            <Tooltip title={`Change from this ${timeframe} candle's open to its latest price`}>
              <span className="screener-card__change">
                <Typography.Text className={change === null ? 'tone-neutral' : change >= 0 ? 'tone-bullish' : 'tone-bearish'}>
                  {change !== null && (change >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />)}
                  {change === null ? '—' : `${Math.abs(change).toFixed(2)}%`}
                </Typography.Text>
                <Typography.Text className="screener-card__change-period">this candle</Typography.Text>
              </span>
            </Tooltip>
          </div>
          <div className="screener-card__signals">
            <div className="screener-card__signal">
              <div className="screener-card__signal-name">
                <Typography.Text>RSI divergence</Typography.Text>
                <Tooltip title="Wilder RSI (14). The latest value can change while the candle is forming.">
                  <Tag className={`screener-card__rsi ${rsi !== undefined && rsi >= 70 ? 'tone-bearish' : rsi !== undefined && rsi <= 30 ? 'tone-bullish' : ''}`}>{rsi?.toFixed(1) ?? '—'}</Tag>
                </Tooltip>
              </div>
              <div className="screener-card__signal-value">
                <Tag className={`screener-card__signal-tag tone-${divTone}`}>{divLabel}</Tag>
                <Typography.Text className="screener-card__signal-detail">{divDetail}</Typography.Text>
              </div>
            </div>
            <div className="screener-card__signal">
              <div className="screener-card__signal-name">
                <Typography.Text>Tug of War</Typography.Text>
                <Tooltip title="Heikin-Ashi wick control includes the current forming candle. Live control can change until this candle closes.">
                  <Tag className={`screener-card__ha${preview ? ' is-live' : ''}`}>{preview ? 'LIVE' : 'HA'}</Tag>
                </Tooltip>
              </div>
              <div className="screener-card__signal-value">
                <Tooltip title={tow.detail}>
                  <Tag className={`screener-card__signal-tag tone-${tow.tone}`}>{tow.label}</Tag>
                </Tooltip>
                <Typography.Text className="screener-card__signal-detail">{towDetail}</Typography.Text>
              </div>
            </div>
          </div>
        </div>
        <footer className="screener-card__footer">
          <Tooltip title={feedDetail}>
            <Badge
              className="screener-card__feed"
              status={feedError ? 'error' : stale ? 'warning' : loaded ? 'success' : 'processing'}
              text={feedLabel}
            />
          </Tooltip>
          <Button type="link" size="small" className="screener-card__detail-button" aria-label={`View ${base} details`} onClick={() => selectSymbol(symbol)}>
            View chart <ArrowRightOutlined />
          </Button>
        </footer>
      </Card>
    </article>
  )
}
export const ScreenerCard = memo(ScreenerCardImpl)

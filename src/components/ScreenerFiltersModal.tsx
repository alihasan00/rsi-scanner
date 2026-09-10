import { useState } from 'react'
import { Button, Modal } from 'antd'
import { CloseOutlined, SlidersOutlined } from '@ant-design/icons'
import type { ScreenerFilterPreferences } from '../lib/screenerPreferences'
import { RSI_OVERBOUGHT, RSI_OVERSOLD } from '../lib/rsiState'
import { DIVERGENCE_RECENCY_OPTIONS, RSI_FILTER_OPTIONS } from '../lib/screenerFilterOptions'
import './ScreenerFiltersModal.css'

type ModalFilters = Pick<ScreenerFilterPreferences, 'signal' | 'divergenceRecency' | 'rsiState' | 'starredOnly' | 'fibDirection' | 'fibStage' | 'fibConfluence'>

interface Props {
  initialFilters: ModalFilters
  starredCount: number
  onApply: (filters: ModalFilters) => void
  onClear: () => void
  onClose: () => void
}

/** Mount on open so dismissing the dialog discards unapplied choices. */
export function ScreenerFiltersModal({ initialFilters, starredCount, onApply, onClear, onClose }: Props) {
  const [open, setOpen] = useState(true)
  const [draft, setDraft] = useState(initialFilters)
  const update = (patch: Partial<ModalFilters>) => setDraft((current) => ({ ...current, ...patch }))

  return (
    <Modal
      open={open}
      centered
      width={520}
      className="screener-filters"
      onCancel={() => setOpen(false)}
      afterClose={onClose}
      title={<span className="screener-filters__title"><SlidersOutlined aria-hidden="true" /> {initialFilters.signal === 'fib' ? 'Fib filters' : 'RSI filters'}</span>}
      footer={
        <div className="screener-filters__footer">
          <Button type="text" icon={<CloseOutlined aria-hidden="true" />} onClick={() => { onClear(); setOpen(false) }}>Clear all</Button>
          <Button type="primary" onClick={() => {
            onApply({
              signal: draft.signal,
              divergenceRecency: draft.divergenceRecency,
              rsiState: draft.rsiState,
              starredOnly: draft.starredOnly,
              fibDirection: draft.fibDirection,
              fibStage: draft.fibStage,
              fibConfluence: draft.fibConfluence,
            })
            setOpen(false)
          }}>Apply</Button>
        </div>
      }
    >
      <p className="screener-filters__intro">Choose the pairs and setups you want to see.</p>
      <div className="screener-filters__fields">
        {draft.signal !== 'fib' && <fieldset className="screener-filters__group">
          <legend>RSI signals</legend>
          <div className="screener-filters__options">
            <Button aria-pressed={draft.signal === 'all'} onClick={() => update({ signal: 'all' })}>All RSI charts</Button>
            <Button aria-pressed={draft.signal === 'divergence'} onClick={() => update({ signal: 'divergence' })}>RSI divergences</Button>
          </div>
          {draft.signal === 'divergence' && (
            <fieldset className="screener-filters__group screener-filters__recency">
              <legend>Divergence age</legend>
              <div className="screener-filters__options">
                {DIVERGENCE_RECENCY_OPTIONS.map(({ value, label }) => (
                  <Button key={value} aria-pressed={draft.divergenceRecency === value} onClick={() => update({ divergenceRecency: value })}>{label}</Button>
                ))}
              </div>
              <p className="screener-filters__help">Age starts at the confirmation close. Newly forming setups also match. Older active divergences remain on the charts.</p>
            </fieldset>
          )}
        </fieldset>}
          {draft.signal === 'fib' && <>
            <fieldset className="screener-filters__group">
              <legend>Fib direction</legend>
              <div className="screener-filters__options">{([['any', 'Both directions'], ['long', 'Long'], ['short', 'Short']] as const).map(([value, label]) => <Button key={value} aria-pressed={draft.fibDirection === value} onClick={() => update({ fibDirection: value })}>{label}</Button>)}</div>
            </fieldset>
            <fieldset className="screener-filters__group">
              <legend>Fib stage</legend>
              <div className="screener-filters__options">{([['any', 'Any active setup'], ['waiting', 'Awaiting entry'], ['active', 'Entry reached'], ['pocket', 'In golden pocket']] as const).map(([value, label]) => <Button key={value} aria-pressed={draft.fibStage === value} onClick={() => update({ fibStage: value })}>{label}</Button>)}</div>
              <p className="screener-filters__help">Structure and entry touches update on candle closes. Golden pocket proximity uses the current price and is provisional during a live candle. Used or invalidated setups are excluded.</p>
            </fieldset>
            <fieldset className="screener-filters__group">
              <legend>Trend confluence</legend>
              <div className="screener-filters__options"><Button aria-pressed={draft.fibConfluence === 'any'} onClick={() => update({ fibConfluence: 'any' })}>Any trend</Button><Button aria-pressed={draft.fibConfluence === 'aligned'} onClick={() => update({ fibConfluence: 'aligned' })}>Aligned with SMA 200</Button></div>
              <p className="screener-filters__help">Longs above SMA 200; shorts below. Uses closed prices. Pairs with fewer than 200 closed candles cannot match alignment.</p>
            </fieldset>
          </>}

        <fieldset className="screener-filters__group">
          <legend>RSI state</legend>
          <div className="screener-filters__options">
            {RSI_FILTER_OPTIONS.map(({ value, label }) => (
              <Button key={value} aria-pressed={draft.rsiState === value} onClick={() => update({ rsiState: value })}>{label}</Button>
            ))}
          </div>
          <p className="screener-filters__help">Latest RSI 14 on the selected timeframe. Neutral is above {RSI_OVERSOLD} and below {RSI_OVERBOUGHT}. Live candle readings are provisional.</p>
        </fieldset>

        <fieldset className="screener-filters__group">
          <legend>Pair collection</legend>
          <div className="screener-filters__options">
            <Button aria-pressed={!draft.starredOnly} onClick={() => update({ starredOnly: false })}>All pairs</Button>
            <Button aria-pressed={draft.starredOnly} onClick={() => update({ starredOnly: true })}>Starred <span className="screener-filters__option-count">{starredCount}</span></Button>
          </div>
        </fieldset>
      </div>
    </Modal>
  )
}

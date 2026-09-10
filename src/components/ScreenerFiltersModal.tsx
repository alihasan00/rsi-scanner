import { useState } from 'react'
import { Button, Modal } from 'antd'
import { CloseOutlined, SlidersOutlined } from '@ant-design/icons'
import type { ScreenerFilterPreferences } from '../lib/screenerPreferences'
import { RSI_OVERBOUGHT, RSI_OVERSOLD } from '../lib/rsiState'
import { DIVERGENCE_RECENCY_OPTIONS, FIB_STAGE_OPTIONS, RSI_FILTER_OPTIONS } from '../lib/screenerFilterOptions'
import './ScreenerFiltersModal.css'

type ModalFilters = Pick<ScreenerFilterPreferences, 'signal' | 'divergenceRecency' | 'rsiState' | 'fibDirection' | 'fibStage' | 'fibConfluence' | 'srSource' | 'srSignal'>

interface Props {
  initialFilters: ModalFilters
  onApply: (filters: ModalFilters) => void
  onClear: () => void
  onClose: () => void
}

/** Mount on open so dismissing the dialog discards unapplied choices. */
export function ScreenerFiltersModal({ initialFilters, onApply, onClear, onClose }: Props) {
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
      title={<span className="screener-filters__title"><SlidersOutlined aria-hidden="true" /> {initialFilters.signal === 'sr' ? 'Support & resistance filters' : initialFilters.signal === 'fib' ? 'Fib filters' : 'RSI filters'}</span>}
      footer={
        <div className="screener-filters__footer">
          <Button type="text" icon={<CloseOutlined aria-hidden="true" />} onClick={() => { onClear(); setOpen(false) }}>Clear all</Button>
          <Button type="primary" onClick={() => {
            onApply({
              signal: draft.signal,
              divergenceRecency: draft.divergenceRecency,
              rsiState: draft.rsiState,
              fibDirection: draft.fibDirection,
              fibStage: draft.fibStage,
              fibConfluence: draft.fibConfluence,
              srSource: draft.srSource,
              srSignal: draft.srSignal,
            })
            setOpen(false)
          }}>Apply</Button>
        </div>
      }
    >
      <p className="screener-filters__intro">Choose the pairs and setups you want to see.</p>
      <div className="screener-filters__fields">
        {draft.signal !== 'fib' && draft.signal !== 'sr' && <fieldset className="screener-filters__group">
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
              <div className="screener-filters__options">{FIB_STAGE_OPTIONS.map(({ value, label }) => <Button key={value} aria-pressed={draft.fibStage === value} onClick={() => update({ fibStage: value })}>{label}</Button>)}</div>
              <p className="screener-filters__help">Near entry shows unfilled setups from Fib 0.600 up to, but not including, 0.618. Near entry and golden pocket use the live price. Structure and entry touches update on candle closes; ended setups are excluded.</p>
            </fieldset>
            <fieldset className="screener-filters__group">
              <legend>Trend confluence</legend>
              <div className="screener-filters__options"><Button aria-pressed={draft.fibConfluence === 'any'} onClick={() => update({ fibConfluence: 'any' })}>Any trend</Button><Button aria-pressed={draft.fibConfluence === 'aligned'} onClick={() => update({ fibConfluence: 'aligned' })}>Aligned with SMA 200</Button></div>
              <p className="screener-filters__help">Longs above SMA 200; shorts below. Uses closed prices. Pairs with fewer than 200 closed candles cannot match alignment.</p>
            </fieldset>
          </>}

        {draft.signal === 'sr' && <>
          <fieldset className="screener-filters__group">
            <legend>Level source</legend>
            <div className="screener-filters__options">{([['all', 'All calendar levels'], ['week', 'Previous week'], ['month', 'Previous month'], ['monday', 'Monday body']] as const).map(([value, label]) => <Button key={value} aria-pressed={draft.srSource === value} onClick={() => update({ srSource: value })}>{label}</Button>)}</div>
            <p className="screener-filters__help">Week and month use the completed period’s open, high, low and close. Monday uses its body and midpoint, shown on intraday charts.</p>
          </fieldset>
          <fieldset className="screener-filters__group">
            <legend>Price at the level</legend>
            <div className="screener-filters__options">{([['all', 'All pairs'], ['near', 'Within 0.5%'], ['sfp', 'Confirmed sweeps'], ['bullish', 'Bullish sweep'], ['bearish', 'Bearish sweep']] as const).map(([value, label]) => <Button key={value} aria-pressed={draft.srSignal === value} onClick={() => update({ srSignal: value })}>{label}</Button>)}</div>
            <p className="screener-filters__help">A sweep crosses a level and closes back on the approach side. Signals cover the latest 3 closed candles on your selected timeframe. Forming candles never match confirmed-sweep filters.</p>
          </fieldset>
        </>}

        {draft.signal !== 'sr' && <fieldset className="screener-filters__group">
          <legend>RSI state</legend>
          <div className="screener-filters__options">
            {RSI_FILTER_OPTIONS.map(({ value, label }) => (
              <Button key={value} aria-pressed={draft.rsiState === value} onClick={() => update({ rsiState: value })}>{label}</Button>
            ))}
          </div>
          <p className="screener-filters__help">Latest RSI 14 on the selected timeframe. Neutral is above {RSI_OVERSOLD} and below {RSI_OVERBOUGHT}. Live candle readings are provisional.</p>
        </fieldset>}

      </div>
    </Modal>
  )
}

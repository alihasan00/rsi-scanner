import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Alert, Empty, Select, Tag } from 'antd'
import type { RsiBar } from '../types'
import { useScannerStore } from '../store/scannerStore'
import { getFeedStatus, subscribeFeedStatus } from '../store/feedStatusStore'
import { getHarmonicAnalysis } from '../lib/harmonicScreener'
import { getHarmonicLiveContext, getHarmonicTargets, HARMONIC_C_RANGE } from '../lib/harmonics'
import { HARMONIC_NAMES, HARMONIC_STAGES, selectHarmonicSetup } from '../lib/harmonicRows'
import { formatQuotePrice } from '../lib/priceFormatting'
import { HarmonicChart } from './HarmonicChart'
import { HarmonicGuide } from './HarmonicGuide'

export function HarmonicDetails({ symbol, bars, price }: { symbol: string; bars: readonly RsiBar[]; price: number }) {
  const filters = useScannerStore((state) => state.screenerFilters)
  const analysis = useMemo(() => getHarmonicAnalysis(symbol, bars), [symbol, bars])
  const subscribe = useCallback((notify: () => void) => subscribeFeedStatus(symbol, notify), [symbol])
  const getStatus = useCallback(() => getFeedStatus(symbol), [symbol])
  const feed = useSyncExternalStore(subscribe, getStatus, getStatus)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const [selected, setSelected] = useState<string | null>(null)
  const active = analysis.setups.filter((setup) => setup.status === 'active').sort((a, b) => b.confirmedAt - a.confirmedAt)
  const setup = active.find((item) => item.id === selected) ?? selectHarmonicSetup(analysis, filters) ?? active[0]
  if (!setup) return <><Empty description="No active harmonic in the current candle history. The previous setup may have ended." /><HarmonicGuide /></>
  const lastBar = bars.at(-1)
  const live = getHarmonicLiveContext(setup, price, lastBar?.isClosed === false ? lastBar : undefined)
  const targets = getHarmonicTargets(setup)
  const stale = feed.state !== 'ready' || feed.updatedAt === null || now - feed.updatedAt > 60_000
  const priceLabel = (value: number) => `${formatQuotePrice(value)} USDT`
  return <div className="harmonic-details">
    <div className="harmonic-details__heading">
      <div><Tag color={setup.direction === 'bullish' ? 'green' : 'red'}>{setup.direction === 'bullish' ? 'Bullish' : 'Bearish'}</Tag><strong>{HARMONIC_NAMES[setup.kind]}</strong><Tag>{HARMONIC_STAGES[setup.stage]}</Tag></div>
      {active.length > 1 && <Select aria-label="Harmonic setup" value={setup.id} onChange={setSelected} options={active.map((item) => ({ value: item.id, label: `${HARMONIC_NAMES[item.kind]} · ${item.direction} · ${new Date(item.c.time).toLocaleDateString('en-GB', { timeZone: 'UTC' })}` }))} />}
    </div>
    {stale ? <Alert type="warning" showIcon title="Updates delayed · last known setup" description="Prices, candles, and pattern levels reflect the last received data. Waiting for fresh market updates." /> : live.invalidated ? <Alert type="warning" showIcon title="Live candle crossed a boundary" description="This setup is still based on the last closed candle. A boundary violation on the forming candle is provisional." /> : live.inZone && <Alert type="info" showIcon title="Live price is inside D" description="This is a possible reversal area. A live touch does not confirm a reversal." />}
    <HarmonicChart bars={bars} setup={setup} price={price} />
    <div className="harmonic-details__levels">
      <div><span>Potential D entry zone</span><strong>{priceLabel(setup.zone.low)} – {priceLabel(setup.zone.high)}</strong><small>If price reaches this area, review reversal confluence.</small></div>
      <div><span>C invalidation boundary</span><strong>{priceLabel(setup.cInvalidation)}</strong><small>A wick {setup.direction === 'bullish' ? 'above' : 'below'} this price invalidates the pattern.</small></div>
      <div><span>Stop reference · {setup.kind === 'butterfly' ? 'far edge of D' : 'X'}</span><strong>{priceLabel(setup.stopReference)}</strong><small>Stop belongs {setup.direction === 'bullish' ? 'below' : 'above'} this boundary. Buffer is manual.</small></div>
    </div>
    <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Pattern measurements</caption><thead><tr><th>Leg</th><th>Measurement</th><th>Purpose</th></tr></thead><tbody>
      <tr><th>B / XA</th><td>{setup.bRatio.toFixed(4)}</td><td>Identifies {HARMONIC_NAMES[setup.kind]}</td></tr>
      <tr><th>C / AB</th><td>{setup.cRatio.toFixed(4)}</td><td>Valid within {HARMONIC_C_RANGE.join('–')}</td></tr>
      <tr><th>D / XA{setup.zoneNarrowed ? ' · base' : ''}</th><td>{setup.dRatioRange.map((value) => value.toFixed(4)).join('–')}</td><td>{setup.d ? 'Zone touched; reversal unconfirmed' : 'Projected zone'}</td></tr>
    </tbody></table></div>
    {setup.kind === 'butterfly' && <p className="harmonic-details__manual">{setup.zoneNarrowed ? `D zone narrowed by B→C confluence. Original X→A zone: ${priceLabel(setup.baseZone.low)} – ${priceLabel(setup.baseZone.high)}.` : 'The B→C extension does not narrow this Butterfly. Its full X→A zone is shown.'}</p>}
    <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Take-profit references · {setup.kind === 'butterfly' ? 'C→D' : 'A→D'}</caption><thead><tr><th>Target</th><th>Ratio</th><th>Price</th></tr></thead><tbody>{targets.map((target, index) => <tr key={target.ratio}><th>TP {index + 1}</th><td>{target.ratio}</td><td>{priceLabel(target.price)}</td></tr>)}</tbody></table></div>
    <p className="harmonic-details__manual">{setup.d ? `Targets use the first closed D touch at ${priceLabel(setup.d.price)}.` : `Projected targets use the D zone midpoint at ${priceLabel((setup.zone.low + setup.zone.high) / 2)}; they will update when D is touched.`} Levels follow the video templates and do not imply an executed entry or a confirmed reversal.</p>
    <details className="harmonic-details__method"><summary>How this pattern is detected</summary><HarmonicGuide /></details>
  </div>
}

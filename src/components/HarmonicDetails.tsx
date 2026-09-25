import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Alert, Empty, Select, Tag } from 'antd'
import type { RsiBar } from '../types'
import { useScannerStore } from '../store/scannerStore'
import { getFeedStatus, subscribeFeedStatus } from '../store/feedStatusStore'
import { getHarmonicAnalysis } from '../lib/harmonicScreener'
import { getHarmonicLiveContext, getHarmonicTargets, HARMONIC_C_RANGE } from '../lib/harmonics'
import { getBatGeometryDiagnostics, getHarmonicQuality } from '../lib/harmonicQuality'
import { HARMONIC_NAMES, HARMONIC_STAGES, selectHarmonicSetup } from '../lib/harmonicRows'
import { formatQuotePrice } from '../lib/priceFormatting'
import { HarmonicChart } from './HarmonicChart'
import { HarmonicGuide } from './HarmonicGuide'
import { HarmonicResearchPanel } from './HarmonicResearchPanel'

export function HarmonicDetails({ symbol, bars, price }: { symbol: string; bars: readonly RsiBar[]; price: number }) {
  const filters = useScannerStore((state) => state.screenerFilters)
  const market = useScannerStore((state) => state.market)
  const timeframe = useScannerStore((state) => state.timeframe)
  const identity = `${market}:${timeframe}:${symbol}`
  const analysis = useMemo(() => getHarmonicAnalysis(identity, bars), [identity, bars])
  const subscribe = useCallback((notify: () => void) => subscribeFeedStatus(symbol, notify), [symbol])
  const getStatus = useCallback(() => getFeedStatus(symbol), [symbol])
  const feed = useSyncExternalStore(subscribe, getStatus, getStatus)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  const [selected, setSelected] = useState<{ identity: string; id: string } | null>(null)
  const active = analysis.setups.filter((setup) => setup.status === 'active').sort((a, b) => b.confirmedAt - a.confirmedAt)
  const setup = active.find((item) => selected?.identity === identity && item.id === selected.id) ?? selectHarmonicSetup(analysis, filters) ?? active[0]
  const continuity = analysis.continuity && <Alert type={analysis.continuity.state === 'reset' ? 'warning' : 'info'} showIcon title={analysis.continuity.state === 'reset' ? 'Harmonic history rebuilt' : 'Harmonic history restored'} description={analysis.continuity.detail} />
  const research = <details className="harmonic-details__method"><summary>Compare harmonic rules on historical candles</summary><HarmonicResearchPanel symbol={symbol} market={market} timeframe={timeframe} /></details>
  if (!setup) return <div className="harmonic-details">{continuity}<Empty description="No active harmonic in the current candle history. The previous setup may have ended." />{research}<HarmonicGuide /></div>
  const lastBar = bars.at(-1)
  const live = getHarmonicLiveContext(setup, price, lastBar?.isClosed === false ? lastBar : undefined)
  const targets = getHarmonicTargets(setup)
  const batGeometry = getBatGeometryDiagnostics(setup)
  const quality = getHarmonicQuality(setup, bars.findLast((bar) => bar.isClosed)?.closeTime)
  const stale = feed.state !== 'ready' || feed.updatedAt === null || now - feed.updatedAt > 60_000
  const priceLabel = (value: number) => `${formatQuotePrice(value)} USDT`
  const utc = (time: number) => `${new Date(time).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  return <div className="harmonic-details">
    {continuity}
    <div className="harmonic-details__heading">
      <div><Tag color={setup.direction === 'bullish' ? 'green' : 'red'}>{setup.direction === 'bullish' ? 'Bullish' : 'Bearish'}</Tag><strong>{HARMONIC_NAMES[setup.kind]}</strong><Tag>{HARMONIC_STAGES[setup.stage]}</Tag>{setup.confirmedD && <Tag color="blue">D pivot confirmed</Tag>}</div>
      {active.length > 1 && <Select aria-label="Harmonic setup" value={setup.id} onChange={(id) => setSelected({ identity, id })} options={active.map((item) => ({ value: item.id, label: `${HARMONIC_NAMES[item.kind]} · ${item.direction} · ratio fit ${getHarmonicQuality(item).score.toFixed(0)} · ${new Date(item.c.time).toLocaleDateString('en-GB', { timeZone: 'UTC' })}` }))} />}
    </div>
    {stale ? <Alert type="warning" showIcon title="Updates delayed · last known setup" description="Prices, candles, and pattern levels reflect the last received data. Waiting for fresh market updates." /> : live.invalidated ? <Alert type="warning" showIcon title="Live candle crossed a boundary" description="This setup is still based on the last closed candle. A boundary violation on the forming candle is provisional." /> : live.inZone && <Alert type="info" showIcon title="Live price is inside D" description="This is a possible reversal area. A live touch does not confirm a reversal." />}
    <HarmonicChart bars={bars} setup={setup} price={price} />
    <div className="harmonic-details__levels">
      <div><span>Potential D entry zone</span><strong>{priceLabel(setup.zone.low)} – {priceLabel(setup.zone.high)}</strong><small>If price reaches this area, review reversal confluence.</small></div>
      <div><span>C boundary · before D touch</span><strong>{priceLabel(setup.cInvalidation)}</strong><small>{setup.d ? 'D has been touched, so this boundary no longer invalidates the setup.' : `A wick ${setup.direction === 'bullish' ? 'above' : 'below'} this price invalidates the pattern until D is touched.`}</small></div>
      <div><span>Stop reference · {setup.kind === 'butterfly' ? 'far edge of D' : 'X'}</span><strong>{priceLabel(setup.stopReference)}</strong><small>Stop belongs {setup.direction === 'bullish' ? 'below' : 'above'} this boundary. Buffer is manual.</small></div>
    </div>
    <section className="harmonic-quality" aria-label="Harmonic geometry diagnostics">
      <div className="harmonic-quality__heading"><strong>Ratio fit {quality.score.toFixed(1)} / 100</strong><Tag>{quality.phase === 'observed' ? 'D pivot observed' : 'Awaiting D pivot'}</Tag></div>
      <p className="harmonic-details__manual">This score measures only B and C against the lesson’s ideal ratio bands. It is a geometry comparison, not a probability of reversal. D and zone agreement are separate measurements; they do not change the score or accepted patterns.</p>
      <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Ratio fit and separate confluence measurements</caption><thead><tr><th>Measurement</th><th>Observed value</th><th>Fit / 100</th><th>Meaning</th></tr></thead><tbody>{quality.components.map((component) => <tr key={component.name}><th>{component.name}</th><td>{component.value === null ? 'Unavailable' : component.value.toFixed(4)}</td><td>{component.score === null ? '—' : component.score.toFixed(1)}</td><td>{component.detail}</td></tr>)}</tbody></table></div>
      <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Pattern timing · closed candles</caption><thead><tr><th>XA</th><th>AB</th><th>BC</th><th>CD to {setup.confirmedD ? 'confirmed pivot' : 'first touch'}</th><th>Elapsed since C</th><th>Duration asymmetry</th><th>Age / average XABC leg</th></tr></thead><tbody><tr><td>{quality.durations.xa}</td><td>{quality.durations.ab}</td><td>{quality.durations.bc}</td><td>{quality.durations.cd ?? 'Awaiting touch'}</td><td>{quality.durations.elapsedCd ?? '—'}</td><td>{quality.durationAsymmetry === null ? '—' : `${quality.durationAsymmetry.toFixed(1)}%`}</td><td>{quality.ageInLegs === null ? '—' : `${quality.ageInLegs.toFixed(2)}×`}</td></tr></tbody></table></div>
      <p className="harmonic-details__manual">Duration asymmetry compares each leg with the average of the other legs. It uses XA, AB and BC until a D pivot confirms. These timing measurements do not filter or expire live setups.</p>
      {setup.confirmedD && setup.dConfirmedAt !== null ? <p className="harmonic-details__manual">D pivot: {priceLabel(setup.confirmedD.price)} at {utc(setup.confirmedD.time)}. Available after confirmation at {utc(setup.dConfirmedAt)}. The first D touch and its target references remain fixed.</p> : <p className="harmonic-details__manual">{setup.d ? `First D touch: ${priceLabel(setup.d.price)} at ${utc(setup.d.time)}. A separate D pivot requires three closed candles on each side.` : 'D has not been touched. Its midpoint remains a projected reference.'}</p>}
    </section>
    <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Pattern measurements</caption><thead><tr><th>Leg</th><th>Measurement</th><th>Purpose</th></tr></thead><tbody>
      <tr><th>B / XA</th><td>{setup.bRatio.toFixed(4)}</td><td>Identifies {HARMONIC_NAMES[setup.kind]}</td></tr>
      <tr><th>C / AB</th><td>{setup.cRatio.toFixed(4)}</td><td>Valid within {HARMONIC_C_RANGE.join('–')}</td></tr>
      <tr><th>D / XA{setup.zoneNarrowed ? ' · base' : ''}</th><td>{setup.dRatioRange.map((value) => value.toFixed(4)).join('–')}</td><td>{setup.d ? 'Zone touched; reversal unconfirmed' : 'Projected zone'}</td></tr>
    </tbody></table></div>
    {batGeometry.applicable && <details className="harmonic-details__method">
      <summary>Optional strict Bat geometry · {batGeometry.passes === null ? 'awaiting observed D' : batGeometry.passes ? 'measurements within range' : 'outside stricter ranges'}</summary>
      <p className="harmonic-details__manual">Research comparison using narrower Bat ratios. The lecture pattern remains unchanged. D measurements use the first completed candle touching the zone, which is not a confirmed reversal pivot.</p>
      <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Strict Bat research profile</caption><thead><tr><th>Ratio</th><th>Observed</th><th>Research range</th><th>Result</th></tr></thead><tbody>{batGeometry.checks.map((check) => <tr key={check.name}><th>{check.name}</th><td>{check.value === null ? 'Awaiting D' : check.value.toFixed(4)}</td><td>{check.range.map((value) => value.toFixed(3)).join('–')}</td><td>{check.passed === null ? 'Unavailable' : check.passed ? 'Within range' : 'Outside range'}</td></tr>)}</tbody></table></div>
      <p className="harmonic-details__manual">AD / XA uses 0.886 ± 0.020. These measurements are separate context and do not establish a better-performing strategy.</p>
    </details>}
    {setup.kind === 'butterfly' && <p className="harmonic-details__manual">{setup.zoneNarrowed ? `D zone narrowed by B→C confluence. Original X→A zone: ${priceLabel(setup.baseZone.low)} – ${priceLabel(setup.baseZone.high)}.` : 'The B→C extension does not narrow this Butterfly. Its full X→A zone is shown.'}</p>}
    <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Take-profit references · {setup.kind === 'butterfly' ? 'C→D' : 'A→D'}</caption><thead><tr><th>Target</th><th>Ratio</th><th>Price</th></tr></thead><tbody>{targets.map((target, index) => <tr key={target.ratio}><th>TP {index + 1}</th><td>{target.ratio}</td><td>{priceLabel(target.price)}</td></tr>)}</tbody></table></div>
    <p className="harmonic-details__manual">{setup.d ? `Targets use the first closed D touch at ${priceLabel(setup.d.price)}.` : `Projected targets use the D zone midpoint at ${priceLabel((setup.zone.low + setup.zone.high) / 2)}; they will update when D is touched.`} Levels follow the video templates and do not imply an executed entry or a confirmed reversal.</p>
    <details className="harmonic-details__method"><summary>How this pattern is detected</summary><HarmonicGuide /></details>
    {research}
  </div>
}

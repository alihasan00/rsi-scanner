import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Alert, Select, Tag } from 'antd'
import type { RsiBar, Timeframe } from '../types'
import type { ScreenerMarket } from '../lib/markets'
import type { FibAnalysis } from '../lib/fibonacci'
import { useScannerStore } from '../store/scannerStore'
import { getFeedStatus, subscribeFeedStatus } from '../store/feedStatusStore'
import { useSrContext } from '../hooks/useSrContext'
import { useHigherTimeframe } from '../hooks/useHigherTimeframe'
import { defaultHigherTimeframe, higherTimeframeChoices } from '../lib/higherTimeframe'
import { analyzeSignalEvidence } from '../lib/signalEvidence'
import { getHarmonicAnalysis } from '../lib/harmonicScreener'
import { MarketStructurePanel } from './MarketStructurePanel'
import './SignalContextPanel.css'

const stamp = (time: number) => new Date(time).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

export function SignalContextPanel({ symbol, market, timeframe, bars, price, fib }: { symbol: string; market: ScreenerMarket; timeframe: Timeframe; bars: readonly RsiBar[]; price: number; fib: FibAnalysis }) {
  const [higher, setHigher] = useState<Timeframe | null>(() => defaultHigherTimeframe(timeframe))
  const [direction, setDirection] = useState<'all' | 'bullish' | 'bearish'>('all')
  const [triggersOnly, setTriggersOnly] = useState(false)
  const settings = useScannerStore((state) => state.settings)
  const fibOptions = useScannerStore((state) => state.fibSettings)
  const daily = useSrContext(symbol)
  const htf = useHigherTimeframe(symbol, market, higher)
  const subscribe = useCallback((notify: () => void) => subscribeFeedStatus(symbol, notify), [symbol])
  const getStatus = useCallback(() => getFeedStatus(symbol), [symbol])
  const feed = useSyncExternalStore(subscribe, getStatus, getStatus)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer) }, [])
  const stale = feed.state !== 'ready' || feed.updatedAt === null || now - feed.updatedAt > 60_000
  const harmonic = useMemo(() => getHarmonicAnalysis(`${market}:${timeframe}:${symbol}`, bars), [market, timeframe, symbol, bars])
  const result = useMemo(() => analyzeSignalEvidence({
    symbol, market, timeframe, bars, fibOptions, fibSnapshot: fib, harmonicSnapshot: harmonic,
    calendarMap: daily.status === 'ready' ? daily.map : null,
    higherTimeframe: htf.status === 'ready' ? htf.snapshot : null,
    divergenceOptions: { includeHidden: settings.showHiddenDivergences, requireBodyAgreement: settings.requireBodyAgreement, requireSameRsiCycle: settings.requireSameRsiCycle, invalidationAnchor: settings.divergenceInvalidationAnchor },
  }), [symbol, market, timeframe, bars, fib, harmonic, fibOptions, daily, htf.status, htf.snapshot, settings])
  const visible = result.items.filter((item) => (direction === 'all' || item.direction === direction) && (!triggersOnly || item.role === 'trigger'))
  return <div className="signal-context">
    <div className="signal-context__heading"><div><h3>Signal evidence</h3><p>{result.asOf === null ? 'Waiting for completed candles' : `At the ${stamp(result.asOf)} UTC close · ${timeframe}`}</p></div><div className="signal-context__higher"><label htmlFor="higher-timeframe">Higher timeframe</label><Select id="higher-timeframe" aria-label="Higher timeframe" value={higher} onChange={setHigher} disabled={higherTimeframeChoices(timeframe).length === 0} placeholder="Highest available" options={higherTimeframeChoices(timeframe).map((value) => ({ value, label: value }))} /></div></div>
    {stale && <Alert type="warning" showIcon title="Updates delayed · last known evidence" description="Wait for fresh market data before interpreting the signals below." />}
    {harmonic.continuity?.state === 'reset' && <Alert type="warning" showIcon title="Harmonic history rebuilt" description={harmonic.continuity.detail} />}
    {higher && htf.status !== 'ready' && <p role="status" className="signal-context__note">{htf.status === 'error' ? `${htf.error} Retrying automatically.` : `Loading completed ${higher} candles…`}</p>}
    {daily.status !== 'ready' && <p role="status" className="signal-context__note">{daily.status === 'error' ? `Daily context: ${daily.error} Retrying automatically.` : 'Loading calendar context…'}</p>}
    <div className="signal-context__summary"><Tag color="green">Bullish: {result.bullishFamilies.length} {result.bullishFamilies.length === 1 ? 'family' : 'families'}</Tag><Tag color="red">Bearish: {result.bearishFamilies.length} {result.bearishFamilies.length === 1 ? 'family' : 'families'}</Tag><strong>{result.conflict ? 'Mixed directions · inspect the conflicts' : result.items.length ? 'Evidence available for review' : 'No current directional evidence'}</strong></div>
    <p className="signal-context__note">Families group related observations: RSI signals together, Fib and harmonics together, and level sweeps together. Counts include context and triggers; they are not independent confirmations or a win probability. Higher-timeframe trend can oppose a reversal setup.</p>
    <div className="signal-context__filters"><Select aria-label="Evidence direction" value={direction} onChange={setDirection} options={[{ value: 'all', label: 'Both directions' }, { value: 'bullish', label: 'Bullish evidence' }, { value: 'bearish', label: 'Bearish evidence' }]} /><label><input type="checkbox" checked={triggersOnly} onChange={(event) => setTriggersOnly(event.target.checked)} /> Confirmed triggers only</label></div>
    <div className="signal-context__table-wrap"><table><caption>Evidence at the latest completed candle</caption><thead><tr><th>Source</th><th>Direction / role</th><th>Observation</th><th>Available</th></tr></thead><tbody>{visible.map((item) => <tr key={`${item.source}:${item.id}`}><th>{item.source}<small>{item.family}</small></th><td><span className={`is-${item.direction}`}>{item.direction}</span><small>{item.role}</small></td><td>{item.detail}{item.provenance.length > 1 && <small>{item.provenance.length} coincident references · one observation</small>}</td><td>{item.ageBars === 0 ? 'Latest close' : `${item.ageBars} ${timeframe} candles ago`}<small>{stamp(item.availableAt)} UTC</small></td></tr>)}{!visible.length && <tr><td colSpan={4}>No evidence matches this view.</td></tr>}</tbody></table></div>
    <details className="signal-context__missing"><summary>Missing or inactive evidence ({result.missing.length})</summary><ul>{result.missing.map((item) => <li key={item}>{item}</li>)}</ul></details>
    <MarketStructurePanel identity={`${market}:${timeframe}:${symbol}`} bars={bars} price={price} timeframe={timeframe} />
    <p className="signal-context__note">Signals use completed candles and their confirmation times. Level distances use the displayed price. Higher-timeframe history refreshes once a minute while this view is open.</p>
  </div>
}

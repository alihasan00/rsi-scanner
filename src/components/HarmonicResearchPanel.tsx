import { useEffect, useRef, useState } from 'react'
import { Alert, Button, InputNumber, Select, Space, Tag } from 'antd'
import { DownloadOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons'
import type { Timeframe } from '../types'
import { MARKETS } from '../lib/markets'
import type { ScreenerMarket } from '../lib/markets'
import type { HistoryProgress } from '../lib/binanceHistory'
import {
  defaultResearchExecution, RESEARCH_SAMPLE_CANDLES,
} from '../lib/strategyResearch'
import type { ResearchExecution, ResearchPartition } from '../lib/strategyResearch'
import { HARMONIC_RESEARCH_CANDIDATES, runHarmonicResearch, exportHarmonicResearchCsv } from '../lib/harmonicResearch'
import type { HarmonicResearchReport } from '../lib/harmonicResearch'
import './ResearchPanel.css'

export interface HarmonicResearchPanelProps { symbol: string; timeframe: Timeframe; market: ScreenerMarket }
type RunState =
  | { status: 'idle' }
  | { status: 'running'; progress: HistoryProgress | null; phase: string }
  | { status: 'done'; report: HarmonicResearchReport }
  | { status: 'error'; message: string }
const partitions: ResearchPartition[] = ['training', 'validation', 'holdout']
const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(2)}%`
const date = (time: number | null): string => time === null ? '—' : new Date(time).toISOString().slice(0, 16).replace('T', ' ')

function download(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Remount the complete run state on any market identity change. */
export function HarmonicResearchPanel(props: HarmonicResearchPanelProps) {
  return <ResearchRun key={`${props.market}:${props.symbol}:${props.timeframe}`} {...props} />
}

function ResearchRun({ symbol, timeframe, market }: HarmonicResearchPanelProps) {
  const [sampleCandles, setSampleCandles] = useState(RESEARCH_SAMPLE_CANDLES)
  const [execution, setExecution] = useState<{ [Key in keyof ResearchExecution]: number | null }>(() => defaultResearchExecution(market))
  const [endDate, setEndDate] = useState('')
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const running = run.status === 'running'
  const report = run.status === 'done' ? run.report : null
  const selected = report?.results.find((result) => result.candidate.id === report.selection.candidateId)

  async function start(): Promise<void> {
    if (Object.values(execution).some((value) => value === null)) {
      setRun({ status: 'error', message: 'Enter a value for every execution assumption before running the comparison.' })
      return
    }
    controller.current?.abort()
    const requestController = new AbortController()
    controller.current = requestController
    setRun({ status: 'running', progress: null, phase: 'Loading closed history…' })
    try {
      const result = await runHarmonicResearch({
        symbol, timeframe, market, sampleCandles, execution: execution as ResearchExecution,
        endTime: endDate ? Date.parse(`${endDate}T23:59:59.999Z`) : undefined,
        signal: requestController.signal,
        onProgress: (progress) => {
          if (!requestController.signal.aborted) setRun({ status: 'running', progress, phase: 'Loading closed history…' })
        },
        onPhase: (phase) => {
          if (!requestController.signal.aborted) setRun((previous) => ({ status: 'running', progress: previous.status === 'running' ? previous.progress : null, phase }))
        },
      })
      if (!requestController.signal.aborted) setRun({ status: 'done', report: result })
    } catch (cause) {
      if (!requestController.signal.aborted) setRun({ status: 'error', message: cause instanceof Error ? cause.message : 'Research evaluation failed' })
    }
  }
  function cancel(): void {
    controller.current?.abort()
    setRun({ status: 'idle' })
  }
  function executionInput(key: keyof ResearchExecution, label: string, min: number, max: number, step: number) {
    return (
      <label className="research-panel__field" key={key}>
        <span>{label}</span>
        <InputNumber
          aria-label={label} size="small" min={min} max={max} step={step}
          value={execution[key]} disabled={running}
          onChange={(value) => {
            setExecution((current) => ({ ...current, [key]: value }))
            setRun({ status: 'idle' })
          }}
        />
      </label>
    )
  }

  return (
    <section className="research-panel" aria-label="Harmonic research">
      <div className="research-panel__heading">
        <strong>Harmonic comparison on unseen periods</strong>
        <Tag>{MARKETS[market].venue} · {symbol} · {timeframe}</Tag>
      </div>
      <p>
        Compare the current D-touch rule with a minimum ratio-fit score, waiting for a confirmed D
        pivot, and expiry scaled to pattern length. All use the same lesson ratio bands.
        Results are for the selected market, pair and timeframe; live rules stay unchanged.
      </p>
      <p>
        The first 60% selects a candidate, the next 20% checks it, and the final 20% is the holdout.
        Selection freezes on training results before the later periods are evaluated. Ten training
        trades are required; otherwise the baseline is retained. The comparison table shows all four
        rules on the same dated splits. Use later unseen dates before changing live rules.
      </p>
      <details><summary>Rules being compared</summary><ul>{HARMONIC_RESEARCH_CANDIDATES.map((candidate) => <li key={candidate.id}><strong>{candidate.label}.</strong> {candidate.description}</li>)}</ul></details>
      <div className="research-panel__inputs">
        <label className="research-panel__field">
          <span>Sample after warmup</span>
          <Select
            aria-label="Harmonic research sample size" size="small" value={sampleCandles} disabled={running}
            options={[1_000, 5_000, 10_000, 30_000].map((value) => ({ value, label: `${value.toLocaleString()} candles` }))}
            onChange={(value) => { setSampleCandles(value); setRun({ status: 'idle' }) }} style={{ width: 145 }}
          />
        </label>
        <label className="research-panel__field">
          <span>Last UTC date (optional)</span>
          <input type="date" aria-label="Harmonic research last UTC date" value={endDate} disabled={running} onChange={(event) => { setEndDate(event.target.value); setRun({ status: 'idle' }) }} />
        </label>
        {executionInput('stopAtr', 'Stop × ATR', 0.1, 20, 0.1)}
        {executionInput('targetAtr', 'Target × ATR', 0.1, 20, 0.1)}
        {executionInput('maxHoldingBars', 'Time stop (bars)', 1, 250, 1)}
        {executionInput('forwardBars', 'Forward horizon (bars)', 1, 250, 1)}
        {executionInput('feeBps', 'Fee per side (bp)', 0, 500, 0.5)}
        {executionInput('slippageBps', 'Slippage per side (bp)', 0, 500, 0.5)}
        {executionInput('carryingBpsPerDay', 'Assumed carry (bp/day)', 0, 500, 0.5)}
      </div>
      <p className="research-panel__muted">
        Entry: next candle open after the rule becomes available. This comparison uses fixed ATR(14) stops and targets, one position at a time,
        1× equity. {market === 'spot' ? 'Spot trades are long-only.' : 'Futures tests both directions with an assumed daily carrying cost.'}
        {' '}These benchmark exits differ from the chart’s lesson stop and target references. 1 bp = 0.01%.
        Stop wins ambiguous same-bar touches. The full outcome horizon must remain inside its own period.
      </p>
      <Space wrap>
        {running
          ? <Button size="small" icon={<StopOutlined />} onClick={cancel}>Cancel research</Button>
          : <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => void start()}>Run comparison</Button>}
        {report && <>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => download(`${market}_${symbol}_${timeframe}_harmonic_research.csv`, exportHarmonicResearchCsv(report), 'text/csv')}>Export CSV</Button>
          <Button size="small" icon={<DownloadOutlined />} onClick={() => download(`${market}_${symbol}_${timeframe}_harmonic_research.json`, JSON.stringify(report, null, 2), 'application/json')}>Export full JSON</Button>
        </>}
      </Space>
      {run.status === 'running' && <p role="status">{run.phase} {run.progress && `${run.progress.fetched.toLocaleString()} / ${run.progress.requested.toLocaleString()} candles`}</p>}
      {run.status === 'error' && <Alert type="error" showIcon title="Research failed" description={run.message} />}
      {report && selected && <>
        {report.source.warnings.length > 0 && <Alert type="warning" showIcon title="Research limitations" description={<ul>{report.source.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>} />}
        <div className="research-panel__heading">
          <strong>{selected.candidate.label}</strong>
          <Tag color={report.selection.sufficientSample ? 'blue' : 'default'}>{report.selection.sufficientSample ? 'Frozen training selection' : 'Baseline · insufficient training sample'}</Tag>
        </div>
        <p className="research-panel__muted">Frozen {date(report.selection.frozenAt)} UTC · {report.source.loadedCandles.toLocaleString()} closed candles including warmup · Snapshot {date(report.source.asOf)} UTC. {report.selection.criterion}</p>
        <div className="research-panel__scroll" tabIndex={0} role="region" aria-label="Selected candidate results by period">
          <table>
            <caption>Selected candidate · realized trade outcomes after costs</caption>
            <thead><tr><th>Period (UTC)</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>Compounded return</th><th>Realized drawdown</th><th>Mean costs / trade</th></tr></thead>
            <tbody>{partitions.map((partition) => {
              const { summary, window, eventExclusions } = selected[partition]
              return <tr key={partition}>
                <th scope="row"><span className="research-panel__capitalize">{partition}</span><small>{date(window.startTime)} → {date(window.endTime)}</small><small>{window.candleCount.toLocaleString()} candles</small><small>Excluded: {eventExclusions.formationBoundary} patterns began before period; {eventExclusions.warmup} before warmup</small></th>
                <td>{summary.trades}</td><td>{percent(summary.winRate)}</td><td>{percent(summary.expectancy)}</td>
                <td>{percent(summary.compoundedReturn)}</td><td>{percent(summary.maxDrawdown)}</td>
                <td>{percent(summary.trades ? (summary.totalFees + summary.totalSlippage + summary.totalCarryingCost) / summary.trades : null)}</td>
              </tr>
            })}</tbody>
          </table>
        </div>
        <div className="research-panel__scroll" tabIndex={0} role="region" aria-label="Harmonic rule comparison on the holdout">
          <table>
            <caption>Harmonic rule comparison · same dated splits</caption>
            <thead><tr><th>Candidate</th><th>Training n / expectancy</th><th>Validation n / expectancy</th><th>Holdout n / expectancy</th><th>Holdout drawdown</th><th>Forward n / return</th><th>MFE / MAE</th></tr></thead>
            <tbody>{report.results.map((result) => <tr key={result.candidate.id} className={result.candidate.id === selected.candidate.id ? 'research-panel__selected' : undefined}>
              <th scope="row">{result.candidate.label}{result.candidate.id === selected.candidate.id && <small>Selected on training only</small>}</th>
              {partitions.map((partition) => <td key={partition}>{result[partition].summary.trades} / {percent(result[partition].summary.expectancy)}</td>)}
              <td>{percent(result.holdout.summary.maxDrawdown)}</td>
              <td>{result.holdout.summary.observations} / {percent(result.holdout.summary.meanForwardReturn)}</td>
              <td>{percent(result.holdout.summary.meanMfe)} / {percent(result.holdout.summary.meanMae)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="research-panel__muted">Forward outcomes cover {report.execution.forwardBars} bars from next-bar open, include both signal directions and can overlap. MFE/MAE are maximum favorable/adverse excursions before costs. These observation counts are not independent trades. Holdout comparisons do not reselect the winner.</p>
        <div className="research-panel__scroll" tabIndex={0} role="region" aria-label="Holdout cost sensitivity">
          <table>
            <caption>Selected candidate · holdout cost sensitivity</caption>
            <thead><tr><th>Cost assumption</th><th>Trades</th><th>Expectancy</th><th>Compounded return</th><th>Realized drawdown</th></tr></thead>
            <tbody>{report.costSensitivity.map(({ multiplier, evaluation }) => <tr key={multiplier}>
              <th scope="row">{multiplier === 0 ? 'Zero costs (comparison only)' : `${multiplier}× entered fees, slippage and carry`}</th>
              <td>{evaluation.summary.trades}</td><td>{percent(evaluation.summary.expectancy)}</td><td>{percent(evaluation.summary.compoundedReturn)}</td><td>{percent(evaluation.summary.maxDrawdown)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="research-panel__muted">The full X-to-signal pattern must form inside its period. Additional holdout exclusions: {selected.holdout.excluded.boundary} incomplete outcome horizons, {selected.holdout.excluded.gap} missing-data horizons, {selected.holdout.excluded.overlap} overlapping trades, {selected.holdout.excluded.spotShort} Spot shorts, {selected.holdout.excluded.atr} unavailable/invalid ATR, {selected.holdout.excluded.insolvent} after depleted equity.</p>
        <details>
          <summary>Methodology and recent holdout trades</summary>
          <p>{report.methodology}</p>
          <div className="research-panel__scroll" tabIndex={0} role="region" aria-label="Recent holdout trades">
            <table>
              <caption>Latest 20 holdout trades · full records and source candles in JSON</caption>
              <thead><tr><th>Direction</th><th>Entry (UTC)</th><th>Exit bar (UTC)</th><th>Exit</th><th>Gross return</th><th>Net return</th></tr></thead>
              <tbody>{selected.holdout.trades.slice(-20).map((trade) => <tr key={`${trade.signalId}:${trade.entryTime}`}>
                <th scope="row">{trade.direction === 'bullish' ? 'Long' : 'Short'}</th><td>{date(trade.entryTime)}</td><td>{date(trade.exitTime)}</td><td>{trade.reason}</td><td>{percent(trade.grossReturn)}</td><td>{percent(trade.netReturn)}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>
      </>}
    </section>
  )
}

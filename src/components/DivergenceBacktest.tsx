import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Select, Space, Typography } from 'antd'
import { DownloadOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons'
import type { HistoryProgress } from '../lib/binanceHistory'
import {
  BACKTEST_SAMPLE_CANDLES,
  divergenceBacktestsToCsv,
  runDivergenceBacktest,
} from '../lib/divergenceBacktest'
import type { BacktestSummary, DivergenceBacktestReport } from '../lib/divergenceBacktest'
import type { DivergenceLifecycleOptions } from '../lib/divergenceLifecycle'
import { DIVERGENCE_LABELS, formatSignalTime } from '../lib/divergencePresentation'
import type { Timeframe } from '../types'

const { Text } = Typography

const SAMPLE_OPTIONS = [1_000, 3_000, 10_000, 30_000].map((value) => ({
  value, label: `${value.toLocaleString('en-US')} candles`,
}))

interface DivergenceBacktestProps {
  symbol: string
  timeframe: Timeframe
  options: Partial<DivergenceLifecycleOptions>
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; progress: HistoryProgress | null }
  | { status: 'done'; report: DivergenceBacktestReport }
  | { status: 'error'; message: string }

function percent(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
}

function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.download = filename
  link.href = url
  link.click()
  URL.revokeObjectURL(url)
}

function SummaryRow({ label, summary }: { label: string; summary: BacktestSummary }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{summary.detected}</td>
      <td>{summary.confirmed}</td>
      <td>{summary.targetHits}</td>
      <td>{summary.confirmedHarmonised}</td>
      <td>{summary.expired}</td>
      <td>
        <strong>{percent(summary.targetHitRate)}</strong>
        <small>{summary.denominator} resolved</small>
      </td>
    </tr>
  )
}

/**
 * Historical replay of the exact card state machine for one symbol. The run is
 * keyed by symbol and timeframe from the parent, so a report never outlives the
 * chart it was computed for.
 */
export function DivergenceBacktest({ symbol, timeframe, options }: DivergenceBacktestProps) {
  const [sampleCandles, setSampleCandles] = useState(BACKTEST_SAMPLE_CANDLES)
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])

  async function start(): Promise<void> {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setRun({ status: 'running', progress: null })
    try {
      const report = await runDivergenceBacktest({
        symbol, timeframe, sampleCandles, options, signal: controller.signal,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setRun({ status: 'running', progress })
        },
      })
      if (!controller.signal.aborted) setRun({ status: 'done', report })
    } catch (error) {
      if (controller.signal.aborted) return
      setRun({ status: 'error', message: error instanceof Error ? error.message : 'Backtest failed' })
    }
  }

  function stop(): void {
    controllerRef.current?.abort()
    controllerRef.current = null
    setRun({ status: 'idle' })
  }

  const report = run.status === 'done' ? run.report : null
  const running = run.status === 'running'
  const kinds = (['regular-bullish', 'regular-bearish', 'hidden-bullish', 'hidden-bearish'] as const)
    .filter((kind) => options.includeHidden || !kind.startsWith('hidden'))

  return (
    <section className="divergence-backtest" aria-label="Divergence backtest">
      <div className="divergence-details__heading">
        <strong>Historical replay</strong>
        <Space size="small" wrap>
          <Select
            aria-label="Backtest sample size"
            size="small"
            value={sampleCandles}
            options={SAMPLE_OPTIONS}
            onChange={setSampleCandles}
            disabled={running}
            style={{ width: 150 }}
          />
          {running ? (
            <Button size="small" icon={<StopOutlined />} onClick={stop}>Stop</Button>
          ) : (
            <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={() => void start()}>
              Run backtest
            </Button>
          )}
          {report && (
            <>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => downloadText(
                  `${symbol}_${timeframe}_divergence_backtest.csv`,
                  divergenceBacktestsToCsv([report]),
                  'text/csv',
                )}
              >
                CSV
              </Button>
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={() => downloadText(
                  `${symbol}_${timeframe}_divergence_backtest.json`,
                  JSON.stringify(report, null, 2),
                  'application/json',
                )}
              >
                JSON
              </Button>
            </>
          )}
        </Space>
      </div>
      <p className="divergence-details__note">
        Fetches closed {timeframe} candles from Binance, adds a 250-candle RSI warmup, and replays the
        current detection, confirmation, invalidation, RSI 50 target, and 14-candle expiry rules.
        The hit rate counts RSI 50 targets, not profit, and is not a trade record.
      </p>
      {running && (
        <p className="divergence-details__note" role="status">
          Loading history… {run.progress ? `${run.progress.fetched.toLocaleString('en-US')} / ${run.progress.requested.toLocaleString('en-US')} candles` : 'contacting Binance'}
        </p>
      )}
      {run.status === 'error' && (
        <Alert type="error" showIcon title="Backtest failed" description={run.message} />
      )}
      {report && (
        <>
          <p className="divergence-details__note">
            {report.window.evaluatedCandles.toLocaleString('en-US')} candles evaluated
            {report.window.startTime !== null && report.window.endTime !== null && (
              <> · {formatSignalTime(report.window.startTime)} → {formatSignalTime(report.window.endTime)} UTC</>
            )}
            {' · '}Snapshot {formatSignalTime(report.source.asOf)} UTC
            {report.window.gaps > 0 && <> · {report.window.gaps} history gap{report.window.gaps === 1 ? '' : 's'}</>}
          </p>
          {report.source.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title={report.source.complete ? 'Notes' : 'Partial history'}
              description={<ul className="divergence-backtest__warnings">{report.source.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            />
          )}
          <div className="divergence-details__scroll" tabIndex={0} role="region" aria-label="Backtest summary">
            <table className="divergence-details__table divergence-backtest__table">
              <thead>
                <tr>
                  <th scope="col">Pattern</th>
                  <th scope="col">Detected</th>
                  <th scope="col">Confirmed</th>
                  <th scope="col">RSI 50 hit</th>
                  <th scope="col">Harmonised</th>
                  <th scope="col">Expired</th>
                  <th scope="col">Hit rate</th>
                </tr>
              </thead>
              <tbody>
                <SummaryRow label="All patterns" summary={report.summary} />
                {kinds.map((kind) => (
                  <SummaryRow key={kind} label={DIVERGENCE_LABELS[kind]} summary={report.byKind[kind]} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="divergence-details__note">
            Excluded from the hit rate: {report.summary.excluded.unconfirmed} unconfirmed,
            {' '}{report.summary.excluded.preconfirmationHarmonised} harmonised before confirmation,
            {' '}{report.summary.excluded.confirmationTarget} reached RSI 50 on the confirmation candle,
            {' '}{report.summary.excluded.stillOpen} still open, {report.summary.excluded.interrupted} interrupted.
          </p>
          <Text type="secondary" style={{ fontSize: 11 }}>{report.methodology}</Text>
        </>
      )}
    </section>
  )
}

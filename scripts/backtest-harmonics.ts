/** Closed-history harmonic event comparison, with an explicit fixed ATR benchmark. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Candle, Timeframe } from '../src/types'
import type { ClosedCandleHistory } from '../src/lib/binanceHistory'
import type { ScreenerMarket } from '../src/lib/markets'
import type { ResearchExecution } from '../src/lib/strategyResearch'
import { evaluateHarmonicResearch, exportHarmonicResearchCsv, runHarmonicResearch } from '../src/lib/harmonicResearch'
import type { HarmonicResearchReport, HarmonicResearchRequest } from '../src/lib/harmonicResearch'

const HELP = `Usage: bun run backtest:harmonics -- --symbol BTCUSDT --timeframe 4h --market spot --candles 5000
  --market spot|tradfi      Binance Spot or Futures history (default spot)
  --symbol SYMBOL          One symbol per report (default BTCUSDT)
  --timeframe 1h            Scanner timeframe (default 4h)
  --candles 5000            Evaluated candles, plus 250 warmup (500–30000)
  --end 2026-08-31          Inclusive final UTC date, optional
  --minimum-trades 10       Minimum training trades before selecting a candidate
  --fee-bps 10              Execution fee, per side
  --slippage-bps 2          Adverse execution slippage, per side
  --carry-bps 0             Assumed daily carry, not actual funding history
  --stop-atr 1.5            Fixed stop distance in event-close ATR(14)
  --target-atr 3            Fixed target distance in event-close ATR(14)
  --holding-bars 20         Maximum holding period
  --forward-bars 10         Forward observation period
  --input path.json        Offline candle array or prior harmonic report
  --json path.json          Full report, frozen events, candles and trade records
  --csv path.csv            Candidate/partition summaries and exclusions
  --help                   Show this help
Compares first D touch, ratio fit ≥80, confirmed D pivot and proportional expiry.
Entries are at the next open, with fixed ATR stops/targets. This benchmark does
not execute the lecture's D-zone entry, X/D stop or target-reference rules.
Replaying a harmonic report restores its identity, sample and execution settings
unless explicitly overridden. No settings are applied to the live scanner.`

async function save(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function main(): Promise<void> {
  const flags = new Map<string, string>()
  const allowed = new Set(['symbol', 'timeframe', 'market', 'candles', 'end', 'minimum-trades', 'fee-bps', 'slippage-bps', 'carry-bps', 'stop-atr', 'target-atr', 'holding-bars', 'forward-bars', 'json', 'csv', 'input'])
  const args = process.argv.slice(2).filter((arg) => arg !== '--')
  if (args.includes('--help')) { console.log(HELP); return }
  for (let index = 0; index < args.length; index++) {
    const name = args[index].replace(/^--/, '')
    if (!args[index].startsWith('--') || !allowed.has(name)) throw new Error(`Unknown option: ${args[index]}`)
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`)
    if (flags.has(name)) throw new Error(`Duplicate option: --${name}`)
    flags.set(name, value)
  }
  let offline: Candle[] | null = null
  let previous: HarmonicResearchReport | null = null
  if (flags.has('input')) {
    const parsed: unknown = JSON.parse(await readFile(flags.get('input')!, 'utf8'))
    if (Array.isArray(parsed)) offline = parsed as Candle[]
    else if (parsed && typeof parsed === 'object' && 'study' in parsed && parsed.study === 'harmonic-atr-benchmark' && 'candles' in parsed && Array.isArray(parsed.candles)) {
      previous = parsed as HarmonicResearchReport
      offline = previous.candles
    } else throw new Error('Input must be a candle array or an exported harmonic research report')
  }
  const execution: Partial<ResearchExecution> = { ...previous?.execution }
  const executionFlags: [string, keyof ResearchExecution][] = [
    ['fee-bps', 'feeBps'], ['slippage-bps', 'slippageBps'], ['carry-bps', 'carryingBpsPerDay'],
    ['stop-atr', 'stopAtr'], ['target-atr', 'targetAtr'], ['holding-bars', 'maxHoldingBars'], ['forward-bars', 'forwardBars'],
  ]
  for (const [flag, key] of executionFlags) if (flags.has(flag)) execution[key] = Number(flags.get(flag))
  const endDate = flags.get('end')
  if (endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !Number.isFinite(Date.parse(`${endDate}T00:00:00Z`)) || new Date(`${endDate}T00:00:00Z`).toISOString().slice(0, 10) !== endDate)) throw new Error('--end must be a real YYYY-MM-DD date')
  const request: HarmonicResearchRequest = {
    symbol: flags.get('symbol') ?? previous?.symbol ?? 'BTCUSDT',
    timeframe: (flags.get('timeframe') ?? previous?.timeframe ?? '4h') as Timeframe,
    market: (flags.get('market') ?? previous?.market ?? 'spot') as ScreenerMarket,
    sampleCandles: Number(flags.get('candles') ?? previous?.source.requestedCandles ?? 5_000),
    minimumTrainingTrades: Number(flags.get('minimum-trades') ?? previous?.selection.minimumTrainingTrades ?? 10),
    execution,
    endTime: endDate ? Date.parse(`${endDate}T23:59:59.999Z`) : previous?.source.asOf,
  }
  if (previous) for (const key of ['symbol', 'timeframe', 'market'] as const) {
    if (previous[key] !== request[key]) throw new Error(`Offline report ${key} differs from the requested ${request[key]}`)
  }
  const source: ClosedCandleHistory | undefined = previous ? {
    symbol: previous.symbol, timeframe: previous.timeframe, market: previous.market, candles: previous.candles,
    requestedCount: previous.source.requestedCandles + 250, serverTime: previous.source.asOf + 1,
    asOf: previous.source.asOf, complete: previous.source.complete, warnings: previous.source.warnings, error: null,
  } : undefined
  const report = offline ? evaluateHarmonicResearch(offline, request, source) : await runHarmonicResearch(request)
  const percentage = (value: number | null) => value === null ? 'n/a' : `${(100 * value).toFixed(2)}%`
  console.log(`${report.market} ${report.symbol} ${report.timeframe}: ${report.source.loadedCandles} closed candles; fixed ATR benchmark`)
  console.log(`Frozen candidate: ${report.selection.candidateId}; ${report.selection.sufficientSample ? 'training minimum met' : 'insufficient training sample; baseline fallback'}`)
  console.table(report.results.map((result) => ({
    candidate: result.candidate.label,
    trainingN: result.training.summary.trades, trainingMean: percentage(result.training.summary.expectancy),
    validationN: result.validation.summary.trades, validationMean: percentage(result.validation.summary.expectancy),
    holdoutN: result.holdout.summary.trades, holdoutMean: percentage(result.holdout.summary.expectancy),
    holdoutDrawdown: percentage(result.holdout.summary.maxDrawdown),
  })))
  for (const warning of report.source.warnings) console.log(`Note: ${warning}`)
  console.log(report.methodology)
  if (flags.has('json')) await save(flags.get('json')!, JSON.stringify(report, null, 2) + '\n')
  if (flags.has('csv')) await save(flags.get('csv')!, exportHarmonicResearchCsv(report))
}

if (import.meta.main) main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
})

/** Repeatable closed-history research; every exported report retains market identity. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Candle, Timeframe } from '../src/types'
import type { ScreenerMarket } from '../src/lib/markets'
import { evaluateStrategyResearch, runStrategyResearch, strategyResearchToCsv } from '../src/lib/strategyResearch'
import type { ResearchExecution, ResearchRequest } from '../src/lib/strategyResearch'

const HELP = `Usage: bun run backtest:research -- --symbol BTCUSDT --timeframe 4h --market spot --candles 5000
  --market spot|tradfi      Binance Spot or Futures history (default spot)
  --symbol SYMBOL          One symbol per report (default BTCUSDT)
  --timeframe 1h            Scanner timeframe (default 4h)
  --candles 5000            Evaluated candles, plus 250 warmup (500–30000)
  --end 2026-08-31          Inclusive final UTC date, optional
  --fee-bps 10              Execution fee, per side
  --slippage-bps 2          Adverse execution slippage, per side
  --carry-bps 0             Assumed daily carry, not actual funding history
  --stop-atr 1.5            Fixed stop distance in confirmation ATR(14)
  --target-atr 3            Fixed target distance in confirmation ATR(14)
  --holding-bars 20         Maximum holding period
  --forward-bars 10         Forward observation period
  --input path.json        Offline candle array or previous report JSON
  --json path.json          Full report, including candles and trade records
  --csv path.csv            Candidate/partition summary table
  --help                   Show this help
No settings are applied to the live scanner. For multiple symbols/timeframes, run separate reports.`

async function save(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

async function main(): Promise<void> {
  const flags = new Map<string, string>()
  const allowed = new Set(['symbol', 'timeframe', 'market', 'candles', 'end', 'fee-bps', 'slippage-bps', 'carry-bps', 'stop-atr', 'target-atr', 'holding-bars', 'forward-bars', 'json', 'csv', 'input'])
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
  const execution: Partial<ResearchExecution> = {}
  const executionFlags: [string, keyof ResearchExecution][] = [
    ['fee-bps', 'feeBps'], ['slippage-bps', 'slippageBps'], ['carry-bps', 'carryingBpsPerDay'],
    ['stop-atr', 'stopAtr'], ['target-atr', 'targetAtr'], ['holding-bars', 'maxHoldingBars'], ['forward-bars', 'forwardBars'],
  ]
  for (const [flag, key] of executionFlags) if (flags.has(flag)) execution[key] = Number(flags.get(flag))
  const endDate = flags.get('end')
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error('--end must be YYYY-MM-DD')
  if (endDate && new Date(`${endDate}T00:00:00Z`).toISOString().slice(0, 10) !== endDate) throw new Error('--end must be a real calendar date')
  const request: ResearchRequest = {
    symbol: flags.get('symbol') ?? 'BTCUSDT', timeframe: (flags.get('timeframe') ?? '4h') as Timeframe,
    market: (flags.get('market') ?? 'spot') as ScreenerMarket,
    sampleCandles: Number(flags.get('candles') ?? 5_000), execution,
    endTime: endDate ? Date.parse(`${endDate}T23:59:59.999Z`) : undefined,
  }
  let offline: Candle[] | null = null
  if (flags.has('input')) {
    const parsed: unknown = JSON.parse(await readFile(flags.get('input')!, 'utf8'))
    if (Array.isArray(parsed)) offline = parsed as Candle[]
    else if (parsed && typeof parsed === 'object' && 'candles' in parsed && Array.isArray(parsed.candles)) {
      for (const key of ['symbol', 'timeframe', 'market'] as const) {
        if (key in parsed && parsed[key as keyof typeof parsed] !== request[key]) throw new Error(`Offline report ${key} differs from the requested ${request[key]}`)
      }
      offline = parsed.candles as Candle[]
    } else throw new Error('Input must be a candle array or an exported research report')
  }
  const report = offline ? evaluateStrategyResearch(offline, request) : await runStrategyResearch(request)
  const percentage = (value: number | null) => value === null ? 'n/a' : `${(100 * value).toFixed(2)}%`
  console.log(`${report.market} ${report.symbol} ${report.timeframe}: ${report.source.loadedCandles} closed candles`)
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
  if (flags.has('csv')) await save(flags.get('csv')!, strategyResearchToCsv(report))
}

if (import.meta.main) main().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
})

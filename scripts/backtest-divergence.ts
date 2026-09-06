/**
 * Historical RSI divergence backtest over Binance spot candles.
 *
 *   bun run backtest:divergence -- --timeframe 4h --symbols BTCUSDT,ETHUSDT --candles 3000
 *   bun run backtest:divergence -- --timeframe 1d --csv out/1d.csv --json out/1d.json
 *
 * Flags: --symbols a,b,c (default: every scanner symbol) · --timeframe 4h ·
 * --candles 3000 · --hidden · --no-body · --no-cycle · --anchor first|second ·
 * --concurrency 1 · --csv path · --json path
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import {
  BACKTEST_SAMPLE_CANDLES,
  divergenceBacktestsToCsv,
  runDivergenceBacktest,
  summarizeDivergenceSetups,
} from '../src/lib/divergenceBacktest'
import type { BacktestSummary, DivergenceBacktestReport } from '../src/lib/divergenceBacktest'
import type { DivergenceLifecycleOptions } from '../src/lib/divergenceLifecycle'
import { SYMBOLS } from '../src/lib/symbols'
import type { Timeframe } from '../src/types'

interface CliArgs {
  symbols: string[]
  timeframe: Timeframe
  candles: number
  concurrency: number
  csv: string | null
  json: string | null
  options: Partial<DivergenceLifecycleOptions>
}

function parseArgs(argv: readonly string[]): CliArgs {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const [name, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) flags.set(name, inlineValue)
    else if (argv[index + 1] !== undefined && !argv[index + 1].startsWith('--')) flags.set(name, argv[++index])
    else flags.set(name, true)
  }
  const text = (name: string): string | null => {
    const value = flags.get(name)
    return typeof value === 'string' ? value : null
  }
  const timeframe = (text('timeframe') ?? '4h') as Timeframe
  if (!Object.hasOwn(TIMEFRAME_MILLISECONDS, timeframe)) throw new Error(`Unsupported timeframe: ${timeframe}`)
  const candles = Number(text('candles') ?? BACKTEST_SAMPLE_CANDLES)
  const concurrency = Number(text('concurrency') ?? 1)
  const anchor = text('anchor') ?? 'second'
  if (anchor !== 'first' && anchor !== 'second') throw new Error('--anchor must be first or second')
  return {
    symbols: text('symbols')?.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean) ?? [...SYMBOLS],
    timeframe,
    candles,
    concurrency: Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : 1,
    csv: text('csv'),
    json: text('json'),
    options: {
      includeHidden: flags.has('hidden'),
      requireBodyAgreement: !flags.has('no-body'),
      requireSameRsiCycle: !flags.has('no-cycle'),
      invalidationAnchor: anchor,
    },
  }
}

function percent(rate: number | null): string {
  return rate === null ? '    —' : `${(rate * 100).toFixed(1).padStart(5)}%`
}

function row(label: string, summary: BacktestSummary, note = ''): string {
  return [
    label.padEnd(12),
    String(summary.detected).padStart(8),
    String(summary.confirmed).padStart(9),
    String(summary.targetHits).padStart(6),
    String(summary.confirmedHarmonised).padStart(11),
    String(summary.expired).padStart(8),
    percent(summary.targetHitRate).padStart(9),
    note,
  ].join('  ')
}

async function writeOutput(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const reports: DivergenceBacktestReport[] = []
  const failures: string[] = []
  const queue = [...args.symbols]
  console.log(`Backtesting ${queue.length} symbol(s) on ${args.timeframe}, ${args.candles} candles each, options ${JSON.stringify(args.options)}`)

  async function worker(): Promise<void> {
    for (let symbol = queue.shift(); symbol !== undefined; symbol = queue.shift()) {
      try {
        const report = await runDivergenceBacktest({
          symbol, timeframe: args.timeframe, sampleCandles: args.candles, options: args.options,
        })
        reports.push(report)
        const note = report.source.complete ? '' : `partial (${report.window.loadedCandles} loaded)`
        console.log(row(symbol, report.summary, note))
      } catch (error) {
        failures.push(`${symbol}: ${error instanceof Error ? error.message : String(error)}`)
        console.log(`${symbol.padEnd(12)}  failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  console.log(['symbol'.padEnd(12), 'detected', 'confirmed', '50 hit', 'harmonised', 'expired', ' hit rate'].join('  '))
  await Promise.all(Array.from({ length: Math.min(args.concurrency, queue.length) }, worker))

  reports.sort((left, right) => left.symbol.localeCompare(right.symbol))
  const setups = reports.flatMap((report) => report.setups)
  console.log('')
  console.log(row('ALL', summarizeDivergenceSetups(setups), `${reports.length} symbols`))
  for (const kind of ['regular-bullish', 'regular-bearish', 'hidden-bullish', 'hidden-bearish'] as const) {
    const subset = setups.filter((setup) => setup.kind === kind)
    if (subset.length > 0 || !kind.startsWith('hidden')) console.log(row(kind, summarizeDivergenceSetups(subset)))
  }
  const excluded = summarizeDivergenceSetups(setups).excluded
  console.log(`\nExcluded from hit rate: ${excluded.unconfirmed} unconfirmed, ${excluded.preconfirmationHarmonised} harmonised before confirmation, `
    + `${excluded.confirmationTarget} reached 50 on the confirmation candle, ${excluded.stillOpen} still open, ${excluded.interrupted} interrupted.`)
  if (failures.length > 0) console.log(`\n${failures.length} symbol(s) failed:\n  ${failures.join('\n  ')}`)
  if (reports.length > 0) console.log(`\n${reports[0].methodology}`)

  if (args.csv) {
    await writeOutput(args.csv, divergenceBacktestsToCsv(reports))
    console.log(`\nCSV written to ${args.csv}`)
  }
  if (args.json) {
    await writeOutput(args.json, JSON.stringify(reports, null, 2))
    console.log(`JSON written to ${args.json}`)
  }
  if (reports.length === 0) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

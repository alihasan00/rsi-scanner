import { SYMBOLS } from '../src/lib/symbols'

// Reports configured pairs that are not currently trading on Binance Spot, so
// halted or delisted pairs can be removed instead of showing as stuck cards.

interface ExchangeSymbol {
  symbol: string
  status: string
  quoteAsset: string
  isSpotTradingAllowed: boolean
}

const response = await fetch('https://api.binance.com/api/v3/exchangeInfo')
if (!response.ok) throw new Error(`exchangeInfo failed: ${response.status}`)
const info = await response.json() as { symbols: ExchangeSymbol[] }
const bySymbol = new Map(info.symbols.map((entry) => [entry.symbol, entry]))

const problems = SYMBOLS.flatMap((symbol) => {
  const entry = bySymbol.get(symbol)
  if (!entry) return [`${symbol}: not listed on spot`]
  if (entry.status !== 'TRADING') return [`${symbol}: status ${entry.status}`]
  if (!entry.isSpotTradingAllowed) return [`${symbol}: spot trading not allowed`]
  if (entry.quoteAsset !== 'USDT') return [`${symbol}: quote asset ${entry.quoteAsset}`]
  return []
})

const duplicates = SYMBOLS.filter((symbol, index) => SYMBOLS.indexOf(symbol) !== index)
for (const symbol of duplicates) problems.push(`${symbol}: duplicated`)

if (problems.length === 0) {
  console.log(`All ${SYMBOLS.length} pairs are trading on Binance Spot.`)
} else {
  console.error(`${problems.length} of ${SYMBOLS.length} pairs need attention:`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

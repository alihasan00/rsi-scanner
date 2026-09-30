# Shared Go watchlist engine

This subtree embeds the scanner from Go crypto dashboard release
`0.13.1-26e07587190d` (upstream scan schema 12). Its local extension serves
the separate Ichimoku Cloud screen and ports the sibling crypto project's
twelve earlier profiles plus five combinations from 30 September 2026, into the
mixed Watchlist. The browser supplies completed candle histories; a Web Worker
executes the Go code as WebAssembly. There is no local server, database, AI
worker, account ledger or trading action.

The frozen upstream files and their SHA256 hashes are recorded in
`provenance.json`, extracted from that release's verified `source.tar.gz`.
The harmonic detector, regime, structure and historical selection calculations
are retained in the source tree, but the mixed Watchlist selects only the
17 paper profiles. The original production source adaptation replaces the
database adapter's `cachefeed.BoundaryGrace` import with existing
`market.BoundaryGrace`; both constants are exactly five seconds. Two tests use
the same alias adaptation. This keeps the dependency closure in Go's standard
library. Copyright and license notices remain in the imported files; see
`THIRD_PARTY_NOTICES.md`.

The dedicated Ichimoku extension adds the lecture measurement/plot contract,
TK/PK Kijun retests and cloud edge-to-edge strategies, and improves cloud-zone
retests. The mixed extension adds the paper roster and its source-frame plans.
`provenance.json` preserves upstream hashes and records local amendments. See
[the paper profile rules](../docs/watchlist.md) and [Ichimoku source coverage](../docs/ichimoku-lecture.md).

## Browser interface

Load the committed `public/watchlist-wasm-exec.js` and instantiate
`public/watchlist-engine.wasm` in a worker using Go's runtime. After `go.run`
initializes, the worker has a synchronous function:

```ts
globalThis.goWatchlistScan(JSON.stringify({
  now: Date.now(),
  scope: 'all', // mixed paper roster; 'ichimoku' is the separate indicator screen
  // timeframe: '4h', // Ichimoku only: one chosen chart period, default '1h'
  symbols: ['BTCUSDT'],
  histories: [{
    symbol: 'BTCUSDT',
    timeframe: '1d', // also supply 4h and 15m for the range and envelope profiles
    candles: [{ openTime, closeTime, open, high, low, close, volume }],
    preview: { openTime, closeTime, open, high, low, close, volume },
    receivedAt: successfulProviderReceiptInMilliseconds,
    status: 'ready', // 'error' fails this frame, even if old candles remain
    error: null,
  }],
}))
```

Timestamps are milliseconds, with inclusive Binance candle closing times.
Supply up to the latest **500 completed candles plus the current provisional
candle** for each requested frame. Request 501 exchange klines to obtain that
window; requesting 500 usually returns only 499 completed candles. For mixed 15m, request 1000 klines and supply up to 999 completed candles plus
a preview; the first NWE crossing needs 999 completed bars. Dedicated Ichimoku
retains 500 bars on every timeframe. A genuinely
shorter history is allowed, subject to each paper family's warmup requirement.
Unsorted, overlapping, duplicated, missing or invalid candles are not repaired.
The provisional candle can supply a live quote, but never enters indicators or
the mixed paper plan's completed-close assessment.

The adapter preserves each successful receipt timestamp. Stale input, missing
or invalid frames, and provider errors become per-frame scanner errors. A recent receipt
does not make a missing latest candle fresh. The deployed `--max-cache-age`
default is two minutes, retained here and returned as `maxAgeMs: 120000`.
The selector independently requires expected latest closes and complete
evidence on a profile's own frame: `1d` for fourteen mixed profiles, `4h` for
two range profiles and `15m` for the envelope combination. Each frame can qualify without the other. The
dedicated Ichimoku tab requires only its selected timeframe. Do not overwrite
receipts on cached reads or when the watchlist is opened.

The returned JSON contains:

```ts
{
  version: string, // exact local revision recorded in provenance.json
  scope: 'all', // echoed normalized scope; 'all' when omitted
  sourceHash: '26e07587190d24c66d62602e968ef24dafafb281b9b1a0140afa7f6c6d0a0d00',
  now: number,
  maxAgeMs: 120000,
  result: {
    config, items: [], trends: [],
    strategies: { items: StrategyCandidate[], limit: 0, /* summaries and coverage */ },
    breadth, benchmarks, examined, eligible, directionFiltered, costFiltered,
    limit: 0,
  },
  scan: { series, errors, progress: { done, total } },
  error?: string,
}
```

The mixed `result` retains the surrounding `selection.Result` schema but uses
only `result.strategies.items`. Its `items` and `trends` are empty; neither the
engine nor UI applies the old 12-item/asset cap. Candidates can have a
`ready_for_review` plan or a blocked plan status. Every mixed candidate's
`family` must be one of the 17 IDs in `internal/strategies/paper_catalog.go`,
and its interval must be that family's declared `1d`, `4h` or `15m` frame. `result`
is absent on invalid top-level input.

With `scope: 'ichimoku'`, `timeframe` selects one of `1m`, `3m`, `5m`, `15m`,
`30m`, `1h`, `2h`, `4h`, `8h`, `1d`, `3d` or `1w` (default `1h` when omitted).
`selection.BuildIchimokuTimeframe` discovers only the five Ichimoku families on
that timeframe and returns all active observations with `limit: 0`. Only the
selected history is read. It supplies the quote, triggers, entry validation and
subsequent stop/target checks; there is no automatic 15m or higher-frame gate.
Unrelated supplied histories cannot affect the scan. Monday weekly boundaries
and the exchange's three-day phase are retained. Harmonic/trend lists are empty,
terminal observations are excluded, and the existing cost and plan rules apply.
The response echoes the selected `timeframe` for Ichimoku only. Invalid scopes
or unsupported Ichimoku timeframes are rejected. The browser includes scope and
timeframe in its evaluation identity and validates both before publishing.
`scan.series` is a compact diagnostic list: symbol, interval, price,
priceSource, observedAt, lastClosedAt, closedCandles, ready, trend, momentum,
internalBias, warnings and `ichimoku` lecture readings on valid frames.
Selected assets also carry `ichimokuSeries` chart coordinates on each frame.
The readings distinguish current displayed spans from known forward display
positions. Every value comes from completed scanner history; previews never
enter Ichimoku. The dedicated view groups all active setups by asset, without
a display cap.

The mixed scanner requests daily, four-hour and fifteen-minute histories and calls
`selection.BuildPaperWatchlist`. Four daily Donchian variants, six daily cloud
reclaim variants, daily TK cross with RSI and four-hour fresh weekly rebound
are joined by five combinations (see [port notes](../docs/combinations-port.md)). Each profile's indicators and trigger use
completed source candles. Donchian filters are checked on the breakout close;
cloud and TK filters are frozen at first raw eligibility, so a later favorable
indicator cannot revive a rejected identity. The separate Ichimoku scope
retains every timeframe in its picker, including 15m.

The paper plan checks the latest completed close and frozen stop, entry band,
target and expiry where applicable. Donchian has no fixed profit target or
fabricated target reward/risk: it carries an initial 2-ATR stop, a non-widening
3.5-ATR trail after completed daily closes, an exit after a close below the
preceding 20 lows, and a 96-daily-bar maximum hold. Cloud plans expose their
original structural target. A farther target is capped at net 2R only after
an actual opening, adverse slippage and all-in risk are known. TK and weekly
plans retain their frozen target and 24-source-bar maximum hold; the weekly
entry additionally requires at least 3% raw opening-to-stop distance. The
forward paper trial considers the next whole one-minute opening after
observation and checks intervening minute candles for protective touches.
This browser has only daily, four-hour and fifteen-minute source candles for mixed profiles;
it cannot verify that minute path, an opening fill, amended trailing stop or
realized exit from the signal card.

Fixed-target plans use the reference cost model of 20bps fees plus 10bps
slippage/spread round trip and minimum net reward/risk 1. These are screening
assumptions, not measured fees or executable quantities. The sibling crypto
project computes indicators over full stored contiguous history. This browser
retains 500 daily/4h and 999 mixed 15m completed candles, so recursive indicators and
even the latest profile signal can differ from the source dashboard.
Identical valid inputs produce identical native and WebAssembly decisions here;
full source-project history parity is unavailable with this bounded feed.

The source catalog calls these tested **forward paper experiments**. Its
corrected evidence review does not establish recent profitability or readiness
for live trading: some variants have sparse or concentrated results, short
backtests omit borrowing and funding, and research selection reused available
history. Those historical backtests used next daily or four-hour source-bar
openings, so they did not test the forward trial's minute execution. The
historical crypto results do not validate TradFi perpetuals.
The engine does not fill equity market closures with synthetic data or model
funding, borrow, leverage, liquidity, position sizing or order execution.

## Rebuild and verify

Normal frontend deployment serves the committed browser artifacts and does
not require Go on the hosting platform. Rebuild after changing engine or adapter sources and recording their provenance:

```sh
WATCHLIST_GO=/path/to/go1.26.8/bin/go node engine/scripts/build.mjs
node engine/scripts/verify.mjs
node engine/scripts/parity.mjs
cd engine
go test ./internal/...
```

The build requires Go 1.26.8, avoids network dependency downloads, and retains
the original Go module path for unchanged imports. `build-manifest.json` hashes
the generated artifacts and adapter sources. The original frozen package
tests are included alongside focused adapter tests. `cmd/watchlist-native`
accepts the same JSON on stdin for native/WebAssembly parity verification.

# Shared Go watchlist engine

This subtree embeds the scanner and selector from the Go crypto dashboard
release `0.13.1-26e07587190d` (upstream scan schema 12), with the local
`+ichimoku.3` extension. The browser provides
completed candle histories; a Web Worker executes the Go code as WebAssembly.
There is no local server, database, AI worker, account ledger or trading action.

The frozen upstream files and their SHA256 hashes are recorded in
`provenance.json`, extracted from that release's verified `source.tar.gz`.
The harmonic detector, regime, structure and shared selection/risk calculations
are retained. The original production source adaptation replaces the database
adapter's `cachefeed.BoundaryGrace` import with existing
`market.BoundaryGrace`; both constants are exactly five seconds. Two tests use
the same alias adaptation. This keeps the dependency closure in Go's standard
library. Copyright and license notices remain in the imported files; see
`THIRD_PARTY_NOTICES.md`.

The local extension adds the lecture measurement/plot contract, TK/PK Kijun
retests and cloud edge-to-edge strategies, and improves cloud-zone retests.
`provenance.json` preserves upstream hashes and records local amendments.
See [source coverage and conventions](../docs/ichimoku-lecture.md).

## Browser interface

Load the committed `public/watchlist-wasm-exec.js` and instantiate
`public/watchlist-engine.wasm` in a worker using Go's runtime. After `go.run`
initializes, the worker has a synchronous function:

```ts
globalThis.goWatchlistScan(JSON.stringify({
  now: Date.now(),
  scope: 'all', // optional; 'ichimoku' returns the uncapped active Ichimoku screener
  // timeframe: '4h', // Ichimoku only: one chosen chart period, default '1h'
  symbols: ['BTCUSDT'],
  histories: [{
    symbol: 'BTCUSDT',
    timeframe: '15m', // supply 1d, 4h, 1h and 15m for each symbol
    candles: [{ openTime, closeTime, open, high, low, close, volume }],
    preview: { openTime, closeTime, open, high, low, close, volume },
    receivedAt: successfulProviderReceiptInMilliseconds,
    status: 'ready', // 'error' fails this frame, even if old candles remain
    error: null,
  }],
}))
```

Timestamps are milliseconds, with inclusive Binance candle closing times.
Supply the latest **500 completed candles plus the current provisional
candle**. Request 501 exchange klines to obtain that window; requesting 500
usually returns only 499 completed candles. A genuinely shorter history is
allowed, with the original analyzer warmup rules deciding availability.
Unsorted, overlapping, duplicated, missing or invalid candles are not repaired.
The provisional candle supplies only the quote and never enters indicators.

The adapter preserves each successful receipt timestamp. Stale input, missing
required frames and provider errors become scanner errors. A recent receipt
does not make a missing latest candle fresh. The deployed `--max-cache-age`
default is two minutes, retained here and returned as `maxAgeMs: 120000`.
The selector independently requires expected latest closes and complete
evidence on the requested frames: all four for the mixed Watchlist, or only the
selected timeframe for the Ichimoku tab. Do not overwrite receipts on cached reads or when the
watchlist is opened.

The returned JSON contains:

```ts
{
  version: '0.13.1-26e07587190d+ichimoku.3',
  scope: 'all', // echoed normalized scope; 'all' when omitted
  sourceHash: '26e07587190d24c66d62602e968ef24dafafb281b9b1a0140afa7f6c6d0a0d00',
  now: number,
  maxAgeMs: 120000,
  result: {
    config, items, trends, strategies, breadth, benchmarks,
    examined, eligible, directionFiltered, costFiltered, limit: 12,
  },
  scan: { series, errors, progress: { done, total } },
  error?: string,
}
```

`result` retains the `selection.Build` contract, including the original
12-item limit in each section. It is absent on invalid top-level input.
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
enter Ichimoku. The UI can group the selected sources into a
12-instrument list without promoting any excluded observation.

The mixed Watchlist scanner requests 500 candles, minimum harmonic geometry score 90,
all six pattern types, both directions and all four timeframes. The original
adaptive SuperTrend and internal/swing structure rules remain unchanged.
Costs use the original disclosed model: 20bps fees + 10bps slippage/spread
round trip, minimum net R/R 1, no turnover floor and no account profile.
These are screening assumptions, not measured fees or executable quantities.

Identical valid histories and settings produce the same engine decisions.
Different candle windows, exchange prices or market session gaps can change
results. The engine accepts normalized uninterrupted Spot or perpetual
histories, but does not invent data during an equity market closure or model
futures funding, borrow, leverage or order execution. Original bearish Spot
instrument cautions remain part of the preserved reference model. Raw
geometry, watch eligibility, entry confirmation and account sizing remain
separate concepts. These rules do not establish trading profitability.

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

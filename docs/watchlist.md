# Live setup watchlist

The Watchlist runs the actual scanner and selector from the frozen Go crypto
dashboard release **0.13.1-26e07587190d** (scan schema 12). It checks Crypto or
TradFi across **15m, 1h, 4h and 1d together**, then presents at most **12 unique
assets**. A symbol appears once; open its card to compare the selected setups.
Stars are a personal filter and never make an asset analytically eligible.

## Selection and presentation

The original Go engine selects three sources:

- **Harmonics:** Gartley, Bat, Butterfly, Crab, Shark and Cypher, with the
  original minimum geometry score of 90 and both directions enabled.
- **Trend pullbacks:** the original multi-timeframe trend and pullback watches.
- **Independent methods:** sweep reversal, regular-divergence reversal,
  hidden-divergence continuation, range rejection, compression breakout,
  fair-value-gap pullback, Fibonacci pullback, Kijun reclaim and cloud reclaim.
  Experimental methods remain labeled in setup detail.

Every asset requires fresh, usable context on all four timeframes. The engine
retains its own trend alignment, countertrend confirmation, structure,
momentum, lifecycle and historical reference checks. In particular, harmonic
eligibility requires intact stop and target history, price within one setup
ATR of the **entry reference**, gross reward/risk of at least 1 and modeled net
reward/risk of at least 1. The original opposing-target cap and consumed
reference checks prevent a recovered quote from resurrecting an old target
opportunity.

Trend and independent-method sections retain their own developing, confirmed
and blocked lifecycles. The Go selector includes some blocked observations in
these sections. A selected watch is not necessarily an entry: a developing
watch may still lack a complete reference plan.

The unchanged `selection.Build` result keeps at most 12 items in each original
source section. The browser interleaves those sections in round-robin order,
preserving the Go order within each section. It then groups the selected
methods and timeframes by asset and caps the display at 12 unique assets.
It never fills spare cards with rejected detector inventory, and raw detector
counts are not presented as qualifying watches.

Each card has one leading setup, a preview of its captured candles and geometry,
its evaluated quote, direction, reward/risk when available, and next checkpoint.
The whole card opens the setup detail; its star remains a separate control.
Setup tabs inside the detail compare the other **engine-selected** setups
retained for that asset, including separate timeframe context and reference
plans. Stops, targets and entry references belong to individual setups; they
are never averaged into a composite trade. Opposing directions and setups
outside the current filters are marked for comparison.

**Shortlist**, **Triggered** and **Developing** filter setups before choosing
an asset's leading setup and applying the asset cap. A secondary confirmed
setup can therefore represent its asset in Triggered even when the unfiltered
lead is developing. Search and stars use the scanner's existing preferences;
direction, source and status filters belong to this view. Filters do not
bypass the Go selection rules. Coverage counts describe timeframe feeds,
while result counts describe unique matching assets.

The detail chart uses the exact candles captured for the selected Go evaluation.
It plots the returned harmonic XABC/D anchors, entry zone, evaluated quote,
plan entry, stop, first target and completed-candle events where available.
A projected D is never presented as an observed pivot. Trend break events keep
their hourly timestamps, while retests and triggers retain their 15m context.
Independent methods retain their frozen source window, location and events.
Unavailable anchors or event prices are not replaced with guessed coordinates.

The timeframe controls inspect the four captured histories, with **Setup** and
**Recent** views and pointer or keyboard candle inspection. The outlined open
candle is provisional. Chart annotations come from the Go result and its
captured input; opening the chart does not rerun a different indicator engine.
The modal keeps its original evaluation while new results arrive. **Load latest**
explicitly replaces it, and an aged or no-longer-selected setup is identified
as a saved evaluation.

## Sharing a setup for review

Open a card, select the setup to review, then use **Copy setup** to copy a
plain-text Markdown brief for an agent chat. It includes exact price references,
costs, confirmation evidence, four-timeframe context, cautions, opposing setup
summaries and the saved evaluation's identity and timestamps. Freshness is
checked again at the time of copying; an aged or no-longer-selected evaluation
is not relabeled as a current confirmation. A clipboard failure exposes the
same brief for manual copying.

**Save HTML** downloads a standalone report with the currently displayed chart
timeframe and range, the review brief, and the full captured candle data for
the selected setup. The chart keeps its annotations and appearance without
requiring the app or a network connection. Attach this file when the reviewer
needs the visual chart or raw candles; the clipboard brief itself contains
text only. Both actions preserve the selected evaluation, even if the live
shortlist changes. Neither action uploads the report or contacts an agent.

## Reference plans and costs

Reference plans preserve the original entry, stop, targets, confirmation
state, next action and cautions. Prices shown in the shortlist are the quotes
used by the latest evaluation, rather than a separately repriced trade plan.
A completed trigger and a usable plan remain distinct from an executed trade.

The frozen release's cost assumptions are **20 basis points of fees plus 10
basis points of slippage/spread round trip**. For an eligible, correctly
ordered stop and target, the model uses:

```text
risk   = abs(quote - stop)
reward = abs(target - quote)
cost   = quote * (20 + 10) / 10000
netRR  = (reward - cost) / (risk + cost)
```

The default minimum net reward/risk is 1, the minimum turnover floor is 0,
and no account profile is supplied. Targets are not moved farther away to
make a setup pass. These are model assumptions, not measured trading fees.
Funding, borrow, leverage, spread, depth and actual fills remain unverified.
Bearish Spot observations do not establish that an instrument can be shorted.
The shortlist does not establish a win rate or profitability.

## Candles, freshness and evaluation

Crypto uses Binance Spot candles. TradFi uses its own Binance USDT perpetual
candles for contracts tracking stocks, ETFs and commodities. Real session gaps
remain in the input and can block selection; no synthetic candles are added
to make an asset pass.

For each asset and timeframe, REST requests 501 klines to obtain the latest
**500 completed candles plus the provisional candle**. A genuinely shorter
history is assessed by the original Go warmup rules. The provisional candle
supplies a quote but never enters closed-candle indicators. WebSocket updates
maintain the same bounded histories and request recovery when needed.

The four timeframes share one bounded request queue: at most eight concurrent
requests and eight starts per second, with a 15-second request timeout,
retry backoff and exchange cooldown handling. Leaving the view or changing
market or symbol universe cancels the feed and worker. Results are identified
by both market and the exact symbol universe, so an earlier scan cannot be
published under a new universe.

The original successful provider receipt timestamp is preserved. Receipt age
must be at most two minutes, and the latest completed candle must independently
match the expected close, allowing the original five-second boundary grace.
Reading cached candles does not renew their freshness. Coverage incorporates
Go analyzer readiness and scanner errors, not just successful HTTP responses.

Evaluations run one at a time. During initial loading, the first asset with all
four feeds ready can start an evaluation; further complete assets are batched
at most once every six seconds. Qualifying cards appear progressively, followed
by a loading card until the evaluation covering all initial feed attempts has
returned. Missing context cannot qualify. Once that initial scan completes,
evaluations run at most once every 30 seconds. The first usable asset can start
an evaluation immediately when its feeds arrive, without waiting for the
two-second coverage display timer. A five-second UI timer withholds
expired confirmations, stale receipts and results that lack a newly required
completed candle between evaluations. Only a fresh Go result can readmit them.
New feed failures also withhold the affected asset.

The chart snapshot is captured before dispatch and matched to the returned
provider receipts and latest closes. Later socket updates cannot change the
candles or annotations in an already-open evaluation.

Closed histories are frozen at publication and shared safely with later
evaluation snapshots. A completed candle or historical correction replaces the
array; preview-only ticks keep the same closed history. Mutable caller data is
still copied defensively. Reusing a history never refreshes its receipt time or
reuses an eligibility decision: every evaluation still runs the original Go
scanner and selector with the captured quote, receipts and evaluation time.
Chart rendering is memoized so coverage timers do not redraw unchanged charts.

The larger request overlap retains the existing eight-starts-per-second
limit. In a deterministic test with 440 requests taking 750 ms each, loading
finishes in 54.75 seconds, compared with a minimum of 82.5 seconds with four
slots. This is a queue simulation, not a guarantee for a live connection.
At the current request rate, 440 cold requests still require at least 54
seconds to start; subsequent quotes arrive through WebSockets. Returning
after leaving the Watchlist currently performs a new cold seed.

Run `bun run scripts/benchmark-watchlist-snapshots.ts` to compare the previous
full-copy preparation with immutable reuse for 440 histories / 220,000 closed
candles. This measures snapshot preparation only, independently of network,
Go calculation and rendering costs.

A 30-second worker startup watchdog and a 90-second evaluation watchdog expose
engine failures instead of leaving an endless loading state. An engine error
clears the current results rather than substituting an older publication.

## Browser deployment and verification

The frozen Go engine runs as WebAssembly in a browser Web Worker. Normal Vite
or Vercel deployment serves the committed browser artifacts and needs no Go
installation on the host, crypto service, database, AI worker or trading
worker. The imported source is the deployed schema-12 release, not pending
changes in the sibling crypto working tree.

The engine's source hash is:

```text
26e07587190d24c66d62602e968ef24dafafb281b9b1a0140afa7f6c6d0a0d00
```

`engine/provenance.json` records upstream and adapted file hashes. The only
production source adaptation replaces the database feed's boundary-grace
constant with the already-existing identical five-second market constant.
The scanner and selector calculations are retained. The generated artifacts
and adapter hashes can be checked with:

```sh
node engine/scripts/verify.mjs
```

See [the engine interface, provenance and rebuild instructions](../engine/README.md)
for the Go 1.26.8 build, original package tests and native/WebAssembly parity
checks. Identical valid histories and settings produce identical native and
browser engine decisions; venue, candle window, retention and session
differences can change the result.

`goWatchlistFeed.ts` owns the four-timeframe feed, `useGoWatchlist.ts` owns the
worker lifecycle, and `goWatchlist.ts` adapts the Go result for presentation.
`watchlistChart.ts` captures the evaluated histories; `WatchlistSetupChart`
renders them inside the cards and `WatchlistSetupModal`.
The older TypeScript helpers `watchlist.ts`, `watchlistAnalysis.ts` and
`useWatchlistRows.ts` remain as shared types or
library/regression code. Their former selection pipeline is not mounted by
the current Watchlist and does not select its results.

Stars and view preferences stay in browser storage. There is no durable setup
journal, candle database, account ledger or order execution. Reopening the
watchlist rebuilds it from available history; it cannot monitor markets while
the app is closed or prove that every intervening setup was observed.

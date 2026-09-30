# Live setup watchlist

**Crypto → Ichimoku Cloud** (also available under TradFi) uses the shared chart
and review components with a dedicated engine scope. It selects only
`kijun_reclaim`, `cloud_reclaim`, `tk_cross`, `pk_cross` and `cloud_edge_to_edge`
before ranking, returns all active setups on the selected timeframe without
a display cap, and excludes terminal inventory. Unrelated methods
cannot appear in cards, detail tabs or exported reviews. The browser disables
the ordinary market-wide RSI feed while this indicator is open.

The Ichimoku toolbar uses the same timeframe picker as the other indicator tabs:
**1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 1d, 3d and 1w**. That choice drives
detection and is saved in the shared scanner preferences and `timeframe` URL
parameter. The browser loads only the selected frame on every interval.
Detection, trigger confirmation, subsequent stop/target touches and expiry all
use that source’s completed candles. Other timeframes do not gate the dedicated
scan. Source freshness and the shared cost and plan checks still apply.
Changing market or timeframe cancels the previous scan, clears its results and
closes any saved setup detail.

The Ichimoku chart and context summary show the selected frame’s captured
evidence. Unavailable histories are not offered as empty charts. Copied reviews
and saved HTML retain this exact evidence scope. The three-frame paper rules below
describe the separate mixed Watchlist.

The mixed **Watchlist** presents the sibling crypto project's twelve earlier paper
profiles plus five combinations from 30 September 2026: 17 in total. Fourteen use
daily candles, two use four-hour candles and one uses fifteen-minute candles.
Crypto uses Binance Spot and TradFi uses Binance USDT perpetual histories. Each
source frame qualifies independently: a missing four-hour feed does not block a
valid daily profile, or vice versa. All qualifying assets can appear, grouped
one card per symbol without a 12-card cap. Stars are a personal filter and do
not make an asset analytically eligible.

## Selection and presentation

The mixed selector recognizes exactly these profile IDs:

| Profile | Frame | Direction | Completed-candle condition |
|---|---|---|---|
| `donchian55_atr_trail` | 1d | Long | Close above the previous 55 highs. |
| `donchian55_atr_trail_stoch` | 1d | Long | Same breakout; smoothed Stochastic K14/3 above 50. |
| `donchian55_atr_trail_macd` | 1d | Long | Same breakout; MACD12/26 above its EMA9 signal. |
| `donchian55_atr_trail_adx_range` | 1d | Long | Same breakout; defined ADX14 at or below 20. |
| `cloud_reclaim_volume_2r` | 1d | Long or short | First eligible cloud reclaim with volume confirmation. |
| `cloud_reclaim_volume_2r_ema` | 1d | Long or short | Cloud rule with EMA10/20 direction. |
| `cloud_reclaim_volume_2r_sma` | 1d | Long or short | Cloud rule with SMA10/20 direction. |
| `cloud_reclaim_volume_2r_supertrend` | 1d | Long or short | Cloud rule with Supertrend direction. |
| `cloud_reclaim_volume_2r_ao` | 1d | Long or short | Cloud rule with Awesome Oscillator sign. |
| `cloud_reclaim_volume_2r_sma_ema_macd` | 1d | Long or short | Cloud rule with SMA, EMA and MACD agreement. |
| `fresh_weekly_range_long` | 4h | Long | Untouched prior-week low, sweep/reclaim and confirmation. |
| `tk_cross_rsi` | 1d | Long or short | TK-cross retest with RSI14 above 50 for long or below 50 for short. |

| `combo_trendlines_adx_daily` | 1d | Long | Trendlines breakout with defined Signal Forge ADX14 ≤20. |
| `combo_trendlines_cluster_daily` | 1d | Long | Breakout with latest clustered-Supertrend event bullish, age 0–2. |
| `combo_trendlines_sfp_daily` | 1d | Long | Breakout with latest SFP event bullish, age 0–2. |
| `combo_range_weekly_4h` | 4h | Long | Weekly event at first raw range eligibility or preceding two source bars. |
| `combo_nwe_rsi_ultimate_15m` | 15m | Long | Causal NWE lower-band fade, Signal Forge RSI14 >50, persistent bullish Ultimate RSI event. |

The new combinations' exact exit rules and source comparisons are documented in
[Combination port](combinations-port.md). Timeframe buttons filter before asset
grouping and show both enabled profile counts and current matching asset counts.
An empty timeframe still has its active profiles; no signal is manufactured.

The Donchian filters are read on the breakout close. Cloud and TK filter states
are frozen at the first raw eligible emission; a later favorable indicator
cannot revive a rejected signal identity. Cloud volume must at least equal the
mean of the preceding 20 completed bars, excluding the signal bar. The crypto
source resets indicator state after real gaps; this browser withholds a gapped
feed rather than smoothing it. The weekly level is the previous complete UTC
week's low and must have no earlier touch during the rejection week.

The mixed `selection.BuildPaperWatchlist` result places paper profiles only in
`result.strategies.items`; `result.items` and `result.trends` are empty. It does
not select the original harmonic, trend-pullback or independent-method roster.
That historical code remains in the shared engine for its other paths and
regression tests. Each profile needs a fresh, usable history on its own frame,
the expected latest completed close and the frozen protective/reference checks.
The selector can report a candidate as blocked when its plan fails a current
cost, stop, expiry or evidence check. A signal with a reviewable plan still
does not imply that the next opening passed admission checks.

Each card shows its leading profile, captured chart, evaluated completed-close
price, direction and next checkpoint. The whole card opens detail; its star is
a separate control. Detail tabs compare the other engine-selected profiles for
that asset, including independent plans. Stops, targets and entry references
are never averaged. Opposing directions are marked. **All signals** and
**Triggered** filter the mixed view; the status filter offers confirmed and
blocked. Search, stars and direction filters cannot bypass engine eligibility.
Coverage counts describe individual frame feeds; result counts describe unique
matching assets.

The detail chart uses the candles captured for that Go evaluation. It shows
the profile's frozen source window, evaluated price, entry reference, stop,
structural target when one exists, and completed-candle events. Donchian has no
fixed target. An unavailable anchor or event price is not guessed.

In the dedicated Ichimoku screen, the **Ichimoku** chart toggle draws the exact
Go Tenkan/Kijun and cloud paths. Known forward cloud spans are marked as
projections from completed prices. Its detail exposes cloud position, color and
width, flat edges, cross validity, twists, edge-to-edge references, cloud
Fibonacci levels and the combined thinning-cloud/widening-line-gap warning.
These readings and overlays survive review export. See the
[lecture coverage audit](ichimoku-lecture.md) for the source rules, deliberate Chikou exclusion
and numerical conventions.

The timeframe controls inspect available captured histories, with **Setup** and
**Recent** views and pointer or keyboard candle inspection. The outlined open
candle is provisional. Chart annotations come from the Go result and its
captured input; opening the chart does not rerun a different indicator engine.
The modal keeps its original evaluation while new results arrive. **Load latest**
explicitly replaces it, and an aged or no-longer-selected setup is identified
as a saved evaluation.

## Sharing a setup for review

Open a card, select the setup to review, then use **Copy setup** to copy a
plain-text Markdown brief for an agent chat. It includes exact price references,
costs, confirmation evidence, captured timeframe context, cautions, opposing setup
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

Reference plans preserve the signal's entry reference, frozen stop and any
structural target, confirmation time, next action and cautions. The displayed
price is the latest completed close used by the evaluation. It is not a later
opening, an execution price or a repriced plan. The mixed Watchlist neither
places nor tracks paper or live orders.

- **Donchian:** a daily close above the preceding 55 highs sets an initial
  stop two arithmetic ATR14 below the signal close. There is **no fixed profit
  target** and no fabricated target reward/risk. An entry is considered only at
  the next whole one-minute opening after observation while the one-daily-bar
  entry window is valid.
  After entry, a 3.5 ATR stop ratchets after completed daily closes and never
  widens. A close below the preceding 20 lows schedules an exit at the next
  whole one-minute opening. Maximum holding is 96 daily bars.
- **Cloud reclaim:** the original entry band, protective stop, structural
  target and admission checks remain. The chart shows that original target.
  Only a farther target is shortened to net 2R **after an actual opening and
  adverse slippage** determine the entry and all-in risk. Volume and any trend
  filter stay frozen at first raw eligibility. Maximum holding is 24 daily
  bars.
- **TK cross with RSI:** the original fixed entry band, stop and target remain,
  with a 24-daily-bar holding limit.
- **Fresh weekly rebound:** the original frozen range entry band, stop and
  target remain. At the actual whole one-minute opening, the raw opening-to-stop
  distance must be at least 3%, in addition to the entry-band and cost checks.
  Maximum holding is 24 four-hour bars.

All 17 forward paper profiles consider the next whole one-minute opening after
observation. The source checks minute candles from the latest completed source
candle through observation for prior protective touches. This browser fetches
daily, four-hour and fifteen-minute source candles, not that minute execution path, and cannot
verify whether a setup remains eligible or would fill at that opening.

The reference cost assumptions are **20 basis points of fees plus 10 basis
points of slippage/spread round trip**. For a correctly ordered fixed stop and
target, the current-close screen uses:

```text
risk   = abs(quote - stop)
reward = abs(target - quote)
cost   = quote * (20 + 10) / 10000
netRR  = (reward - cost) / (risk + cost)
```

The minimum net reward/risk is 1. Targets are never moved farther away to
make a setup pass. The real opening may fail the entry band, stop-width guard,
cost check or expiry even when the displayed signal has a reviewable plan.
Actual fees, spread, funding, borrow, depth, leverage and fills remain
unverified. Bearish Spot observations do not establish that an instrument can
be shorted. The crypto historical tests do not validate these profiles on
TradFi perpetual contracts.

The source catalog calls these profiles **forward paper experiments**. Historical
backtests used next daily or four-hour source-bar openings and did not replay
the trial's minute execution cadence. Its corrected
evidence review finds that recent Donchian profitability is unproven, the small
Stochastic difference is not a demonstrated improvement, the weekly rebound
has a sparse sample, and TK cross with RSI is concentrated in a few trades.
Cloud trend filters are research leads, without evidence that EMA is superior
or that the combined long/short result transfers to Spot long trading. The
historical tests used the available history for selection, including today's
surviving symbols; they are not an untouched out-of-sample test. This
Watchlist makes no win-rate or profitability claim.

## Candles, freshness and evaluation

Crypto uses Binance Spot candles. TradFi uses its own Binance USDT perpetual
candles for contracts tracking stocks, ETFs and commodities. Real session gaps
remain in the input and can block selection; no synthetic candles are added
to make an asset pass.

REST requests 501 klines for **500 completed candles plus the provisional candle**.
The mixed Watchlist requests 1000 klines for its 15m envelope, preserving 999
completed candles so both causal bands can warm up. The mixed Watchlist
loads `1d`, `4h` and `15m`; the dedicated Ichimoku screen loads only its selected
picker timeframe. A genuinely shorter history is assessed by the applicable
warmup rules. The provisional candle can supply a live quote, but never enters
closed-candle indicators or the mixed paper plan's completed-close assessment.
WebSocket updates maintain the same bounded histories and request recovery
when needed.

The sibling crypto dashboard can calculate indicators over its full stored
contiguous history. This browser retains the latest 500 daily/4h bars and 999 mixed 15m bars.
Dedicated Ichimoku retains its existing 500-bar history on every selected frame. Recursive filters such as Supertrend can retain older state, so
even the latest indicator decision and profile signal may differ from the
source. Full source-history parity is unavailable with this bounded feed.

The requested timeframes share one bounded request queue: at most eight
concurrent requests and eight starts per second, with a 15-second request timeout,
retry backoff and exchange cooldown handling. Leaving the view or changing
market, Ichimoku timeframe or symbol universe cancels the feed and worker.
Results are identified by scope, selected timeframe, market and the exact
symbol universe, so an earlier scan cannot be published under a new view.

The original successful provider receipt timestamp is preserved. Receipt age
must be at most two minutes, and the latest completed candle must independently
match the expected close, allowing the original five-second boundary grace.
Reading cached candles does not renew their freshness. Coverage incorporates
Go source-frame readiness and scanner errors, not just successful HTTP responses.

Evaluations run one at a time. During initial loading, an asset can enter the
mixed scan when either its daily or four-hour source is usable; the other
frame may still be loading or unavailable. The dedicated Ichimoku view can
start when its selected frame is usable. Further ready frames are batched at
most once every six seconds. Cards appear progressively, followed by a
loading card until the evaluation covering all initial feed attempts has
returned. Missing or stale source evidence blocks only profiles that need
that source. Once the initial scan completes, evaluations run at most once
every 30 seconds. The first usable source can start an evaluation immediately,
without waiting for the coverage display timer. Between evaluations, the UI
withholds expired confirmations and stale or failed source feeds. Only a fresh
Go result can readmit them.

The chart snapshot is captured before dispatch and matched to the returned
provider receipts and latest closes. Later socket updates cannot change the
candles or annotations in an already-open evaluation.

Closed histories are frozen at publication and shared safely with later
evaluation snapshots. A completed candle or historical correction replaces the
array; preview-only ticks keep the same closed history. Mutable caller data is
still copied defensively. Reusing a history never refreshes its receipt time or
reuses an eligibility decision: every evaluation still runs the Go
scanner and selector with the captured quote, receipts and evaluation time.
Chart rendering is memoized so coverage timers do not redraw unchanged charts.

The mixed Watchlist now requests two histories per asset rather than four.
The existing 440-history snapshot benchmark is a larger stress case; run
`bun run scripts/benchmark-watchlist-snapshots.ts` to measure immutable
snapshot preparation separately from network, Go calculation and rendering.
Returning after leaving the Watchlist currently performs a new cold seed.

A 30-second worker startup watchdog and a 90-second evaluation watchdog expose
engine failures instead of leaving an endless loading state. An engine error
clears the current results rather than substituting an older publication.

## Browser deployment and verification

The Go engine runs as WebAssembly in a browser Web Worker. Normal Vite
or Vercel deployment serves the committed browser artifacts and needs no Go
installation on the host, crypto service, database, AI worker or trading
worker. The original Go dashboard release remains the base for the scanner and
dedicated Ichimoku screen. The mixed selector ports the sibling project's
active paper roster and its frozen profile rules into this browser engine.

The upstream archive's source hash is:

```text
26e07587190d24c66d62602e968ef24dafafb281b9b1a0140afa7f6c6d0a0d00
```

`engine/provenance.json` records upstream and adapted file hashes. The original
boundary-grace import adaptation retains the identical five-second constant.
The local extension records both the dedicated Ichimoku changes and the paper
strategy port. The generated artifacts, extension revision and source hashes
can be checked with:

```sh
node engine/scripts/verify.mjs
```

See [the engine interface, provenance and rebuild instructions](../engine/README.md)
for the Go 1.26.8 build, original package tests and native/WebAssembly parity
checks. Identical valid histories and settings produce identical native and
browser engine decisions. The sibling Rust dashboard has a different stored
history window and execution environment; venue, candle retention, session
gaps and actual opening prices can change its result.

`goWatchlistFeed.ts` owns the scope-specific candle feeds, `useGoWatchlist.ts` owns the
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

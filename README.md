# Market Screener

Deployed app: [rsi-scanner-dusky.vercel.app](https://rsi-scanner-dusky.vercel.app/)

A Vite + React + TypeScript app with **Crypto** and **TradFi** screeners for
Binance USDT markets. Crypto uses Spot pairs; TradFi uses USDT perpetual
contracts tracking equities, ETFs, and commodities. The **RSI** tab shows price
and RSI charts; **Fibs** shows price candles with an impulse trendline;
**Support & Resistance** maps calendar liquidity and recent swing failures.
Each tab has its own signal filters. Binance REST seeds
the candle history and combined kline WebSocket streams keep it current. Open
any card for aligned price, Heikin-Ashi, and RSI charts or the Fib system view.
The interface uses Ant Design components with the supplied dark purple theme.

This repository contains the frontend only. The standalone Rust data tool lives
in the separate sibling project `../cli` and fetches and analyzes market
data from the command line for AI-assisted analysis. Both projects build and run
independently.

## Development

```bash
bun install
bun run dev
```

Quality checks:

```bash
bun test
bun run lint
bun run build
```

## Screener

Choose **Crypto** or **TradFi** in the header, then select **RSI**, **Fibs**, or
**Support & Resistance**.
RSI cards have a compact pair heading and favorite button above equally tall
raw price and RSI(14) panels on a shared timeline. Selecting RSI divergences
adds the matching setup's state and age. Fibs cards show the symbol, live price,
favorite button, and **Uptrend** or **Downtrend** above raw candles and an
impulse trendline. Golden-pocket shading, ratios, entries, targets, and stops
appear only after opening the card. A compact summary beside the tabs shows
loaded pairs and the active tab's signal count. The final hollow candle is
still forming; its price and RSI are provisional. Chart times are shown in
UTC. The candle-change sort uses the latest candle's open to its current close
on the selected timeframe, **not a 24-hour change**.

The timeframe remains selectable in the screener toolbar and is not repeated
in each card heading.

- **Search:** type a pair such as `BTC` or `BTC/USDT`; press `/` to focus search
  when no input or dialog is active.
- **Tabs:** use **RSI** for price and oscillator charts, **Fibs** for Fib
  trends, or **Support & Resistance** for calendar levels and sweeps.
  Returning to RSI restores your last **All RSI charts** or
  **RSI divergences** choice.
- **Divergence recency:** on the RSI tab, open **Filters → RSI divergences** for choices
  of the latest **1**, **3** (default), or **5 closed candles**, or **Any age**.
  Selecting RSI divergences uses the current choice and opens those options in
  the same modal. This preference applies only to the RSI divergence filter;
  **All RSI charts** includes active divergences of any age.
  Bullish and bearish setups are included together.
- **Fib system:** on the Fibs tab, open **Filters** for direction, setup stage,
  and optional SMA200 alignment. Waiting setups have an unfilled plan; active
  setups have one or more modeled entry touches. **Near entry** shows only
  waiting plans with live Fib ratios from `0.600` inclusive to `0.618` exclusive,
  using the selected linear or logarithmic scale in either direction. Golden
  pocket narrows the results to prices inside the `0.618–0.666` zone. Open a
  matching card for its scaled entries, stop, and targets.
- **Favorites:** star cards, then use **All pairs / Starred** to the right of
  sorting and card size above the results. The selection applies immediately
  across all three tabs. Crypto and TradFi have separate favorites; existing
  saved favorites belong to Crypto.
- **Sorting:** use watchlist order, active signals, candle change, RSI ascending
  or descending, or pair name. **Active signals** ranks RSI divergence setups
  with confirmed setups before forming setups. In the Fib view it ranks pairs
  in the golden pocket first, then entered setups before waiting plans.
- **Layout and timeframe:** choose comfortable or compact cards and a common
  candle timeframe. The selected view is saved across reloads and reflected in
  the URL.

Loading cards show **Waiting for market data**. Failed requests retry
automatically while available pairs keep updating. A small warning icon in the
card heading exposes **Data unavailable · retrying** or **Updates delayed**
(after 60 seconds without an update) through an accessible label and tooltip.
Pairs without loaded candles cannot satisfy signal filters. Empty
searches and filters have a reset action.

Click a chart to open the shared detail view. A card opened from Fibs starts in
**Fib system**, with the full chart levels and trade plan. A card opened from
RSI starts in **Price & RSI**; the view control can switch between them.
A compact header shows the pair, timeframe, and current raw market price.
Raw price, Heikin-Ashi, and RSI charts share one timeline in the RSI view.
Heikin-Ashi prices are labeled as averaged, and the open candle updates live.
A card opened from Support & Resistance starts with its nearby liquidity
chart, completed calendar levels, and recent reactions; Price & RSI and
Fib system remain available in the view control.

### Support & Resistance

This tab implements the calendar-liquidity portion of the advanced lecture:
previous completed week and month open/high/low/close, plus the latest
completed Monday candle's **body** low/midpoint/high. Monday uses open and
close, not wick extremes, and appears on minute/hour charts only. UTC
calendar boundaries control updates; incomplete source periods are omitted.

Cards show the nearest support below live price and resistance above it,
their source, and distance in percent. A level changes roles when crossed.
Open a card for the chart, all available levels with source dates, and
recent bullish/bearish swing failures. A confirmed sweep wicks through a
level and closes back on the approach side; the preceding contiguous
candle must close on that side. Signals cover the latest 3 closed candles
on the selected reaction timeframe. Forming sweeps stay provisional.

Filters select the level source, **Within 0.5%**, and confirmed sweeps in
either or one direction. **All pairs / Starred** applies immediately from
the results toolbar, to the right of sorting and card size. The **Filters**
badge counts only choices in the modal, excluding the pair collection.
The default **Watchlist order** matches the other tabs: BTC, ETH, SOL, and
the rest of the Crypto list, or exchange listing order on TradFi. Nearest
level, recent sweeps, and name sorts are also available. Search, favorites,
timeframe, and density are shared with the other tabs; RSI and Fib signal
filters do not restrict this tab.

The daily context feed runs only while this tab is active, separately from
the selected reaction timeframe. It uses up to 180 closed daily candles,
exchange-clock closure, four concurrent seeds, a rate-limit cooldown, and
midnight refresh. Switching the market or leaving the tab cancels it.

The lecture's Fib/anchored-volume-profile levels, VSA-cluster confluence,
and 4h boxes require discretionary selection and are not estimated here.
**How to read this** and **Settings** explain this scope. Calendar liquidity
is context, not an entry system. See [the lecture rules](docs/support-resistance.md).

### Binance TradFi

TradFi discovers active USDT-margined, USDT-quoted contracts directly from
Binance Futures exchange information each time this market is opened. The
selection uses Binance's exact `TRADIFI_PERPETUAL` contract type, keeping crypto
perpetuals and non-USDT contracts out of this view. Equities, ETFs, commodities,
and other TradFi listings that meet those criteria are included automatically.
These charts show the perpetual contract's traded price. Search by the Binance
ticker, such as `TSLA`, `NVDA`, or `XAU`.

Live history comes from `https://fapi.binance.com/fapi/v1/klines` and combined
streams from `wss://fstream.binance.com/market/stream`. Both use the existing
RSI, divergence, and candle-closure rules. Switching markets disconnects the
previous feed, cancels outstanding requests and retries, clears its candles,
and closes the detail chart before loading the new data. Seed requests are
limited to eight at a time. Market-list failures show a **Retry** action;
an empty exchange result is shown explicitly.

Verified on 2026-09-09 against Binance's
[exchange information](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#exchange-information)
and [market streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market),
with 190 active USDT TradFi contracts and live TSLA/XAU candles. The count comes
from discovery and is not fixed in the app.

### Saved and shared views

Market, search, the selected tab and its divergence, Fib, or liquidity filters, RSI
state, **Starred**-only, sorting, timeframe, card density, and the Fib template
persist in local storage and synchronize with the URL. Control changes replace
the current browser history entry.

| URL parameter | View preference |
| --- | --- |
| `market` | `spot` (Crypto, default) or `tradfi` |
| `q` | Pair search |
| `indicator` | `all` or `divergence` selects RSI; `fib` selects Fibs; `sr` selects Support & Resistance |
| `candles` | Latest `1`, `3`, or `5` closed candles, or `any` age |
| `rsi` | `all`, `overbought`, `oversold`, `either`, or `neutral` |
| `fibSide` | `any` (default), `long`, or `short` |
| `fibStage` | `any` (default), `waiting`, `near`, `active`, or `pocket` |
| `fibTrend` | `any` (default) or `aligned` with SMA200 |
| `fibScale` | `linear` (default) or `log` |
| `fibStop` | Initial stop ratio: `0.92` (default), `1.04`, `1.14`, or `1.272` |
| `fibTp3` | `-0.236` (default) or `0` |
| `fibTp4` | A ratio below TP3; default `-0.382` |
| `fibRunner` | A ratio below TP4; default `-0.618` |
| `srSource` | `all` (default), `week`, `month`, or `monday` |
| `srSignal` | `all` (default), `near` (within 0.5%), `sfp`, `bullish`, or `bearish` |
| `srSort` | `watchlist` (default), `nearest`, `signals`, or `symbol` |
| `starred` | `1` for Starred-only; otherwise All pairs |
| `sort` | `watchlist`, `signals`, `change`, `rsi-low`, `rsi-high`, or `symbol` |
| `timeframe` | Selected candle timeframe, such as `15m` or `4h` |
| `density` | `comfortable` or `compact` |

Any recognized parameter makes the URL the complete view. Omitted or invalid
values use defaults: Crypto, empty search, RSI with All RSI charts, latest 3 closed candles,
All pairs, watchlist order, 15m, and comfortable cards. A URL without these
parameters restores the saved local preferences. Generated URLs always include
the timeframe, including for a default view, and preserve unrelated parameters.
Fib defaults include either direction, any stage, no required SMA200 alignment,
linear levels, the `0.92` stop, and the target ratios in the table above.
The last RSI signal choice is remembered locally across tab switches and
reloads. A shared URL selects its own tab and current filters through
`indicator`; it does not include that separate local memory.

For example, [BTC RSI divergences on 4h with a 5-candle window](https://rsi-scanner-dusky.vercel.app/?timeframe=4h&q=BTC&indicator=divergence&candles=5)
includes recent confirmations and newly forming setups awaiting confirmation.
For TradFi, use `?market=tradfi&timeframe=15m`; the selected market is also
restored from local preferences on a bare URL.

For example, [long Fib setups on 4h with SMA200 alignment](https://rsi-scanner-dusky.vercel.app/?timeframe=4h&indicator=fib&fibSide=long&fibTrend=aligned)
shares both the screen and the default Fib template. Optional Fib template
parameters can share a different stop, scale, or target configuration.

**Reset filters** and **Clear all** retain the current tab. On RSI they select
**All RSI charts**; on Fibs or Support & Resistance they retain that tab. They reset search,
divergence recency, RSI state, Fib direction/stage/alignment, liquidity filters, Starred-only, and
sorting to their defaults. They retain the Fib template, market, timeframe,
card density, favorites, and chart settings. The favorite-symbol list and chart settings
themselves stay local; a shared Starred-only view uses the recipient's favorites.

### Heikin-Ashi and Tug of War library

The detail chart independently derives Heikin-Ashi candles. The underlying
`src/lib/tugOfWar.ts` analysis library also remains available, with the same
defaults as the sibling Rust CLI: **20 warmup candles**, a **0.05 minimum wick
ratio**, **2 minimum Tug of War candles**, and a **0.30 minimum body ratio**.
Tug of War does not contribute to screener filters, signal ranking, signal
counts, or card badges.

Both qualifying wicks indicate indecision. A sufficient sequence followed by
accepted directional control can confirm a continuation or reversal; without a
prior trend it is classified as a resolution. The library tracks warmup and
pending sequences separately from confirmations and can project the current
candle's live control. Its Heikin-Ashi open comes from the last closed HA candle,
while high/low/close update with the forming raw candle. Two-sided wicks add the
live candle to the projected TOW count.
A directional live candle may project a continuation or reversal, but it never
creates a confirmed signal.

A confirmed decision is retained as current only on the latest closed candle.
Missing candles restart the Heikin-Ashi sequence and its warmup. Live updates
cannot alter the closed state; preview calculations reuse it rather than
replaying the history on every tick. Quoted market prices come from raw candles;
the separately labeled Heikin-Ashi chart shows synthetic averaged prices.

The frontend builds and runs independently of the Rust CLI. It does not start,
call, or depend on the CLI for its analysis.

## Fibonacci system

Choose the **Fibs** tab. Open **Filters** to select direction, stage, and
optional SMA200 alignment. Stage choices include waiting, **Near entry**,
active, and golden pocket. These combine with RSI state, pair search, and favorites.
Closing the modal without applying discards edits; **Clear all** resets the
filters while keeping the Fibs tab and your Fib template. Use **Apply** to
save filter edits.

**Near entry** selects unfilled plans approaching the first entry: the live
retracement ratio must be `0.600 ≤ ratio < 0.618`. It excludes plans with
modeled entries already reached and ended setups. This proximity band works
for longs and shorts on the chosen linear or logarithmic scale; it is not a
trade confirmation. The choice persists across reloads and in shared URLs as
`fibStage=near`. Waiting and golden-pocket filters retain their existing scope.

The main card shows the symbol, live price, star, **Uptrend** or **Downtrend**,
and raw candles with the impulse trendline. Open it for the golden pocket,
Fib levels, and full trade plan: 20%, 30%, and 50% entries at `0.618`, `0.786`,
and `0.886`; the modeled average of filled entries; the initial and current
stop; and four partial exits with a 10% runner. The default initial stop is
`0.92`. A waiting plan is not a filled position.
Switch from **Trade levels** to **Full grid** to display all enabled screenshot
ratios. Expand **Reference grid & recent setup events** for exact prices and
the closed-candle event history; nonpositive reference prices are unavailable.

The default targets are `0.382`, `0.236`, `−0.236`, and `−0.382`; the remaining
10% moves its stop to TP4 at `−0.618`. The supplied Fib settings screenshot
confirms the negative extension ratios. Fib settings let you choose TP3 at `0`,
adjust TP4 and the runner, select another initial stop, or calculate levels on
a logarithmic scale. Open **Settings** while on Fibs, or expand **Fib settings**
in a chart's detail view, then use **Apply Fib settings**. **Restore template**
resets the draft; apply it to save those defaults. These preferences are saved and
included in shared URLs.

Structure, entry touches, targets, and stop changes use closed candles. The
forming candle can update live price proximity but cannot confirm or fill a
setup. Plans whose entries were reached before their structure became
observable are marked missed, and a used golden pocket cannot supply repeated
new entries. If one closed candle spans conflicting trade levels, the replay
uses a conservative ordering and identifies the ambiguity.

These are hypothetical price levels and lifecycle states, not exchange orders
or a profit record. The nominal break-even stop excludes fees, funding, and
slippage. A bearish Fib setup on a Spot chart does not imply that instrument
can be shorted. See [Fibonacci rules and implementation choices](docs/fibonacci-system.md)
for the lecture references, swing confirmation, averaging, and replay rules.

## RSI divergences

RSI divergence detection, lifecycle tracking, and chart overlays are always
enabled on RSI charts. On the RSI tab, **Settings → Include hidden divergences**
adds hidden patterns. Two
separately switchable **Lecture filters** are on by default: wick/body agreement
and one RSI 50 cycle. The **RSI invalidation anchor** chooses which pivot's RSI
kills a regular setup. These settings apply to every RSI card and RSI detail chart;
equivalent flags configure the backtest CLI.

### What a card shows

Card charts overlay only **live** setups: a forming pattern means the second
pivot closed on the latest candle and the next candle decides; a confirmed
pattern means the confirmation candle has closed. Resolved setups leave the
chart. Open a card for aligned price, Heikin-Ashi, and RSI charts with live
divergence overlays on price and RSI.

With the **RSI divergences** filter selected, cards also show the matching
setup's state and age. Confirmed setup age starts at the **price-confirmation
candle**, not the first pivot: age 0 means the latest closed candle, so the
default latest 3 candles includes ages 0, 1, and 2. A new forming setup on the
latest closed candle remains eligible and is labeled **Awaiting confirmation**.
The open candle does not advance either age or confirmation.

**Any age** includes all still-active setups, not completed, invalidated,
expired, or otherwise resolved setups. Recency filters the screener results;
it does not remove older active overlays from a matching card or its detail
chart, change lifecycle rules, or alter the backtest. The default 3-candle
window is a screening preference, not a lecture rule or a proven trading
threshold.

### Setup rules

The engine replays closed candles only. A live candle never forms, confirms,
invalidates, completes, or expires a setup.

| Pattern | Price at the two pivots | RSI |
| --- | --- | --- |
| Regular bullish | Lower low | Higher low |
| Regular bearish | Higher high | Lower high |
| Hidden bullish | Higher low | Lower low |
| Hidden bearish | Lower high | Higher high |

- RSI is Wilder's RSI(14) from closes. Bullish patterns compare candle lows,
  bearish patterns compare candle highs, always on the same candle as the RSI.
- **First pivot:** a strict RSI low or high against 5 candles on each side. It is
  only usable once its fifth right-hand candle has closed.
- **Second pivot:** provisional. It is the strict RSI low or high of the last 5
  closed candles including itself, and the setup appears at that candle's close
  with no right-side lag. If the very next candle makes a deeper RSI extreme, the
  first attempt is harmonised and a new attempt forms from the new candle.
- Pivots are 5–60 candles apart. Equal RSI or price endpoints are not divergence.
- The second pivot's RSI must still be on the near side of 50 (below for
  bullish, above for bearish), otherwise the RSI 50 target is already behind it.
- **Wick and body agreement:** candle-body lows (`min(open, close)`) or highs
  (`max(open, close)`) must have the same strict relationship as the wicks.
- **One RSI 50 cycle:** every RSI sample from the first pivot through the second
  stays strictly below 50 for bullish pairs and strictly above 50 for bearish
  pairs. Touching or crossing 50, or a bullish pair sitting above 50, fails.

### Lifecycle rules

- **Confirmation:** only the candle immediately after the second pivot can
  confirm. Bullish needs a green close, bearish a red close. A close beyond the
  pivot candle's open is recorded as strong confirmation. Wrong colour or a doji
  ends the setup as *unconfirmed*.
- **Invalidation (harmonised):** the setup dies when a closed RSI strictly
  breaches the anchor pivot's RSI: below it for bullish, above it for bearish.
  Equality does not invalidate. The anchor defaults to the second pivot
  (tighter). The first pivot gives more room. Hidden setups always use the
  second pivot because their first pivot is already breached at formation.
  Invalidation applies before and after confirmation.
- **Target (completed):** a closed RSI at or across 50 within the 14 closed
  candles after confirmation. Confirmation is candle 0; candles 1 through 14
  count. A target reached on the confirmation candle itself is recorded but
  excluded from the backtest hit rate.
- **Expiry:** 14 closed candles after confirmation without the target. A breach
  on the same candle wins over expiry.
- **Interrupted:** missing, unfinished, or malformed candle data censors a live
  setup rather than letting it linger.

### Backtest

Use the backtest CLI to fetch closed candles from Binance, add a 250-candle RSI
warmup, and replay the same engine across one or more symbols. It reports
detected, confirmed, RSI 50 hits, harmonised, expired, and hit rate overall and
per pattern, with optional CSV and JSON exports:

```bash
bun run backtest:divergence -- --timeframe 4h --candles 3000
bun run backtest:divergence -- --timeframe 1d --symbols BTCUSDT,ETHUSDT --csv out/1d.csv --json out/1d.json
bun run backtest:divergence -- --timeframe 15m --hidden --no-cycle --anchor first
```

The hit rate is `RSI 50 targets after confirmation ÷ (targets + confirmed
harmonisations + expiries)`. It measures whether the lecture's target is reached
before its stop or clock, not profit. Fees, fills, slippage, and price returns
are not modelled, and overlapping setups are not independent trades.

### Data handling

- Invalid bars and missing candles break comparisons. Duplicate or old stream
  updates cannot advance RSI twice. Recovery replays missing closed candles into
  the existing Wilder average, preserving confirmed values. A gap beyond the
  350-candle REST recovery window starts a fresh history for the affected symbol.
- The newest REST candle stays provisional until an exchange final update or a
  later REST candle proves it closed; confirmation does not rely on the computer's
  clock. Up to 3,000 closed candles per symbol are retained for lifecycle tracking.

### Lecture transcript verification

The supplied Gemini Roman Urdu/English transcript was cross-checked against the
automatic subtitles and chat. It agrees on candle alignment, wick/body agreement,
one RSI 50 cycle, the four divergence definitions, green/red candle confirmation,
RSI 50 completion, and 14 candles after price confirmation. The audio was not
independently verified.

Two points are implementation decisions rather than transcript facts. The
transcript does not identify which pivot's RSI line kills a setup, so the anchor
is a setting. The lecture's explanation that RSI(14) cannot see beyond 14 candles
is incorrect for Wilder RSI, whose recursive averages retain older information;
the 14-candle expiry is kept as the lecturer's strategy rule, not as an RSI
property. Trend context, "not near 50", repeated-divergence warnings, and
trendline or moving-average confluence have no complete numerical rules in the
transcript and are not automated. See the timestamped
[lecture rule analysis](docs/rsi-lecture-rules.md) for evidence.

### Research and implementation choice

Reviewed open-source implementations:

- [SpiralDevelopment/RSI-divergence-detector](https://github.com/SpiralDevelopment/RSI-divergence-detector)
  (MIT): supports all four patterns and includes a Binance example. Its detector
  uses close prices, fixed RSI thresholds, regression, angle filters, and a
  minimum separation of more than 21 candles. Those choices are specific to that
  strategy, so this scanner does not inherit them.
- [RSI Divergence Indicator Pine Script reference](https://github.com/fmzquant/strategies/blob/master/RSI-Divergence-Indicator.md)
  (source marked MPL-2.0): uses 5/5 RSI pivots, candle low/high comparisons, and
  regular/hidden options. This scanner uses the same mathematical pattern
  definitions in an independently written TypeScript detector. It explicitly
  requires closed confirmation candles, rejects plateau pivots, and measures
  separation directly. Some Pine implementations use shifted `barssince`
  expressions, so their boundary results can differ by one candle; exact
  TradingView signal parity is not claimed.

Tests cover the four patterns, body/cycle filters, confirmation latency, live-bar exclusion,
distance boundaries, equal values, gaps, malformed bars, and replay stability,
plus candle/RSI alignment and seed-to-stream handling.

## Architecture

- `src/store/scannerStore.ts` uses Zustand for shared UI state, favorites, and
  persisted screener and display preferences.
- `src/lib/screenerPreferences.ts` validates saved preferences and reads and
  writes shared view URL parameters.
- `src/store/dataStore.ts` holds per-symbol market snapshots;
  `src/store/feedStatusStore.ts` tracks loading, request errors, and update times.
- `src/lib/markets.ts` selects market endpoints and discovers the TradFi universe;
  `src/hooks/useMarketUniverse.ts` handles loading, errors, retry, and cancellation.
- `src/hooks/useRsiFeed.ts` connects the active market and timeframe to the
  REST/WebSocket lifecycle in `src/lib/rsiFeed.ts`, including cancellation,
  bounded concurrency, and automatic recovery.
- `src/components/ScreenerGrid.tsx` renders the three tabs, contextual filters, and
  card grid; `src/components/ScreenerCard.tsx` presents each pair's compact
  heading with the RSI panels or Fib trend preview for the selected tab.
- `src/hooks/useScreenerRows.ts` batches watchlist updates twice per second.
  `src/lib/screener.ts` caches closed-candle RSI divergence results and contains
  the pure filtering, sorting, and candle-change rules.
- `src/components/ScreenerChart.tsx` and `src/lib/drawScreenerChart.ts` draw price
  candles and aligned RSI with divergence overlays. Offscreen cards defer
  drawing until they approach the viewport.
- `src/lib/tugOfWar.ts` derives closed Heikin-Ashi candles, tracks pending
  sequences and latest-candle confirmations, and projects current-candle control
  without mutating closed analysis. The detail chart displays its Heikin-Ashi
  output; screener filters and cards do not use its Tug of War decisions or
  status labels.
- `src/lib/symbols.ts` lists Binance Spot USDT pairs. `bun run check:symbols`
  reports pairs that are halted, delisted, or duplicated.
- `src/lib/rsi.ts` contains the framework-independent RSI implementation.
- `src/lib/fibonacci.ts` contains the pure Fibonacci structure and lifecycle model;
  `fibScreener.ts` caches it separately and composes its screening filters.
  `fibPreferences.ts` validates the persisted/shared template. `FibChart`,
  `FibDetails`, and `FibSettingsPanel` render the chart, plan, and settings.
  Main Fib cards use a compact candles-and-trendline chart; full levels and
  trade details appear only in the clicked card's modal.
- `src/lib/rsiHistory.ts` aligns OHLC and RSI, separates live previews from closed
  candles, and recovers stream gaps without recalculating established history.
- `src/lib/divergence.ts` contains the pure pivot-pair detector and shared validation.
- `src/lib/divergenceLifecycle.ts` is the closed-candle state machine: provisional
  second pivot, next-candle confirmation, anchor invalidation, RSI 50 target, and
  14-candle expiry. Cards, detail charts, and the backtest all run this one engine.
- `src/lib/binanceHistory.ts` pages closed candles backwards from the exchange clock.
- `src/lib/divergenceBacktest.ts` replays history through the engine and summarises
  outcomes; `scripts/backtest-divergence.ts` is its CLI.
- `src/hooks/useDivergences.ts` runs the engine over each symbol's retained candles.
- `ChartModal` is loaded only when a chart is opened; `src/lib/drawRsiChart.ts`
  renders its aligned raw price, Heikin-Ashi, and RSI panels.

- `src/lib/liquidityLevels.ts` derives calendar references and strict sweep events;
  `liquidityScreener.ts` filters and sorts them. `srContextRest.ts`,
  `srContextFeed.ts`, and `srContextStore.ts` own daily data independently of RSI.
  `LiquidityScreener`, `LiquidityChart`, and `LiquidityDetails` render the tab.

Legacy pivot-based support/resistance and market-analysis helpers remain in the source tree,
but their views are not mounted or used by the calendar-liquidity tab. The original standalone HTML
file remains in the repository as a behavior reference.

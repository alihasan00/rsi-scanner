# Market Screener

Deployed app: [rsi-scanner-dusky.vercel.app](https://rsi-scanner-dusky.vercel.app/)

A Vite + React + TypeScript app with one **Screener** workspace for Binance Spot
USDT pairs. Each card keeps just a pair heading and a price and RSI chart.
Filters focus on **RSI divergences**. Binance REST seeds
the candle history and combined kline WebSocket streams keep it current. Open
any card for aligned price, Heikin-Ashi, and RSI charts.
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

The single **Screener** workspace shows a card for each watchlist pair. Each card
has a compact pair heading and favorite button,
followed by equally tall raw price candlestick and RSI(14) panels on a shared
timeline. Quotes, percentage changes, indicator breakdowns, and status footers
are omitted from cards. Selecting RSI divergences adds the matching setup's
state and age above the chart. The final hollow candle
is still forming; its price and RSI are provisional. Chart times are shown in
UTC. The candle-change sort uses the latest candle's open to its current close
on the selected timeframe, **not a 24-hour change**.

The timeframe remains selectable in the screener toolbar and is not repeated
in each card heading.

- **Search:** type a pair such as `BTC` or `BTC/USDT`; press `/` to focus search
  when no input or dialog is active.
- **Indicators:** choose **All indicators** or **RSI divergences**. Overview
  counters show pairs tracked and pairs with an active RSI divergence. There is
  no separate confirmation view or control; confirmation remains a signal state.
- **Divergence recency:** open **Indicator → RSI divergences** for nested choices
  of the latest **1**, **3** (default), or **5 closed candles**, or **Any age**.
  Selecting RSI divergences uses the current choice and opens those options in
  the same menu. This preference applies only to the RSI divergence filter;
  **All indicators** includes active divergences of any age.
  Bullish and bearish setups are included together.
- **Favorites:** star cards and switch to **Starred** for a focused collection.
- **Sorting:** use watchlist order, active signals, candle change, RSI ascending
  or descending, or pair name. **Active signals** ranks RSI divergence setups,
  with confirmed setups before forming setups.
- **Layout and timeframe:** choose comfortable or compact cards and a common
  candle timeframe. The selected view is saved across reloads and reflected in
  the URL.

Loading cards show **Waiting for market data**. Failed requests retry
automatically while available pairs keep updating. A small warning icon in the
card heading exposes **Data unavailable · retrying** or **Updates delayed**
(after 60 seconds without an update) through an accessible label and tooltip.
Pairs without loaded candles cannot satisfy signal filters. Empty
searches and filters have a reset action.

Click a chart to open the shared detail view. A compact header
shows the pair, timeframe, and current raw market price. Raw price, Heikin-Ashi,
and RSI charts share one timeline. Heikin-Ashi prices are labeled as averaged,
and the open candle updates live. Support/resistance, market-analysis, and
order-flow views are no longer part of the interface.

### Saved and shared views

Search, the indicator and its nested divergence recency, **Starred**-only,
sorting, timeframe, and card density persist in local storage and synchronize
with the URL. Control changes replace the current browser history entry.

| URL parameter | View preference |
| --- | --- |
| `q` | Pair search |
| `indicator` | `all` or `divergence` |
| `candles` | Latest `1`, `3`, or `5` closed candles, or `any` age |
| `starred` | `1` for Starred-only; otherwise All pairs |
| `sort` | `watchlist`, `signals`, `change`, `rsi-low`, `rsi-high`, or `symbol` |
| `timeframe` | Selected candle timeframe, such as `15m` or `4h` |
| `density` | `comfortable` or `compact` |

Any recognized parameter makes the URL the complete view. Omitted or invalid
values use defaults: empty search, All indicators, latest 3 closed candles,
All pairs, watchlist order, 15m, and comfortable cards. A URL without these
parameters restores the saved local preferences. Generated URLs always include
the timeframe, including for a default view, and preserve unrelated parameters.

For example, [BTC RSI divergences on 4h with a 5-candle window](https://rsi-scanner-dusky.vercel.app/?timeframe=4h&q=BTC&indicator=divergence&candles=5)
includes recent confirmations and newly forming setups awaiting confirmation.

**Reset filters** resets search, indicator, divergence recency, Starred-only,
and sorting to their defaults. It retains the timeframe, card density,
favorites, and chart settings. The favorite-symbol list and chart settings
themselves stay local; a shared Starred-only view uses the recipient's favorites.

### Heikin-Ashi and Tug of War library

The detail chart independently derives Heikin-Ashi candles. The underlying
`src/lib/tugOfWar.ts` analysis library also remains available, with the same
defaults as the sibling Rust CLI: **20 warmup candles**, a **0.05 minimum wick
ratio**, **2 minimum Tug of War candles**, and a **0.30 minimum body ratio**.
Tug of War does not contribute to screener filters, signal ranking, overview
counters, or card badges.

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

## RSI divergences

RSI divergence detection, lifecycle tracking, and chart overlays are always
enabled. **Settings → Include hidden divergences** adds hidden patterns. Two
separately switchable **Lecture filters** are on by default: wick/body agreement
and one RSI 50 cycle. The **RSI invalidation anchor** chooses which pivot's RSI
kills a regular setup. These settings apply to every card and detail chart;
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
- `src/hooks/useRsiFeed.ts` owns REST/WebSocket lifecycle state, including
  cancellation when the timeframe changes and automatic recovery.
- `src/components/ScreenerGrid.tsx` renders the unified overview, filters, and
  card grid; `src/components/ScreenerCard.tsx` presents each pair's compact
  heading and price/RSI chart.
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

Legacy support/resistance and market-analysis helpers remain in the source tree,
but their views are not mounted in the screener. The original standalone HTML
file remains in the repository as a behavior reference.

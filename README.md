# Market Scanners

A Vite + React + TypeScript app with separate **RSI** and **Support & Resistance**
tabs. It seeds Binance spot candles from REST and keeps each symbol current with
combined kline WebSocket streams. The RSI view, ported from `RSI Scanner.html`,
renders compact canvas charts plus an annotatable detail view.

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

## Support & Resistance

Select **Support & Resistance** to see every symbol's current price in USDT,
trend, nearest support, and nearest resistance, each with its percentage
distance from the live price. Toggle between **Cards** and **List**; the list
view is a compact table whose Pair, Support, and Resistance headers also set the
sort order. Search filters by symbol, and the timeframe picker applies to both
scanners. Switching tabs reuses the existing feed; the tab, view, sort, and
filters are saved across reloads.

Filters narrow the market to pairs that are interacting with a level:

- **Side:** apply the level conditions to support, resistance, or either.
- **Within:** keep pairs whose chosen level is within 0.25% to 5% of price.
- **Trend:** uptrend, downtrend, or sideways.
- **Touches:** require a zone built from two or three or more confirmed swings.
- **Testing only:** price is beyond a level that no candle has closed past yet.
- **Sort:** list order, nearest level, closest support, or closest resistance.

All level conditions must hold on the same level, so "within 0.5%" with
"2+ touches" means one zone that is both close and well tested. Pairs still
loading are hidden while any filter is active, because they cannot be
evaluated. Market-wide updates for filtering and sorting are throttled to a few
per second; individual cards still update on their own ticks.

The detector uses the latest 300 closed candles from the most recent continuous
history segment. A price swing low or high must be strictly lower or higher than
the three candles on each side, so a swing becomes available only after its
third right-hand candle closes. RSI values do not enter this calculation.

- **Zones:** confirmed swings within 0.1% of a surviving level merge into one
  zone whose price is the mean of its swings. Touches count the merged swings.
- **Retirement:** a closed candle's close more than 0.1% beyond a zone retires
  it. Wicks, equal closes, and closes inside that buffer keep the zone.
- **Support:** the highest surviving zone from swing lows at or below the live
  price. If the live price has crossed below a surviving support without a
  confirming close, that zone is shown instead and marked **Testing**.
- **Resistance:** the mirror image using swing highs, marked Testing when the
  live price has crossed above a surviving resistance.
- **Trend:** the latest two confirmed highs and latest two confirmed lows must
  both rise for an uptrend or both fall for a downtrend. Mixed or equal swings
  show sideways; insufficient swings show unknown.

Only closed candles form, confirm, or retire zones. Broken zones do not
automatically switch roles. Missing levels show a dash instead of extrapolating
beyond the available history. Invalid bars and gaps prevent comparisons with
older segments.

Levels are computed for every symbol in `src/store/supportResistanceStore.ts`
as candles are published, not inside the visible cards. The closed-bar structure
is rebuilt only when a candle closes; live ticks just reselect the nearest zone
against the new price. This keeps a market-wide proximity ranking possible.

## RSI divergences

Check **Divergences** in the header to enable detection, lifecycle tracking, and
chart overlays. It is off by default, and the preference is saved. **Settings →
Include hidden divergences** adds hidden patterns. Two separately switchable
**Lecture filters** are on by default: wick/body agreement and one RSI 50 cycle.
The **RSI invalidation anchor** chooses which pivot's RSI kills a regular setup.
Disabling the feature stops divergence calculation and removes its overlays
without restarting the market feed.

### What a card shows

Cards show only **live** setups: `Bull · forming` means the second pivot closed
on the latest candle and the next candle decides; `Bull · confirmed` with `3/14`
means the confirmation candle closed and 3 of the 14 allowed candles have
elapsed. Resolved setups leave the card. Open a card for aligned price candles
and RSI, overlay lines for live or all retained setups, and a log of every
setup detected in retained history with its outcome. The log doubles as a
forward test: reload or change a filter and it is rebuilt from the same rules.

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

Open a chart and use **Historical replay** to fetch closed candles from Binance,
add a 250-candle RSI warmup, and run the exact same engine over 1,000 to 30,000
candles. The panel reports detected, confirmed, RSI 50 hits, harmonised, expired,
and hit rate overall and per pattern, and exports CSV or JSON. The CLI does the
same for many symbols:

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
  clock. Up to 3,000 closed candles per symbol are retained for the outcome log.

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

- `src/store/scannerStore.ts` uses Zustand for shared UI state and persisted display preferences. Components subscribe through narrow selectors so unrelated changes do not fan out across the grid.
- `src/store/dataStore.ts` is intentionally a per-symbol external store. Market ticks notify only the matching card instead of running every grid selector on every update.
- `src/hooks/useRsiFeed.ts` owns REST/WebSocket lifecycle state, including cancellation when the timeframe changes.
- `src/lib/rsi.ts` contains the framework-independent RSI implementation.
- `src/lib/supportResistance.ts` detects confirmed price swings, merges them
  into zones, retires broken zones, and calculates trend. Structure building is
  separate from nearest-level selection so ticks stay cheap.
- `src/store/supportResistanceStore.ts` derives per-symbol levels from published
  market snapshots and caches the closed-bar structure between ticks.
- `src/lib/supportResistanceFilters.ts` holds the pure filter and sort rules;
  `useSupportResistanceRows` feeds them a throttled market-wide snapshot.
- `src/lib/symbols.ts` lists Binance Spot USDT pairs. `bun run check:symbols`
  reports pairs that are halted, delisted, or duplicated.
- `SupportResistanceGrid` and `SupportResistanceCard` render the separate price
  scanner with symbol search and per-symbol store subscriptions.
- `src/lib/rsiHistory.ts` aligns OHLC and RSI, separates live previews from closed
  candles, and recovers stream gaps without recalculating established history.
- `src/lib/divergence.ts` contains the pure pivot-pair detector and shared validation.
- `src/lib/divergenceLifecycle.ts` is the closed-candle state machine: provisional
  second pivot, next-candle confirmation, anchor invalidation, RSI 50 target, and
  14-candle expiry. Cards, the detail log, and the backtest all run this one engine.
- `src/lib/binanceHistory.ts` pages closed candles backwards from the exchange clock.
- `src/lib/divergenceBacktest.ts` replays history through the engine and summarises
  outcomes; `scripts/backtest-divergence.ts` is its CLI.
- `src/hooks/useDivergences.ts` runs the engine over each symbol's retained candles.
- `ChartModal` and its Konva drawing dependencies are loaded only when a chart is opened.

The original standalone HTML file remains in the repository as a behavior reference.

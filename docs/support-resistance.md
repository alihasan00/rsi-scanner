# Support and resistance: calendar liquidity

The **Support & Resistance** tab implements the calendar-liquidity and swing-failure portion
of [`r-s.txt`](../../r-s.txt). It is a contextual map of possible reactions,
not an entry system. A level can become support or resistance as price moves
across it. A touch alone is not a confirmed reaction.

The lecture also teaches manually selected Fibonacci and volume-profile
confluence. That part is not automated in this tab. Its 4h boxes are likewise
not included: their centers must come from those Fib/volume-profile levels,
not from ordinary swing pivots or the calendar levels below.

## Lecture evidence and scope

Most of the practical instruction is one long paragraph at `r-s.txt:29`.
The earlier explanation of oscillating mean levels is at lines 23–25.

| Subject | Transcript evidence | Implemented interpretation |
| --- | --- | --- |
| Meaning of levels | “these are oscillatory supports and resistances”; “these levels only suggest liquidity areas” | Areas price may sweep and reclaim; no guaranteed bounce or strength score. |
| Previous month | “لاسٹ منتھلی کرنٹ منتھ نہیں جو لاسٹ منتھ کلوز ہوا” | Previous completed calendar month OHLC. |
| Previous week | “لاسٹ ویک کی جو کینڈل ہے” | Previous completed calendar week OHLC. |
| Monday range | “منڈے کینڈل کی جو باڈی ہے” | Monday **body** lower edge, midpoint, and upper edge; excludes wicks. |
| Swing failure | “پرائس اوپر جا رہی ہے کلوزنگ نیچے ہوئی ہے”; “these levels are your SFP areas” | Wick beyond a level with a close back on the approach side; mirror for bullish cases. |
| Visibility | Monthly/weekly levels are valid on every timeframe; Monday template enables hours/minutes | Monthly and weekly levels on every supported frame; Monday levels hidden on 1d, 3d, and 1w. |

The lecturer uses 1d / 4h / 45m for swing trading but explicitly allows other
high/middle/low timeframe combinations, including 30m or 1h instead of 45m.
The tab uses the screener's selected timeframe to inspect reactions at its
calendar levels. It does not claim to perform the full three-frame method.

## Exact calendar definitions

All calendar boundaries use **UTC**, matching Binance daily candles. The
lecture does not specify a timezone; UTC is an implementation choice.
`periodStart` is inclusive, `periodEnd` is exclusive, and `availableFrom`
equals `periodEnd`. No level exists for signal detection before its source
period closes.

| Labels | Source values | Available | Replaced |
| --- | --- | --- | --- |
| Month open / high / low / close | First open, maximum high, minimum low, last close of the previous calendar month | First day of the new month, 00:00 UTC | Next month, 00:00 UTC |
| Week open / high / low / close | Same OHLC aggregation for the preceding Monday–Sunday week | Monday, 00:00 UTC | Following Monday, 00:00 UTC |
| Monday body low / midpoint / high | `min(open, close)`, body midpoint, `max(open, close)` of the latest completed Monday daily candle | Tuesday, 00:00 UTC | Following Tuesday, 00:00 UTC |

The previous Monday body remains current throughout the following Monday,
while the new Monday candle is forming. At Tuesday's boundary the new body
replaces it. If that completed candle is missing, the old range expires;
the application does not silently carry it for another week. A doji retains
all three source labels at the same price.

The lecture's manual routine refreshes low-timeframe work, weekly OHLC, and
Monday range on Tuesday; 4h work every other Tuesday; daily work and monthly
OHLC monthly, preferably on an early Tuesday. Calendar OHLC in the app rolls
immediately when the period closes instead of waiting for that manual
maintenance session. No fortnightly schedule is needed for the implemented
calendar-only scope.

## Reaction rules and availability

`analyzeLiquidity` returns the nearest distinct level strictly below live
price as support and strictly above as resistance. Exact equality is
returned separately in `atPrice`. Shared prices retain their individual
source labels; choosing one nearest level does not merge their provenance.
Crossing a level changes its displayed role and does not retire it before
the calendar replacement date.

A single-candle swing failure requires an immediately preceding,
contiguous **closed** candle. With level `L`:

- **Bearish:** previous close `< L`, current high `> L`, current close `< L`.
- **Bullish:** previous close `> L`, current low `< L`, current close `> L`.

All comparisons are strict. A wick touching `L`, a close exactly at `L`, or
an approach starting exactly at `L` does not qualify. Requiring the previous
close on the approach side is a conservative automation convention. The
lecture also mentions reclaim after one or two closes beyond a level, but
does not supply a complete validation rule; this variant is not detected.

The latest three closed candles may report **confirmed** events. A single
forming tail can report a **forming** event using its current provisional
close. It can disappear before close and cannot confirm anything. Events
sort newest first; `barsAgo = 0` denotes the latest closed candle, 1 and 2
the preceding closed candles. The forming tail also uses zero and is
distinguished by its state.

An event candle must begin at or after the level became available and end
before its replacement. A candle spanning a new calendar boundary cannot
retroactively sweep a level derived from that boundary. Expired levels and
their events are omitted, including when a multi-day candle crosses their
replacement date. Monday levels cannot emit events on daily-or-higher
charts because they are not visible there.

The daily map has an `asOf` watermark. `advanceLiquidityMap` advances its
effective clock to the latest valid closed display candle's `closeTime + 1`,
or a forming candle's `openTime`, whichever is later. Both visible-level
selection and reaction detection use this same advanced map, so stale
calendar levels disappear from charts and events together. A final exchange candle update is
evidence its close has happened; a daily map cached earlier therefore does
not suppress subsequent intraday events. A preview left behind past its
close time is stale and cannot produce a forming event.

## Data quality

`buildLiquidityMap` requires positive finite prices, consistent OHLC bounds,
nonnegative finite volume, ordered unique timestamps, and completed UTC
daily candles of exactly one day. Malformed, duplicate, out-of-order,
misaligned, or not-yet-closed daily input returns an empty map with a plain
warning. It does not sort, repair, or silently reinterpret invalid input.

Every day of a source week/month must be present. A gap or truncated period
omits that source and explains the missing data; independently complete
sources remain available. Missing days are never padded, and an older
complete week/month is never substituted for the actual previous period.
This also applies to instruments whose returned data omit non-trading days.

Display candles must have valid OHLC, the selected interval's duration,
chronological order, and at most one forming bar at the end. Invalid display
input cannot advance the map clock or produce events. A gap prevents a reaction from using the
candle before that gap as its approach candle. An invalid current price
returns no nearest levels or events.

## Daily feed and view preferences

The daily context feed uses the selected market's endpoints, up to 180 closed
daily candles, four concurrent seeds, and at most eight seed starts per second.
An exchange-clock request is shared for up to 30 seconds, expiring earlier at
UTC midnight. Each clock/history request has a 15-second deadline covering
both response headers and the JSON body; timeouts enter the normal retry queue.
Rate-limit responses pause the shared queue for `Retry-After`. Market/tab changes
abort requests, disconnect streams, and clear the context. Changing only the
reaction timeframe keeps the daily context. Midnight refresh also handles
quiet TradFi sessions without relying on a locally inferred candle close.

The default **Watchlist order** preserves the market universe's pair order,
matching RSI and Fibs (BTC, ETH, SOL first for Crypto). Loading and live price
changes do not reorder cards. Nearest-level, recent-sweep, and alphabetical
sorting remain explicit alternatives; filtering keeps the selected order.

The tab persists its source, signal, and sort filters in local storage and
the URL (`srSource`, `srSignal`, `srSort`, with `indicator=sr`). Source selection
applies before nearest-level and event analysis. Near means at most 0.5% of
live price from a selected visible level. Confirmed-sweep filters exclude
forming events and pairs whose daily or reaction feed reports an error.
Filter dismissal discards drafts; reset retains the tab, market, timeframe,
density, favorites, and Fib template.

## The remaining manual confluence

The lecture derives its primary SR levels by anchoring a volume profile at
a selected major low, drawing ordinary Fib retracements across a visually
selected range, and retaining ratios with substantial nearby volume. It
explicitly says, “it's all subjective, nothing is so perfect here.”

A separate set of fixed-range profile POCs comes from VSA clusters of
roughly four or five yellow bars within ten bars. The selected range extends
one candle before the first yellow bar and one after the last. These POCs
normally stay hidden and are enabled to assess confluence.

The transcript does not define the yellow-bar indicator formula, profile
estimator, exact anchor selection, significant-volume threshold, or distance
tolerance. Those would require additional specifications and clearly named
automation choices.

The 4h boxes center on **accepted 4h Fib+VP levels**. Their full height is
roughly an average 4h real candle body, with approximately **ATR/3** allowed
in the Q&A. They appear on 4h and lower charts for entry, retest, and target
review; only the nearest above/below boxes are useful at a time. Since those
centers are not available from the implemented method, calendar levels are
not dressed up as equivalent boxes. No stops, targets, position sizes, or
orders are generated from this calendar map.

## Verification

`tests/liquidityLevels.test.ts` checks cross-year weeks/months, leap February,
UTC rollover, Monday body versus wick range, missing days and source
coverage, malformed data, exact touches, role changes, confirmed/provisional
reactions, recency, continuity, calendar availability/expiry, and immutable
inputs.

# Harmonic patterns

The **Harmonic Patterns** tab screens bullish and bearish **Gartley**, **Bat**, and
**Butterfly** patterns from [lecture 17](../../transcripts/l-17.txt) and
[lecture 18](../../transcripts/l-18.txt), with exact template settings recovered
from the user-supplied `L-17.mp4` and `L-18.mp4` source videos. It identifies a conditional reversal
area: **if price reaches D, that area may reject price**. A projected D does
not predict that price will reach it, and a zone touch does not confirm a
reversal. No orders are placed.

## Lecture evidence

References beginning `l-17:` or `l-18:` below are line numbers in the supplied
transcript files. Video references use playback timestamps. The original
videos are supplied separately in `Documents/Monty`; they are not bundled
with the frontend.

| Subject | Evidence | Interpretation |
| --- | --- | --- |
| Supported families | `l-17:19` | Gartley, Bat, and Butterfly only. |
| Direction | `l-17:77–79` | XA rising means bullish, with a possible long reversal at D; XA falling means bearish. |
| Roles of the legs | `l-17:85–87`, `l-18:21–27` | B identifies the family, C validates it, and D defines the entry area. |
| Ideal ratios | `l-17:95–103` | B and D are measured against XA; C is measured against AB. |
| Tolerance | `l-17:111–117` | The lecture motivates its bands with ±10%; detection uses the literal values in its saved on-screen templates. |
| Invalid B | `l-18:45–47` | A B pivot between the accepted family bands is not a valid pattern. |
| A/C structure | `l-18:91–105` | Bullish A/C form lower highs; bearish A/C form higher lows. C must reach its accepted retracement band. |
| Chronology | `l-18:111` | C follows the actual B extremum; do not ignore an intervening more extreme B to fit a pattern. |
| Conditional D | `l-18:135` | The analysis says what may happen if D is reached, not where price must go. |
| C invalidation | `l-18:141–143` | A wick through C's outer boundary invalidates the pattern, in either direction. |
| Early discovery | `l-18:147` | Prefer CD already beyond B: below B for bullish patterns, above B for bearish patterns. Earlier patterns remain early. |
| Price scale | `l-18:51`, `l-18:183` | Harmonics use linear price ratios, not logarithmic calculations. |
| Timeframe | `l-18:197` | The trader may choose the timeframe; there is no required single interval. |

## Ratios and boundaries

For chronologically ordered, alternating swing points X, A, B, C:

```text
B ratio = abs(A − B) / abs(A − X)
C ratio = abs(C − B) / abs(A − B)
D price at ratio r = A − r × (A − X)
```

All price calculations are linear, including when the separate Fibs tab uses
a logarithmic template. B must fit one of these bands, including its endpoints:

| Family | Ideal B ratio | Accepted B ratio | Ideal D ratio | Accepted D ratio |
| --- | --- | --- | --- | --- |
| Gartley | 0.618 | 0.556–0.678 | 0.786 | 0.707–0.864 |
| Bat | 0.382–0.500 | 0.343–0.550 | 0.886 | 0.797–0.974 |
| Butterfly | 0.786 | 0.707–0.864 | 1.272–1.618 | 1.144–1.779 |

For all three families, the ideal C ratio is **0.382–0.886** and the accepted
C ratio is **0.343–0.974**, including endpoints. The accepted values are the
literal settings shown in the original homework templates. They are not
recomputed from the ideal ratios; display formatting does not alter detection.

The transcript's arithmetic and a later spoken Gartley entry answer are
inconsistent: `0.618 × 1.1` equals `0.6798`, but `l-17:115` says `0.678`;
`l-18:189` also calls `0.678` the Gartley entry start. The source video resolves
which settings to implement: Gartley's saved **B** band ends at `0.678`, while
its saved **D** band starts at `0.707`. The saved template values take priority
over a recalculated ±10% formula or the inconsistent spoken answer.

C's outer limit is `B + 0.974 × (A − B)`. A bullish pattern is invalid if a
later high exceeds that price; a bearish pattern is invalid if a later low
falls below it. Equality is still inside the band. Returning through C's
inner boundary on the way toward D is expected and does not invalidate the
pattern.

### Original video settings

The following native settings dialogs in `L-17.mp4` supply the numeric
templates omitted from the transcript. Enabled 0 and 1 lines are anchor
references; they are not additional target orders.

| Video time | Saved template | Verified values |
| --- | --- | --- |
| 35:06 | Harmonic Bat D | B `0.343–0.550`; D `0.797–0.974` |
| 35:12 | Harmonic Bat TP A-D | `0.382`, `0.618`, `0.886`, `1.382`, `1.618` |
| 35:18 | Harmonic Butterfly B-C for D | `1.4562–2.8798` |
| 35:24 | Harmonic Butterfly D | B `0.707–0.864`; D `1.144–1.779` |
| 35:33 | Harmonic Butterfly TP C-D | `0.236`, `0.618`, `0.886`, `1.12`, `1.27` |
| 35:39 | Harmonic Gartley D | B `0.556–0.678`; D `0.707–0.864` |
| 35:42 | Harmonic Gartley TP A-D | `0.236`, `0.382`, `0.618` |
| 35:48 | Harmonic Leg C | `0.343–0.974` |

## Automation conventions

The lectures demonstrate visual selection. They do not specify a pivot
algorithm, a history length, a confirmation delay, or a setup expiry. The
following are explicit implementation conventions rather than additional
lecture rules:

- Use at most the latest **500 closed candles** from the current timeframe,
  restricted to the latest contiguous segment. Missing candles are not padded
  and patterns do not span a history gap.
- A strict **3/3 wick pivot** must be more extreme than the three closed
  candles on each side. Its pivot time and its availability time differ:
  it is available only when the third right-hand candle closes. Equal
  neighboring extremes do not qualify as strict pivots.
- Build consecutive alternating pivots. When consecutive candidates are on
  the same side, retain the more extreme one. Do not search arbitrary
  combinations of nonadjacent pivots until ratios happen to fit.
- Freeze the first accepted C for each XAB triple and consume that triple.
  A later C retest cannot revive an expired, missed, completed, or invalidated
  setup. A candle that is simultaneously a strict high and strict low pivot
  is skipped because its intrabar high/low order is unknown.
- X, A, B, and C must all be available before the setup can report a D touch.
  A touch before or on C's confirmation candle is marked missed, not reused
  as a new entry signal. D records the first subsequent observed contact;
  it is not an assumed future pivot or an executed fill.
- An unfilled pattern expires on the **60th closed candle after C**. D
  touches stay recent for the latest **three closed candles**, including the
  touch candle; the setup then becomes completed and leaves the active
  results rather than remaining actionable indefinitely.
- Candle wicks determine zone contact and structural violations. When a
  candle both reaches D and breaches a boundary, the violation takes
  precedence; OHLC data cannot establish which happened first.
- A wick past D's far edge retires the scanner setup. This conservative
  convention does not imply that the lecture's stop beyond D or X was
  executed. Nonpositive or nonfinite projected D prices omit a candidate.

The stages distinguish structure from live proximity:

| Stage | Meaning |
| --- | --- |
| Early setup (`forming`) | XABC is valid, but no CD candle has closed strictly beyond B toward D. This is the lecture's early catch. |
| Approaching D (`approaching`) | A CD candle has closed strictly beyond B toward D, but no eligible closed candle has touched D. |
| D zone reached (`zone`) | An eligible closed candle touched D within the latest three closed candles, without invalidating the setup. This is contact, not reversal confirmation. |

A forming market candle may update live distance to the D zone, indicate
that price is currently in the zone, or flag a provisional boundary breach.
It cannot confirm a stage or promote a provisional touch into a closed-candle
event. Live proximity can change before close. A forming candle's wick breach
remains provisionally flagged even when its latest price returns inside the
boundary; the closed setup itself changes only after candle closure.

## Stops, targets, and manual confluence

The display can identify structural stop boundaries, not an exact executable
stop order. For bullish patterns, the lecture places a stop below the D zone;
bearish patterns mirror this above the zone. Bat's preferred stop lies beyond
X. Gartley may use the zone boundary or, as the lecturer prefers, the more
distant X boundary (`l-18:165–167`). No tick allowance, percentage, ATR buffer,
position sizing, or execution rule is provided. A displayed boundary therefore
needs an independently chosen buffer before it could be used as an order.
The application uses X as the reference for Gartley and Bat, and D's far
edge as the reference for Butterfly.

The lecture describes the take-profit anchors at `l-18:169–175`; the original
L17 video supplies their exact saved ratios:

| Family | Fibonacci anchor for targets | Target reference ratios |
| --- | --- | --- |
| Bat | A → D | `0.382`, `0.618`, `0.886`, `1.382`, `1.618` |
| Gartley | A → D | `0.236`, `0.382`, `0.618` |
| Butterfly | C → D | `0.236`, `0.618`, `0.886`, `1.12`, `1.27` |

For ratio `r`, target price is `D + r × (A − D)` for Bat/Gartley and
`D + r × (C − D)` for Butterfly. Before an eligible D touch, the application
uses the midpoint of the projected D zone and labels levels as projected.
After a touch, it uses the first actual closed-candle contact stored at D.
That contact is an observed price, not a confirmed terminal D pivot, entry
fill, or guarantee of reversal. The target lines are reference levels; there
are no inferred exit allocations, partial fills, stop moves, or profit records.
Nonpositive target prices are unavailable rather than tradable levels.

For Butterfly only, the **B → C for D** template can narrow the XA-derived D
zone (`l-18:153`). Its candidate endpoints are
`C − 1.4562 × (C − B)` and `C − 2.8798 × (C − B)`, from `L-17.mp4` at
35:18. Where this BC band has a positive-width overlap with the full D zone,
the overlap becomes the effective zone. If there is no overlap or the bands
only meet at one price, the full XA zone stays in use; BC
does not disqualify the pattern. This is an optional refinement in the
lecture, not a general pattern-identification rule. `l-17:57–69` expressly
excludes BC ratios from normal identification and validation.

The lecture asks for additional confluence at D: horizontal support or
resistance, moving averages, order blocks, fair-value gaps, psychological
prices, and VWAP (`l-17:121`). It also prefers patterns whose shaded area
contains the majority of candle closes (`l-18:121–129`). These checks remain
manual; neither subjective visual quality nor an assumed success percentage
is a confirmation signal. Butterfly is described as harder to trade because
it often opposes the trend (`l-18:137`).

## Screener and preferences

The tab uses the selected market's existing candle feed and timeframe.
Crypto retains its Spot universe; TradFi retains its discovered perpetual
universe. Harmonic analysis is independent of RSI and Fib signal filters.
Market, timeframe, symbol search, **All pairs / Starred**, and card density
are shared with the other screener tabs.

Default **Watchlist order** preserves the current market's universe order.
Price updates and newly loaded symbols do not continually reorder existing
cards. **Nearest D zone** and **Symbol** are optional sorts. Harmonic filters
and sort persist in the URL and local storage with `indicator=harmonic`:

| Setting / URL key | Choices | Default |
| --- | --- | --- |
| `harmonicPattern` | `all`, `gartley`, `bat`, `butterfly` | `all` |
| `harmonicDirection` | `any`, `bullish`, `bearish` | `any` |
| `harmonicStage` | `all`, `forming`, `approaching`, `zone` | `all` |
| `harmonicSort` | `watchlist`, `nearest`, `symbol` | `watchlist` |

Stage filters use closed-candle state; a live price moving into D does not
make the setup satisfy the closed D-zone filter. The Filters modal presents
only harmonic pattern, direction, and stage choices on this tab; RSI, Fib,
and support/resistance filters do not constrain harmonic results. Applying
harmonic filters preserves those other tab choices.

Filter modal changes apply on **Apply**, while dismissal discards drafts.
Recognized URL preferences define the complete view before feed startup
and take priority over saved preferences; a bare URL restores the saved view.
Reset and **Clear all** retain the harmonic tab, remembered RSI selection,
market, timeframe, card density, saved favorites, and Fib template. They
restore the pair collection to **All pairs** and reset filtering and sorting.

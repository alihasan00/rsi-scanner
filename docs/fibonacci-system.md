# Fibonacci system

The screener turns the supplied `fib-1.txt` and `fib-2.txt` lectures into
repeatable setup detection, chart levels, and a scaled trade plan. It works on
the selected timeframe for both Crypto Spot pairs and TradFi perpetuals. A
short setup on a Spot chart describes bearish price structure; it does not
make that Spot pair a shortable instrument.

This document separates the lecturer's rules from choices needed to automate
chart examples. Transcript references are original line numbers in
[`fib-1.txt`](../../fib-1.txt) and [`fib-2.txt`](../../fib-2.txt). The supplied
text contains references to visible chart levels whose numbers are sometimes
omitted. The user-supplied Fib settings screenshot confirms the negative
extension ratios used below; exact historical chart parity is not claimed.

## Using the screener

Choose the **Fibs** screener tab. Its cards show the symbol, live price,
favorite star, and **Uptrend** or **Downtrend**, with raw candles and an impulse
trendline. The compact summary beside the tabs shows loaded pairs and Fib
setup count. Golden-pocket shading, ratios, entry levels, targets, and stops
appear inside the clicked card's detail view.

Open **Filters** on Fibs to select long or short direction, waiting or active
setups, or golden-pocket proximity. The optional SMA200 filter keeps setups
aligned with that moving average. These choices combine with pair search, RSI
state, favorites, market, and timeframe. The RSI tab instead offers **All RSI
charts** or **RSI divergences**, with divergence recency when selected. Use the
tabs to change systems; the filter modal stays within the selected tab.

Clicking a Fib card opens **Fib system** detail, showing the anchors, golden
pocket, three scaled entries, initial and current stop, targets, and remaining
runner. The modal can also switch to **Price & RSI**. The detail chart's **Full
grid** option includes every enabled reference ratio from the screenshot;
**Trade levels** keeps the entry/target/stop view compact. Exact grid prices and
recent events are available below the plan. Reference levels whose calculation
is nonpositive or nonfinite are explicitly marked unavailable.

Open **Settings** from Fibs, or **Fib settings** inside the card detail, to
select linear or logarithmic levels, the initial stop ratio, and extension
targets. **Apply Fib settings** saves the draft. The selected tab, filters,
and Fib template are saved and shared through the view URL: `indicator=fib`
selects Fibs, while `all` or `divergence` selects RSI. The previous RSI signal
choice is remembered locally when switching tabs. **Clear all** and **Reset
filters** keep the current tab and Fib template while resetting shared filters
and sorting; an RSI reset selects **All RSI charts**. Dismissing a filter
modal without applying discards its edits.

The current candle can show live proximity to a level. It cannot confirm a
swing, create or fill a setup, hit a target, or move a stop. Lifecycle changes
use closed candles only.

## Lecture rules

| Topic | Rule | Transcript |
| --- | --- | --- |
| Orientation | Long: draw from a low to a later high. Short: from a high to a later low. | `fib-1.txt:53–59` |
| Midpoint | `0.5` separates the two halves of the impulse. It is not the golden pocket. | `fib-1.txt:39–41,87` |
| Golden pocket | The zone between `0.618` and `0.666`. | `fib-1.txt:23,87` |
| Entries | `0.618`, `0.786`, `0.886`, with recommended allocations of 20%, 30%, 50%. | `fib-2.txt:27–31` |
| Initial stop | Default `0.92`; alternatives `1.04`, `1.14`, and `1.272` for different volatility conditions. Wider stops need revised exposure. | `fib-2.txt:23–25` |
| TP1 | Take 20% at `0.382`; move stop to the average of entries actually filled. | `fib-2.txt:33` |
| TP2 | Take another 20% at `0.236`; move stop to TP1. | `fib-2.txt:35,41` |
| TP3 | Take another 20% at `0` or the extension spoken as `0.236`; the lecturer prefers moving stop to TP2. | `fib-2.txt:37,41` |
| TP4 | Take 30%; move stop to TP3. The target ratio is not spoken. | `fib-2.txt:39–41` |
| Runner | Keep 10%. At the later extension spoken as `0.618`, move stop to TP4 without taking another partial exit. | `fib-2.txt:41–45` |
| Stop progression | Move the stop after each target every time; the remaining position exits if that stop is hit. | `fib-2.txt:105–109` |

Exit percentages are portions of the filled position before exits, rather than
successive percentages of the remainder. The lecturer's example books
20 + 20 + 20 + 30 = 90% and leaves 10% running (`fib-2.txt:41`).

### Structure and significant swings

A local structure must break before the next retracement can supply a trade.
The lecturer explicitly uses closes below a low for bearish structure and
waits while neither the current high nor low is broken
(`fib-2.txt:65,85,93,107`). The scanner applies closed-price breaks to both
directions.

A replacement swing must retrace at least half of the preceding significant
impulse. A shallower pullback keeps the older origin. When a newer significant
low or high is established, the previous same-side origin is retired
(`fib-2.txt:73–81,95`). The terminal anchor is the subsequent extreme in that
local structure. If price extends before the entries fill, the unfilled plan
must follow the new extreme (`fib-2.txt:81–83,97`).

Wait for the terminal extreme to mature and retracement to begin. The lecture
suggests allowing three or four candles to play out (`fib-2.txt:71`), but does
not specify a complete pivot detector. Launch wicks are not reliable structure;
after an exceptionally large candle, wait for structure again
(`fib-2.txt:65,109`).

A golden pocket that has already supplied its trade is not reused for a new
entry. Its price can still be a support or resistance reference. After a stop
or completed setup, wait for new structure rather than repeatedly entering the
same pocket (`fib-2.txt:89,99–101,107`).

### Automated pivots and maturity

The scanner makes the qualitative structure rules reproducible with these
explicit conventions:

1. A price pivot is a strict high or low against three closed candles on each
   side. Equal-height or equal-low plateaus do not qualify. An outside candle
   that qualifies as both a high and low is excluded because their intrabar
   order is unknown. A pivot at candle `p` is available only at the close of
   `p + 3`.
2. A later same-side pivot replaces its significant anchor when the intervening
   retracement covers at least 50% of the prior accepted opposite leg. If no
   accepted opposite leg intervened, only a new same-side extreme replaces it.
3. A close strictly above the significant high starts a long impulse; a close
   strictly below the significant low starts a short impulse. Merely touching
   the boundary does not break it. The latest eligible opposite significant
   anchor is the origin.
4. The impulse endpoint follows wick extremes and must itself become a strict
   pivot with three closed candles on each side. The retracement plan becomes
   available after both that maturity and the closed structure break. This is
   distinct from the origin pivot's own confirmation; it cannot backdate a
   plan before the required evidence was available.
5. Entry orders are hypothetical only after the plan is available. If an entry
   level was already touched after the endpoint but before or at maturity,
   the opportunity is marked missed, with no backdated fill. A missed or filled
   origin is consumed and cannot supply another setup.
6. An unfilled plan can be superseded by a new terminal extreme, then must
   mature again. The old plan's entry touch is checked before replacing it:
   an entry and extension in the same bar cannot erase that entry. Once an
   entry fills, anchors and levels are frozen for that setup.

Three left and right bars, strict equality rules, symmetric close breaks,
missed-entry handling, and consumed-origin tracking are automation choices.
The transcript specifies the 50% significance test and suggests three or four
bars of maturity, but does not specify this full algorithm.

Analysis uses the latest contiguous suffix of at most 500 closed candles.
Missing or malformed candles break that sequence rather than being filled with
invented data. Signals depend on the history available inside that window; the
500-candle cap is a computation limit, not the lecturer's definition of an old
structure. The open candle never supplies evidence for a historical pivot or
lifecycle transition.

## Level calculations

Let `origin` be the impulse's starting extreme, `end` its terminal extreme, and
`r` the retracement ratio. Linear levels use:

```text
price(r) = end + (origin - end) * r
```

The `0` level is the terminal extreme and `1` is the origin. For a long setup,
deeper entry ratios produce lower prices; for a short setup they produce higher
prices. Negative ratios extend beyond the terminal extreme in the trade's
direction. The golden pocket is always the price interval between `price(0.618)`
and `price(0.666)`, irrespective of their ordering.

Logarithmic levels interpolate positive prices in log space:

```text
price(r) = exp(log(end) + (log(origin) - log(end)) * r)
```

Linear is the default. The logarithmic option changes the calculated levels,
not only the chart's appearance. The lecture acknowledges that a wick can
reach an entry on the linear chart while another scaling misses it
(`fib-2.txt:97`); it does not prescribe a universal scale. Price inputs and
calculated trade levels must remain finite and positive.

### Screenshot-confirmed extension defaults

The configured defaults are TP3 `−0.236`, TP4 `−0.382`, and runner threshold
`−0.618`. TP3 can also use the explicitly mentioned `0` level. The screenshot
confirms that all three negative ratios are enabled. Their assignment to TP3,
TP4, and the runner follows the sequence in the second lecture:

- TP1 `0.382` and TP2 `0.236` are explicit in the text.
- The TP3 extension is spoken as `0.236`; the screenshot supplies its minus
  sign. TP3 `0` is an explicit alternative (`fib-2.txt:37`).
- For TP4, the transcript only says “here” (`fib-2.txt:39`); the screenshot
  supplies the intervening `−0.382` level.
- The final `0.618` is described as a further extension; the screenshot
  supplies the minus sign (`fib-2.txt:41–45`).

The screenshot's enabled grid is `0`, `0.236`, `0.382`, `0.5`, `0.618`,
`0.666`, `0.786`, `0.886`, `0.92`, `1`, `1.618`, `3.618`, `−0.236`, `−0.382`,
and `−0.618`. Positive `1.618` and `3.618` are reference grid ratios, not
additional profit targets in the lecture's trade sequence. Alternative stop
ratios remain available from the lecture even though they are not enabled in
this screenshot.

Changing targets recomputes the hypothetical replay. It does not change an
order at an exchange.

### Allocation and average entry

The 20/30/50 entry allocations are shares of a fixed quote-currency budget. For
filled entries with allocation `w_i` and level price `p_i`:

```text
quantity_i = w_i / p_i
averageEntry = sum(w_i) / sum(quantity_i)
```

Only filled allocations participate. One fill uses that entry's price; two
fills use their combined quantity and cost, and the third fill updates it
again. This harmonic weighting represents equal quote-budget accounting. A
simple allocation-weighted arithmetic mean would instead assume the weights
describe base-asset quantities.

The lecture discusses changing average cost as entries fill and describes
allocations as portions of margin (`fib-2.txt:31–35,41,59`), but does not state
an averaging formula. Quote-budget accounting is therefore an explicit
implementation convention. The displayed average and stop omit fees,
slippage, funding, and leverage.

## Closed-candle lifecycle and OHLC ambiguity

Waiting means the structure and mature endpoint have supplied an unfilled
plan. Active means at least one entry has filled and some of the hypothetical
position remains open. Golden-pocket proximity describes the latest available
price relative to that zone; it can change while a candle is still forming
without changing the closed-candle lifecycle.

Wicks that include an entry or target level can count as touches, consistent
with the lecture's wick-fill example (`fib-2.txt:97`). A candle's open, high,
low, and close do not reveal the sequence of trades inside it. The replay uses
these conservative conventions:

- Process touches against an existing waiting grid before changing its anchors.
  Entry fills freeze the plan; targets on a candle that adds any entry are
  suppressed because the favorable excursion may have happened before that
  entry.
- An existing stop takes priority over target touches in the same candle.
- If a target moves the stop and that candle also spans the newly moved stop,
  mark the candle ambiguous and exit the remaining position at that stop.
  This is an adverse ordering assumption, not an observed intrabar path.
- Cancel any unfilled second or third entry when TP1 is reached. Subsequent
  movement cannot add to a position that has already started taking profits.
- Each target is taken once. After TP1, stop uses the average of the entries
  filled so far; after TP2, TP3, TP4, and the runner threshold, it moves to TP1,
  TP2, TP3, and TP4 respectively. A stop never moves backward.

A price gap can pass a resting level without printing its exact price. Entry
touches use the configured limit price as the model price. When a candle opens
beyond a stop, the event records that actual execution is unknown and could
be worse than the displayed stop. This is separate from a gap in candle data,
which breaks the analyzed history.

Canceling pending entries after TP1 and the OHLC ordering rules are scanner
conventions. The lecture does not state a full exchange-order lifecycle. The
remaining 10% after TP4 has no additional fixed sell target; its stop advances
to TP4 only when the configured runner threshold is reached.

## Confluences and discretion

SMA200 is optional context: above it favors longs and below it favors shorts;
recovering it argues against a short (`fib-2.txt:93`). A full 200 closed candles
are required, and alignment uses the latest closed price strictly above or
below their average, respectively. Equality does not qualify as aligned.
The lecture also demonstrates the Fib rules without additional
confluences (`fib-2.txt:91–93`).

Golden-pocket rejection, a reclaim followed by bullish engulfing (“golden
engulfing”), and repeated failure to reclaim the pocket can inform manual
management (`fib-2.txt:67,99–101,117`). Large fair-value gaps can justify a wider
stop together with different sizing (`fib-2.txt:87`). The text does not provide
complete numerical rules for those decisions.

The scanner does not automatically widen a stop, change the 20/30/50 allocation,
or take a discretionary early exit because of those observations. Selecting a
wider initial stop is a different replay configuration. The lecturer's warning
about very old structures has no stated age threshold (`fib-2.txt:83`). Any
implemented age limit is a scanner convention, not a quoted lecture number.

## Interpretation limits

The app detects a technical pattern from public candles and shows a
hypothetical trade plan. It does not place orders or connect to an account.
Level touches, average entry, and stop progression are replay state, not
confirmed exchange fills or guaranteed profit. A stop at the modeled average
is only nominal break-even before fees and execution costs.

Higher-timeframe accuracy is the lecturer's qualitative claim
(`fib-1.txt:59`), not a measured win rate for this implementation. Discretionary
chart judgment cannot be recovered exactly from the transcripts.

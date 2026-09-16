# RSI trendlines

Choose **RSI → Filters → RSI trendlines → Apply**. This shows pairs with a
formed line, a line near a break, or a recent closed-candle break. Trendlines
replace divergence overlays in both the card and its detail chart. There is
one RSI panel; the existing price and Heikin-Ashi layouts are unchanged.
Choose **RSI divergences** to return to divergence setups. **All RSI charts**
retains the existing unfiltered RSI/divergence view.

The selected mode persists in local storage and the `indicator=trendline` URL
parameter, and is remembered when visiting another tab. Search, favorites,
timeframe, and RSI-state filters still apply. Divergence age does not restrict
trendlines. Active-signal sorting places recent breaks before approaching
lines, then formed lines. The summary counts qualifying pairs, not individual
lines.

## Lecture evidence

The sources are the local text transcripts; these claims are not an independent
audio/video verification.

- **Lecture 14, paragraphs at lines 153–171:** avoid steep lines, recognize
  cycles between RSI 50 touches, prefer same-cycle anchors that hold a clear
  trend, and prefer the break to occur on the opposite side of 50 from the
  anchors. Sideways charts should not have forced trendlines. Mixed-cycle
  lines receive weaker treatment, and visually clear curves are permitted.
- **Lecture 15, lines 159–161:** a triple-anchored line and moving-average
  break add confluence. The text does not require three anchors for every
  RSI trendline or explicitly identify that particular line as RSI.
- **Lecture 19, lines 43 and 53–65:** RSI trendlines on 4h/daily can select
  coins. Formed, approaching-break, and already-broken situations are discussed,
  then price analysis supplies a possible entry/retest. These are narrated
  situations, not a numerical scanner specification.
- **Lecture 20, lines 27 and 149:** RSI trendline breaks provide oscillator
  confluence; a lower RSI line breaking down argues against longs. No warning
  duration or reset is specified.
- **Lecture 3, lines 255–295 and 747:** mature anchors and an
  extreme-to-first-geometric-touch ray are taught on price charts. Applying
  that construction to RSI, and using exactly five candles on each side,
  are scanner interpretations. Price-wick exclusions do not filter RSI spikes.

## Detection conventions

`src/lib/rsiTrendlines.ts` replays contiguous, valid closed RSI(14) bars using
information available at each close. The shared strict pivot primitive also
serves divergence detection without changing its mature/provisional rules.

| Rule | Initial default |
| --- | --- |
| Mature pivot | Strict high/low against 5 candles on each side; ties excluded |
| Cycle | Strictly above or below 50; equality or crossing resets it |
| Incomplete history boundary | Skip the first cycle until its start can be observed |
| First anchor | Cycle extreme known at formation, itself a mature pivot |
| Second anchor | Later mature contact in that same cycle |
| Direction | Falling resistance above 50; rising support below 50 |
| Anchor separation | At least 5 candles |
| Anchor RSI difference | At least 3 points |
| Absolute slope | 0.05–1.5 RSI points per candle, independent of chart size |
| Allowed line violation through formation | At most 0.5 RSI points |
| Approaching | Closed RSI is within 2 points on the holding side, including the tolerated 0.5-point overshoot |
| Break | A later close strictly more than 0.5 points through the line |
| Unbroken lifetime | Ages 0–119 after formation; expires at age 120 |
| Recent broken lifetime | Break age 0–11; expires at age 12 |

These thresholds are explicit product defaults, not lecturer-specified values
or profitability claims. The slope and anchor-change requirements are simple
filters for flat/noisy or steep structures; they are not a complete sideways
market classifier. Curves, mixed-cycle anchors, and provisional anchors are
excluded from this version.

Each candidate ray must hold every closed RSI sample from the first anchor
through the second anchor's confirmation candle. Five right-hand closes delay
formation by 20 hours on 4h and five days on daily. A break that occurs before
the line becomes observable is not backfilled as an opportunity. An additional
mature contact can increase the touch count while preserving the anchors. A
different eligible ray can supersede the unbroken line from the same cycle;
the earlier record stays in the returned history.

**Crossing 50 after the anchors does not expire the line.** It must survive
that transition to detect the preferred opposite-side break. A resistance
break closing below 50 or a support break closing above 50 is labeled **ideal**.
Same-side breaks and closes exactly at 50 receive **non-ideal** grading.
Breaks are confluence, not automatic entry instructions.

## States and display

Lines move between **formed** and **approaching**, then to **broken** or a
resolved state (**expired**, **superseded**, **interrupted**). Proximity describes
distance, not a forecast. The open candle updates the RSI drawing but cannot
form anchors, confirm breaks, advance ages, or clear a warning.

An unbroken line expires before evaluating a potential break at age 120. A
recorded break keeps its anchor pair, formation time, break time, break RSI,
grade, and identity as later bars arrive. Broken relevance expires at age 12.
A gap or malformed/interior unclosed bar interrupts affected lines; detection
does not bridge missing evidence.

**No longs · RSI support broken** is a display warning for a recent support
breakdown. It ends on the first closed RSI at or above that ray, at broken age
12, or on a data interruption. A reclaimed event does not reactivate its
warning. The original broken line can remain visible until its age expires.
This convention applies to the selected timeframe only and does not alter
divergence lifecycle decisions or execute trades.

At most one resistance and one support line are drawn. The most recently
formed eligible line of each kind is selected, except an active bearish warning
takes priority for support. Amber is resistance; blue is support. Solid spans
connect the original anchors, dashed spans extend forward, and circles mark
the observed break RSI. Broken rays stop at their break candle. Off-screen
anchors retain their original geometry and are clipped to the plot; no false
anchor dots are placed on its edges. Price retests remain discretionary.

## History and validation

Detection uses the retained `bars`, not the 72/80-candle display windows. A live
seed requests 350 candles, normally yielding 335 closed RSI samples after
warm-up, and can grow toward a 3,000-bar cap. Reloads, timeframe/market changes,
and recovery gaps can shorten history and remove older evidence. Results are
causal within the retained replay; this feature does not create persistent
cross-session signal storage or fetch extra history.

Card, detail, filters, and ranking share cached analysis of the same closed
bar identities. Live preview changes reuse it; corrected history invalidates
it. Tests cover maturity, cycle boundaries, tangent violations, prefix
causality, grades, live immunity, reclaim/expiry, gaps, filter intersections,
preference restoration, exclusive overlay modes, and off-screen projection.

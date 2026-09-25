# Harmonic script comparison — 25 September 2026

Implementation follow-up: active-setup checkpoints, ratio-fit diagnostics,
separate terminal D-pivot confirmation, and harmonic historical comparison were
subsequently implemented following user approval. See the current
[harmonic rules](./harmonic-patterns.md) and [research guide](./harmonic-research.md).
The original findings and reproduction below describe the reviewed baseline.

The supplied **Harmonic Pattern Detection, Prediction, and Backtesting System**
by **reees** offers useful ideas for quality measurements, D-pivot confirmation,
and pattern timing. It does not establish that replacing our lecture-based
detector would improve trading results. The best sequence is to fix active-setup
continuity, add explainable diagnostics, then evaluate new filters on unseen data.

This is an assessment at repository commit `e851884`; application behavior was
not changed. References to “Pine” below are line numbers in the supplied
843-line attachment. Its imported libraries were not included, so their internal
calculations were not verified. The review covers the visible code and our local
implementation. All **74 existing harmonic tests passed** (402 assertions).

## Recommended improvements

| Priority | Improvement | What the comparison shows | Recommended application |
| --- | --- | --- | --- |
| First | Preserve active setups across the history window | Pine retains pending pattern objects; our scanner reconstructs everything from the latest 500 candles. A live setup can disappear without a lifecycle event. | Retain active state and anchor provenance independently of the discovery window; verify correction, gap, reconnect, and reload behavior. Reproduction below. |
| High | Explainable geometry quality | Pine exposes ratio accuracy, agreement between projected reversal levels, and D proximity to those levels (56–62, 289–302). Our optional diagnostics only cover strict Bat ratios. | Extend measurements to Gartley, Bat, and Butterfly. Show components and missing values; offer an optional quality sort. A score measures geometry, not probability of profit. |
| High | Separate D contact from D-pivot confirmation | Pine checks a D extremum with three preceding bars and a configurable number of following bars (741–788). Our D deliberately records the first closed-candle zone touch. | Keep the observed touch and add a separate pivot, confirmation time, and state. An alert or simulated entry can use confirmation only once the required candles close. |
| High | Harmonic outcome research | Pine tracks entries, targets, stops, and timeouts. Our existing Research panel evaluates RSI divergences, not harmonic signals. | Compare the current profile with each proposed change using chronological training, validation, and holdout periods, sample counts, costs, and explicit execution assumptions. |
| Medium | Leg-duration and relative-age measurements | Pine checks leg asymmetry and scales incomplete/entry/target windows to pattern duration (51, 57, 60, 184–195, 709–712). We use 60 candles before D and 12 candles outside D after contact. | Show XA/AB/BC durations and elapsed CD age first. Test duration-based expiry and symmetry thresholds as separate research settings. |
| Lower | Additional pivot strengths | Pine tries pivot lengths 3–20 (803–824). Our detector already searches dominant A and X across the history, rather than requiring consecutive small pivots. | Investigate whether pivot strength improves ranking or stability. Do not assume 18 scan passes recover missing large patterns; measure unique coverage, delay, duplicates, and cost. |

Quality calculations can build on [harmonicQuality.ts](../src/lib/harmonicQuality.ts)
and the existing detail view. The current Bat diagnostics are pass/fail ratio
checks, not a score. Any new scoring formula must be explicitly defined: the
Pine file exposes weights of 4/2/3 for ratio/PRZ/D components, but delegates their
normalization and combination to imported code. Its default threshold of 90 is
not validated for our detector.

Before D exists, the D component must remain unavailable. Scores recorded when a
setup first appeared must not acquire later D information retroactively. Keep
the distinction between provisional geometry and geometry measured at a
subsequently confirmed pivot. Confirming a price pivot does not establish that
the entire reversal will succeed.

## Reproduced continuity issue

The existing Gartley fixture in `tests/harmonics.test.ts` has X=100 at candle
index 3, A=200 at 7, B=138.2 at 11, and C=176.3924 at 15. C becomes available at
index 18. Append identical closed candles from index 19 onward with open/close
120, low 118, and high 122.

The D zone is 113.6–129.3. The first contact records D=118, target 1 is 137.352,
and the stop boundary is 100. Every appended candle touches D; none reaches the
target or breaches the stop. No later strict pivots supersede the setup.

| Supplied candles | Actual result |
| ---: | --- |
| 20 | Active, D zone reached |
| 499 | Active, D zone reached |
| 500 | Active, D zone reached |
| 501 | No setup |
| 506 | No setup |

At candle 501, the rolling window drops the first candle. X is still present,
but now lacks the three preceding candles needed to rediscover it as a strict
pivot. The setup disappears with no completion, invalidation, or expiry.

Both [harmonics.ts](../src/lib/harmonics.ts) (`closedSuffix`, `strictPivot`,
`analyzeHarmonics`) and [harmonicScreener.ts](../src/lib/harmonicScreener.ts)
bound and reconstruct history. This is a deterministic synthetic reproduction,
not a measured frequency in market data. The current tests cover bounded
history but do not cover an active harmonic surviving rollover.

A fix should test survival through rollover and eventual target/stop/expiry,
timestamp-stable anchors, retained first contact, and historical corrections.
Simply keeping stale objects in a cache would be insufficient: corrections and
gaps must still invalidate unsupported state, and reloads need a defined recovery
policy. The Fib replay continuity work in this repository is a useful starting
point for that design.

## Preserve the lecture profile

Our [documented harmonic rules](./harmonic-patterns.md) use exact saved template
bands, three pattern families, specific target anchors, and X or D stop
boundaries. Pine's 15% tolerance, Crab/Shark/Cypher support, target defaults,
entry thresholds, and percentage stops describe a different strategy.

The lecture explicitly excludes BC from ordinary identification; Butterfly alone
has optional BC narrowing. Additional XA/BC agreement can be presented as
supplemental geometry with a named research profile. Making it mandatory for all
families would change which lecture setups qualify.

Likewise, a later D pivot should be stored separately from the existing first
contact. Pine can update D, stops, and targets after an entry (469–482). Reusing
that behavior without preserving historical decisions would make research
results hard to interpret. Our first-contact target references have a different,
deliberate meaning.

A small existing presentation mismatch also deserves correction: the detail
view and guide describe C-boundary invalidation without limiting it to the
period before D contact. The engine correctly ignores that boundary after D is
touched; a reversal through C is then allowed. The main harmonic documentation
already explains this correctly.

## Evaluate outcomes independently

The visible Pine results table should not be treated as proof of better signals:

- Timeouts and missed entries are excluded from its success/return table
  (704). Report all outcome categories and the denominator used for each rate.
- The total success rates average per-family percentages (692–694), rather
  than pooling successes and trades. Families with very different sample sizes
  therefore receive equal weight.
- Short returns use `entry / exit - 1` (637–648). A short from 100 to 90 is
  reported as 11.11%, versus 10% under a linear short-return convention.
- Returns are summed, without a defined portfolio allocation or overlap model.
  The visible return formulas do not deduct fees or slippage.
- Exact entry fills, intrabar ordering, ratio tests, and scoring depend on
  `reees/TA/85` and `reees/Obj_XABCD_Harmonic/10`, whose source is absent from the
  attachment.

Our [research infrastructure](./research-evaluation.md) already supplies
chronological partitions and a cost-aware simulator, but its signal generator
currently calls `findRsiDivergenceSetups`. Harmonics need their own chronological
event stream with setup identity and actual availability times. Calling
`analyzeHarmonics` once on thousands of candles would retain only the final 500
and miss earlier signals; selecting only currently active setups would also
exclude prior failures and completions.

First compare fixed forward price outcomes from defined events such as first
observable D contact and later D-pivot confirmation. For trade simulations,
define executable entry timing, stop buffers, gaps, ambiguous same-candle
outcomes, costs, overlapping positions, and time exits. A generic next-bar ATR
benchmark can reuse the existing simulator; harmonic limit entries and
structural stops require their own explicit rules.

Adopt quality filters, alternative expiry, or new pattern families only after
separate comparisons show a useful tradeoff on unseen dates and instruments.
This review establishes useful engineering opportunities, not improved returns.

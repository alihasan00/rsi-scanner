# Harmonic research

Open a symbol's **Harmonics** detail view and expand its historical comparison.
The study is also available when the symbol has no currently active harmonic.
Choose a history size, optional last UTC date, and execution assumptions, then
run the comparison. The selected market controls the data venue: Crypto uses
Binance Spot, TradFi uses Futures. Switching market, symbol, or timeframe resets
the panel and cancels its previous request.

The study compares four fixed candidates using the same lecture ratio bands:

| Candidate | Event |
| --- | --- |
| First D touch · baseline | First observable closed-candle D-zone contact. |
| Ratio fit ≥80 · touch | The same event when B/C ratio fit is at least 80. |
| Confirmed D pivot | The terminal CD extreme inside D becomes a strict 3/3 pivot. |
| Proportional expiry · touch | First observable contact with timing scaled to pattern length. |

The proportional profile expires unfilled setups `max(3, ceil((C−X)/3 × 3.5))`
candles after C. Its post-touch recency allowance is
`max(3, ceil((D−X)/2))` candles outside D, anchored to the first touch.
These are research hypotheses. The live scanner keeps its fixed 60/12 timing,
and no result changes live settings. The contact benchmark primarily tests
pre-touch timing; its independent trade exits do not use post-touch scanner expiry.

## Availability and chronological selection

Replay advances one closed candle at a time. A first-contact event becomes
observable at the later of C confirmation and the touch candle close. A contact
inside C's confirmation window never creates an earlier executable entry.
Candidates already retired when first visible do not create a contact signal.

D-pivot events use the third right-hand candle close, not the earlier pivot
timestamp. A pivot learned on the same candle as lecture-target completion is
retained because the benchmark has its own exits. Pivots learned after a setup
ended, and setups invalidated on the confirmation candle, are excluded.

Events are frozen at availability and remain in exported records when a setup
later completes, fails, expires, or leaves the discovery window. The study does
not sample only surviving active setups or only the last 500 candles.

After 250 warmup candles, the sample is split into 60% training, 20% validation,
and 20% holdout. Every contiguous history segment needs that warmup before C
confirmation. The entire X-to-event pattern must fit within its period; the full
maximum holding and forward-observation horizons must also fit. Formation and
warmup exclusions are reported separately from execution exclusions.

Select the candidate with the greatest training net expectancy among those with
at least ten training trades by default (`--minimum-trades` can change this for
CLI studies). Ties keep preset order. Freeze that selection
before replaying validation and holdout; retain the baseline with an explicit
insufficient-sample notice if none qualify. Later-period comparisons and cost
sensitivity do not reselect the candidate. Repeatedly inspected holdouts become
development data; additional unseen dates and instruments are needed before a
performance conclusion.

## Execution benchmark

The study measures harmonic event timing under a common **next-open ATR
benchmark**. It does not simulate entering at the chart's D extreme, its exact
structural stop, or its lecture take-profit template. That distinction makes
execution assumptions explicit and comparisons repeatable.

The benchmark reuses the [research execution model](./research-evaluation.md):
enter at the next contiguous candle open after the event, freeze ATR(14) from
the event close, and set stop/target distances from the raw entry open. Defaults
are 1.5 ATR stop, 3 ATR target, a 20-candle holding limit, and a 10-candle forward
observation horizon. Each candidate has one position at a time at 1× equity.
Spot trades longs only; Futures permits both directions. Forward observations
include both signal directions and may overlap.

Stops take the worse open on an adverse gap; targets fill at the target without
favorable gap improvement. The open is processed before intrabar extremes, and
the stop wins ambiguous remaining same-candle touches. A holding timeout exits
at the final holding close and is included in trade returns. Missing-data outcome
horizons are excluded. Fees apply on both sides, slippage worsens both fills,
and Futures carry is an assumed daily cost rather than reconstructed funding.

Results report sample counts, net expectancy, compounded return, realized
trade-close drawdown, price excursions, exclusions, and zero/entered/doubled-cost
sensitivity for the frozen candidate. They are evidence under the stated model,
not proof that a geometry score is a success probability.

## Repeatable exports

CSV contains candidate and period summaries. Full JSON includes the exact
closed OHLCV snapshot, execution assumptions, frozen events with availability
times and ratio scores, trade records, and selection. Existing return and cost
fields are fractions, not percent points.

```sh
bun run backtest:harmonics -- --symbol BTCUSDT --timeframe 4h --candles 10000 --end 2026-08-31 --json out/btc-harmonics.json --csv out/btc-harmonics.csv
bun run backtest:harmonics -- --symbol BTCUSDT --timeframe 4h --candles 10000 --input out/btc-harmonics.json
```

Use `--help` for market, date, cost, holding, and output options. Source identity
is checked when replaying an exported report; malformed candles and intervals
are rejected. Partial history and small samples are explicitly reported.

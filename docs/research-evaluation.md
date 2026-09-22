# Chronological strategy research

Open a symbol chart and choose **Research**, then **Run comparison**. The panel loads a closed Binance snapshot for the selected market and timeframe. Crypto uses Spot, TradFi uses Futures; the exchange clock and historical candles use the same venue. Each run has its own market/symbol/timeframe identity. Switching any of those cancels and resets the panel.

The existing **Divergences → Historical replay** study still measures RSI reaching 50. Research adds price outcomes and a separate, explicitly defined execution model. Neither the optimizer nor any experiment changes live settings.

## Fixed candidates and unseen periods

The default grid is Wilder RSI 12, 14 and 16, plus independently defined trend-weighted RSI 14 and adaptive RSI 14 experiments. All use the existing regular-divergence lifecycle, with pivots and confirmation events recalculated for their oscillator. The live baseline is Wilder RSI 14. No LuxAlgo source was copied.

Each contiguous history segment needs 250 warmup bars. After the initial warmup, the requested sample is divided chronologically into 60% training, 20% validation and 20% holdout. Prior closed candles may warm indicators for the following period; later candles cannot influence an earlier period. Replay is bounded to the end of each period. A setup must form and confirm inside its period, and the entire maximum holding and forward-observation horizons must fit before the next period starts. This also excludes a near-boundary setup that happens to exit early, avoiding selection based on its future outcome.

The candidate with the greatest training net expectancy among those with at least ten training trades is frozen before validation or holdout are evaluated. Ties keep the preset grid order. If no candidate qualifies, the baseline remains selected and the report explicitly states insufficient evidence. Validation and holdout results are displayed for every candidate, but they do not change selection. Neighboring Wilder periods are displayed together to expose a fragile isolated result.

These are research comparisons, not a claim that a setting has improved trading performance. Repeated inspection turns a holdout into development data; evaluate new dates and additional symbols/timeframes before adopting a rule. Reports retain separate market identities, and the application does not pool correlated pairs into an inflated sample size.

## Price observations

Forward return starts at the next candle's raw open after confirmation and ends at the configured horizon's last close. Direction-adjusted maximum favorable/adverse excursions (MFE/MAE) use all highs/lows in that horizon. Bullish and bearish observations are retained, including bearish Spot signals, and these observations can overlap. Observation counts are therefore different from independent trade counts. Missing candles anywhere in the required horizon censor the outcome rather than fabricate a fill.

## Execution assumptions

- One position at a time per candidate and period, at 1× starting equity notional. Spot takes longs only; Futures takes longs and shorts. All positions are flat at the period boundaries.
- Enter at the next contiguous bar's open after the confirmation close. Setup discovery and later outcome states cannot move that entry earlier.
- ATR(14) is frozen at the confirmation close. Stop and target are fixed distances from the raw entry open; defaults are 1.5 ATR and 3 ATR. Neither moves afterward.
- Resting exits are checked at the next open before the intrabar range. A gap through a stop fills at that worse open. A favorable gap through a target receives the target price, without improvement. If the remaining intrabar range touches both stop and target, assume the stop occurs first, including on the entry bar.
- If no price exit occurs, the position exits at the close of its final holding bar (default 20 bars). Missing-data horizons are excluded entirely. The simulator does not infer a tradable price from an absent candle.
- Slippage worsens both entry and exit prices. Fees apply to the executed entry and exit notionals. Defaults are 10 bp per side for Spot, 4 bp for Futures, and 2 bp slippage per side. One basis point is 0.01%.
- Futures defaults to a fixed assumed carry of 1 bp/day; Spot defaults to zero. Carry is charged through the exit bar's close because OHLC cannot identify an intrabar execution time. This is a configurable carrying-cost scenario, not historical exchange funding, margin, or liquidation reconstruction.
- No more positions are opened after an account-depleting return. The losing trade itself retains its uncapped modeled loss. Actual margin constraints are not reconstructed.

Expectancy is the arithmetic mean net return per completed trade. Compounded return reinvests remaining equity after each completed trade. Reported drawdown uses realized equity at trade closes; intratrade equity lows can be worse. The cost-sensitivity table reruns the frozen candidate's holdout with zero, entered, and doubled fees/slippage/carry. It never chooses a different candidate.

## Experimental oscillator definitions

Both experiments use only closes available at the current bar and reset after history gaps. They stay between 0 and 100 and are separately labeled in every report.

- **Trend-weighted:** trailing efficiency equals `abs(net close change) / sum(abs(close changes))` over the chosen period. A close change agreeing with the trailing net direction is multiplied by `1 + efficiency` before Wilder smoothing of gains and losses.
- **Adaptive:** ordinary gains and losses use Wilder smoothing with effective length `period × (1.5 − efficiency)`. This length is shorter during efficient directional movement and longer in choppy movement.

They are independently defined hypotheses, not replicas or claimed substitutes for LuxAlgo's Ultimate RSI or Inertial RSI. Their pivot and lifecycle outcomes are recalculated, and live RSI remains unchanged.

## Export and repeatability

CSV contains each candidate/partition's market, dates, sample sizes, price observations, costs and performance summaries. JSON also includes the exact closed OHLCV snapshot, candidate definitions, frozen selection, execution settings, exclusions and trade records. Trade returns and cost fields are fractions, not percent points or currency amounts. Sum-of-cost fields add per-trade fractions; they are not portfolio-currency charges.

```sh
bun run backtest:research -- --symbol BTCUSDT --timeframe 4h --candles 10000 --end 2026-08-31 --json /tmp/btc-research.json --csv /tmp/btc-research.csv
bun run backtest:research -- --symbol XAUUSDT --market tradfi --timeframe 1h --carry-bps 1 --json /tmp/gold-research.json
bun run backtest:research -- --symbol BTCUSDT --timeframe 4h --candles 10000 --input /tmp/btc-research.json
```

Use `--help` for explicit fees, slippage, holding limits and other parameters. Reports with partial history or too few trades retain their values and warnings; no result is fabricated for empty samples.

The conceptual starting points were the out-of-sample workflow, signal combination and volatility-based measurement discussed in [the LuxAlgo review](./luxalgo-review.md). Tests independently verify chronological isolation, oscillator causality, next-bar execution, overlapping-position control, same-bar/gap assumptions, costs and Futures routing.

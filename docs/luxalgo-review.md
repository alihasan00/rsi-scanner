**LuxAlgo review and scanner improvement recommendations — 22 September 2026**

Implementation follow-up: these recommendations were subsequently added after user approval. The original findings and baseline measurements remain here as the review record. See the [current guide](../README.md#combined-context-and-research), [Fib continuity](fibonacci-system.md), [structure rules](market-structure.md), and [research methodology](research-evaluation.md) for the implemented behavior and limits.

The strongest opportunities are to preserve active setups reliably, evaluate new rules on unseen data, and combine the scanner's existing evidence in one view. LuxAlgo provides useful ideas for these changes. This review does not establish that their signals outperform this scanner.

The review covered the 24 recent publications on the first catalog page, a focused search of their RSI publications, and relevant educational posts. Public Pine calculation and execution sections were inspected for **RSI Divergence: Out-of-Sample Optimizer**, **Signal Forge**, and **Ultimate RSI**. Other script observations below come from published descriptions. The profile listed 409 scripts; this was a targeted comparison, not an audit of all 409 or of the invite-only products.

The local baseline was commit `9b69a8c`. No strategy or application code was changed during the initial review. Validation: **867 tests passed**, lint passed, and production build passed. The build emitted its existing warning about a roughly 600 kB minified shared chunk. These checks establish software behavior, not trading profitability.

**What is already working well**

The active application already has Wilder RSI(14), regular and optional hidden divergence, explicit formation/confirmation/invalidation/expiry, mature RSI trendline anchors, Fibonacci structure breaks and SMA200 alignment, harmonic D zones, and calendar-level sweep/reclaim detection. Live candles remain provisional. Tests cover causal replay, confirmation delays, gaps, corrected history, and ambiguous OHLC outcomes.

These behaviors are worth preserving. The older swing-based support/resistance engine remains in the repository but is not the active Support & Resistance view. Recommendations below refer to the mounted calendar-liquidity view.

**Best ideas to adapt**

| Priority | LuxAlgo reference | Application to this scanner | Validation required |
| --- | --- | --- | --- |
| High | [RSI Divergence: Out-of-Sample Optimizer](https://www.tradingview.com/script/O3syNlIv-RSI-Divergence-Out-of-Sample-Optimizer-LuxAlgo/) and [Universal Signal Backtester](https://www.tradingview.com/script/Y5CIZ9CB-Universal-Signal-Backtester-LuxAlgo/) | Add chronological training/validation/holdout comparisons, parameter sensitivity, price outcomes, and a separately defined cost-aware trade simulation. | Freeze candidate rules before holdout evaluation; report sample size, drawdown, expectancy, and results by market/timeframe. |
| High | [Signal Forge](https://www.tradingview.com/script/HtOSLjaj-Signal-Forge-LuxAlgo/) and [Bat Harmonic Pattern — Advanced Analysis](https://www.tradingview.com/chart/BTCUSD/HmKK8nvf-Bat-Harmonic-Pattern-Advanced-Analysis/) | Show existing divergence, trendline, harmonic/Fib location, and calendar-level reactions together with their direction and age. | Join only evidence available at the displayed signal time; handle conflicts and stale/missing data explicitly. |
| High | [ATR Exceedance Probability Model](https://www.tradingview.com/script/YIL56q9W-ATR-Exceedance-Probability-Model-LuxAlgo/) and [Structural Leg Profiler](https://www.tradingview.com/script/tYFQSk49-Structural-Leg-Profiler-LuxAlgo/) | Add closed-bar ATR and distance/rejection measurements in volatility units. These can make proximity comparable across instruments and intervals. | Hand-calculated ATR fixtures, live-bar isolation, gap handling, zero-range behavior, and price-scaling invariance; performance testing for any new threshold. |
| Medium | [EQH/EQL Liquidity Zones](https://www.tradingview.com/script/29faH0pr-EQH-EQL-Liquidity-Zones-LuxAlgo/) and [Historical Liquidity Proximity Heatmap](https://www.tradingview.com/script/G6x1m9GX-Historical-Liquidity-Proximity-Heatmap-LuxAlgo/) | Extend calendar levels with confirmed swing highs/lows and equal-high/equal-low clusters; show nearest relevant levels and their history. | Explicit pivot availability, cluster tolerance, swept/expired states, duplicate suppression, and rolling-history tests. |
| Medium | [Retest & Break Setup](https://www.tradingview.com/script/E4w7VtBS-Retest-Break-Setup-LuxAlgo/) and [Market Structure & Scatter Dashboard](https://www.tradingview.com/script/17J0iPWK-Market-Structure-Scatter-Dashboard-LuxAlgo/) | Expose price structure breaks as reusable events, then optionally track break → retest → continuation. Fib already contains some structure-break logic. | Separate continuation from reversal; define retest tolerance, timeout, invalidation, and the first observable confirmation time. |
| Medium | [HTF Reversal Divergences](https://www.tradingview.com/script/ZF0M3jqb-HTF-Reversal-Divergences-LuxAlgo/) | Add a compact completed higher-timeframe context, such as 4h direction beside a 15m setup, with live HTF previews visibly separate. | Use actual higher-timeframe candles and their closure timestamps; preserve market identity and bounded feed concurrency. |
| Experimental | [Ultimate RSI](https://www.tradingview.com/script/17Jj7Vcg-Ultimate-RSI-LuxAlgo/) and [Inertial RSI](https://www.tradingview.com/script/eg4t9sX8-Inertial-RSI-LuxAlgo/) | Offer separate research variants only if comparisons show a benefit. | Recalculate pivots and lifecycle outcomes for each oscillator; test robust parameter neighborhoods and unseen dates. |

**Two local reliability improvements**

1. **Keep active Fib plans when their origins leave the detection window.** The current engine replays a maximum of 500 candles and starts all setup state from scratch. A managing plan can therefore disappear without a target, stop, or invalidation. This is a documented history-window limitation, now reproduced concretely.

   The existing bullish test fixture was extended with a first-entry candle (low 145, high 160), then repeated closed candles with open/close 165, low 160, high 170. The resulting states were:

   | Available candles | Status | Position remaining | Stop | Resolution |
   | ---: | --- | ---: | ---: | --- |
   | 22 | entered | 100% | 125.60 | none |
   | 23 | managing | 80% | 146.74 | none |
   | 500 | managing | 80% | 146.74 | none |
   | 504 | managing | 80% | 146.74 | none |
   | 505 | no setup | — | — | no explicit resolution |

   None of the repeated bars hits the 146.74 stop or the 173.48 second target. The origin falls out of the replay window. Preserve active-plan state and consumed origins independently of the bounded discovery window, or surface an explicit history-truncation state. A durable solution must cover reloads/reconnects as well as incremental updates, and define how historical corrections invalidate checkpoints.

   Relevant code: [history truncation](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/fibonacci.ts:174), [replay initialization](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/fibonacci.ts:368), [cache window](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/fibScreener.ts:15), and [documented limitation](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/docs/fibonacci-system.md:145). Add a regression extending the existing bullish fixture beyond 505 candles, through eventual exit, with rolling-window and reconnect comparisons.

2. **Make divergence cache identity match replay semantics.** The cache removes every unclosed bar from its comparison key, but replay treats an interior unclosed bar as an interruption. Inserting an interior unclosed marker while preserving all closed objects leaves the cached result `forming`, while fresh replay returns no live setups.

   This is a defensive consistency issue: the normal production history builder appends at most one preview at the tail, so no current production trigger was demonstrated. Replacing a closed bar would correctly invalidate the cache. Trim trailing previews only, matching the trendline cache, and add a focused regression.

   Relevant code: [divergence cache](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/screener.ts:25), [existing trendline approach](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/rsiTrendlineAnalysis.ts:35), and [normal snapshot construction](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/rsiHistory.ts:113).

**Make confluence concrete and explainable**

A useful first version would show a small evidence panel in the detail view, for example: “Bullish divergence confirmed · weekly-low reclaim 1 candle ago · inside bullish Bat D zone.” Show negative or missing evidence too. This would connect calculations that users currently inspect separately.

The current daily context feed runs only on the Support & Resistance tab ([App.tsx](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/App.tsx:20)). Confluence needs context availability independent of that tab, initially fetched for the selected symbol or a bounded shortlist. Shared records should retain market, symbol, timeframe, direction, observed time, confirmation time, status, source identity, and freshness. In historical evaluation, a pivot's earlier chart location must not become its earlier signal time.

Ranking currently uses simple setup-state scores ([screener.ts](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/screener.ts:96)); Fib alignment is SMA200 only ([fibonacci.ts](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/fibonacci.ts:467)). An evidence count could support sorting, but correlated RSI observations must not be presented as independent confirmation or converted into an unvalidated “80% confidence.” Coincident week/month levels should retain provenance without being counted as independent votes.

The fixed liquidity proximity threshold is 0.5% ([liquidityScreener.ts](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/liquidityScreener.ts:8)). Add `distance / ATR` alongside the current percent. For sweep descriptions, consider penetration depth, close-back distance, wick/body proportions, and relative volume. High volume and low-volume exhaustion are different hypotheses; neither should be made universally mandatory without testing. Preserve the existing exact sweep/reclaim definition and harmonic ratios while adding these measurements.

**Preserve the meaning of each strategy**

Signal Forge's public source uses RSI above 50 as bullish trend evidence and below 50 as bearish evidence. Our bullish divergences form below 50 and complete when they reach 50; bearish setups are symmetric. Requiring those same-timeframe trend conditions would conflict with our active divergence lifecycle ([formation rule](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/divergenceLifecycle.ts:168), [target rule](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/divergenceLifecycle.ts:139)). Define trend context and reversal triggers as separate concepts. A higher-timeframe trend filter is a distinct experiment.

Ultimate RSI also changes the underlying math: its source replaces ordinary close changes with the signed rolling range when a new rolling source extreme occurs, then normalizes smoothed changes. Its default extreme levels are 80/20. It is not a smoother drop-in replacement for our Wilder RSI, and existing divergence/trendline thresholds would require fresh evaluation.

The Bat article describes AB/XA of 0.382–0.500, BC/AB of 0.382–0.886, CD/BC of 1.618–2.618, and AD/XA near 0.886. Our [harmonic templates](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/harmonics.ts:55) intentionally use wider ranges recovered from the user's lectures. The article supports adding divergence evidence inside D and potentially an optional stricter geometry profile. It does not demonstrate that the current lecture implementation is wrong. Additional BC/CD measurements should be labeled separately before considering a stricter detector.

**Evaluate results with explicit execution assumptions**

The current backtest correctly measures whether RSI reaches 50, and explicitly excludes trade P&L, fees, fills, slippage, sizing, and price returns ([methodology](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/divergenceBacktest.ts:104)). Retain that study and add a separate evaluation layer:

- Freeze a baseline, then compare one candidate filter at a time on chronological holdouts and additional symbols. Keep outcomes that cross selection boundaries from leaking into model selection.
- Report forward price returns and maximum favorable/adverse excursion, followed by a clearly specified trade simulation where needed. A practical baseline assumes entry at the next tradable bar after confirmation, with fees/slippage and conservative gap/stop/target handling.
- Report sample size, expectancy, drawdown, and cost sensitivity. Control overlapping signals and avoid treating many correlated pairs as independent evidence.
- Choose robust neighborhoods of settings, rather than the single best historical number. Publish poor results and insufficient-sample cases too.
- Preserve market identity: the historical fetcher is currently Spot-specific ([binanceHistory.ts](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/lib/binanceHistory.ts:4)); a TradFi evaluation needs Futures routing and, for P&L, appropriate funding/cost assumptions.

Source inspection reinforces the need to verify execution: the RSI optimizer's description says entry is on the following bar, but the inspected Pine code calls pivot detection and trade updates on the current bar and assigns that bar's close as the entry. Its inspected trade-return calculations do not subtract commission or slippage. The out-of-sample workflow is useful inspiration; the displayed performance should not be imported as evidence for our strategy.

**Ideas to defer**

The three-dimensional volume/momentum surfaces are mainly presentation choices and add complexity to a multi-symbol scanner. A compact table of state, distance, and evidence has a clearer initial use here.

[Order Flow VWAP Deviation](https://www.tradingview.com/script/bOdqA7m9-Order-Flow-VWAP-Deviation-LuxAlgo/) explicitly describes delta as a candle-based proxy. Our normalized [candle data](/Users/alihasam/workspace/github.com/alihasan00/rsi-scanner/src/types.ts:45) contains total volume but no trade-side or volume-at-price records. Candle color or close position cannot establish actual aggressive buying, resting stops, absorption, or order-book liquidity. A true order-flow feature would need an appropriate feed; an OHLCV estimate must be labeled as such.

The inspected Pine sources carry **CC BY-NC-SA 4.0** headers. No source code was copied into the application. Any future direct port must respect its particular license; generic concepts can be developed independently with source attribution where appropriate.

LuxAlgo's educational articles on [repainting](https://www.tradingview.com/chart/BTCUSD/RSSM3EkN-Let-s-Talk-About-Repainting/), [indicator settings and timeframes](https://www.tradingview.com/chart/AMD/LyAeDhTT-What-Are-The-Best-Indicator-Settings-Timeframes/), and [useful versus redundant information](https://www.tradingview.com/chart/SQ/cHvljLV8-Technical-Indicators-What-s-Useful-What-Isn-t/) support the same practical priorities: retain observable timing, test sensitivity, and add information with a distinct purpose. Their historical pattern percentages and cited studies were not independently reproduced in this review.

**Recommended delivery order:** address active Fib continuity and the small cache inconsistency; build the evaluation comparison; add the selected-symbol evidence panel and ATR measurements; then evaluate swing-liquidity/retest events and completed higher-timeframe context. Keep oscillator replacements and stricter harmonic profiles as separately tested options.

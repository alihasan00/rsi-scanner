# Live setup watchlist

The Watchlist adapts the crypto project's automatic shortlist and evidence
presentation to this frontend's existing Binance feeds. Favorites remain a
personal filter; starring a pair does not make it analytically eligible.

## What transfers

| Crypto project concept | Live scanner implementation |
| --- | --- |
| Separate shortlist from raw indicator inventory | Watchlist view alongside the existing indicator views |
| Explain reason, next condition and caution | Why / Next, expandable review notes, and evidence with timestamps |
| Location before indicator agreement | Fib pocket, harmonic D zone or structure retest band |
| Causal confirmation after the setup | Completed location test, then a later relevant completed trigger |
| Current quote can block a historical thesis | Live proximity and boundary checks without mutating closed-candle detectors |
| Check provider freshness and candle completeness | Receipt age and last completed candle checked independently |
| Preserve risk references rather than improve them retrospectively | Existing first targets; structure target reconstructed at the break |

The database, ledger, paper/real trading, AI workers and fixed multi-timeframe
universe scan are not transferred. This is a deterministic view over data
already available to the app. It is not a copy of every crypto selection rule.

## Selection

- **Fib:** include the latest `watching` or `entered` plan; exclude plans already
  managing targets, runners and terminal states. Use its golden pocket, current
  stop and first target. Modeled entry touches are observations, not positions.
- **Harmonics:** include active Gartley, Bat and Butterfly D zones. Use the
  detector's invalidation and first template target. Before D contact the target
  is projected from the midpoint and is labeled accordingly. Contact or a
  confirmed D pivot alone does not count as an entry trigger.
- **Structure:** include awaiting-retest, retested and recently confirmed
  break/retest sequences. Preserve the detector's 12-bar retest and 8-bar
  continuation timeouts. Reconstruct the nearest opposing target level from
  the history observable at the break; no known target means no R/R. Later
  equal-level changes cannot replace it with a more attractive target.

A **Trigger confirmed** row requires all of the following:

1. Fresh, valid quote and completed candles; matching detector timestamps.
2. A completed location test and a strictly later aligned trigger. A retest
   requires its own continuation event. Fib and harmonic locations may use
   RSI divergence/trendline confirmation, an appropriately sided price break
   or retest, or a swing sweep whose level belongs inside the location.
   Calendar sweeps remain supporting evidence, because their current evidence
   contract does not expose a direct level-to-setup link.
3. Trigger age 0–3 completed candles, also expiring after four timeframe
   durations by the wall clock. Live candles never create confirmation.
4. Price inside or within one completed-candle ATR of the location on its
   favorable side; use 0.5% only when ATR is unavailable.
5. Correctly ordered positive stop and first target, with price between them.
   Subsequent observed stop/target crossings prevent a recovered quote from
   reviving the same first-target opportunity. A completed boundary crossing
   takes priority over trigger evidence. Live-wick crossings temporarily block
   the row pending the candle close; they do not mutate detector lifecycle.
6. No recent opposing trigger or nearby opposing location. Distant opposing
   locations are cautions. A Fib against its SMA200 context is a conflict.

These are screening conventions, not a validated entry strategy. A trigger
confirmation does not establish profitability, executable liquidity or HTF
agreement. Bearish Spot observations do not imply the instrument can be shorted.

## Risk references and ranking

Gross R/R is `(target − quote) / (quote − stop)` for bullish rows, with signs
reversed for bearish rows. Unavailable, nonfinite or incorrectly ordered
references show no ratio. The ratio concerns the first target alone; it omits
fees, spread, slippage, funding, staged entries, partial exits and later targets.
Less than 1R gets a caution, not a false claim about the full strategy's payoff.
Targets are never selected farther away just to pass an R/R cutoff.

Sort by status (confirmed, testing, approaching, waiting, conflicting, extended,
blocked, delayed), then trigger recency, distinct supporting evidence families,
distance and stable symbol/source/ID tie-breakers. Evidence families group
correlated observations and are not independent votes or win probabilities.

## Live-data architecture

`useRsiFeed` owns the selected market and timeframe. The watchlist does not open
a second price feed. `useSrContextFeed` extends its existing bounded daily-feed
scope to this view, with cancellation when the market or view changes. Selected
higher-timeframe detail requests are not included in shortlist ranking, so an
opened pair gets no advantage from extra data unavailable to other rows.

Price receipt must be at most 60 seconds old, and the last completed candle must
be within one timeframe plus a five-second rollover grace. A five-second timer
updates freshness without depending on incoming ticks. Data/timeframe/market
changes are guarded so old data cannot be relabeled as new data. Coverage
counts refer to the price feed; missing daily/HTF evidence is disclosed in each
row's review notes.

`watchlistAnalysis.ts` caches discovery and target reconstruction by instrument,
market, timeframe, exact closed OHLCV/RSI values, settings and calendar-map
identity. Trailing live previews reuse discovery. Corrections and interior
unfinished candles invalidate it; gaps remain visible to the detectors.
Quotes and suitability are recomputed in batched updates, at most twice per
second. The cache is bounded to the current universe and disappears on unmount.

Stars and view preferences use existing browser storage. Existing Fib and
harmonic lifecycle caches continue to validate their own checkpoints. The
watchlist adds no candle database or durable event history and cannot monitor
the market while the app is closed. Reloads and gaps rebuild from the available
contiguous history; they do not prove that every intervening setup was observed.

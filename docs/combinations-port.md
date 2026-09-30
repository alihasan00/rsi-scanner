# Five combination strategies in the React Watchlist

Ported 30 September 2026. Local engine release:
`0.13.1-26e07587190d+ichimoku.3.watchlist.3`.

The five ranked combinations join the React app's twelve existing paper
research profiles: **17 profiles: 14 daily, two four-hour, one fifteen-minute**.
Timeframe buttons show the number of enabled strategies and matching assets,
even when no signal currently qualifies. Filters apply before asset grouping,
so cards and saved reviews contain only the chosen source timeframe.

| Added profile | Source | Entry | Original exit policy shown in the app |
|---|---|---|---|
| `combo_trendlines_adx_daily` | 1d | Trendlines breakout; defined Signal Forge ADX14 ≤20 | Initial 2× Wilder ATR14 stop; never-widening 3.5× ATR trail; ungated opposite raw Trendlines event; 96 bars |
| `combo_trendlines_cluster_daily` | 1d | Breakout; latest clustered-Supertrend event bullish, age 0–2 | Same Trendlines exit |
| `combo_trendlines_sfp_daily` | 1d | Breakout; latest SFP event bullish, age 0–2 | Same Trendlines exit |
| `combo_range_weekly_4h` | 4h | Weekly event at first raw range eligibility or preceding two source bars | Original frozen band, stop and target; 24 bars; no added weekly 3% opening-width guard |
| `combo_nwe_rsi_ultimate_15m` | 15m | Causal endpoint lower-band fade; Signal Forge RSI14 >50; persistent bullish Ultimate RSI event | Fixed 2× Wilder ATR14 stop; target = actual raw opening + 2 × (raw opening − stop); 24 bars; no trail or opposite-event exit |

Most recent helper events win, a newer opposite cancels, simultaneous opposites
neutralize, and direction-only events count. No later helper agreement revives
an earlier rejected primary. New daily/envelope entries require an event on
the latest completed candle. Partial candles never enter these calculations.
The browser rejects gaps rather than carrying state across them.

The original Signal Forge precise-sum seeds and the separate LuxAlgo ordered-sum
Wilder seeds are retained. Explicit `float64` product conversions prevent
native fused multiply-add from changing clustered performance ties relative
to Rust and WebAssembly. This detail was caught by the source comparisons.

## History and execution limits

The envelope needs **999 completed 15m bars** to compare two fully formed
bands. Mixed 15m requests 1000 Binance rows and preserves the last row as a
preview. No extra pagination or synthetic history is used. Daily/4h retain
500 completed bars. The separate Ichimoku scope retains 500 bars on every
selected timeframe; it does not inherit the combination roster.

The browser's bounded history can differ from the crypto app's full stored
contiguous history, especially for recursive indicators and persistent helper
state. The fixtures establish parity on identical input windows, not parity
with all full-history live signals. Short listings remain insufficient for
NWE rather than receiving a shorter formula.

The React app presents signals and reference plans. It has no paper account,
minute execution path, position ledger or background trading while closed.
It does not assume a fill, fabricate a pre-entry NWE target, or apply a trailing
stop to a position. The crypto app remains responsible for paper execution.
Research findings do not establish trading profitability; TradFi perpetuals
have not been separately validated by the crypto research.

This port includes the five requested combinations. It does not also import
the sibling app's separate hourly-confirmed weekly variant or four standalone
LuxAlgo controls; hence its 17-profile count differs from that app's 22.

## Verification and review

- All **1,284 frontend tests** pass, including new profile IDs, timeframe
  filtering, 999-bar feed retention, dedicated 500-bar requests and portable
  review target semantics. Lint, TypeScript and the production build pass.
- The complete Go test suite passes, including local mock-server tests.
- **79 Rust/native-Go/WebAssembly comparisons** pass: eight accepted and eight
  rejected cases per combination, except the range/weekly combination with
  seven accepted and eight rejected available reference cases. Each accepted
  case also passes browser plan admission with matching identity and target.
- Go additionally compares every helper event and stop in those windows, and
  checks helper cancellation, age limits, simultaneous opposites, gaps, NWE
  warmup and prefix causality.
- The existing native/browser parity cases still pass for all twelve dedicated
  Ichimoku timeframes, source failures, provisional candles and invalid input.
- Live local preview verified all three timeframe buttons, daily cards,
  empty intraday views and the 360-feed denominator (120 symbols × 3 frames).

The committed artifact is `public/watchlist-engine.wasm`. Its build hashes are
in `engine/build-manifest.json`; `engine/provenance.json` retains the original
archive hashes and separately records the Rust source hashes and local ports.
LuxAlgo attribution and CC BY-NC-SA 4.0 notices are preserved.

Useful review files:

- `engine/internal/strategies/paper_luxalgo.go`: causal indicators and entry gates.
- `engine/internal/strategies/paper_range_combo.go`: first-eligibility reconstruction.
- `engine/internal/selection/paper_watchlist.go`: per-frame readiness and plan policy.
- `engine/internal/strategies/testdata/combinations_rust.json`: candles, expected
  signals, frozen plans, helper events and original research offsets.
- `engine/scripts/combinations-oracle.rs`: Rust fixture-generation source; run
  as a temporary binary in the sibling crypto server from the crypto project
  root. It reads the existing activation cases and candles and writes only
  `/private/tmp/rsi-combo-fixtures.json`; it does not modify research reports.

Reproduce normal checks from this repository:

```sh
bun test
bun run lint
bun run build
cd engine && go test ./...
```

Use Go 1.26.8 for the engine. From the repository root:

```sh
WATCHLIST_GO=/path/to/go1.26.8 node engine/scripts/build.mjs
WATCHLIST_GO=/path/to/go1.26.8 node engine/scripts/parity.mjs
```

No deployment or external-agent review is claimed by these checks.

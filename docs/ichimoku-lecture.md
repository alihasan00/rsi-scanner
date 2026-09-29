# Ichimoku lecture coverage

The watchlist includes a local extension of the imported Go engine, version
`0.13.1-26e07587190d+ichimoku.3`. It implements the lecture's measurable signals
and exposes its qualitative guidance as inspectable context. It does not treat
the lecturer's example profits, “magnet” descriptions or target precision as
verified trading performance.

## Source verification

Reviewed on 28 September 2026:

- Complete `103-ichimoku-cloud.txt` transcript, physical lines 1–113, from the
  sibling `crypto-scanner/Transcripts` collection.
- `103-ichimoku-cloud.mp4`, duration 63:57.520, from the supplied Monty videos.
  A visual survey sampled the recording every two minutes; detailed stills
  were checked at 03:15, 29:00, 34:00, 47:00, 58:00 and 62:00. This is a full
  transcript review with selected video cross-checks, not an independent
  transcription of every spoken word.
- The 03:15 settings dialog shows 20 / 60 / 120 / 30. The 47:00 diagram confirms
  the valid/invalid TK geometry, including the mildly bullish exception where
  rising Tenkan crosses falling Kijun. The cloud examples corroborate the flat
  opposite-edge concept and the separate cloud/line roles.

Source SHA256 values:

```text
transcript 78ec5cf69a77ed79eb718b22aa06b022731817487ba78af36feec517173a0bb7
video      c6d6ea6f8aca29d0562d820e3fd089e43e1444786cd4add5f70ae6e049871a1f
```

## Coverage

| Source | Taught behavior | Watchlist implementation |
| --- | --- | --- |
| 19–33 | Custom lengths; Tenkan, Kijun, Senkou A/B and shaded cloud | 20-bar Tenkan, 60-bar Kijun, 120-bar Span B; orange Tenkan, red Kijun and green/red cloud overlays. |
| 19–21, 29, 45 | Chikou/lagging line explicitly unused | Omitted intentionally. Tenkan is not promoted to the Kijun support/resistance role. |
| 43–49, 65 | Entire cloud and both boundaries can support/resist; cloud can be a target reference | Current boundaries, price position and support/resistance role are visible; cloud reclaim and edge-to-edge use these references. |
| 51–57 | Kumo twist; possible direction change; frequent flips suggest indecision | Current displayed and forward plotted twists have separate calculation/display timestamps; observed alternation is disclosed as context. A twist does not require a simultaneous breakout or independently confirm entry. |
| 63–65 | Cloud breakout/breakdown followed by a held retest | Cloud reclaim requires a completed break and a later held cloud retest. Candle size is not a mandatory condition. |
| 73, 77–83 | Enter cloud on a close, anticipate entry-edge retest, target opposite edge; prefer width and flat far edge | `cloud_edge_to_edge` exposes entry potential and freezes the opposite-edge plan when confirmed. Either cloud color is allowed. A nonflat far edge can become flat by a later held retest. |
| 81–83 | Significant width and flat opposite edge | Exact flat duration and raw/ATR width are shown. A zero-width cloud cannot supply an edge-to-edge plan; the shared cost/RR checks decide whether a reference is economically usable. No numerical “significant width” is attributed to the lecture. |
| 83 | Below red, thickening cloud suggests stronger bearish context | Price/color/thickness agreement is described; bullish symmetry is an implementation interpretation. Thickness is not volume or a calibrated trend probability. |
| 85, 89, 95 | Fibonacci and other indicators provide confluence | Cloud Fib intermediate references, Kijun/cloud prices, existing independent Fibonacci/structure setups and the captured candles can be compared. They are not counted as independent confidence votes. |
| 89 | Kijun support/resistance, regain/loss and held retest, entry and nearby stop ideas | Kijun reclaim and PK/TK pullbacks use Kijun references with stops beyond the retest/level. Distance, slope and flat duration remain visible. |
| 91–95 | TK geometry; reject KT-driven crosses; mild bullish exception | `tk_cross` follows moving Tenkan; flat-Tenkan/Kijun-driven changes are excluded. Rising Tenkan crossing falling Kijun is labeled mild. Equality plateaus do not create repeated crosses. |
| 95 | Ignore in-cloud crosses; stronger bullish above green / bearish below red | Cross position and cloud color are checked and disclosed. Outside-cloud crosses without the favorable color/location stack retain weaker-confluence labeling. |
| 97 | Price/Kijun (PK) crosses trade like TK | `pk_cross` uses completed closing price crossing Kijun and a later Kijun retest; it shares the location and lifecycle safeguards. |
| 95 | Fib from green cloud's flat low to flat high | The two flat cloud edges anchor intermediate 0.236/0.382/0.5/0.618/0.786 levels. These common ratios are a disclosed implementation choice; the lecture demonstrates 0.236 and 0.5 but supplies no complete ratio template. |
| 103 | Thinning cloud together with widening Tenkan/Kijun separation suggests retracement/extension | Combined warning plus both underlying measurements; neither condition alone activates it. This is a warning, not an automatic reversal trade or an RSI-style threshold. |

## Calculation and lifecycle conventions

The lecture expressly skips the formulas. The engine uses the conventional
midpoint of the highest high and lowest low over the entire stated window.
Span A averages Tenkan and Kijun; Span B is the 120-bar midpoint.

The existing engine's displacement is **30 actual completed bars**. At index
`i`, the displayed cloud comes from calculations at `i - 30`; calculations at
`i` can be drawn at `i + 30` as a known projection. It needs 150 completed
contiguous candles for a current cloud. The video confirms input 30 but does
not establish the platform's offset-versus-offset-minus-one convention. Exact
TradingView pixel parity is not claimed. New strategies and overlays use the
same engine convention throughout.

Closed prices on a cloud boundary are inside for context. Crosses require a
change of side after a previously established nonzero side; a touch and return
is not a fresh crossover. Flatness means exactly unchanged adjacent seeded
values, with duration measured in completed transitions. Cross location is a
completed-candle interpretation, not an inferred intrabar path. Changes caused
by an old extreme leaving a window are possible and do not prove new pressure.

Cloud thinning, thickening and widening line separation compare adjacent
completed observations. The source gives no ATR threshold for “thin,” “thick,”
Kijun extension, or significant width, and no numeric whipsaw window. These
remain measurements and qualified context. No probability or Ichimoku score
is manufactured from correlated signals.

The dedicated **Crypto → Ichimoku Cloud** tab detects trade methods only on
the selected toolbar timeframe: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 1d, 3d
or 1w. It loads only that source history and applies the setup algorithm’s
trigger, invalidation and expiry rules to the same completed candles. Another
timeframe’s history or direction does not gate this tab. Its detail chart and
exported context preserve the selected frame’s captured evidence.

The lecture prescribes no particular timeframe. The dedicated setup algorithms
use these product conventions where the lecture is qualitative: at most 24 bars
to observe a retest, a 0.1 ATR protective stop buffer, 0.25 ATR entry bounds,
four-bar confirmation expiry and structural target history where the lecture
does not supply a target. Edge-to-edge uses its actual opposite cloud edge.
These are product choices, not quotations from the lecture. Stops and targets
are frozen at the trigger, with later consumed references and ambiguous
stop/target candles handled conservatively. The separate mixed **Watchlist**
now selects the crypto project's paper research profiles; its rules are in
[the Watchlist guide](watchlist.md).

The shared fees, slippage, net reward/risk and data freshness checks still
apply. The dedicated tab checks subsequent stop/target history on its selected
source. Qualitative signal readings cannot bypass these rules. Orders,
borrowing, leverage and real fills are outside this app.

## Saved evidence and verification

The Go engine publishes the readings and chart paths from the same validated
completed input used to select the setup. The browser does not recalculate a
second Ichimoku engine. Selected assets receive chart paths; other assets retain
compact readings. Exact provider receipt, final close and evaluation identity
must match before attaching these to a saved chart. Preview prices cannot enter
the calculations; forward display timestamps do not claim future observations.

The setup chart, detail readings, copied review and saved HTML preserve the
captured evaluation. New bars do not move an already saved setup's references.
Tests cover source-specific crosses, cloud/edge rules, causality, malformed
history, null/zero ATR, mirrored directions, reference consumption, frozen
publication ownership, browser transport and native/WebAssembly parity.

The upstream archive identity remains recorded in `engine/provenance.json`.
Local amendments and source hashes identify the extension; the built browser
artifact must be regenerated and pass `engine/scripts/verify.mjs` after changes.

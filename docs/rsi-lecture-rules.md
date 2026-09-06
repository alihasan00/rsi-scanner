# RSI divergence lecture: rule interpretation

**Verification status: Gemini transcript cross-checked against subtitles and chat; not independently audio-verified.** The user-supplied Roman Urdu/English transcript substantially agrees with the intelligible subtitle passages and makes several garbled passages clearer. It is usable for the corroborated rules below. This is a comparison of two transcriptions, not a certification of every spoken word; neither the audio nor the displayed chart has been independently checked.

Sources:

- [Automatic subtitles](<../GMT20260212-161136_Recording.cc (1).vtt>). All timestamps below refer to this file.
- [Supporting chat](<../GMT20260212-161136_RecordingnewChat (1).txt>). Chat timestamps appear approximately 13–14 minutes ahead of the subtitles, with response delays. Do not assume an exact offset. Chat corroborates the questions about RSI 50 and 14 candles; it is not independent verification of the answers.
- User-supplied Gemini transcript (pasted into the review session; not stored in the repository). Untimed Roman Urdu/English text, cross-checked on 2026-09-06. Line numbers in the comparison table refer to that pasted text.

The subtitles contain substantial transcription errors. “High confidence” below means the intended rule is clear across the Gemini transcript and intelligible, repeated subtitle passages. It does not establish the strategy's effectiveness or independently verify the audio/visual example.

## Transcript comparison

| Subtitle time | Gemini lines | Finding |
| --- | --- | --- |
| 01:45–02:22 | 17–22 | Agreement: look for a bearish reversal in a rising trend and a bullish reversal in a falling trend. A universal trend definition and its application to hidden patterns are not specified. |
| 08:44–09:26 | 61–63 | Agreement: compare price and RSI at the same two candle timestamps. |
| 09:31–10:53; 20:21–20:31 | 65–71; 121 | Agreement: wick and body relationships must both support the divergence. The later example corrects an initial “higher high” utterance to “higher low”; use the repeated, consistent definitions rather than that isolated phrase. |
| 12:26–14:12; 37:37–38:30 | 79–87; 203–205 | Agreement: an intervening RSI 50 touch separates cycles; only the interval between selected swings matters. Gemini adds “not even near 50” and an overbought/oversold reference, but no numeric margin or 30/70 threshold is established. |
| 15:10–15:35 | 93–97 | Agreement: all four regular/hidden definitions match the detector. |
| 20:52–22:11; 39:54–40:04 | 125–129; 211 | Agreement: ordinary confirmation is a green bullish or red bearish closing candle. Gemini clearly identifies the bullish engulfing example's reference as the previous body's open, consistent with the captions' “body…open” and “last body” fragments. Subsequent reference selection still relies on the chart. |
| 24:01–24:29; 25:03–26:12; 35:03–35:10 | 135–145; 189–191 | Agreement: another unfavorable candle can leave a setup alive; matching RSI/price structure invalidates it. Gemini's “this RSI line,” “last low,” and “this high” still do not identify the exact invalidation anchor. |
| 26:33–28:23; 35:39–35:45 | 149–163; 191 | Agreement: mark the price-confirming candle and allow the following 14 candles to reach the target. This is separate from pivot confirmation and pivot separation. |
| 30:21–30:48 | 165–173 | Agreement: RSI 50 is the stated dynamic completion target; profit-taking and moving the stop are trade-management examples. |
| 32:41–34:05 | 179–183 | Agreement: repeated divergences with weak recovery and continued price decline are discouraged. No reproducible count, size, or time threshold is provided. |
| 37:24–37:31 | 201 | Both repeat the incorrect claim that RSI cannot see beyond 14 candles. Transcription agreement does not make this mathematical claim correct. |

The chat independently records the students asking about the M/W sides versus middle and about the 14-candle duration. It supports the context and order of those discussions, but its answers cannot resolve chart-specific lines or validate the RSI-memory explanation.

## Mathematical facts and definitions

Wilder RSI(14) initializes average gains and losses from 14 price changes, then recursively updates them with weight `1/14` for the new observation and `13/14` for the previous average. Older observations continue to influence the result. It does **not** lose all information older than 14 candles: after 14 updates, `(13/14)^14 ≈ 35.4%` of each earlier smoothed average remains. RSI 50 corresponds to equal smoothed gains and losses in the usual nondegenerate case; touching 50 does not reset the RSI computation.

At **15:10–15:35**, the lecture gives the standard divergence definitions. They match the current detector:

| Type | Price relationship | RSI relationship |
| --- | --- | --- |
| Regular bullish | Lower low | Higher low |
| Regular bearish | Higher high | Lower high |
| Hidden bullish | Higher low | Lower low |
| Hidden bearish | Lower high | Higher high |

These relationships define patterns; they do not guarantee a future price move. The lecturer's additional filters, confirmation events, targets, and expiry period are strategy choices rather than mathematical properties of RSI.

## Lecturer's setup rules

### Compare vertically aligned candles

**08:44–09:26 · High confidence.** Price and RSI comparisons must refer to the same two candles. Do not pair price extrema with RSI extrema from different timestamps. The current implementation already uses the high or low of each RSI pivot's own candle.

### Require wick and body agreement

**09:31–10:53; 20:21–20:31 · High confidence in the requirement.** The divergence should exist using both wick extremes and candle bodies. A wick-only relationship contradicted by the bodies is rejected.

For selected candles `a < b`, define:

```text
bodyLow(i)  = min(open(i), close(i))
bodyHigh(i) = max(open(i), close(i))
```

The formula-ready interpretation is:

| Type | Required comparisons |
| --- | --- |
| Regular bullish | `low(b) < low(a)` AND `bodyLow(b) < bodyLow(a)` AND `rsi(b) > rsi(a)` |
| Regular bearish | `high(b) > high(a)` AND `bodyHigh(b) > bodyHigh(a)` AND `rsi(b) < rsi(a)` |
| Hidden bullish | `low(b) > low(a)` AND `bodyLow(b) > bodyLow(a)` AND `rsi(b) < rsi(a)` |
| Hidden bearish | `high(b) < high(a)` AND `bodyHigh(b) < bodyHigh(a)` AND `rsi(b) > rsi(a)` |

Using body extrema and strict inequalities is an explicit implementation interpretation; neither transcription specifies equality handling. Applying the filter to hidden types follows the lecturer's general wording, but the hidden examples have not been visually verified. This is a supported optional filter on top of the detector's wick comparisons.

### Keep both swings in one RSI 50 cycle

**12:26–14:12; clarification 37:37–38:30 · High confidence.** An RSI 50 touch between the compared swings resets the cycle and disqualifies that pair. The relevant section lies **between the two selected pivots**. The outer legs of the larger M/W shape may touch 50.

A formula-ready interpretation for discrete RSI samples is:

```text
sameCycle(a, b) =
  bullish (low pivots):  every rsi(k) < 50 for a <= k <= b
  bearish (high pivots): every rsi(k) > 50 for a <= k <= b
```

This rejects exact touches and crossings that jump over 50 between samples. Including the endpoints is a documented conservative interpretation. Samples outside `[a, b]` do not invalidate this pair's formation.

The side is fixed by the pattern, not by where the first pivot happens to sit. The lecturer describes a W (compare lows, bullish) and an M (compare highs, bearish), places divergence highs above the overbought area and lows below the oversold area (37:37–38:30), and sets the target at RSI returning to 50 (30:21–30:48). A bullish pair whose lows are both above 50 would have that target below the pattern, so it is not one lecture cycle. The same reasoning is applied to hidden patterns because the lecturer treats hidden and regular alike apart from the bullish/bearish distinction (15:10–15:35); the hidden examples have not been visually verified.

The Gemini transcript's final clarification says the middle should not even be near 50 and refers to overbought/oversold areas. The subtitles preserve the requirement for a gap but do not clearly reproduce the full addition. Neither source supplies a minimum gap or an explicit requirement to reach 30/70. Do not silently add those thresholds.

## Price confirmation is separate from pivot confirmation

**21:43–22:11 · High confidence.** Ordinary bullish confirmation is a later candle closing green: `close > open`. **39:54–40:04** explicitly requests a red candle for bearish confirmation: `close < open`.

**20:52–21:38 · High confidence in the body-engulfing concept; medium confidence in a complete automated definition.** Stronger confirmation is described as engulfing the preceding candle's body. Gemini lines 125–127 explicitly clarify that the bullish example's threshold is that body's open, agreeing with the intelligible subtitle fragments. A conventional body-engulfing interpretation would require the new body to contain the reference body, as well as close in the expected direction. The reference candle after intervening candles, opening-gap treatment, and strict/equal boundary handling still need visual verification. The stocks example confirms that ordinary red/green confirmation depends on that candle's own open, even after a gap.

**24:01–24:29** indicates that another unfavorable candle can occur while the divergence remains alive, followed by a later confirmation opportunity. The subtitles do not establish whether the second swing endpoint or engulfing reference moves each time.

The current detector uses strict RSI pivots with **five candles on each side**. A pivot at index `b` becomes known only when candle `b + 5` closes. That event is its current `confirmedAt`. The lecture's green/red price confirmation can happen sooner and is not equivalent to waiting five right-hand candles.

Do not silently relabel the existing `confirmedAt` as lecture confirmation, start the lecture's timer from it, or backdate a signal to a candle before its required evidence was available. A lecture implementation needs separate definitions for setup availability, price confirmation, and later status changes. For example, store `candleConditionAt` separately and require `actionableAt = max(pivotConfirmedAt, candleConditionAt)`. A target reached before the signal became observable must not be counted as a successful actionable signal. Retain the detected pattern and derive any lifecycle state separately. The lecture does not establish the current 5/5 pivot window or 5–60 pivot-distance bounds.

## Invalidation, completion, and expiry

### Invalidation through matching price and RSI structure

**23:06–23:18; 25:03–26:12; 35:03–35:10 · High confidence in the concept; low confidence in the exact anchor.** The lecturer says a divergence dies or “harmonizes” when the opposing RSI relationship disappears. Regular bullish examples discuss RSI making a lower low; a bearish example says “this high” being exceeded kills the divergence.

Both transcriptions refer to a displayed line, low, or high without identifying it reliably. Gemini's “RSI last low se neeche” is clearer than the subtitles' “last close,” but still does not safely establish whether the threshold is the first pivot, the second pivot, a later swing, or a drawn line. Do not invent that threshold from the text.

Hidden types need their own verified invalidation rules. For example, `rsi <= firstPivotRsi` would already be true at formation for hidden bullish divergence, so it cannot serve as a universal bullish invalidation condition.

### Completion at RSI 50

**30:21–30:48 · High confidence.** The lecturer calls the cycle reset—RSI reaching 50—the dynamic target, with trade management discussed at that event. This is an oscillator completion condition, not a fixed price target.

Whether an intrabar touch counts is not settled by either transcription. Using only closed RSI samples would make scanner status reproducible, but should be labeled as an implementation convention until verified.

### Fourteen candles after price confirmation

**26:33–28:23; 35:39–35:45 · High confidence in the duration and starting event.** Mark the candle that confirms the price reversal. If the setup has not reached its target within the following 14 candles, the lecturer treats it as expired. This is a post-confirmation lifetime, **not** a maximum distance between the two pivots.

An explicit implementation convention could use confirmation index `c` and monitor the next 14 closed candles, `c + 1` through `c + 14`, expiring after the last closes if completion has not occurred. The exact boundary and precedence when completion/invalidation coincide with expiry need verification.

**37:24–37:31** attributes the duration to RSI being unable to see beyond 14 candles; chat repeats that explanation. That rationale is mathematically incorrect for Wilder RSI. Retain any 14-candle expiry as the lecturer's chosen strategy rule; do not truncate or alter Wilder's recursive RSI calculation to match the explanation.

## Qualitative guidance without an automated threshold

**28:36–29:16:** trendline and moving-average breaks are presented as additional supporting evidence. The lecture does not specify an MA length, line-fitting method, or required combination.

**32:41–34:05:** the repeated-divergence example warns about continued decline after small recoveries. It does not establish that every second divergence is invalid, or define a quantitative recovery threshold. Keep this as research guidance rather than a hardcoded rejection rule.

**42:27–42:42:** timeframe choice depends on trading style. No universal best timeframe is established.

## Details still requiring visual or spoken clarification

1. How are the two swing candles selected, and does a new low/high replace the second endpoint while awaiting price confirmation?
2. Which exact candle supplies the engulfing reference after several intervening candles?
3. Which RSI level or drawn line invalidates each regular setup? How are hidden setups invalidated?
4. Do hidden bullish/bearish patterns use the same directional RSI half and lifecycle rules as the regular examples?
5. Are touches evaluated intrabar or at candle close? How are equality, doji candles, and the 14th-candle boundary handled?
6. Is the broad “opposite the current trend” wording at **01:45–02:22** intended only for regular reversal examples? Standard hidden divergences are commonly interpreted as continuation patterns, so a blanket reversal filter should not be inferred for them.

The supported changes are optional wick/body agreement and same-RSI50-cycle filters (bullish below 50, bearish above 50); same-candle alignment is already built into the detector. Ordinary candle-color confirmation is also clearly described, but a faithful full trade lifecycle still needs explicit causality, invalidation anchors, and boundary conventions. Use the corroborated transcript for the stated filters without presenting it as independently audio-verified, and leave the unresolved thresholds out of automated decisions.

## Implemented in the scanner

The **Divergences** master checkbox remains off by default. Under **Settings**,
**Require wick and body agreement** and **Keep pivots in one RSI 50 cycle** are
enabled by default and can each be disabled for comparison. The **RSI
invalidation anchor** defaults to the second pivot. All choices persist.

The lifecycle described above is now automated in `src/lib/divergenceLifecycle.ts`
with these explicit conventions, each chosen where the transcript was silent:

- The second pivot is provisional (strict extreme of the last 5 closed candles
  including itself) so the setup appears at that candle's close, matching the
  moment the lecturer spots it. The first pivot still needs 5 closed candles on
  both sides.
- Only the next closed candle can confirm; wrong colour or a doji ends the setup.
- Invalidation is a strict RSI breach of the chosen anchor pivot; equality keeps
  the setup alive. Hidden setups always anchor on the second pivot.
- Confirmation is candle 0 of the 14-candle window; the RSI 50 target counts on
  closed samples only, including a crossing without an exact 50 print; the
  target wins over expiry on candle 14 and an anchor breach wins over both.
- A target reached on the confirmation candle itself is recorded but excluded
  from backtest hit rates, since it was never an actionable trade.

Trend context, confluence, and the "not near 50" margin remain manual.

package selection

import (
	"sort"
	"time"

	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

// BuildPaperWatchlist presents the crypto project's active paper roster on
// independent completed 1d, 4h and 15m sources. Each frame stands on its own:
// missing four-hour data cannot suppress a valid daily signal, and vice versa.
// The view never places an order or treats an opening check as a known fill.
func BuildPaperWatchlist(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, configs ...Config) Result {
	cfg := selectedConfig(configs)
	methods := StrategyResult{Version: strategies.Version, Experimental: true, Items: []StrategyCandidate{},
		Summary: []StrategySummary{}, Contexts: []strategies.Context{}, Coverage: []StrategyCoverage{}, Unavailable: []string{}, Limit: 0}
	index := make(map[string]int, len(strategies.PaperFamilies))
	for _, family := range strategies.PaperFamilies {
		index[family] = len(methods.Summary)
		methods.Summary = append(methods.Summary, StrategySummary{Family: family})
	}
	seen := map[string]bool{}
	for _, symbol := range symbols {
		if seen[symbol] {
			continue
		}
		seen[symbol] = true
		readyFrames := map[string]bool{}
		inputs := map[string]strategies.Input{}
		for _, tf := range []string{"1d", "4h", "15m"} {
			in, ready := paperFrameInput(snapshot, histories, symbol, tf, now, maxAge)
			inputs[tf], readyFrames[tf] = in, ready
		}
		context := strategies.Context{Symbol: symbol, Availability: "unavailable", DirectionalState: "unavailable",
			VolatilityState: "unavailable", Relative: []strategies.RelativeStrength{}}
		if readyFrames["1d"] || readyFrames["4h"] || readyFrames["15m"] {
			context.Availability = "ready"
			at := int64(0)
			for _, tf := range []string{"1d", "4h", "15m"} {
				if readyFrames[tf] && inputs[tf].Frames[tf].LastClosedAt > at {
					at = inputs[tf].Frames[tf].LastClosedAt
				}
			}
			context.AsOf = &at
		} else {
			methods.Unavailable = append(methods.Unavailable, symbol)
		}
		methods.Contexts = append(methods.Contexts, context)
		for _, family := range strategies.PaperFamilies {
			tf := strategies.PaperFamilyFrame(family)
			in, ready := inputs[tf], readyFrames[tf]
			bars := in.Histories[tf].Candles
			coverage := StrategyCoverage{Symbol: symbol, Family: family, Interval: tf,
				Status: "data_unavailable", HistoryBars: len(bars)}
			if ready {
				at := in.Frames[tf].LastClosedAt
				coverage.AsOf, coverage.Status = &at, "ready"
				if len(bars) < paperFamilyWarmup(family) {
					coverage.Status = "insufficient"
				}
			}
			if coverage.Status != "ready" {
				methods.Summary[index[family]].Unavailable++
			}
			methods.Coverage = append(methods.Coverage, coverage)
		}
		if readyFrames["1d"] {
			in := inputs["1d"]
			paperAppendCandidates(&methods, index, in, now, cfg, strategies.PaperDonchianOpportunities(in))
			paperAppendCandidates(&methods, index, in, now, cfg, strategies.PaperLuxAlgoOpportunities(in, "1d"))
			paperAppendCandidates(&methods, index, in, now, cfg, strategies.PaperCloudTKOpportunities(in, now.UnixMilli()))
		}
		if readyFrames["4h"] {
			in := inputs["4h"]
			paperAppendCandidates(&methods, index, in, now, cfg, strategies.PaperWeeklyOpportunities(in))
			paperAppendCandidates(&methods, index, in, now, cfg, strategies.PaperRangeWeeklyOpportunities(in))
		}
		if readyFrames["15m"] {
			in := inputs["15m"]
			paperAppendCandidates(&methods, index, in, now, cfg, strategies.PaperLuxAlgoOpportunities(in, "15m"))
		}
	}
	sort.SliceStable(methods.Items, func(i, j int) bool {
		a, b := methods.Items[i], methods.Items[j]
		if a.Eligible != b.Eligible {
			return a.Eligible
		}
		if a.Opportunity.TriggerAt != nil && b.Opportunity.TriggerAt != nil && *a.Opportunity.TriggerAt != *b.Opportunity.TriggerAt {
			return *a.Opportunity.TriggerAt > *b.Opportunity.TriggerAt
		}
		if a.Opportunity.Symbol != b.Opportunity.Symbol {
			return a.Opportunity.Symbol < b.Opportunity.Symbol
		}
		if index[a.Opportunity.Family] != index[b.Opportunity.Family] {
			return index[a.Opportunity.Family] < index[b.Opportunity.Family]
		}
		return a.Opportunity.ID < b.Opportunity.ID
	})
	for _, item := range methods.Items {
		methods.Summary[index[item.Opportunity.Family]].Displayed++
	}
	result := Result{Config: cfg, Strategies: methods, Items: []Candidate{}, Trends: []TrendWatch{},
		Benchmarks: []Benchmark{}, Breadth: []Breadth{}, Limit: 0}
	for _, summary := range methods.Summary {
		result.Examined += summary.Observed
		result.Eligible += summary.Eligible
	}
	for _, item := range methods.Items {
		if item.Status == "cost_blocked" {
			result.CostFiltered++
		}
	}
	return result
}

func paperFamilyWarmup(family string) int {
	switch family {
	case strategies.PaperDonchianBase, strategies.PaperDonchianStoch,
		strategies.PaperDonchianMACD, strategies.PaperDonchianADXRange:
		return 56
	case strategies.PaperTrendADX, strategies.PaperTrendCluster, strategies.PaperTrendSFP:
		return 30
	case strategies.PaperNWEMomentum:
		return 999
	case strategies.PaperFreshWeeklyRangeLong, strategies.PaperRangeWeekly:
		return 44
	case "tk_cross_rsi":
		return 151
	default:
		return 152
	}
}

func paperFrameInput(snapshot scanner.Snapshot, histories map[string]scanner.History, symbol, timeframe string, now time.Time, maxAge time.Duration) (strategies.Input, bool) {
	in := strategies.Input{Symbol: symbol, Frames: map[string]scanner.SeriesSummary{}, Histories: map[string]scanner.History{}}
	blocked := snapshot.Running
	for _, frame := range snapshot.Series {
		if frame.Symbol != symbol || frame.Interval != timeframe {
			continue
		}
		if _, duplicate := in.Frames[timeframe]; duplicate {
			blocked = true
		}
		in.Frames[timeframe] = frame
	}
	for _, scanError := range snapshot.Errors {
		if scanError.Symbol == symbol && scanError.Interval == timeframe {
			blocked = true
		}
	}
	history := histories[pair(symbol, timeframe)]
	in.Histories[timeframe] = history
	frame, present := in.Frames[timeframe]
	// The sibling paper screen treats a candle as completed only after its
	// inclusive close millisecond, even when a caller bypasses browserengine.
	return in, !blocked && present && frame.LastClosedAt < now.UnixMilli() && IchimokuSeriesReady(frame, history, now, maxAge)
}

func paperAppendCandidates(out *StrategyResult, index map[string]int, in strategies.Input, now time.Time, cfg Config, opportunities []strategies.Opportunity) {
	for _, opportunity := range opportunities {
		familyIndex, selected := index[opportunity.Family]
		if !selected || opportunity.Interval == "" || opportunity.Interval != strategies.PaperFamilyFrame(opportunity.Family) {
			continue
		}
		out.Summary[familyIndex].Observed++
		if opportunity.State == "entry_confirmed" {
			out.Summary[familyIndex].Confirmed++
		}
		candidate := assessPaperCandidate(opportunity, in, now, cfg)
		if candidate.Eligible {
			out.Summary[familyIndex].Eligible++
		}
		out.Items = append(out.Items, candidate)
	}
}

// The paper catalog's account checks the next whole one-minute opening after
// observation and the intervening minute path. This source-frame watchlist
// checks the frozen signal and presents that policy for review, but cannot
// verify the execution path, a fill or its slipped-entry target in advance.
func assessPaperCandidate(op strategies.Opportunity, in strategies.Input, now time.Time, cfg Config) StrategyCandidate {
	op = cloneOpportunity(op)
	frame := in.Frames[op.Interval]
	history := in.Histories[op.Interval]
	price := 0.0
	if len(history.Candles) > 0 {
		price = history.Candles[len(history.Candles)-1].Close
	}
	candidate := StrategyCandidate{Opportunity: op, Price: price, Status: op.State, Reason: op.Reason}
	plan := TradePlan{Status: "invalid_evidence", Entry: number(price), Stop: clonePointer(op.Stop), Target: clonePointer(op.Target),
		FeeBPS: cfg.FeeBPS, SlippageBPS: cfg.SlippageBPS, MinNetRR: cfg.MinNetRR,
		Trigger: op.Next, Invalidation: op.Invalidation, ExpiresAt: clonePointer(op.ExpiresAt),
		Instrument: "spot_long_reference", SizingStatus: "unconfigured", Reasons: []string{},
		Management: "Paper research reference. The source account checks the next whole one-minute opening and intervening minute candles; this browser cannot verify an entry or fill."}
	if op.Direction == "bearish" {
		plan.Instrument = "short_instrument_unverified"
		plan.Reasons = append(plan.Reasons, "Spot short availability, borrowing, funding and execution costs are unverified.")
	}
	block := func(status, reason string) StrategyCandidate {
		plan.Status = status
		plan.Reasons = append(plan.Reasons, reason)
		candidate.Plan, candidate.Status, candidate.Reason = plan, status, reason
		return candidate
	}
	if op.State != "entry_confirmed" || op.TriggerAt == nil || op.ExpiresAt == nil || op.Stop == nil ||
		op.AsOf != frame.LastClosedAt || *op.TriggerAt > frame.LastClosedAt || op.AvailableAt > *op.TriggerAt ||
		op.SourceStartAt > op.SourceEndAt || op.SourceEndAt > op.AvailableAt || op.LocationAvailableAt > op.AvailableAt ||
		!positive(price) || !positive(*op.Stop) {
		return block("invalid_evidence", "A complete causal source-frame signal and frozen protective stop are required.")
	}
	if now.UnixMilli() >= *op.ExpiresAt || !now.Truncate(time.Minute).Add(time.Minute).Before(time.UnixMilli(*op.ExpiresAt)) {
		return block("expired", "No whole one-minute paper opening remains before the frozen entry deadline.")
	}
	if op.Direction != "bullish" && op.Direction != "bearish" ||
		op.Direction == "bullish" && *op.Stop >= price || op.Direction == "bearish" && *op.Stop <= price {
		return block("invalid_stop", "The frozen protective stop must remain on the adverse side of the latest completed price.")
	}
	if err := cfg.Validate(); err != nil {
		return block("invalid_configuration", err.Error())
	}
	isDonchian := op.Family == strategies.PaperDonchianBase || op.Family == strategies.PaperDonchianStoch ||
		op.Family == strategies.PaperDonchianMACD || op.Family == strategies.PaperDonchianADXRange
	isCloud := len(op.Family) >= len("cloud_reclaim_volume_2r") && op.Family[:len("cloud_reclaim_volume_2r")] == "cloud_reclaim_volume_2r"
	isTrendCombo := op.Family == strategies.PaperTrendADX || op.Family == strategies.PaperTrendCluster || op.Family == strategies.PaperTrendSFP
	isNWE := op.Family == strategies.PaperNWEMomentum
	if isDonchian || isTrendCombo || isNWE {
		if op.Target != nil || op.Direction != "bullish" || op.ReferenceATR == nil || !positive(*op.ReferenceATR) {
			return block("invalid_evidence", "This plan needs its original ATR stop and no target known before execution.")
		}
		plan.Management = "The paper trial checks the next whole one-minute opening above the initial 2-ATR stop, after verifying intervening minute candles. Ratchet a 3.5-ATR stop after completed daily closes without widening it; a close below the previous 20-bar low exits at the following one-minute opening. Exit after at most 96 daily bars."
		if isTrendCombo {
			plan.Management = "Initial 2×Wilder ATR14 stop; never-widening 3.5×Wilder ATR14 trail after completed daily closes. Ungated opposite raw Trendlines events exit at the next one-minute opening. Maximum holding: 96 daily bars. Check intervening minutes and the next whole opening before entry."
		}
		if isNWE {
			plan.Management = "Keep the initial 2×Wilder ATR14 stop fixed. At execution, target = raw opening + 2 × (raw opening − stop), using the actual raw opening before slippage. No trail or opposite-event exit. Maximum holding: 24 fifteen-minute bars. Check intervening minutes and opening costs before entry; the target and after-fill reward/risk are unknown here."
		}
	} else {
		if op.Target == nil || op.EntryMin == nil || op.EntryMax == nil || op.ReferenceATR == nil ||
			!positive(*op.Target) || !positive(*op.EntryMin) || !positive(*op.EntryMax) || !positive(*op.ReferenceATR) ||
			*op.EntryMin > *op.EntryMax || price < *op.EntryMin || price > *op.EntryMax {
			return block("invalid_evidence", "The source plan needs its frozen target, ATR and current completed close inside the entry band.")
		}
		checked := referencePlan(op.Direction, price, *op.Stop, *op.Target, cfg)
		if checked.Status != "awaiting_trigger" {
			plan.Reasons = append(plan.Reasons, checked.Reasons...)
			return block(checked.Status, "The original frozen target does not pass the current cost and protective-order checks.")
		}
		plan.Target = clonePointer(op.Target) // original structural target, before any execution-time cap
		if isCloud {
			plan.Management = "Volume and directional filters were frozen at the first eligible completed close. The paper trial checks the next whole one-minute opening inside the frozen band after verifying intervening minute candles. Keep the original stop; shorten a farther target to a net 2R after actual slipped entry costs. Maximum holding: 24 daily bars. The chart target is the original structural reference."
		} else if op.Family == strategies.PaperRangeWeekly {
			plan.Management = "Weekly agreement is frozen at the first eligible range emission. Check the next whole one-minute opening inside the original band and intervening minute candles. Keep the original stop and target; maximum holding: 24 four-hour bars. The weekly helper adds no 3% opening-width guard."
		} else if op.Family == strategies.PaperFreshWeeklyRangeLong {
			plan.Management = "The paper trial checks the next whole one-minute opening inside the frozen band after verifying intervening minute candles, only if raw opening-to-stop distance is at least 3%. Keep the original range target; maximum holding: 24 four-hour bars."
		} else {
			plan.Management = "The paper trial checks the next whole one-minute opening inside the frozen band after verifying intervening minute candles. Keep the original stop and target; maximum holding: 24 daily bars."
		}
	}
	plan.Status = "ready_for_review"
	plan.Reasons = append(plan.Reasons, "Intervening one-minute candles, next-opening price, adverse slippage, fees, liquidity and position sizing remain unverified here; no fill is assumed.")
	candidate.Plan, candidate.Status, candidate.Eligible = plan, "ready_for_review", true
	return candidate
}

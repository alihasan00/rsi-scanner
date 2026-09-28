package selection

import (
	"fmt"
	"sort"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

type StrategyCandidate struct {
	Opportunity strategies.Opportunity `json:"opportunity"`
	Plan        TradePlan              `json:"plan"`
	Price       float64                `json:"price"`
	Status      string                 `json:"status"`
	Eligible    bool                   `json:"eligible"`
	Reason      string                 `json:"reason"`
}

type StrategySummary struct {
	Family      string `json:"family"`
	Observed    int    `json:"observed"`
	Confirmed   int    `json:"confirmed"`
	Eligible    int    `json:"eligible"`
	Displayed   int    `json:"displayed"`
	Unavailable int    `json:"unavailable"`
}

// Coverage records every requested family/frame, including no-event prefixes.
// It is the denominator for future research, independent of display limits.
type StrategyCoverage struct {
	Symbol      string `json:"symbol"`
	Family      string `json:"family"`
	Interval    string `json:"interval"`
	Status      string `json:"status"`
	AsOf        *int64 `json:"asOf"`
	HistoryBars int    `json:"historyBars"`
}

type StrategyResult struct {
	Version      int                  `json:"version"`
	Experimental bool                 `json:"experimental"`
	Items        []StrategyCandidate  `json:"items"`
	Summary      []StrategySummary    `json:"summary"`
	Contexts     []strategies.Context `json:"contexts"`
	Coverage     []StrategyCoverage   `json:"coverage"`
	Unavailable  []string             `json:"unavailable"`
	Limit        int                  `json:"limit"`
}

// BuildStrategies shares production discovery and gates with detail, journal
// and replay. A zero limit retains terminal/rejected observations as well.
func BuildStrategies(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, limit int, cfg Config, prepared ...*Prepared) StrategyResult {
	return buildStrategies(snapshot, histories, symbols, now, maxAge, limit, cfg, strategies.Families, limit > 0, prepared...)
}

var ichimokuFamilies = []string{strategies.KijunReclaim, strategies.CloudReclaim, strategies.TKCross, strategies.PKCross, strategies.CloudEdgeToEdge}

// BuildIchimokuStrategies filters families before ranking/display selection and
// returns every active Ichimoku setup. Zero Limit here means an uncapped active
// screener, not the terminal inventory returned by BuildStrategies with zero.
func BuildIchimokuStrategies(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, cfg Config, prepared ...*Prepared) StrategyResult {
	return buildStrategies(snapshot, histories, symbols, now, maxAge, 0, cfg, ichimokuFamilies, true, prepared...)
}

func buildStrategies(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, limit int, cfg Config, families []string, activeOnly bool, prepared ...*Prepared) StrategyResult {
	var cached *Prepared
	if len(prepared) > 0 {
		cached = prepared[0]
	}
	out := StrategyResult{Version: strategies.Version, Experimental: true, Items: []StrategyCandidate{}, Summary: []StrategySummary{}, Contexts: []strategies.Context{}, Coverage: []StrategyCoverage{}, Unavailable: []string{}, Limit: limit}
	index := map[string]int{}
	for _, family := range families {
		index[family] = len(out.Summary)
		out.Summary = append(out.Summary, StrategySummary{Family: family})
	}
	seen := map[string]bool{}
	for _, symbol := range symbols {
		if seen[symbol] {
			continue
		}
		seen[symbol] = true
		in, ready := strategyInput(snapshot, histories, symbol, now, maxAge)
		context := strategies.Context{Symbol: symbol, Availability: "unavailable", DirectionalState: "unavailable", VolatilityState: "unavailable", Relative: []strategies.RelativeStrength{}}
		if ready {
			var found bool
			if cached != nil {
				context, found = cached.contexts[symbol]
			}
			if !found {
				context = strategies.Describe(in)
			}
		} else {
			out.Unavailable = append(out.Unavailable, symbol)
		}
		context.Relative = relativeContexts(symbol, snapshot, histories, now, maxAge)
		context.AsOf = clonePointer(context.AsOf)
		context.Range = clonePointer(context.Range)
		out.Contexts = append(out.Contexts, context)
		for _, family := range families {
			frames, warmup := strategyRequirements(family)
			for _, tf := range frames {
				c := StrategyCoverage{Symbol: symbol, Family: family, Interval: tf, Status: "data_unavailable", HistoryBars: len(in.Histories[tf].Candles)}
				if ready {
					at := in.Frames[tf].LastClosedAt
					c.AsOf = &at
					c.Status = "ready"
					if c.HistoryBars < warmup {
						c.Status = "insufficient"
					}
				}
				if c.Status != "ready" {
					out.Summary[index[family]].Unavailable++
				}
				out.Coverage = append(out.Coverage, c)
			}
		}
		if !ready {
			continue
		}
		var opportunities []strategies.Opportunity
		var found bool
		if cached != nil {
			opportunities, found = cached.opportunities[symbol]
		}
		if !found {
			opportunities = strategies.Analyze(in)
		}
		for _, opportunity := range opportunities {
			if _, selected := index[opportunity.Family]; !selected {
				continue
			}
			candidate := assessStrategy(opportunity, in, now, cfg)
			summary := &out.Summary[index[opportunity.Family]]
			summary.Observed++
			if candidate.Opportunity.State == "entry_confirmed" {
				summary.Confirmed++
			}
			if candidate.Eligible {
				summary.Eligible++
			}
			out.Items = append(out.Items, candidate)
		}
	}
	return finishStrategySelection(out, families, activeOnly, limit)
}

func finishStrategySelection(out StrategyResult, families []string, activeOnly bool, limit int) StrategyResult {
	index := make(map[string]int, len(out.Summary))
	for i, summary := range out.Summary {
		index[summary.Family] = i
	}
	addOpposingStrategyCautions(out.Items)
	sort.SliceStable(out.Items, func(i, j int) bool {
		a, b := out.Items[i], out.Items[j]
		if a.Eligible != b.Eligible {
			return a.Eligible
		}
		aa, bb := strategyActive(a.Opportunity.State), strategyActive(b.Opportunity.State)
		if aa != bb {
			return aa
		}
		if a.Opportunity.AvailableAt != b.Opportunity.AvailableAt {
			return a.Opportunity.AvailableAt > b.Opportunity.AvailableAt
		}
		return a.Opportunity.ID < b.Opportunity.ID
	})
	if activeOnly {
		// Round-robin families within each priority group avoids a prolific
		// source monopolizing the cards, while eligible entries remain first.
		inventory := out.Items
		out.Items = []StrategyCandidate{}
		// A zero configured limit removes the display bound while preserving
		// the same active-only tiers and per-family round-robin ordering.
		displayLimit := limit
		if displayLimit <= 0 {
			displayLimit = len(inventory)
		}
		for tier := 0; tier < 2 && len(out.Items) < displayLimit; tier++ {
			queues := map[string][]StrategyCandidate{}
			for _, c := range inventory {
				t := 2
				if c.Eligible {
					t = 0
				} else if strategyActive(c.Opportunity.State) {
					t = 1
				}
				if t == tier {
					queues[c.Opportunity.Family] = append(queues[c.Opportunity.Family], c)
				}
			}
			for added := true; added && len(out.Items) < displayLimit; {
				added = false
				for _, family := range families {
					q := queues[family]
					if len(q) == 0 || len(out.Items) >= displayLimit {
						continue
					}
					out.Items = append(out.Items, q[0])
					queues[family] = q[1:]
					added = true
				}
			}
		}
	}
	for _, c := range out.Items {
		out.Summary[index[c.Opportunity.Family]].Displayed++
	}
	return out
}

func strategyRequirements(family string) ([]string, int) {
	switch family {
	case strategies.SweepReversal:
		return []string{"15m"}, 4
	case strategies.DivergenceReversal, strategies.DivergenceContinuation:
		return []string{"15m"}, 160
	case strategies.KijunReclaim:
		return []string{"1h", "4h"}, 61
	case strategies.CloudReclaim:
		return []string{"1h", "4h"}, 151
	case strategies.TKCross, strategies.PKCross:
		return []string{"1h", "4h"}, 150
	case strategies.CloudEdgeToEdge:
		return []string{"1h", "4h"}, 151
	case strategies.CompressionBreakout:
		return []string{"1h", "4h"}, 41
	case strategies.FVGPullback:
		return []string{"1h", "4h"}, 22
	case strategies.FibonacciPullback:
		return []string{"1h", "4h"}, 26
	default:
		return []string{"1h", "4h"}, 21
	}
}

// StrategyDataReady validates the same complete evidence used by discovery.
func StrategyDataReady(snapshot scanner.Snapshot, histories map[string]scanner.History, symbol string, now time.Time, maxAge time.Duration) bool {
	_, ready := strategyInput(snapshot, histories, symbol, now, maxAge)
	return ready
}

func strategyInput(snapshot scanner.Snapshot, histories map[string]scanner.History, symbol string, now time.Time, maxAge time.Duration) (strategies.Input, bool) {
	in := strategies.Input{Symbol: symbol, Frames: map[string]scanner.SeriesSummary{}, Histories: map[string]scanner.History{}}
	ready := !snapshot.Running
	for _, s := range snapshot.Series {
		if s.Symbol != symbol {
			continue
		}
		if _, duplicate := in.Frames[s.Interval]; duplicate {
			ready = false
		}
		in.Frames[s.Interval] = s
	}
	for _, e := range snapshot.Errors {
		if e.Symbol == symbol {
			ready = false
		}
	}
	for _, tf := range intervals {
		s, ok := in.Frames[tf]
		h := histories[pair(symbol, tf)]
		in.Histories[tf] = h
		if !ok || !strategyFrameReady(s, h, now, maxAge) || s.LastClosedAt > in.Frames["15m"].LastClosedAt {
			ready = false
		}
	}
	return in, ready
}

func strategyFrameReady(s scanner.SeriesSummary, h scanner.History, now time.Time, maxAge time.Duration) bool {
	width, err := time.ParseDuration(s.Interval)
	if s.Interval == "1d" {
		width = 24 * time.Hour
		err = nil
	}
	if err != nil || width <= 0 || !seriesReady(s, now, maxAge) || !positive(s.Price) || s.ObservedAt.UnixMilli() < s.LastClosedAt || !trendHistoryValid(h.Candles, width, s.LastClosedAt) {
		return false
	}
	if s.Analysis.AsOf != 0 && s.Analysis.AsOf != s.LastClosedAt {
		return false
	}
	if s.ClosedCandles != 0 && s.ClosedCandles != len(h.Candles) {
		return false
	}
	if s.FirstOpenTime != 0 && s.FirstOpenTime != h.Candles[0].OpenTime {
		return false
	}
	for _, b := range h.Candles {
		if b.OpenTime%width.Milliseconds() != 0 {
			return false
		}
	}
	return true
}

func strategyActive(state string) bool {
	return oneOf(state, "observing", "waiting_for_retest", "awaiting_confirmation", "entry_confirmed")
}

func assessStrategy(o strategies.Opportunity, in strategies.Input, now time.Time, cfg Config) StrategyCandidate {
	return assessStrategyOnFrame(o, in, now, cfg, "15m", false)
}

// The original mixed selector always passes validated 15m monitoring. The
// dedicated indicator uses its selected source for price, entry validation and
// subsequent stop/target checks on every chart period.
func assessStrategyOnFrame(o strategies.Opportunity, in strategies.Input, now time.Time, cfg Config, assessmentFrame string, sourceOnly bool) StrategyCandidate {
	o = cloneOpportunity(o)
	price := in.Frames[assessmentFrame].Price
	c := StrategyCandidate{Opportunity: o, Price: price, Status: o.State, Reason: o.Reason}
	stop, target := 0.0, 0.0
	if o.Stop != nil {
		stop = *o.Stop
	}
	if o.Target != nil {
		target = *o.Target
	}
	c.Plan = referencePlan(o.Direction, price, stop, target, cfg)
	c.Plan.Trigger = o.Next
	c.Plan.Invalidation = o.Invalidation
	c.Plan.ExpiresAt = o.ExpiresAt
	block := func(status, reason string) StrategyCandidate {
		c.Status, c.Reason, c.Plan.Status = status, reason, status
		c.Plan.Reasons = append(c.Plan.Reasons, reason)
		return c
	}
	if !strategyActive(o.State) {
		return block(o.State, o.Reason)
	}
	if o.State != "entry_confirmed" {
		return block(o.State, o.Reason)
	}
	if o.TriggerAt == nil || o.ExpiresAt == nil || o.EntryMin == nil || o.EntryMax == nil || o.ReferenceATR == nil || !positive(*o.ReferenceATR) || *o.EntryMin > *o.EntryMax || !positive(*o.EntryMin) || !positive(*o.EntryMax) || o.AvailableAt > *o.TriggerAt {
		return block("invalid_evidence", "Frozen completed trigger, entry bounds, ATR and expiry are required.")
	}
	if *o.ExpiresAt <= *o.TriggerAt || o.SourceStartAt > o.SourceEndAt || o.SourceEndAt > o.AvailableAt || o.LocationAvailableAt > o.AvailableAt {
		return block("invalid_evidence", "Source and expiry timestamps must preserve causal order.")
	}
	if *o.TriggerAt > in.Frames[assessmentFrame].LastClosedAt {
		return block("invalid_evidence", "Frozen completed trigger, entry bounds, ATR and expiry are required.")
	}
	// Source analyzers resolve on their own frame. Recheck every fully later
	// assessment-frame bar so a signal cannot revive after a protective touch.
	if o.Stop == nil || o.Target == nil {
		return block("invalid_evidence", "Frozen structural stop and target are required.")
	}
	duration, supported := market.IntervalDuration(assessmentFrame)
	if !supported || duration <= 0 {
		return block("invalid_evidence", "A supported completed-candle assessment timeframe is required.")
	}
	width := duration.Milliseconds()
	first := (*o.TriggerAt/width + 1) * width
	if sourceOnly {
		// Inclusive source closes identify the next complete opening without
		// imposing an epoch phase on three-day or Monday weekly candles.
		first = *o.TriggerAt + 1
	}
	last := in.Frames[assessmentFrame].LastClosedAt
	bars := in.Histories[assessmentFrame].Candles
	if len(bars) == 0 {
		return block("data_unavailable", "Completed "+assessmentFrame+" history is required.")
	}
	if first <= last && (len(bars) == 0 || bars[0].OpenTime > first) {
		return block("data_unavailable", "Complete post-trigger "+assessmentFrame+" history is required.")
	}
	for _, b := range bars {
		if b.OpenTime < first {
			continue
		}
		status, reason := "", ""
		if o.Direction == "bullish" && b.Low <= stop || o.Direction == "bearish" && b.High >= stop {
			status, reason = "invalidated", "A later completed "+assessmentFrame+" candle touched the frozen stop."
		} else if o.Direction == "bullish" && b.High >= target || o.Direction == "bearish" && b.Low <= target {
			status, reason = "target_reached", "A later completed "+assessmentFrame+" candle touched the frozen target."
		}
		if status != "" {
			at := b.CloseTime
			c.Opportunity.State = status
			c.Opportunity.Reason = reason
			c.Opportunity.ResolvedAt = &at
			return block(status, reason)
		}
	}
	if now.UnixMilli() >= *o.ExpiresAt {
		c.Opportunity.State, c.Opportunity.ResolvedAt = "expired", o.ExpiresAt
		c.Opportunity.Reason = "The frozen entry window ended."
		return block("expired", "The frozen entry window ended.")
	}
	closed := bars[len(bars)-1].Close
	for _, value := range []float64{price, closed} {
		if value < *o.EntryMin || value > *o.EntryMax || directionSign(o.Direction)*(value-stop) <= 0 || directionSign(o.Direction)*(target-value) <= 0 {
			return block("entry_distance_or_levels", "Current quote and latest completed close must remain inside the frozen entry bounds, stop and target.")
		}
	}
	applyTurnover(&c.Plan, in.Frames[assessmentFrame].Analysis.Volume, cfg)
	applySizing(&c.Plan, o.Symbol, o.Direction, cfg, now)
	if c.Plan.Status != "awaiting_trigger" {
		c.Status = c.Plan.Status
		c.Reason = "The shared reference-plan checks block this entry."
		return c
	}
	if c.Plan.SizingStatus == "blocked" {
		return block("account_blocked", "The supplied account limits block this entry.")
	}
	c.Plan.Status, c.Status, c.Eligible = "ready_for_review", "ready_for_review", true
	return c
}

func addOpposingStrategyCautions(items []StrategyCandidate) {
	for i := range items {
		c := &items[i]
		if !strategyActive(c.Opportunity.State) {
			continue
		}
		count := 0
		for j := range items {
			o := items[j].Opportunity
			if o.Symbol == c.Opportunity.Symbol && o.Direction != c.Opportunity.Direction && strategyActive(o.State) {
				count++
			}
		}
		if count > 0 {
			if c.Opportunity.Caution != "" {
				c.Opportunity.Caution += " "
			}
			c.Opportunity.Caution += fmt.Sprintf("%d other active method observation(s) on this coin point in the opposite direction; resolve the conflicting context before entry.", count)
		}
		if c.Plan.CostRiskR != nil && *c.Plan.CostRiskR >= 1 {
			if c.Opportunity.Caution != "" {
				c.Opportunity.Caution += " "
			}
			c.Opportunity.Caution += "Modeled round-trip costs equal or exceed the initial price risk."
		}
	}
}

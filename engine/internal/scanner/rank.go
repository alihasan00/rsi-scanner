package scanner

import (
	"fmt"
	"sort"
)

// Rank is a deterministic sort key and grouping aid derived from evidence that
// is already present on the row: whether D is confirmed, the setup timeframe's
// own closed-candle SuperTrend and internal-structure direction, and the
// entry-to-stop distance in the setup timeframe's ATR. The legacy order is a
// display heuristic; its original retrospective justification had stage/score
// hindsight (see docs/ranking-evaluation.md). It is not a probability,
// a recommendation, or a replacement for the geometry score, and it never
// changes which setups are reported.
type Rank struct {
	Order     int      `json:"order"`
	Tier      string   `json:"tier"`
	Evidence  []string `json:"evidence"`
	Group     string   `json:"group"`
	GroupRank int      `json:"groupRank"`
	GroupSize int      `json:"groupSize"`
}

// Tier labels in rank order. Only the setup's own timeframe contributes;
// higher-timeframe context stays informational in the decision block.
const (
	TierConfirmedWithTrendTightStop    = "confirmed_with_trend_tight_stop"
	TierConfirmedTightStop             = "confirmed_tight_stop"
	TierConfirmed                      = "confirmed"
	TierPotentialWithTrendAndStructure = "potential_with_trend_and_structure"
	TierPotentialWithTrend             = "potential_with_trend"
	TierPotential                      = "potential"
)

// Tiers lists every tier label in rank order (index + 1 == order).
var Tiers = []string{TierConfirmedWithTrendTightStop, TierConfirmedTightStop, TierConfirmed, TierPotentialWithTrendAndStructure, TierPotentialWithTrend, TierPotential}

func directional(v string) bool { return v == "bullish" || v == "bearish" }

// TierFor classifies a setup from evidence knowable at the setup timeframe's
// last closed candle. stage is the harmonic stage (potential or confirmed);
// direction is the harmonic direction; trend and internal are the setup
// timeframe's SuperTrend direction and internal-structure bias (any value other
// than bullish/bearish counts as unavailable); stopATR is the entry-to-stop
// distance in that timeframe's ATR, nil when unavailable. It returns the order,
// the tier label and the evidence codes that produced them.
func TierFor(stage, direction, trend, internal string, stopATR *float64) (int, string, []string) {
	confirmed := stage == "confirmed"
	trendAgrees := directional(trend) && trend == direction
	internalAgrees := directional(internal) && internal == direction
	underOne := stopATR != nil && *stopATR < 1
	underTwo := stopATR != nil && *stopATR < 2

	evidence := make([]string, 0, 4)
	if confirmed {
		evidence = append(evidence, "d_confirmed")
	} else {
		evidence = append(evidence, "d_unconfirmed")
	}
	switch {
	case trendAgrees:
		evidence = append(evidence, "setup_trend_agrees")
	case directional(trend):
		evidence = append(evidence, "setup_trend_opposes")
	default:
		evidence = append(evidence, "setup_trend_unavailable")
	}
	switch {
	case internalAgrees:
		evidence = append(evidence, "setup_internal_structure_agrees")
	case directional(internal):
		evidence = append(evidence, "setup_internal_structure_opposes")
	default:
		evidence = append(evidence, "setup_internal_structure_unknown")
	}
	switch {
	case underOne:
		evidence = append(evidence, "stop_under_1_atr")
	case underTwo:
		evidence = append(evidence, "stop_under_2_atr")
	case stopATR != nil:
		evidence = append(evidence, "stop_2_atr_or_more")
	default:
		evidence = append(evidence, "stop_atr_unavailable")
	}

	var order int
	switch {
	case confirmed && trendAgrees && underTwo:
		order = 1
	case confirmed && underOne:
		order = 2
	case confirmed:
		order = 3
	case trendAgrees && internalAgrees:
		order = 4
	case trendAgrees:
		order = 5
	default:
		order = 6
	}
	return order, Tiers[order-1], evidence
}

// GroupKey identifies one reversal point: alternative X/A/B legs and different
// families that share a C pivot in the same direction describe the same zone.
func GroupKey(symbol, interval, direction string, cTime int64) string {
	return fmt.Sprintf("%s:%s:%s:%d", symbol, interval, direction, cTime)
}

func rankFor(row Row) Rank {
	trend, internal := "unavailable", "unknown"
	for _, frame := range row.Decision.Timeframes {
		if frame.Interval == row.Interval && frame.Availability == "ready" {
			trend, internal = frame.Trend, frame.InternalBias
		}
	}
	order, tier, evidence := TierFor(row.Pattern.Stage, string(row.Pattern.Direction), trend, internal, row.Decision.Risk.EntryStopDistanceATR)
	return Rank{Order: order, Tier: tier, Evidence: evidence, Group: GroupKey(row.Symbol, row.Interval, string(row.Pattern.Direction), row.Pattern.C.Time)}
}

// rowLess is the single result ordering: rank order, then geometry score,
// symbol, interval and pattern ID. Rows without a rank (order 0) keep the
// pre-rank ordering among themselves.
func rowLess(a, b Row) bool {
	if a.Rank.Order != b.Rank.Order {
		return a.Rank.Order < b.Rank.Order
	}
	if a.Pattern.Score != b.Pattern.Score {
		return a.Pattern.Score > b.Pattern.Score
	}
	if a.Symbol != b.Symbol {
		return a.Symbol < b.Symbol
	}
	if a.Interval != b.Interval {
		return a.Interval < b.Interval
	}
	return a.Pattern.ID < b.Pattern.ID
}

// assignRanks computes each row's tier and its position within its reversal
// point group using the same ordering that Snapshot applies to results.
func assignRanks(rows []Row) {
	for i := range rows {
		rows[i].Rank = rankFor(rows[i])
	}
	order := make([]int, len(rows))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return rowLess(rows[order[a]], rows[order[b]]) })
	size := make(map[string]int, len(rows))
	for i := range rows {
		size[rows[i].Rank.Group]++
	}
	seen := make(map[string]int, len(size))
	for _, i := range order {
		group := rows[i].Rank.Group
		seen[group]++
		rows[i].Rank.GroupRank = seen[group]
		rows[i].Rank.GroupSize = size[group]
	}
}

// attachRanks runs after decisions exist; it reads only this scan's rows.
func (s *Scanner) attachRanks() {
	s.mu.Lock()
	defer s.mu.Unlock()
	assignRanks(s.state.Rows)
}

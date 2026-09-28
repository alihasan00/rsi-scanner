package scanner

import (
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/harmonic"
)

func TestTierForCoversEveryEvidenceClass(t *testing.T) {
	half, one, three := 0.5, 1.5, 3.0
	cases := []struct {
		name                   string
		stage, trend, internal string
		stop                   *float64
		order                  int
		tier                   string
		evidence               []string
	}{
		{"confirmed with trend and tight stop", "confirmed", "bullish", "bearish", &one, 1, TierConfirmedWithTrendTightStop, []string{"d_confirmed", "setup_trend_agrees", "setup_internal_structure_opposes", "stop_under_2_atr"}},
		{"confirmed with trend but wide stop", "confirmed", "bullish", "bullish", &three, 3, TierConfirmed, []string{"d_confirmed", "setup_trend_agrees", "setup_internal_structure_agrees", "stop_2_atr_or_more"}},
		{"confirmed counter-trend tight stop", "confirmed", "bearish", "unknown", &half, 2, TierConfirmedTightStop, []string{"d_confirmed", "setup_trend_opposes", "setup_internal_structure_unknown", "stop_under_1_atr"}},
		{"confirmed counter-trend under two ATR is not tier 2", "confirmed", "bearish", "bearish", &one, 3, TierConfirmed, []string{"d_confirmed", "setup_trend_opposes", "setup_internal_structure_opposes", "stop_under_2_atr"}},
		{"confirmed without ATR", "confirmed", "bullish", "bullish", nil, 3, TierConfirmed, []string{"d_confirmed", "setup_trend_agrees", "setup_internal_structure_agrees", "stop_atr_unavailable"}},
		{"potential with trend and structure", "potential", "bullish", "bullish", &half, 4, TierPotentialWithTrendAndStructure, []string{"d_unconfirmed", "setup_trend_agrees", "setup_internal_structure_agrees", "stop_under_1_atr"}},
		{"potential with trend only", "potential", "bullish", "bearish", nil, 5, TierPotentialWithTrend, []string{"d_unconfirmed", "setup_trend_agrees", "setup_internal_structure_opposes", "stop_atr_unavailable"}},
		{"potential counter-trend", "potential", "bearish", "bullish", &half, 6, TierPotential, []string{"d_unconfirmed", "setup_trend_opposes", "setup_internal_structure_agrees", "stop_under_1_atr"}},
		{"potential trend unavailable", "potential", "neutral", "bullish", &half, 6, TierPotential, []string{"d_unconfirmed", "setup_trend_unavailable", "setup_internal_structure_agrees", "stop_under_1_atr"}},
	}
	for _, c := range cases {
		order, tier, evidence := TierFor(c.stage, "bullish", c.trend, c.internal, c.stop)
		if order != c.order || tier != c.tier || !reflect.DeepEqual(evidence, c.evidence) {
			t.Errorf("%s: got order=%d tier=%s evidence=%v", c.name, order, tier, evidence)
		}
		if Tiers[order-1] != tier {
			t.Errorf("%s: tier label does not match order", c.name)
		}
	}
	if order, _, _ := TierFor("confirmed", "bearish", "bearish", "bearish", &half); order != 1 {
		t.Fatalf("bearish agreement must mirror bullish agreement, got order %d", order)
	}
}

func TestRanksUseOnlyTheSetupTimeframe(t *testing.T) {
	row, series, history := decisionFixture()
	row.Pattern.Stage, row.Pattern.C.Time = "confirmed", 42
	// All higher timeframes agree (bullish) while the setup timeframe opposes.
	item := series[row.Interval]
	item.Analysis.Regime.Direction = "bearish"
	item.Analysis.Structure.Internal.Bias = "bearish"
	series[row.Interval] = item
	row.Decision = assess(row, series, history, decisionIntervals, DefaultAnalysisSettings())
	rank := rankFor(row)
	if rank.Order != 3 || rank.Tier != TierConfirmed || rank.Group != "BTCUSDT:1h:bullish:42" {
		t.Fatalf("higher-timeframe agreement leaked into the rank: %+v", rank)
	}
	if !reflect.DeepEqual(rank.Evidence, []string{"d_confirmed", "setup_trend_opposes", "setup_internal_structure_opposes", "stop_2_atr_or_more"}) {
		t.Fatalf("unexpected evidence: %v", rank.Evidence)
	}
	// A stale or warming setup timeframe contributes no direction evidence.
	item.Stale = true
	series[row.Interval] = item
	row.Stale = true
	row.Decision = assess(row, series, history, decisionIntervals, DefaultAnalysisSettings())
	if rank := rankFor(row); rank.Evidence[1] != "setup_trend_unavailable" || rank.Evidence[2] != "setup_internal_structure_unknown" {
		t.Fatalf("stale setup timeframe must be unavailable evidence: %+v", rank)
	}
}

func TestRankOrderingAndReversalPointGroups(t *testing.T) {
	row, series, history := decisionFixture()
	s := New(nil, []string{row.Symbol}, "fixture", 1, harmonic.DefaultConfig())
	build := func(id, kind, stage string, score float64, cTime int64, stop float64) Row {
		r := row
		r.Pattern.ID, r.Pattern.Kind, r.Pattern.Stage, r.Pattern.Score, r.Pattern.C.Time, r.Pattern.Stop = id, kind, stage, score, cTime, stop
		r.Decision = assess(r, series, history, decisionIntervals, DefaultAnalysisSettings())
		return r
	}
	// Fixture: bullish setup, bullish 1h SuperTrend and structure, ATR 2, entry 100.
	s.state.Rows = []Row{
		build("potential-high-score", "shark", "potential", 100, 7, 95), // stop 5 = 2.5 ATR -> tier 4
		build("confirmed-tight", "gartley", "confirmed", 91, 7, 97),     // stop 3 = 1.5 ATR -> tier 1
		build("confirmed-wide", "bat", "confirmed", 99, 7, 90),          // stop 10 = 5 ATR -> tier 3
		build("other-point", "cypher", "confirmed", 95, 8, 99),          // separate group -> tier 1
	}
	s.attachRanks()
	snapshot := s.Snapshot()
	got := make([]string, 0, len(snapshot.Rows))
	for _, r := range snapshot.Rows {
		got = append(got, r.Pattern.ID)
	}
	want := []string{"other-point", "confirmed-tight", "confirmed-wide", "potential-high-score"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rank order wrong: got %v want %v", got, want)
	}
	byID := map[string]Rank{}
	for _, r := range snapshot.Rows {
		byID[r.Pattern.ID] = r.Rank
	}
	if byID["other-point"].Order != 1 || byID["confirmed-tight"].Order != 1 || byID["confirmed-wide"].Order != 3 || byID["potential-high-score"].Order != 4 {
		t.Fatalf("unexpected tiers: %+v", byID)
	}
	if byID["confirmed-tight"].Group != "BTCUSDT:1h:bullish:7" || byID["confirmed-tight"].GroupRank != 1 || byID["confirmed-wide"].GroupRank != 2 || byID["potential-high-score"].GroupRank != 3 || byID["confirmed-tight"].GroupSize != 3 {
		t.Fatalf("group ranks do not follow result order: %+v", byID)
	}
	if byID["other-point"].GroupRank != 1 || byID["other-point"].GroupSize != 1 {
		t.Fatalf("separate reversal point must form its own group: %+v", byID["other-point"])
	}
	// Snapshot evidence must be an independent copy.
	snapshot.Rows[0].Rank.Evidence[0] = "MUTATED"
	if s.Snapshot().Rows[0].Rank.Evidence[0] != "d_confirmed" {
		t.Fatal("snapshot rank evidence shares memory with scanner state")
	}
}

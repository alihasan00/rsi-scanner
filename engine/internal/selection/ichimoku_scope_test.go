package selection

import (
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/strategies"
)

func TestIchimokuScopeFiltersBeforeCapsAndKeepsActiveFamilyOrder(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	snapshot, histories := strategyTestFixture(now)
	base, _ := strategyTestPlan(t, now, "bullish")
	opportunities := []strategies.Opportunity{}
	for i := 0; i < 24; i++ {
		for _, family := range []string{strategies.FVGPullback, strategies.TKCross} {
			op := base
			op.ID, op.Family = fmt.Sprintf("%s:%02d", family, i), family
			opportunities = append(opportunities, op)
		}
	}
	for i, family := range ichimokuFamilies {
		for _, state := range []string{"waiting_for_retest", "target_reached"} {
			op := base
			op.ID, op.Family, op.State = fmt.Sprintf("%s:%s:%d", family, state, i), family, state
			opportunities = append(opportunities, op)
		}
	}
	prepared := &Prepared{opportunities: map[string][]strategies.Opportunity{"TESTUSDT": opportunities}}
	mixed := BuildStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, 12, DefaultConfig(), prepared)
	if len(mixed.Items) != 12 {
		t.Fatalf("mixed control should hit its existing cap: %d", len(mixed.Items))
	}
	scoped := BuildIchimokuStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, DefaultConfig(), prepared)
	if scoped.Limit != 0 || len(scoped.Items) != 24+len(ichimokuFamilies) {
		t.Fatalf("scope dropped active opportunities beyond the mixed cap: %d", len(scoped.Items))
	}
	for i, candidate := range scoped.Items {
		if !oneOf(candidate.Opportunity.Family, ichimokuFamilies...) || candidate.Opportunity.State == "target_reached" {
			t.Fatalf("unrelated or terminal inventory entered the screener: %+v", candidate)
		}
		if i < 24 && !candidate.Eligible || i >= 24 && candidate.Eligible {
			t.Fatal("eligible and developing priority tiers changed")
		}
		if i >= 24 && candidate.Opportunity.Family != ichimokuFamilies[i-24] {
			t.Fatal("developing families lost the existing round-robin ordering")
		}
	}
	if len(scoped.Summary) != len(ichimokuFamilies) {
		t.Fatal("scoped summary retained unrelated families")
	}
	for _, coverage := range scoped.Coverage {
		if !oneOf(coverage.Family, ichimokuFamilies...) {
			t.Fatal("scoped coverage retained unrelated families")
		}
	}
	// The same discovery publication still gives the exact mixed result after
	// the scoped view; neither filter mutates prepared opportunities or plans.
	again := BuildStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, 12, DefaultConfig(), prepared)
	if !reflect.DeepEqual(mixed, again) {
		t.Fatal("scoped selection mutated the mixed watchlist")
	}
}

func TestIchimokuScopePreservesFreshnessCostsAndTerminalExclusion(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	snapshot, histories := strategyTestFixture(now)
	base, _ := strategyTestPlan(t, now, "bullish")
	base.Family = strategies.CloudEdgeToEdge
	prepared := &Prepared{opportunities: map[string][]strategies.Opportunity{"TESTUSDT": {base}}}
	cfg := DefaultConfig()
	cfg.MinNetRR = 3
	costBlocked := BuildIchimokuStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, cfg, prepared)
	if len(costBlocked.Items) != 1 || costBlocked.Items[0].Eligible || costBlocked.Items[0].Status != "cost_blocked" {
		t.Fatal("scoped active observation bypassed the existing net reward/risk gate")
	}
	stale := BuildIchimokuStrategies(snapshot, histories, []string{"TESTUSDT"}, now.Add(3*time.Minute), time.Minute, DefaultConfig(), prepared)
	if len(stale.Items) != 0 || len(stale.Unavailable) != 1 {
		t.Fatal("scope reused an eligible result after its evidence became stale")
	}
	bars := histories["TESTUSDT/15m"].Candles
	bars[len(bars)-1].High = *base.Target
	consumed := BuildIchimokuStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, DefaultConfig(), prepared)
	if len(consumed.Items) != 0 {
		t.Fatal("scope retained an opportunity resolved by the shared 15m target check")
	}
}

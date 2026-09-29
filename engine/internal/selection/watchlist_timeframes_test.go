package selection

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

func TestWatchlistFiltersHarmonicOriginsBeforeCapWithoutChangingEvidence(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	symbols := []string{}
	for _, prefix := range []string{"A15M", "B1H"} {
		for i := 0; i < 12; i++ {
			symbols = append(symbols, fmt.Sprintf("%s%02dUSDT", prefix, i))
		}
	}
	snapshot, histories := selectionFixture(now, "bullish", symbols...)
	for i := range snapshot.Rows[:12] {
		row := &snapshot.Rows[i]
		row.Interval = "15m"
		row.LastClosedAt = *selectionFrame(row, "15m").LastClosedAt
	}
	before, _ := json.Marshal(snapshot)
	control := Build(snapshot, histories, symbols, now, time.Minute)
	if len(control.Items) != 12 {
		t.Fatal("control fixture did not fill the source cap")
	}
	for _, item := range control.Items {
		if item.Setup.Interval != "15m" {
			t.Fatal("control fixture must let 15m setups fill the original cap")
		}
	}
	want := BuildAll(snapshot, histories, symbols, now, time.Minute).Items[12:]
	got := BuildWatchlist(snapshot, histories, symbols, now, time.Minute)
	if got.Limit != 12 || got.Eligible != 12 || !reflect.DeepEqual(got.Items, want) {
		t.Fatal("15m origins consumed source slots or changed retained harmonic evidence/plans")
	}
	if !reflect.DeepEqual(got.Breadth, control.Breadth) || len(got.Breadth) != 4 {
		t.Fatal("setup filtering changed four-frame market context")
	}
	after, _ := json.Marshal(snapshot)
	if string(before) != string(after) {
		t.Fatal("watchlist selection mutated the scanner publication")
	}
}

func TestWatchlistFiltersStrategyOriginsBeforeCapAndKeepsPreparedInventory(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	snapshot, histories := strategyTestFixture(now)
	base, _ := strategyTestPlan(t, now, "bullish")
	opportunities := []strategies.Opportunity{}
	for i := 0; i < 24; i++ {
		lower, higher := base, base
		lower.ID, lower.Family, lower.Interval = fmt.Sprintf("lower-%02d", i), strategies.SweepReversal, "15m"
		higher.ID = fmt.Sprintf("higher-%02d", i)
		opportunities = append(opportunities, lower, higher)
	}
	prepared := &Prepared{snapshot: snapshot, histories: histories, opportunities: map[string][]strategies.Opportunity{"TESTUSDT": opportunities}}
	control := prepared.Build([]string{"TESTUSDT"}, now, time.Minute, 12, DefaultConfig())
	lowerCount := 0
	for _, item := range control.Strategies.Items {
		if item.Opportunity.Interval == "15m" {
			lowerCount++
		}
	}
	if len(control.Strategies.Items) != 12 || lowerCount == 0 {
		t.Fatal("control fixture did not let 15m origins consume strategy slots")
	}
	filtered := watchlistPrepared(prepared)
	got := filtered.Build([]string{"TESTUSDT"}, now, time.Minute, 12, DefaultConfig())
	if len(got.Strategies.Items) != 12 || got.Strategies.Limit != 12 {
		t.Fatal("15m origins crowded higher-timeframe strategies out of the source cap")
	}
	inventory := prepared.Build([]string{"TESTUSDT"}, now, time.Minute, 0, DefaultConfig()).Strategies.Items
	want := []StrategyCandidate{}
	for _, item := range inventory {
		if item.Opportunity.Interval == "1h" && len(want) < 12 {
			want = append(want, item)
		}
	}
	if !reflect.DeepEqual(got.Strategies.Items, want) {
		t.Fatal("origin selection changed higher-timeframe strategy order, plans or evidence")
	}
	if !reflect.DeepEqual(filtered.snapshot.Series, snapshot.Series) || !reflect.DeepEqual(filtered.histories, histories) {
		t.Fatal("setup filtering changed the complete analysis inputs")
	}
	if again := prepared.Build([]string{"TESTUSDT"}, now, time.Minute, 12, DefaultConfig()); !reflect.DeepEqual(again, control) {
		t.Fatal("watchlist selection mutated the original prepared inventory")
	}
	// The retained hourly setup must still retire after a later 15m target touch.
	bars := histories["TESTUSDT/15m"].Candles
	bars[len(bars)-1].High = *base.Target
	if got := filtered.Build([]string{"TESTUSDT"}, now, time.Minute, 12, DefaultConfig()); len(got.Strategies.Items) != 0 {
		t.Fatal("removing 15m setup origins bypassed the 15m target-consumption check")
	}
}

func TestWatchlistStillRequiresAllFourFrames(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	for _, interval := range intervals {
		t.Run(interval, func(t *testing.T) {
			snapshot, histories := selectionFixture(now, "bullish", "TESTUSDT")
			baseline := BuildWatchlist(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(baseline.Items) != 1 {
				t.Fatal("fresh higher-timeframe fixture was not admitted")
			}
			snapshot.Errors = []scanner.ScanError{{Symbol: "TESTUSDT", Interval: interval, Error: "required feed failed"}}
			got := BuildWatchlist(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(got.Items) != 0 || len(got.Trends) != 0 || len(got.Strategies.Items) != 0 {
				t.Fatal("origin selection bypassed required context readiness")
			}
		})
	}
}

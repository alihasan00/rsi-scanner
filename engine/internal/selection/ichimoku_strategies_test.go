package selection

import (
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/strategies"
)

func TestLectureIchimokuFamiliesKeepSharedEntryAndCostGates(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	for _, family := range []string{strategies.TKCross, strategies.PKCross, strategies.CloudEdgeToEdge} {
		for _, direction := range []string{"bullish", "bearish"} {
			o, in := strategyTestPlan(t, now, direction)
			o.Family = family
			if got := assessStrategy(o, in, now, DefaultConfig()); !got.Eligible || got.Plan.Status != "ready_for_review" {
				t.Fatalf("%s/%s usable reference plan did not reach shared review: %+v", family, direction, got)
			}
			cfg := DefaultConfig()
			cfg.MinNetRR = 3
			if got := assessStrategy(o, in, now, cfg); got.Eligible || got.Status != "cost_blocked" {
				t.Fatalf("%s/%s bypassed net reward/risk: %+v", family, direction, got)
			}
			history := in.Histories["15m"]
			if direction == "bullish" {
				history.Candles[len(history.Candles)-1].High = *o.Target
			} else {
				history.Candles[len(history.Candles)-1].Low = *o.Target
			}
			in.Histories["15m"] = history
			if got := assessStrategy(o, in, now, DefaultConfig()); got.Eligible || got.Status != "target_reached" {
				t.Fatalf("%s/%s revived a target consumed in a later 15m candle: %+v", family, direction, got)
			}
		}
	}
}

func TestLectureIchimokuCoverageReportsCloudWarmup(t *testing.T) {
	for _, family := range []string{strategies.TKCross, strategies.PKCross, strategies.CloudEdgeToEdge} {
		frames, bars := strategyRequirements(family)
		want := 150
		if family == strategies.CloudEdgeToEdge {
			want = 151
		}
		if len(frames) != 2 || frames[0] != "1h" || frames[1] != "4h" || bars != want {
			t.Fatalf("%s does not report its actual displayed-cloud requirement: %v %d", family, frames, bars)
		}
	}
}

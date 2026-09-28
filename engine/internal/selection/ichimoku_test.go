package selection

import (
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/ichimoku"
)

func TestIchimokuObservationsCannotChangeSelectionOrPlans(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		snapshot, histories := trendFixture(now, direction, "TESTUSDT")
		bars := histories["TESTUSDT/15m"].Candles
		trendFixtureTouch(&bars[len(bars)-1], direction)
		want := BuildAll(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, DefaultConfig())
		if len(want.Trends) != 1 {
			t.Fatal("fixture must contain a selected continuation watch")
		}
		for _, position := range []string{"above", "inside", "below", "unavailable"} {
			for i := range snapshot.Series {
				s := &snapshot.Series[i]
				if s.Interval == "4h" || s.Interval == "1h" {
					s.Analysis.Ichimoku = &ichimoku.Snapshot{Status: "ready", Cloud: ichimoku.CloudContext{Position: position}}
				}
			}
			got := BuildAll(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, DefaultConfig())
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("%s observation changed %s selection or reference plan", position, direction)
			}
		}
	}
}

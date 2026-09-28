package harmonic

import "testing"

func TestSmallValidGeometryRetainsDWithoutObservingUnusableReferences(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		bars := fixture("gartley", direction)
		for i := range bars {
			bars[i].Open += 4000; bars[i].High += 4000; bars[i].Low += 4000; bars[i].Close += 4000
		}
		cfg := config("gartley")
		p := findExpected(t, Analyze(bars, cfg), "gartley", direction)
		if p.D == nil || p.Stage != "confirmed" || p.ReferenceStatus != "unusable" || p.EntryTouched || p.ConfirmedAt != bars[47].CloseTime {
			t.Fatalf("%s lost geometry or admitted invalid references: %+v", direction, p)
		}
		bars = append(bars, bar(48, bars[47].Close))
		later := findExpected(t, Analyze(bars, cfg), "gartley", direction)
		if later.EntryTouched || later.Status == "invalidated" || later.D == nil {
			t.Fatalf("unusable references produced a price outcome: %+v", later)
		}
	}
}

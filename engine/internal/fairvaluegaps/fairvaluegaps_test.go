package fairvaluegaps

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func candle(i int, open, high, low, close float64) market.Candle {
	return market.Candle{OpenTime: int64(i) * 1000, CloseTime: int64(i+1)*1000 - 1,
		Open: open, High: high, Low: low, Close: close, Volume: 1}
}

func formation() []market.Candle {
	return []market.Candle{
		candle(0, 98, 100, 95, 99),
		candle(1, 99, 115, 98, 112),
		candle(2, 112, 116, 110, 114),
	}
}

func mirror(candles []market.Candle) []market.Candle {
	result := append([]market.Candle{}, candles...)
	for i := range result {
		c := &result[i]
		c.Open, c.Close, c.High, c.Low = 250-c.Open, 250-c.Close, 250-c.Low, 250-c.High
	}
	return result
}

func requireGap(t *testing.T, s Snapshot, id string) Gap {
	t.Helper()
	if s.Status != "ready" {
		t.Fatalf("snapshot unavailable: %+v", s)
	}
	for _, gap := range s.Gaps {
		if gap.ID == id {
			return gap
		}
	}
	t.Fatalf("gap %q missing: %+v", id, s)
	return Gap{}
}

func requireAt(t *testing.T, value *int64, want int64) {
	t.Helper()
	if value == nil || *value != want {
		t.Fatalf("timestamp %v, want %d", value, want)
	}
}

func TestFormationNeedsThirdCloseAndDoesNotTouchItself(t *testing.T) {
	for _, bearish := range []bool{false, true} {
		name := "bullish"
		bars := formation()
		if bearish {
			name, bars = "bearish", mirror(bars)
		}
		t.Run(name, func(t *testing.T) {
			before := Analyze(bars[:2])
			if before.Status != "insufficient" || len(before.Gaps) != 0 {
				t.Fatalf("two-candle prefix already created a gap: %+v", before)
			}
			s := Analyze(bars)
			if s.Status != "ready" || len(s.Gaps) != 1 || s.GapTotal != 1 || s.GapOmitted != 0 {
				t.Fatalf("unexpected ready snapshot: %+v", s)
			}
			gap := s.Gaps[0]
			lower, upper := 100.0, 110.0
			if bearish {
				lower, upper = 140, 150
			}
			if gap.Direction != name || gap.Lower != lower || gap.Upper != upper || gap.Midpoint != (lower+upper)/2 || gap.State != "active" {
				t.Fatalf("incorrect strict wick geometry: %+v", gap)
			}
			if gap.FormedAt != 2999 || gap.StateAt != 2999 || gap.FirstOpenTime != 0 || gap.MiddleOpenTime != 1000 || gap.ThirdOpenTime != 2000 || gap.AgeBars != 0 {
				t.Fatalf("incorrect source/formation timestamps: %+v", gap)
			}
			if gap.FirstTouchedAt != nil || gap.MidpointAt != nil || gap.TraversedAt != nil || gap.PriceBeyondAt != nil || gap.ResolvedAt != nil || gap.BarsSinceResolution != nil || gap.ResolutionReason != "" {
				t.Fatalf("formation candle fabricated a later interaction: %+v", gap)
			}
		})
	}
}

func TestStrictGeometryDoesNotRequireMiddleColor(t *testing.T) {
	bars := formation()
	bars[1].Open, bars[1].Close = 114, 99
	if s := Analyze(bars); len(s.Gaps) != 1 || s.Gaps[0].Direction != "bullish" {
		t.Fatalf("middle candle color incorrectly filtered gap: %+v", s)
	}
	for _, low := range []float64{100, 99} {
		test := formation()
		test[2].Low = low
		for _, candidate := range [][]market.Candle{test, mirror(test)} {
			s := Analyze(candidate)
			if s.Status != "ready" || len(s.Gaps) != 0 {
				t.Fatalf("equal/overlapping first/third wicks created a gap: %+v", s)
			}
		}
	}
}

func TestMirroredLifecycleAndFrozenFirstRetirement(t *testing.T) {
	base := append(formation(),
		candle(3, 114, 115, 108, 111),
		candle(4, 111, 112, 105, 109),
		candle(5, 106, 107, 99, 101))
	for _, bars := range [][]market.Candle{base, mirror(base)} {
		formed := Analyze(bars[:3]).Gaps[0]
		touched := requireGap(t, Analyze(bars[:4]), formed.ID)
		if touched.State != "touched" || touched.ResolvedAt != nil || touched.StateAt != 3999 || touched.AgeBars != 1 {
			t.Fatalf("wrong first interaction: %+v", touched)
		}
		requireAt(t, touched.FirstTouchedAt, 3999)
		if touched.MidpointAt != nil || touched.TraversedAt != nil {
			t.Fatalf("shallow wick fabricated deeper overlap: %+v", touched)
		}
		midpoint := requireGap(t, Analyze(bars[:5]), formed.ID)
		if midpoint.State != "midpoint_mitigated" || midpoint.StateAt != 4999 || midpoint.ResolutionReason != "midpoint_overlap" {
			t.Fatalf("midpoint not retired: %+v", midpoint)
		}
		requireAt(t, midpoint.MidpointAt, 4999)
		requireAt(t, midpoint.ResolvedAt, 4999)
		if midpoint.BarsSinceResolution == nil || *midpoint.BarsSinceResolution != 0 {
			t.Fatalf("new resolution age: %+v", midpoint)
		}
		far := requireGap(t, Analyze(bars), formed.ID)
		if far.State != "fully_traversed" || far.StateAt != 5999 || far.ResolutionReason != "midpoint_overlap" || far.FormedAt != formed.FormedAt {
			t.Fatalf("far-boundary update changed source/first retirement: %+v", far)
		}
		requireAt(t, far.TraversedAt, 5999)
		requireAt(t, far.ResolvedAt, 4999)
		requireAt(t, far.FirstTouchedAt, 3999)
		requireAt(t, far.MidpointAt, 4999)
		if far.BarsSinceResolution == nil || *far.BarsSinceResolution != 1 {
			t.Fatalf("wrong frozen retirement age: %+v", far)
		}
	}
}

func TestBoundaryEqualityCountsAsLaterOverlap(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		low   float64
		state string
	}{
		{"near", 110, "touched"},
		{"middle", 105, "midpoint_mitigated"},
		{"far", 100, "fully_traversed"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			base := append(formation(), candle(3, 114, 115, scenario.low, 114))
			for _, bars := range [][]market.Candle{base, mirror(base)} {
				gap := requireGap(t, Analyze(bars), Analyze(bars[:3]).Gaps[0].ID)
				if gap.State != scenario.state {
					t.Fatalf("exact boundary overlap has wrong state: %+v", gap)
				}
				requireAt(t, gap.FirstTouchedAt, 3999)
			}
		})
	}
}

func TestPriceJumpNeverInventsBoundaryOverlap(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		after  market.Candle
		state  string
		touch  bool
		reason string
	}{
		{"skip_entire_zone", candle(3, 98, 99, 96, 97), "price_beyond", false, "far_boundary_passed_without_overlap"},
		{"skip_midpoint", candle(3, 102, 104, 101, 103), "midpoint_mitigated", true, "midpoint_passed_without_overlap"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			base := append(formation(), scenario.after)
			for _, bars := range [][]market.Candle{base, mirror(base)} {
				gap := requireGap(t, Analyze(bars), Analyze(bars[:3]).Gaps[0].ID)
				if gap.State != scenario.state || gap.ResolutionReason != scenario.reason {
					t.Fatalf("jump incorrectly classified: %+v", gap)
				}
				if (gap.FirstTouchedAt != nil) != scenario.touch || gap.MidpointAt != nil || gap.TraversedAt != nil {
					t.Fatalf("jump manufactured an unobserved boundary touch: %+v", gap)
				}
				requireAt(t, gap.PriceBeyondAt, 3999)
				requireAt(t, gap.ResolvedAt, 3999)
			}
		})
	}
}

func TestTerminalDoesNotResurrectAndRecentWindowIsFirstRetirement(t *testing.T) {
	base := append(formation(), candle(3, 98, 99, 96, 97))
	id := Analyze(base[:3]).Gaps[0].ID
	for i := 4; i < 8; i++ {
		base = append(base, candle(i, 105, 116, 99, 114))
		s := Analyze(base)
		if i < 7 {
			gap := requireGap(t, s, id)
			if gap.State != "price_beyond" || gap.FirstTouchedAt != nil || gap.MidpointAt != nil || gap.TraversedAt != nil || gap.StateAt != 3999 {
				t.Fatalf("later range resurrected a retired gap: %+v", gap)
			}
		} else {
			for _, gap := range s.Gaps {
				if gap.ID == id {
					t.Fatalf("four-bars-old retired gap retained: %+v", gap)
				}
			}
		}
	}
	// A midpoint retirement also must not reappear when the far edge is visited
	// long after that first retirement.
	base = append(formation(), candle(3, 110, 115, 105, 112))
	for i := 4; i < 10; i++ {
		base = append(base, candle(i, 112, 115, 109, 113))
	}
	base = append(base, candle(10, 106, 114, 99, 101))
	for _, gap := range Analyze(base).Gaps {
		if gap.ID == id {
			t.Fatalf("late far-edge visit made old reference recent: %+v", gap)
		}
	}
}

func TestBoundPreservesNearestActiveReferencesAndCounts(t *testing.T) {
	var bars []market.Candle
	for i := 0; i < 30; i++ {
		price := 100 + float64(i)*10
		bars = append(bars, candle(i, price, price+3, price-3, price))
	}
	s := Analyze(bars)
	if s.Status != "ready" || s.GapTotal != 28 || len(s.Gaps) != MaxGaps || s.GapOmitted != 20 {
		t.Fatalf("bounded ledger lost original counts: %+v", s)
	}
	for i, gap := range s.Gaps {
		if gap.ThirdOpenTime != int64(29-i)*1000 || gap.State != "active" {
			t.Fatalf("nearest active order wrong at %d: %+v", i, gap)
		}
	}
	if !reflect.DeepEqual(s, Analyze(bars)) {
		t.Fatal("repeated analysis is not deterministic")
	}
	latest := s.Gaps[0]
	if latest.FormedAt != bars[len(bars)-1].CloseTime {
		t.Fatal("newest active reference omitted despite being nearest")
	}
}

func TestActivePriorityOverCloserRecentRetirement(t *testing.T) {
	bars := append(formation(),
		candle(3, 131, 135, 130, 134),
		candle(4, 134, 137, 131, 135),
		candle(5, 132, 133, 120, 130))
	id := Analyze(bars[:3]).Gaps[0].ID
	s := Analyze(bars)
	if len(s.Gaps) < 3 || s.Gaps[0].ID != id || s.Gaps[0].ResolvedAt != nil {
		t.Fatalf("nearer consumed gaps displaced active reference: %+v", s)
	}
	for _, gap := range s.Gaps[1:] {
		if gap.ResolvedAt == nil {
			t.Fatalf("expected recent midpoint retirements: %+v", gap)
		}
	}
}

func TestFiniteExtremePricesKeepRepresentableGeometry(t *testing.T) {
	for _, scale := range []float64{1e-300, 1e306} {
		bars := formation()
		for i := range bars {
			bars[i].Open *= scale
			bars[i].High *= scale
			bars[i].Low *= scale
			bars[i].Close *= scale
		}
		s := Analyze(bars)
		if s.Status != "ready" || len(s.Gaps) != 1 {
			t.Fatalf("valid extreme price rejected at scale %g: %+v", scale, s)
		}
		g := s.Gaps[0]
		if !(g.Lower < g.Midpoint && g.Midpoint < g.Upper) {
			t.Fatalf("midpoint over/underflow at scale %g: %+v", scale, g)
		}
		if _, err := json.Marshal(s); err != nil {
			t.Fatalf("nonfinite JSON geometry at scale %g: %v", scale, err)
		}
	}
}

func TestHistoricalPrefixesAndInputOwnership(t *testing.T) {
	bars := append(formation(),
		candle(3, 114, 115, 108, 111),
		candle(4, 111, 112, 105, 109),
		candle(5, 106, 107, 99, 101))
	before, _ := json.Marshal(bars)
	formed := Analyze(bars[:3])
	for n := 3; n <= len(bars); n++ {
		s := Analyze(bars[:n])
		for _, gap := range s.Gaps {
			if gap.FormedAt > bars[n-1].CloseTime || gap.StateAt > bars[n-1].CloseTime || gap.FormedAt > gap.StateAt {
				t.Fatalf("future observation leaked into prefix %d: %+v", n, gap)
			}
			for _, event := range []*int64{gap.FirstTouchedAt, gap.MidpointAt, gap.TraversedAt, gap.PriceBeyondAt, gap.ResolvedAt} {
				if event != nil && (*event <= gap.FormedAt || *event > bars[n-1].CloseTime) {
					t.Fatalf("noncausal interaction in prefix %d: %+v", n, gap)
				}
			}
		}
	}
	after, _ := json.Marshal(bars)
	if string(before) != string(after) || !reflect.DeepEqual(formed, Analyze(bars[:3])) {
		t.Fatal("analysis mutated input or a previously published prefix")
	}
}

func TestReadinessAndInvalidHistory(t *testing.T) {
	for n := 0; n < 3; n++ {
		s := Analyze(formation()[:n])
		if s.Status != "insufficient" || s.ClosedBars != n || s.WarmupBars != 3 || s.Gaps == nil || s.Warnings == nil || len(s.Gaps) != 0 {
			t.Fatalf("incorrect warmup at %d: %+v", n, s)
		}
		if (s.AsOf != nil) != (n > 0) {
			t.Fatalf("incorrect asOf at %d: %+v", n, s)
		}
	}
	cases := map[string]func([]market.Candle){
		"gap":       func(b []market.Candle) { b[2].OpenTime += 1000; b[2].CloseTime += 1000 },
		"duplicate": func(b []market.Candle) { b[2].OpenTime = b[1].OpenTime; b[2].CloseTime = b[1].CloseTime },
		"duration":  func(b []market.Candle) { b[2].CloseTime++ },
		"nan":       func(b []market.Candle) { b[1].Close = math.NaN() },
		"infinity":  func(b []market.Candle) { b[0].High = math.Inf(1) },
		"volume":    func(b []market.Candle) { b[0].Volume = -1 },
		"ohlc":      func(b []market.Candle) { b[1].High = b[1].Low - 1 },
		"reverse":   func(b []market.Candle) { b[0], b[2] = b[2], b[0] },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bars := formation()
			mutate(bars)
			s := Analyze(bars)
			if s.Status != "invalid" || s.AsOf != nil || len(s.Gaps) != 0 || s.GapTotal != 0 || s.GapOmitted != 0 || len(s.Warnings) == 0 {
				t.Fatalf("invalid history published usable evidence: %+v", s)
			}
		})
	}
}

func TestCloneOwnsEveryMutableField(t *testing.T) {
	s := Analyze(formation())
	s.Warnings = []string{"example"}
	g := &s.Gaps[0]
	g.FirstTouchedAt, g.MidpointAt, g.TraversedAt, g.PriceBeyondAt, g.ResolvedAt = pointer(int64(1)), pointer(int64(2)), pointer(int64(3)), pointer(int64(4)), pointer(int64(5))
	g.BarsSinceResolution = pointer(1)
	before, _ := json.Marshal(s)
	clone := CloneSnapshot(s)
	*clone.AsOf = 0
	clone.Warnings[0] = "changed"
	clone.Gaps[0].Lower = 1
	clone.Gaps[0].ID = "changed"
	c := &clone.Gaps[0]
	for _, p := range []*int64{c.FirstTouchedAt, c.MidpointAt, c.TraversedAt, c.PriceBeyondAt, c.ResolvedAt} {
		*p = 0
	}
	*c.BarsSinceResolution = 0
	after, _ := json.Marshal(s)
	if string(before) != string(after) {
		t.Fatal("clone shares mutable snapshot state")
	}
	if got := CloneSnapshot(Snapshot{}); got.Gaps == nil || got.Warnings == nil {
		t.Fatal("empty clone should keep JSON arrays, not null")
	}
}

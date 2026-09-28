package technical

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func candles(closes ...float64) []market.Candle {
	out := make([]market.Candle, len(closes))
	const duration = int64(15 * 60 * 1000)
	for i, close := range closes {
		open := int64(i) * duration
		out[i] = market.Candle{OpenTime: open, CloseTime: open + duration - 1, Open: close, High: close, Low: close, Close: close, Volume: 1}
	}
	return out
}

func flat(n int, close float64) []market.Candle {
	closes := make([]float64, n)
	for i := range closes {
		closes[i] = close
	}
	return candles(closes...)
}

func ramp(n int, start, step float64) []market.Candle {
	closes := make([]float64, n)
	for i := range closes {
		closes[i] = start + float64(i)*step
	}
	return candles(closes...)
}

func closeTo(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-10*math.Max(1, math.Abs(want)) {
		t.Fatalf("got %v, want %.15g", got, want)
	}
}

func TestHandComputedMovingAveragesAndPopulationBands(t *testing.T) {
	b := ramp(20, 1, 1)
	s := Analyze(b)
	if s.Status != "insufficient" || s.SMA.Status != "ready" || s.Bollinger.Status != "ready" || s.SMA.Direction != "bullish" || *s.AsOf != b[19].CloseTime || s.Bars != 20 {
		t.Fatalf("unexpected readiness: %+v", s)
	}
	closeTo(t, s.SMA.Fast, 15.5)
	closeTo(t, s.SMA.Slow, 10.5)
	closeTo(t, s.SMA.SeparationPercent, 5.0/10.5*100)
	// The population variance of integers 1 through 20 is (20^2-1)/12.
	deviation := math.Sqrt(33.25)
	closeTo(t, s.Bollinger.Middle, 10.5)
	closeTo(t, s.Bollinger.Upper, 10.5+2*deviation)
	closeTo(t, s.Bollinger.Lower, 10.5-2*deviation)
	closeTo(t, s.Bollinger.BandWidthPercent, 4*deviation/10.5*100)
	closeTo(t, s.Bollinger.PercentB, (20-(10.5-2*deviation))/(4*deviation))
	if s.SMA.LastCrossAt != nil || s.SMA.BarsSinceCross != nil || s.SMA.LastCrossDirection != "unavailable" {
		t.Fatal("initial seeded direction became an invented crossover")
	}
	if s.Bollinger.WidthChange3Bars != nil || s.Bollinger.WidthPercentile != nil {
		t.Fatal("a history-dependent field escaped its own warmup")
	}
}

func TestFieldsHaveIndependentWarmups(t *testing.T) {
	for _, n := range []int{0, 9, 10, 19, 20, 22, 23, 118, 119} {
		s := Analyze(flat(n, 100))
		if s.Bars != n || (s.AsOf != nil) != (n > 0) || (s.SMA.Fast != nil) != (n >= 10) || (s.SMA.Slow != nil) != (n >= 20) || (s.Bollinger.Middle != nil) != (n >= 20) || (s.Bollinger.WidthChange3Bars != nil) != (n >= 23) || (s.Bollinger.WidthPercentile != nil) != (n >= 119) {
			t.Fatalf("wrong field warmup at %d bars: %+v", n, s)
		}
		if (s.Status == "ready") != (n >= 119) || (s.SMA.Status == "ready") != (n >= 20) || (s.Bollinger.Status == "ready") != (n >= 20) || (s.Bollinger.WidthChangeStatus == "ready") != (n >= 23) || (s.Bollinger.WidthPercentileStatus == "ready") != (n >= 119) {
			t.Fatalf("wrong availability status at %d bars: %+v", n, s)
		}
		if s.SMA.WarmupBars != 20 || s.Bollinger.WarmupBars != 20 || s.Bollinger.WidthChangeWarmupBars != 23 || s.Bollinger.PercentileWarmupBars != 119 || s.Bollinger.PercentileObservations != min(100, max(0, n-19)) {
			t.Fatalf("incorrect warmup metadata at %d bars: %+v", n, s)
		}
	}
}

func TestCrossRequiresPriorSeededStateAndRecordsConfirmationAge(t *testing.T) {
	b := flat(24, 100)
	b[20].Open, b[20].High, b[20].Low, b[20].Close = 110, 110, 110, 110
	b[21].Open, b[21].High, b[21].Low, b[21].Close = 90, 90, 90, 90
	b[22].Open, b[22].High, b[22].Low, b[22].Close = 99, 99, 99, 99
	for _, test := range []struct {
		length, crossedAt, age int
		direction, cross       string
	}{
		{21, 20, 0, "bullish", "bullish"},
		{22, 20, 1, "neutral", "bullish"},
		{23, 22, 0, "bearish", "bearish"},
		{24, 22, 1, "bearish", "bearish"},
	} {
		s := Analyze(b[:test.length]).SMA
		if s.Direction != test.direction || s.LastCrossDirection != test.cross || s.LastCrossAt == nil || *s.LastCrossAt != b[test.crossedAt].CloseTime || s.BarsSinceCross == nil || *s.BarsSinceCross != test.age {
			t.Fatalf("wrong crossover at prefix %d: %+v", test.length, s)
		}
	}
	if seeded := Analyze(ramp(20, 100, -1)).SMA; seeded.Direction != "bearish" || seeded.LastCrossAt != nil {
		t.Fatalf("initial bearish state fabricated a crossover: %+v", seeded)
	}
}

func TestWidthChangeUsesThreeCompletedBarsAndPercentagePoints(t *testing.T) {
	s := Analyze(ramp(23, 1, 1)).Bollinger
	deviation := math.Sqrt(33.25)
	closeTo(t, s.WidthChange3Bars, 4*deviation/13.5*100-4*deviation/10.5*100)
	if s.WidthChangeStatus != "ready" || s.WidthChangeLookbackBars != 3 {
		t.Fatalf("wrong width change metadata: %+v", s)
	}
}

func TestPercentileUsesCurrentObservationMidrankTiesAndTrailingWindow(t *testing.T) {
	// Increasing positive closes have the same absolute standard deviation but
	// increasing means, so the latest relative width is the sole minimum.
	closeTo(t, Analyze(ramp(119, 1, 1)).Bollinger.WidthPercentile, 0.5)
	closeTo(t, Analyze(ramp(119, 200, -1)).Bollinger.WidthPercentile, 99.5)
	closes := make([]float64, 119)
	for i := range closes {
		closes[i] = 100
		if i%2 == 0 {
			closes[i] = 200
		}
	}
	// Every full 20-bar window contains the same ten values of each price.
	closeTo(t, Analyze(candles(closes...)).Bollinger.WidthPercentile, 50)
	b := flat(139, 100)
	for i := 0; i < 20; i++ {
		v := float64(i+1) * 1000
		b[i].Open, b[i].High, b[i].Low, b[i].Close = v, v, v, v
	}
	s := Analyze(b).Bollinger
	closeTo(t, s.WidthPercentile, 50)
	if s.PercentileObservations != 100 {
		t.Fatal("old observations leaked into the trailing-100 reference")
	}
}

func TestFlatPricesAndZeroVolumeHaveFiniteExplicitResults(t *testing.T) {
	b := flat(119, 100)
	for i := range b {
		b[i].Volume = 0
	}
	s := Analyze(b)
	if s.Status != "ready" || s.SMA.Direction != "neutral" || s.SMA.LastCrossAt != nil || s.Bollinger.PercentBStatus != "zero_width" || s.Bollinger.PercentB != nil {
		t.Fatalf("flat or zero-volume history became unusable/fictitious evidence: %+v", s)
	}
	closeTo(t, s.Bollinger.BandWidthPercent, 0)
	closeTo(t, s.Bollinger.WidthChange3Bars, 0)
	closeTo(t, s.Bollinger.WidthPercentile, 50)
	if _, err := json.Marshal(s); err != nil {
		t.Fatalf("nonfinite number escaped snapshot: %v", err)
	}
	// Rounding can collapse an extremely small price interval to one value.
	// A normalized intermediate must not manufacture percentB for that interval.
	small := flat(119, math.SmallestNonzeroFloat64)
	last := &small[len(small)-1]
	last.Open, last.High, last.Low, last.Close = 2*math.SmallestNonzeroFloat64, 2*math.SmallestNonzeroFloat64, 2*math.SmallestNonzeroFloat64, 2*math.SmallestNonzeroFloat64
	degenerate := Analyze(small).Bollinger
	if degenerate.Upper == nil || *degenerate.Upper != *degenerate.Lower || degenerate.PercentB != nil || degenerate.PercentBStatus != "zero_width" {
		t.Fatalf("rounded zero-width bands acquired percentB: %+v", degenerate)
	}
	closeTo(t, degenerate.BandWidthPercent, 0)
}

func TestPriceScalingPreservesNormalizedContext(t *testing.T) {
	b := ramp(150, 3, 0.25)
	original := Analyze(b)
	for _, scale := range []float64{1.0 / 1024, 1024} {
		scaled := append([]market.Candle(nil), b...)
		for i := range scaled {
			scaled[i].Open *= scale
			scaled[i].High *= scale
			scaled[i].Low *= scale
			scaled[i].Close *= scale
		}
		s := Analyze(scaled)
		closeTo(t, s.SMA.Fast, *original.SMA.Fast*scale)
		closeTo(t, s.SMA.Slow, *original.SMA.Slow*scale)
		closeTo(t, s.SMA.SeparationPercent, *original.SMA.SeparationPercent)
		closeTo(t, s.Bollinger.Middle, *original.Bollinger.Middle*scale)
		closeTo(t, s.Bollinger.Upper, *original.Bollinger.Upper*scale)
		closeTo(t, s.Bollinger.Lower, *original.Bollinger.Lower*scale)
		closeTo(t, s.Bollinger.BandWidthPercent, *original.Bollinger.BandWidthPercent)
		closeTo(t, s.Bollinger.PercentB, *original.Bollinger.PercentB)
		closeTo(t, s.Bollinger.WidthPercentile, *original.Bollinger.WidthPercentile)
		closeTo(t, s.Bollinger.WidthChange3Bars, *original.Bollinger.WidthChange3Bars)
	}
}

func TestGapsMalformedBarsAndUnrepresentableBandsRejectEntireHistory(t *testing.T) {
	for name, mutate := range map[string]func([]market.Candle){
		"gap":              func(b []market.Candle) { b[10].OpenTime++; b[10].CloseTime++ },
		"overlap":          func(b []market.Candle) { b[10].OpenTime--; b[10].CloseTime-- },
		"changed interval": func(b []market.Candle) { b[10].CloseTime-- },
		"negative volume":  func(b []market.Candle) { b[10].Volume = -1 },
		"infinite volume":  func(b []market.Candle) { b[10].Volume = math.Inf(1) },
		"nan close":        func(b []market.Candle) { b[10].Close = math.NaN() },
		"zero price":       func(b []market.Candle) { b[10].Low = 0 },
		"unordered OHLC":   func(b []market.Candle) { b[10].Low = 101 },
		"overflow bands": func(b []market.Candle) {
			for i := range b {
				v := math.MaxFloat64 / 4
				if i%2 == 0 {
					v = math.MaxFloat64
				}
				b[i].Open, b[i].High, b[i].Low, b[i].Close = v, v, v, v
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			b := flat(119, 100)
			mutate(b)
			s := Analyze(b)
			if s.Status != "invalid" || s.AsOf != nil || s.SMA.Fast != nil || s.SMA.Slow != nil || s.Bollinger.Middle != nil || s.Bollinger.WidthPercentile != nil || s.SMA.Status != "invalid" || s.Bollinger.PercentBStatus != "invalid" {
				t.Fatalf("invalid history leaked usable numbers: %+v", s)
			}
		})
	}
	// Squared prices would overflow, but the normalized variance remains valid.
	if s := Analyze(flat(119, math.MaxFloat64/2)); s.Status != "ready" || s.Bollinger.PercentBStatus != "zero_width" {
		t.Fatalf("representable constant large prices overflowed: %+v", s)
	}
}

func TestCompletedPrefixesInputsAndPublishedSnapshotsRemainIndependent(t *testing.T) {
	b := ramp(150, 100, 0.5)
	for i := 90; i < 110; i++ {
		b[i].Open, b[i].High, b[i].Low, b[i].Close = 80, 80, 80, 80
	}
	before := append([]market.Candle(nil), b...)
	saved := make([]Snapshot, len(b)+1)
	for i := range saved {
		saved[i] = Analyze(b[:i])
	}
	if !reflect.DeepEqual(b, before) {
		t.Fatal("analysis mutated caller candles")
	}
	for i := 130; i < len(b); i++ {
		b[i].Open, b[i].High, b[i].Low, b[i].Close = 1e12, 1e12, 1e12, 1e12
	}
	_ = Analyze(b)
	for i := 0; i <= 130; i++ {
		if !reflect.DeepEqual(saved[i], Analyze(b[:i])) {
			t.Fatalf("future candles changed completed prefix %d", i)
		}
	}
	s := saved[130]
	if s.SMA.LastCrossAt == nil || s.Bollinger.PercentB == nil || s.Bollinger.WidthPercentile == nil {
		t.Fatal("clone fixture lacks meaningful nullable fields")
	}
	clone := CloneSnapshot(s)
	assertDistinctPointers(t, reflect.ValueOf(s), reflect.ValueOf(clone))
	if !reflect.DeepEqual(clone, s) {
		t.Fatal("clone changed calculated values")
	}
}

func assertDistinctPointers(t *testing.T, original, clone reflect.Value) {
	t.Helper()
	if original.Kind() == reflect.Pointer {
		if !original.IsNil() && original.Pointer() == clone.Pointer() {
			t.Fatal("published clone retained an original nullable value")
		}
		return
	}
	if original.Kind() == reflect.Struct {
		for i := 0; i < original.NumField(); i++ {
			assertDistinctPointers(t, original.Field(i), clone.Field(i))
		}
	}
}

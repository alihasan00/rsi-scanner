package momentum

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func candlesFromCloses(closes []float64) []market.Candle {
	out := make([]market.Candle, len(closes))
	for i, close := range closes {
		open := close
		if i > 0 {
			open = closes[i-1]
		}
		out[i] = market.Candle{OpenTime: int64(i) * 900000, CloseTime: int64(i+1)*900000 - 1,
			Open: open, High: math.Max(open, close) + 1, Low: math.Min(open, close) - 1, Close: close, Volume: 10}
	}
	return out
}

func near(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-10 {
		t.Fatalf("got %v, want %.14f", got, want)
	}
}

func TestWilderArithmeticSeedRecurrenceAndCrosses(t *testing.T) {
	// Fourteen alternating +1/-1 changes seed gain=loss=0.5 exactly.
	closes := make([]float64, 18)
	for i := 0; i < 15; i++ {
		closes[i] = 100 + float64(i%2)
	}
	closes[15], closes[16], closes[17] = 101, 100, 102
	bars := candlesFromCloses(closes)
	initial := Analyze(bars[:15])
	near(t, initial.RSI, 50)
	if initial.Last50Cross != nil || initial.RSIState != "at50" {
		t.Fatal("seed was presented as a historical cross")
	}
	one := Analyze(bars[:16])
	near(t, one.RSI, 100*7.5/14)
	if one.Last50Cross == nil || one.Last50Cross.Direction != "bullish" || one.Last50Cross.At != bars[15].CloseTime {
		t.Fatalf("wrong first cross: %+v", one.Last50Cross)
	}
	two := Analyze(bars[:17])
	near(t, two.RSI, 100*97.5/196)
	if two.Last50Cross == nil || two.Last50Cross.Direction != "bearish" || two.Last50Cross.At != bars[16].CloseTime {
		t.Fatalf("wrong reverse cross: %+v", two.Last50Cross)
	}
	three := Analyze(bars)
	near(t, three.RSI, 100*1659.5/2940)
	near(t, three.RSIChange3, 100*1659.5/2940-50)
	if three.Last50Cross == nil || three.Last50Cross.At != bars[17].CloseTime || three.Last50Cross.Direction != "bullish" {
		t.Fatalf("latest crossing was not retained: %+v", three.Last50Cross)
	}
}

func TestIndependentWarmupsAndFlatMarket(t *testing.T) {
	closes := make([]float64, 30)
	for i := range closes {
		closes[i] = 100
	}
	bars := candlesFromCloses(closes)
	for _, tc := range []struct {
		n                            int
		rsi, sma, change, divergence string
	}{
		{0, "insufficient", "insufficient", "insufficient", "insufficient"},
		{14, "insufficient", "insufficient", "insufficient", "insufficient"},
		{15, "ready", "insufficient", "insufficient", "insufficient"},
		{17, "ready", "insufficient", "insufficient", "insufficient"},
		{18, "ready", "insufficient", "ready", "insufficient"},
		{24, "ready", "insufficient", "ready", "insufficient"},
		{25, "ready", "insufficient", "ready", "ready"},
		{27, "ready", "insufficient", "ready", "ready"},
		{28, "ready", "ready", "ready", "ready"},
	} {
		s := Analyze(bars[:tc.n])
		if s.Status != tc.rsi || s.SMAStatus != tc.sma || s.ChangeStatus != tc.change || s.DivergenceStatus != tc.divergence || s.WarmupBars != 15 || s.ClosedBars != tc.n {
			t.Fatalf("warmup%d: %+v", tc.n, s)
		}
		if (s.RSI != nil) != (tc.rsi == "ready") || (s.RSISMA14 != nil) != (tc.sma == "ready") || (s.RSIChange3 != nil) != (tc.change == "ready") {
			t.Fatalf("unavailable indicator represented numerically: %+v", s)
		}
	}
	s := Analyze(bars)
	near(t, s.RSI, 50)
	near(t, s.RSISMA14, 50)
	near(t, s.RSIChange3, 0)
	if s.Last50Cross != nil || len(s.Divergences) != 0 || s.DivergenceTotal != 0 || s.AsOf == nil || *s.AsOf != bars[29].CloseTime {
		t.Fatalf("flat market manufactured events: %+v", s)
	}
}

func TestWilderOneSidedAndLargePricesRemainFinite(t *testing.T) {
	for _, direction := range []float64{-1, 1} {
		closes := make([]float64, 30)
		for i := range closes {
			closes[i] = 100 + direction*float64(i)
		}
		s := Analyze(candlesFromCloses(closes))
		want := 0.0
		if direction > 0 {
			want = 100
		}
		near(t, s.RSI, want)
		near(t, s.RSISMA14, want)
	}
	closes := make([]float64, 100)
	for i := range closes {
		closes[i] = 1e307
		if i%2 == 0 {
			closes[i] = 1e308
		}
	}
	s := Analyze(candlesFromCloses(closes))
	if s.Status != "ready" || s.RSI == nil || *s.RSI < 0 || *s.RSI > 100 {
		t.Fatalf("large prices overflowed: %+v", s)
	}
	if _, err := json.Marshal(s); err != nil {
		t.Fatalf("nonfinite evidence: %v", err)
	}
}

func TestInvalidHistoryCannotBridgeMomentum(t *testing.T) {
	for name, mutate := range map[string]func([]market.Candle){
		"gap":                func(b []market.Candle) { b[20].OpenTime++; b[20].CloseTime++ },
		"duration":           func(b []market.Candle) { b[20].CloseTime-- },
		"duplicate":          func(b []market.Candle) { b[20] = b[19] },
		"invalid close":      func(b []market.Candle) { b[20].Close = math.NaN() },
		"infinite price":     func(b []market.Candle) { b[20].High = math.Inf(1) },
		"negative volume":    func(b []market.Candle) { b[20].Volume = -1 },
		"invalid envelope":   func(b []market.Candle) { b[20].High = b[20].Low },
		"negative timestamp": func(b []market.Candle) { b[0].OpenTime = -1 },
	} {
		t.Run(name, func(t *testing.T) {
			closes := make([]float64, 60)
			for i := range closes {
				closes[i] = 100 + float64(i%3)
			}
			bars := candlesFromCloses(closes)
			mutate(bars)
			s := Analyze(bars)
			if s.Status != "invalid" || s.SMAStatus != "invalid" || s.ChangeStatus != "invalid" || s.DivergenceStatus != "invalid" || s.RSI != nil || s.RSISMA14 != nil || s.RSIChange3 != nil || s.AsOf != nil || s.Last50Cross != nil || len(s.Divergences) != 0 || len(s.Warnings) == 0 {
				t.Fatalf("invalid history produced evidence: %+v", s)
			}
		})
	}
}

func TestAnalyzeDoesNotMutateInputAndCloneOwnsPointers(t *testing.T) {
	closes := make([]float64, 40)
	for i := range closes {
		closes[i] = 100 + float64(i%3)
	}
	bars := candlesFromCloses(closes)
	before := append([]market.Candle{}, bars...)
	s := Analyze(bars)
	if !reflect.DeepEqual(before, bars) {
		t.Fatal("Analyze mutated input")
	}
	s.Divergences = []Divergence{{ID: "test", ConfirmedAt: pointer(int64(10)), ResolvedAt: pointer(int64(20)), Confirmation: &Confirmation{Close: 100}, BarsSinceResolution: pointer(2)}}
	s.Warnings = []string{"original"}
	clone := CloneSnapshot(s)
	*clone.AsOf = 1
	*clone.RSI = 1
	*clone.RSISMA14 = 1
	*clone.RSIChange3 = 1
	clone.Last50Cross.Direction = "changed"
	clone.Warnings[0] = "changed"
	clone.Divergences[0].ID = "changed"
	*clone.Divergences[0].ConfirmedAt = 30
	*clone.Divergences[0].ResolvedAt = 40
	clone.Divergences[0].Confirmation.Close = 200
	*clone.Divergences[0].BarsSinceResolution = 3
	if *s.AsOf == 1 || *s.RSI == 1 || *s.RSISMA14 == 1 || *s.RSIChange3 == 1 || s.Last50Cross.Direction == "changed" || s.Warnings[0] != "original" || s.Divergences[0].ID != "test" || *s.Divergences[0].ConfirmedAt != 10 || *s.Divergences[0].ResolvedAt != 20 || s.Divergences[0].Confirmation.Close != 100 || *s.Divergences[0].BarsSinceResolution != 2 {
		t.Fatal("clone shares published state")
	}
	if _, err := json.Marshal(CloneSnapshot(Analyze(nil))); err != nil {
		t.Fatal(err)
	}
}

func TestSMAUsesLatestFourteenRSISamplesIncludingCurrent(t *testing.T) {
	// Fifteen initial closes are constant. The next fourteen rise monotonically,
	// making their RSIs exactly 100; the original flat seed of 50 must roll out.
	closes := make([]float64, 29)
	for i := range closes {
		closes[i] = 100 + float64(max(0, i-14))
	}
	before := Analyze(candlesFromCloses(closes[:28]))
	near(t, before.RSISMA14, (50+13*100.0)/14)
	after := Analyze(candlesFromCloses(closes))
	near(t, after.RSISMA14, 100)
	near(t, after.RSIChange3, 0)
}

func TestAnalyzeConnectsWilderRSIToMirroredDivergenceLifecycle(t *testing.T) {
	for _, hidden := range []bool{false, true} {
		for _, bearish := range []bool{false, true} {
			fixture := divergenceFixture(hidden, false)
			// Seed an exact 40 RSI (or 45 for hidden) with seven alternating
			// gains/losses, then invert the independent Wilder recurrence to
			// construct real closing prices for the desired oscillator samples.
			initialRSI := fixture[0].rsi
			up, down := initialRSI/10, (100-initialRSI)/10
			closes := []float64{10000}
			for i := 1; i <= 14; i++ {
				change := up
				if i%2 == 0 {
					change = -down
				}
				closes = append(closes, closes[len(closes)-1]+change)
			}
			gain, loss := up/2, down/2
			for _, sample := range fixture[1:13] {
				ratio := sample.rsi / (100 - sample.rsi)
				change := 13 * (ratio*loss - gain)
				if ratio < gain/loss {
					change = -13 * (gain/ratio - loss)
				}
				closes = append(closes, closes[len(closes)-1]+change)
				gain = (13*gain + math.Max(0, change)) / 14
				loss = (13*loss + math.Max(0, -change)) / 14
			}
			bars := candlesFromCloses(closes)
			first, second, confirmation := &bars[19], &bars[25], &bars[26]
			first.Open = first.Close
			second.Open = math.Min(math.Min(first.Close, second.Close), confirmation.Close) - 10
			if hidden {
				second.Open = second.Close
				first.Open = math.Min(first.Close, second.Close) - 10
			}
			confirmation.Open = confirmation.Close - 1
			for i := range bars {
				bar := &bars[i]
				bar.High, bar.Low = math.Max(bar.Open, bar.Close)+1, math.Min(bar.Open, bar.Close)-1
				if bearish {
					bar.Open, bar.Close, bar.High, bar.Low = 50000-bar.Open, 50000-bar.Close, 50000-bar.Low, 50000-bar.High
				}
			}
			s := Analyze(bars)
			found := false
			for _, d := range s.Divergences {
				if d.Start.OpenTime == bars[19].OpenTime && d.End.OpenTime == bars[25].OpenTime {
					found = true
					wantKind := "regular-bullish"
					if hidden {
						wantKind = "hidden-bullish"
					}
					if bearish {
						wantKind = "regular-bearish"
						if hidden {
							wantKind = "hidden-bearish"
						}
					}
					if d.Kind != wantKind || d.State != "confirmed" || d.ConfirmedAt == nil || *d.ConfirmedAt != bars[26].CloseTime {
						t.Fatalf("wrong public lifecycle evidence: %+v", d)
					}
				}
			}
			if !found {
				t.Fatalf("Wilder/divergence integration missing hidden=%v bearish=%v: %+v", hidden, bearish, s)
			}
		}
	}
}

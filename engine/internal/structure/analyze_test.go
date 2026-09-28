// Tests for the CC BY-NC-SA 4.0 adaptation of LuxAlgo market structure.
package structure

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func bars(prices ...float64) []market.Candle {
	candles := make([]market.Candle, len(prices))
	for i, price := range prices {
		openTime := int64(1700000000000) + int64(i)*60000
		candles[i] = market.Candle{OpenTime: openTime, CloseTime: openTime + 59999,
			Open: price, High: price, Low: price, Close: price, Volume: 10}
	}
	return candles
}

func lengths(internal, swing int) Config {
	return Config{InternalLength: internal, SwingLength: swing}
}

func assertBreak(t *testing.T, got *Break, kind, direction, previous string, level float64, candle market.Candle, pivot *Pivot) {
	t.Helper()
	want := &Break{Type: kind, Direction: direction, PreviousBias: previous, Level: level,
		ConfirmedAt: candle.CloseTime, PivotOccurredAt: pivot.OccurredAt, PivotConfirmedAt: pivot.ConfirmedAt}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("break = %+v, want %+v", got, want)
	}
}

func TestExactSwingBreaksBothDirections(t *testing.T) {
	cases := []struct {
		name        string
		prices      []float64
		firstIndex  int
		secondIndex int
		first       string
		second      string
		firstLevel  float64
		secondLevel float64
	}{
		{"bullish_then_bearish", []float64{100, 90, 100, 110, 100, 95, 110, 120, 110, 100, 90}, 7, 10, BiasBullish, BiasBearish, 110, 95},
		{"bearish_then_bullish", []float64{100, 90, 100, 110, 100, 95, 80, 90, 100, 115}, 6, 9, BiasBearish, BiasBullish, 90, 110},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			candles := bars(tc.prices...)
			before := Analyze(candles[:tc.firstIndex], lengths(2, 2)).Swing
			if before.Bias != BiasUnknown || before.LastBreak != nil {
				t.Fatalf("break appeared before crossing: %+v", before)
			}
			first := Analyze(candles[:tc.firstIndex+1], lengths(2, 2)).Swing
			pivot := first.High
			if tc.first == BiasBearish {
				pivot = first.Low
			}
			assertBreak(t, first.LastBreak, "BOS", tc.first, BiasUnknown, tc.firstLevel, candles[tc.firstIndex], pivot)
			if first.Bias != tc.first || !pivot.Crossed || pivot.CrossedAt != candles[tc.firstIndex].CloseTime {
				t.Fatalf("first crossing state: %+v / %+v", first, pivot)
			}
			second := Analyze(candles[:tc.secondIndex+1], lengths(2, 2)).Swing
			pivot = second.High
			if tc.second == BiasBearish {
				pivot = second.Low
			}
			assertBreak(t, second.LastBreak, "CHoCH", tc.second, tc.first, tc.secondLevel, candles[tc.secondIndex], pivot)
			if second.Bias != tc.second || !pivot.Crossed {
				t.Fatalf("opposing close did not change structure: %+v", second)
			}
		})
	}
}

func TestPivotConfirmationDelayAndNoBackdating(t *testing.T) {
	candles := bars(100, 90, 100, 110, 100, 95, 110, 120)
	cfg := lengths(2, 2)
	if got := Analyze(candles[:3], cfg).Swing.Low; got != nil {
		t.Fatalf("low confirmed without its second following bar: %+v", got)
	}
	low := Analyze(candles[:4], cfg).Swing.Low
	wantLow := &Pivot{Index: 1, Price: 90, OccurredAt: candles[1].OpenTime, ConfirmedAt: candles[3].CloseTime}
	if !reflect.DeepEqual(low, wantLow) {
		t.Fatalf("low = %+v, want %+v", low, wantLow)
	}
	if got := Analyze(candles[:5], cfg).Swing.High; got != nil {
		t.Fatalf("high confirmed too soon: %+v", got)
	}
	high := Analyze(candles[:6], cfg).Swing.High
	wantHigh := &Pivot{Index: 3, Price: 110, OccurredAt: candles[3].OpenTime, ConfirmedAt: candles[5].CloseTime}
	if !reflect.DeepEqual(high, wantHigh) {
		t.Fatalf("high = %+v, want %+v", high, wantHigh)
	}
	if got := Analyze(candles[:7], cfg).Swing.LastBreak; got != nil {
		t.Fatalf("touch at equality was treated as a break: %+v", got)
	}
	broken := Analyze(candles, cfg).Swing.LastBreak
	if broken == nil || broken.ConfirmedAt != candles[7].CloseTime || broken.ConfirmedAt <= broken.PivotConfirmedAt {
		t.Fatalf("crossing was backdated to its pivot: %+v", broken)
	}
}

func TestConfiguredLengthsCountFollowingClosedBars(t *testing.T) {
	for _, length := range []int{1, 5, 50} {
		prices := make([]float64, length+1)
		for i := range prices {
			prices[i] = 100 + float64(i)
		}
		candles := bars(prices...)
		cfg := lengths(length, length)
		if early := Analyze(candles[:length], cfg); early.Swing.Ready || early.Swing.Low != nil {
			t.Fatalf("length %d became ready before its following bars: %+v", length, early.Swing)
		}
		got := Analyze(candles, cfg).Swing
		if !got.Ready || got.Low == nil || got.Low.Index != 0 || got.Low.ConfirmedAt != candles[length].CloseTime || got.Low.OccurredAt != candles[0].OpenTime {
			t.Fatalf("length %d did not preserve its exact confirmation delay: %+v", length, got)
		}
	}
}

func TestCrossOnceAndNewPivotStartsUncrossed(t *testing.T) {
	// The same high is crossed at 8, revisited below at 9, and crossed again at
	// 10. No replacement high has yet been confirmed, so there is only one BOS.
	candles := bars(100, 90, 95, 100, 110, 105, 100, 95, 111, 109, 112)
	first := Analyze(candles[:9], lengths(3, 3)).Swing
	final := Analyze(candles, lengths(3, 3)).Swing
	if first.LastBreak == nil || !reflect.DeepEqual(first.LastBreak, final.LastBreak) || !final.High.Crossed {
		t.Fatalf("already-crossed pivot emitted another break: first=%+v final=%+v", first.LastBreak, final.LastBreak)
	}

	// A later leg establishes a different high. Its crossed state resets; a
	// later close through that new level is a continuation BOS.
	candles = bars(100, 90, 100, 110, 100, 95, 110, 120, 110, 100, 110, 121)
	newPivot := Analyze(candles[:10], lengths(2, 2)).Swing
	if newPivot.High == nil || newPivot.High.Index != 7 || newPivot.High.Price != 120 || newPivot.High.Crossed || newPivot.High.CrossedAt != 0 {
		t.Fatalf("replacement high retained old crossing: %+v", newPivot.High)
	}
	continued := Analyze(candles, lengths(2, 2)).Swing
	assertBreak(t, continued.LastBreak, "BOS", BiasBullish, BiasBullish, 120, candles[11], continued.High)
}

func TestInternalBreaksRequireDistinctKnownSwingLevel(t *testing.T) {
	candles := bars(100, 90, 95, 100, 110, 105, 100, 95, 111, 109, 112, 108)
	cfg := lengths(1, 3)
	first := Analyze(candles[:9], cfg)
	if first.Swing.Bias != BiasBullish || first.Internal.Bias != BiasUnknown || first.Internal.LastBreak != nil || first.Internal.High.Crossed {
		t.Fatalf("internal duplicate of swing break was not suppressed: %+v", first)
	}
	second := Analyze(candles[:11], cfg)
	assertBreak(t, second.Internal.LastBreak, "BOS", BiasBullish, BiasUnknown, 111, candles[10], second.Internal.High)
	third := Analyze(candles, cfg)
	assertBreak(t, third.Internal.LastBreak, "CHoCH", BiasBearish, BiasBullish, 109, candles[11], third.Internal.Low)
	if third.Swing.Bias != BiasBullish || third.Internal.Bias != BiasBearish {
		t.Fatalf("scales incorrectly share their direction state: %+v", third)
	}

	// With a longer swing window, the exact same internal close crosses occur
	// before any swing level is known. Pine's comparison with na blocks them.
	unknown := Analyze(candles, lengths(1, 50))
	if unknown.Internal.High == nil || unknown.Internal.Low == nil || unknown.Internal.LastBreak != nil || unknown.Internal.Bias != BiasUnknown {
		t.Fatalf("unknown swing reference allowed an internal event: %+v", unknown.Internal)
	}
}

func TestWicksDoNotBreakStructure(t *testing.T) {
	for _, direction := range []string{BiasBullish, BiasBearish} {
		t.Run(direction, func(t *testing.T) {
			candles := bars(100, 90, 100, 110, 100, 95, 100)
			if direction == BiasBullish {
				candles[6].High = 120
			} else {
				candles[6].Low = 80
			}
			got := Analyze(candles, lengths(2, 2)).Swing
			if got.LastBreak != nil || got.Bias != BiasUnknown || got.High.Crossed || got.Low.Crossed {
				t.Fatalf("wick-only breach changed structure: %+v", got)
			}
		})
	}
}

func TestLegInitializationAndOutsideBarPriority(t *testing.T) {
	// Source initializes a bearish leg; a first high does not create a pivot.
	got := Analyze(bars(110, 100), lengths(1, 1)).Swing
	if got.High != nil || got.Low != nil {
		t.Fatalf("invented first pivot without a leg transition: %+v", got)
	}
	// A candidate satisfying both high and low tests takes the high branch.
	candles := bars(100, 100)
	candles[0].High, candles[0].Low = 110, 90
	got = Analyze(candles, lengths(1, 1)).Swing
	if got.High != nil || got.Low != nil {
		t.Fatalf("outside bar did not follow source high-first priority: %+v", got)
	}
}

func TestPrefixCausalityAndInputImmutability(t *testing.T) {
	candles := bars(100, 90, 95, 100, 110, 105, 100, 95, 111, 109, 112, 108, 80, 150, 75)
	input := append([]market.Candle(nil), candles...)
	cfg := lengths(1, 3)
	for end := 1; end <= len(candles); end++ {
		snapshot := Analyze(candles[:end], cfg)
		asOf := candles[end-1].CloseTime
		if snapshot.AsOf != asOf {
			t.Fatalf("prefix %d has wrong as-of time: %+v", end, snapshot)
		}
		for _, state := range []State{snapshot.Internal, snapshot.Swing} {
			for _, pivot := range []*Pivot{state.High, state.Low} {
				if pivot != nil && (pivot.Index+state.Length >= end || pivot.ConfirmedAt != candles[pivot.Index+state.Length].CloseTime || pivot.ConfirmedAt > asOf) {
					t.Fatalf("prefix %d leaked a future pivot: %+v", end, pivot)
				}
			}
			if event := state.LastBreak; event != nil && (event.ConfirmedAt > asOf || event.ConfirmedAt < event.PivotConfirmedAt) {
				t.Fatalf("prefix %d leaked/backdated event: %+v", end, event)
			}
		}
		// Backing-array tail prices must have no effect on a shorter slice.
		alternative := append([]market.Candle(nil), candles...)
		for i := end; i < len(alternative); i++ {
			alternative[i].Open, alternative[i].High, alternative[i].Low, alternative[i].Close = 999, 999, 999, 999
		}
		if got := Analyze(alternative[:end], cfg); !reflect.DeepEqual(snapshot, got) {
			t.Fatalf("prefix %d depends on unseen tail: got=%+v want=%+v", end, got, snapshot)
		}
		before, _ := json.Marshal(snapshot)
		_ = Analyze(alternative, cfg)
		after, _ := json.Marshal(snapshot)
		if string(before) != string(after) {
			t.Fatalf("later analysis mutated retained prefix %d", end)
		}
	}
	if !reflect.DeepEqual(candles, input) || cfg != lengths(1, 3) {
		t.Fatal("analysis mutated its input")
	}
}

func TestWarmupFlatAndInvalidInputs(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.InternalLength != 5 || cfg.SwingLength != 50 || cfg.Validate() != nil {
		t.Fatalf("unexpected default configuration: %+v", cfg)
	}
	empty := Analyze(nil, cfg)
	if empty.Status != "warming_up" || empty.Bars != 0 || empty.AsOf != 0 || empty.Internal.Ready || empty.Swing.Ready {
		t.Fatalf("empty result: %+v", empty)
	}
	prices := make([]float64, 51)
	for i := range prices {
		prices[i] = 100
	}
	candles := bars(prices...)
	short := Analyze(candles[:6], cfg)
	if short.Status != "warming_up" || !short.Internal.Ready || short.Swing.Ready {
		t.Fatalf("scale warmup not represented: %+v", short)
	}
	flat := Analyze(candles, cfg)
	if flat.Status != "ready" || !flat.Swing.Ready || flat.Swing.Bias != BiasUnknown || flat.Internal.Bias != BiasUnknown || flat.Swing.High != nil || flat.Swing.Low != nil || flat.Internal.LastBreak != nil {
		t.Fatalf("flat bars invented a directional observation: %+v", flat)
	}
	for _, bad := range []Config{{0, 50}, {5, 0}, {-1, 50}, {5, 10001}, {10001, 50}} {
		if bad.Validate() == nil || Analyze(candles, bad).Status != "invalid" {
			t.Fatalf("accepted invalid configuration: %+v", bad)
		}
	}
	for name, mutate := range map[string]func([]market.Candle){
		"nan":       func(c []market.Candle) { c[7].Close = math.NaN() },
		"infinite":  func(c []market.Candle) { c[7].High = math.Inf(1) },
		"ohlc":      func(c []market.Candle) { c[7].Low = c[7].High + 1 },
		"volume":    func(c []market.Candle) { c[7].Volume = -1 },
		"negative":  func(c []market.Candle) { c[7].OpenTime = -1 },
		"duplicate": func(c []market.Candle) { c[7] = c[6] },
		"overlap":   func(c []market.Candle) { c[7].OpenTime-- },
		"gap":       func(c []market.Candle) { c[7].OpenTime++; c[7].CloseTime++ },
	} {
		t.Run(name, func(t *testing.T) {
			bad := bars(100, 90, 100, 110, 100, 95, 80, 90)
			mutate(bad)
			got := Analyze(bad, lengths(2, 2))
			if got.Status != "invalid" || got.Reason == "" || got.AsOf != 0 || got.Internal.LastBreak != nil || got.Swing.LastBreak != nil || got.Swing.Bias != BiasUnknown {
				t.Fatalf("invalid suffix returned partial structure evidence: %+v", got)
			}
		})
	}
}

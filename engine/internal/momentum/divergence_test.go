package momentum

import (
	"math"
	"reflect"
	"testing"
)

// Oscillator samples are supplied directly to isolate lifecycle semantics from
// the separately hand-checked Wilder calculation. Price and RSI endpoints use
// the same candle; bearish cases reflect both price and oscillator.
func divergenceFixture(hidden, bearish bool) []rsiBar {
	values := []float64{40, 38, 35, 30, 25, 20, 30, 35, 32, 31, 28, 25, 30, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35}
	if hidden {
		values = []float64{45, 44, 42, 40, 35, 30, 40, 42, 39, 38, 35, 20, 25, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35, 35}
	}
	closes := make([]float64, len(values))
	for i := range closes {
		closes[i] = 101
	}
	base := candlesFromCloses(closes)
	out := make([]rsiBar, len(base))
	for i := range base {
		out[i] = rsiBar{Candle: base[i], rsi: values[i]}
	}
	setPrice := func(index int, open, close float64) {
		out[index].Open = open
		out[index].Close = close
		out[index].Low = math.Min(open, close) - 1
		out[index].High = math.Max(open, close) + 1
	}
	setPrice(5, 100, 101)
	setPrice(11, 98, 99)
	setPrice(12, 99, 101)
	if hidden {
		setPrice(5, 98, 99)
		setPrice(11, 100, 101)
		setPrice(12, 101, 103)
	}
	if bearish {
		for i := range out {
			b := &out[i]
			b.Open, b.Close, b.High, b.Low = 400-b.Open, 400-b.Close, 400-b.Low, 400-b.High
			b.rsi = 100 - b.rsi
		}
	}
	return out
}

func targetID(bars []rsiBar, hidden, bearish bool) string {
	kind := "regular-bullish"
	if hidden {
		kind = "hidden-bullish"
	}
	if bearish {
		kind = "regular-bearish"
		if hidden {
			kind = "hidden-bearish"
		}
	}
	setup, ok := makeDivergence(bars, 5, 11, !bearish, DefaultRules())
	if !ok || setup.Kind != kind {
		panic("invalid lifecycle fixture")
	}
	return setup.ID
}

func getSetup(t *testing.T, bars []rsiBar, id string) Divergence {
	t.Helper()
	setups, _, _ := findDivergences(bars, DefaultRules())
	for _, s := range setups {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("setup %s missing in %+v", id, setups)
	return Divergence{}
}

func TestMirroredRegularAndHiddenFormationConfirmation(t *testing.T) {
	for _, hidden := range []bool{false, true} {
		for _, bearish := range []bool{false, true} {
			bars := divergenceFixture(hidden, bearish)
			id := targetID(bars, hidden, bearish)
			before, _, _ := findDivergences(bars[:11], DefaultRules())
			for _, s := range before {
				if s.ID == id {
					t.Fatal("second pivot used before its close")
				}
			}
			formed := getSetup(t, bars[:12], id)
			if formed.State != "forming" || formed.Start.AvailableAt != bars[10].CloseTime || !formed.Start.Mature || formed.End.Mature || formed.AvailableAt != bars[11].CloseTime || formed.DetectedAt != bars[11].CloseTime || formed.ConfirmedAt != nil || formed.Confirmation != nil || formed.AgeBars != 0 || formed.InvalidationRSI != bars[11].rsi {
				t.Fatalf("incorrect forming evidence: %+v", formed)
			}
			confirmed := getSetup(t, bars[:13], id)
			if confirmed.State != "confirmed" || confirmed.ConfirmedAt == nil || *confirmed.ConfirmedAt != bars[12].CloseTime || confirmed.AvailableAt != bars[12].CloseTime || confirmed.Confirmation == nil || confirmed.Confirmation.Strength != "strong" || confirmed.Confirmation.RSI != bars[12].rsi || confirmed.BarsElapsed != 0 || confirmed.AgeBars != 0 || confirmed.BarsSinceDetection != 1 {
				t.Fatalf("incorrect confirmation evidence: %+v", confirmed)
			}
			later := getSetup(t, bars[:15], id)
			if later.State != "confirmed" || later.AgeBars != 2 || later.BarsElapsed != 2 || later.BarsSinceDetection != 3 || later.Start != formed.Start || later.End != formed.End || later.DetectedAt != formed.DetectedAt || !reflect.DeepEqual(later.Confirmation, confirmed.Confirmation) {
				t.Fatalf("age or frozen observations changed: %+v", later)
			}
		}
	}
}

func TestOnlyNextCandleConfirmsAndAnchorBreachHasPriority(t *testing.T) {
	for _, bearish := range []bool{false, true} {
		for _, mode := range []string{"wrong-color", "doji", "breach", "ordinary"} {
			bars := divergenceFixture(false, bearish)
			id := targetID(bars, false, bearish)
			b := &bars[12]
			sign := 1.0
			if bearish {
				sign = -1
			}
			switch mode {
			case "wrong-color":
				b.Close = b.Open - sign
			case "doji":
				b.Close = b.Open
			case "breach":
				b.rsi = bars[11].rsi - sign
			case "ordinary":
				b.Open = bars[11].Open - 2*sign
				b.Close = bars[11].Open - sign
			}
			b.High = math.Max(b.Open, b.Close) + 1
			b.Low = math.Min(b.Open, b.Close) - 1
			s := getSetup(t, bars[:14], id)
			if mode == "ordinary" {
				if s.State != "confirmed" || s.Confirmation == nil || s.Confirmation.Strength != "ordinary" {
					t.Fatalf("ordinary close mislabeled: %+v", s)
				}
				continue
			}
			want, reason := "unconfirmed", "confirmation-missed"
			if mode == "breach" {
				want, reason = "harmonised", "rsi-anchor"
			}
			if s.State != want || s.ResolutionReason != reason || s.ConfirmedAt != nil || s.Confirmation != nil || s.ResolvedAt == nil || *s.ResolvedAt != bars[12].CloseTime || s.AgeBars != 1 {
				t.Fatalf("%s was later confirmed or resolved incorrectly: %+v", mode, s)
			}
		}
	}
}

func TestMirroredTargetExpiryAndRecentResolutionWindow(t *testing.T) {
	for _, bearish := range []bool{false, true} {
		for _, mode := range []string{"target", "expiry", "breach", "confirmation-target"} {
			bars := divergenceFixture(false, bearish)
			id := targetID(bars, false, bearish)
			end := 26
			if mode == "confirmation-target" {
				end = 12
				bars[12].rsi = 50
			}
			if mode == "target" {
				bars[26].rsi = 50
			}
			if mode == "breach" {
				bars[26].rsi = bars[11].rsi - 1
				if bearish {
					bars[26].rsi = bars[11].rsi + 1
				}
			}
			if end == 26 {
				previous := getSetup(t, bars[:26], id)
				if previous.State != "confirmed" || previous.BarsElapsed != 13 {
					t.Fatalf("expired before 14 subsequent closes: %+v", previous)
				}
			}
			s := getSetup(t, bars[:end+1], id)
			want, reason := "expired", "window-elapsed"
			if mode == "target" || mode == "confirmation-target" {
				want, reason = "completed", "rsi-50"
			}
			if mode == "breach" {
				want, reason = "harmonised", "rsi-anchor"
			}
			if s.State != want || s.ResolutionReason != reason || s.ResolvedAt == nil || *s.ResolvedAt != bars[end].CloseTime || s.BarsSinceResolution == nil || *s.BarsSinceResolution != 0 || s.AgeBars != 0 {
				t.Fatalf("%s: %+v", mode, s)
			}
			if mode == "confirmation-target" && (s.BarsElapsed != 0 || *s.ConfirmedAt != *s.ResolvedAt) {
				t.Fatal("confirmation-candle oscillator target became subsequent success")
			}
			if end+4 <= len(bars) {
				retained := getSetup(t, bars[:end+4], id)
				if retained.BarsSinceResolution == nil || *retained.BarsSinceResolution != 3 {
					t.Fatal("latest-four resolution window misaged")
				}
			}
			if end+5 <= len(bars) {
				older, _, _ := findDivergences(bars[:end+5], DefaultRules())
				for _, d := range older {
					if d.ID == id {
						t.Fatal("resolved event retained outside four-bar window")
					}
				}
			}
		}
	}
}

func TestDivergenceRequiresStrictBodyAndSameCycleEvidence(t *testing.T) {
	for _, bearish := range []bool{false, true} {
		for _, mode := range []string{"body-equal", "wick-equal", "rsi-equal", "cycle-touch", "cycle-cross", "immature-first"} {
			bars := divergenceFixture(false, bearish)
			switch mode {
			case "body-equal":
				bars[11].Open = bars[5].Open
				bars[11].Close = bars[5].Close
			case "wick-equal":
				if bearish {
					bars[11].High = bars[5].High
				} else {
					bars[11].Low = bars[5].Low
				}
			case "rsi-equal":
				bars[11].rsi = bars[5].rsi
			case "cycle-touch":
				bars[8].rsi = 50
			case "cycle-cross":
				bars[8].rsi = 51
				if bearish {
					bars[8].rsi = 49
				}
			case "immature-first":
				bars[10].rsi = bars[5].rsi
			}
			setups, _, _ := findDivergences(bars[:12], DefaultRules())
			for _, s := range setups {
				if s.Start.OpenTime == bars[5].OpenTime && s.End.OpenTime == bars[11].OpenTime {
					t.Fatalf("%s admitted %+v", mode, s)
				}
			}
		}
	}
	rules := DefaultRules()
	rules.IncludeHidden = false
	setups, _, _ := findDivergences(divergenceFixture(true, false)[:12], rules)
	if len(setups) != 0 {
		t.Fatal("hidden setting ignored")
	}
}

func TestDeterministicBoundPrioritizesActiveAndReportsOmitted(t *testing.T) {
	rules := DefaultRules()
	records := make([]trackedDivergence, 12)
	for i := range records {
		records[i] = trackedDivergence{value: Divergence{ID: string(rune('a' + i)), State: "confirmed", AvailableAt: int64(i)}, detectedIndex: i, stateIndex: i, resolvedIndex: -1}
	}
	records[11].value.State = "completed"
	records[11].value.ResolvedAt = pointer(int64(11))
	records[11].resolvedIndex = 11
	first, total, omitted := selectDivergences(records, 12, rules)
	second, total2, omitted2 := selectDivergences(records, 12, rules)
	if total != 12 || omitted != 4 || len(first) != 8 || first[0].ID != "k" || total2 != total || omitted2 != omitted || !reflect.DeepEqual(first, second) {
		t.Fatalf("bad bounded evidence: %+v %d/%d", first, total, omitted)
	}
	for _, s := range first {
		if s.ResolvedAt != nil {
			t.Fatal("recent resolution displaced active evidence")
		}
	}
}

func TestFutureSuffixCannotRepaintFormationOrConfirmation(t *testing.T) {
	bars := divergenceFixture(false, false)
	id := targetID(bars, false, false)
	prefix := append([]rsiBar{}, bars[:13]...)
	before := getSetup(t, prefix, id)
	for i := 13; i < len(bars); i++ {
		bars[i].rsi = 1
		bars[i].Low = 1
	}
	after := getSetup(t, bars[:14], id)
	if after.State != "harmonised" || after.Start != before.Start || after.End != before.End || after.DetectedAt != before.DetectedAt || !reflect.DeepEqual(after.Confirmation, before.Confirmation) {
		t.Fatal("future extreme repainted original event")
	}
	if !reflect.DeepEqual(getSetup(t, prefix, id), before) {
		t.Fatal("future suffix changed completed prefix")
	}
}

func TestAnchorEqualityPreservesActiveSetup(t *testing.T) {
	for _, bearish := range []bool{false, true} {
		bars := divergenceFixture(false, bearish)
		id := targetID(bars, false, bearish)
		bars[13].rsi = bars[11].rsi
		if s := getSetup(t, bars[:14], id); s.State != "confirmed" || s.BarsElapsed != 1 {
			t.Fatalf("anchor equality invalidated: %+v", s)
		}
	}
}

func TestPivotSeparationUsesInclusiveFiveToSixtyBars(t *testing.T) {
	for _, distance := range []int{4, 5, 60, 61} {
		bars := divergenceFixture(false, false)
		first := bars[5]
		second := bars[11]
		expanded := make([]rsiBar, 5+distance+1)
		for i := range expanded {
			expanded[i] = bars[0]
			expanded[i].OpenTime = int64(i) * 900000
			expanded[i].CloseTime = int64(i+1)*900000 - 1
		}
		expanded[5].rsi, expanded[5].Open, expanded[5].Close, expanded[5].Low = first.rsi, first.Open, first.Close, first.Low
		end := len(expanded) - 1
		expanded[end].rsi, expanded[end].Open, expanded[end].Close, expanded[end].Low = second.rsi, second.Open, second.Close, second.Low
		_, ok := makeDivergence(expanded, 5, end, true, DefaultRules())
		if ok != (distance >= 5 && distance <= 60) {
			t.Fatalf("distance %d accepted=%v", distance, ok)
		}
	}
}

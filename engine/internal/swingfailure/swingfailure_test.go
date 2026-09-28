package swingfailure

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func candles(rows ...[4]float64) []market.Candle {
	result := make([]market.Candle, len(rows))
	for i, row := range rows {
		result[i] = market.Candle{OpenTime: int64(i) * 900000, CloseTime: int64(i+1)*900000 - 1,
			Open: row[0], High: row[1], Low: row[2], Close: row[3], Volume: 100}
	}
	return result
}

func bearish() []market.Candle {
	return candles(
		[4]float64{9, 10, 8.5, 9},
		[4]float64{9, 12, 9, 11},
		[4]float64{10, 11, 8, 9},
		[4]float64{9, 10.5, 8.5, 10},
		[4]float64{10, 13, 9.2, 11},
	)
}

func mirror(input []market.Candle) []market.Candle {
	result := append([]market.Candle{}, input...)
	for i, bar := range result {
		result[i].Open, result[i].Close = 30-bar.Open, 30-bar.Close
		result[i].High, result[i].Low = 30-bar.Low, 30-bar.High
	}
	return result
}

func appendBar(input []market.Candle, values [4]float64) []market.Candle {
	bar := candles(values)[0]
	bar.OpenTime = input[len(input)-1].CloseTime + 1
	bar.CloseTime = bar.OpenTime + 900000 - 1
	return append(input, bar)
}

func find(t *testing.T, snapshot Snapshot, id string) Event {
	t.Helper()
	for _, event := range snapshot.Events {
		if event.ID == id {
			return event
		}
	}
	t.Fatalf("missing event %q: %+v", id, snapshot.Events)
	return Event{}
}

func TestCausalMirroredSweepAndFollowThrough(t *testing.T) {
	for _, direction := range []string{"bearish", "bullish"} {
		t.Run(direction, func(t *testing.T) {
			input := bearish()
			if direction == "bullish" {
				input = mirror(input)
			}
			before := Analyze(input[:4])
			if before.Status != "ready" || len(before.Events) != 0 {
				t.Fatalf("premature signal: %+v", before)
			}
			snapshot := Analyze(input)
			if len(snapshot.Events) != 1 {
				t.Fatalf("events: %+v", snapshot.Events)
			}
			e := snapshot.Events[0]
			if e.State != "confirmed" || e.Direction != direction || e.ConfirmedAt != input[4].CloseTime ||
				e.AvailableAt != e.ConfirmedAt || e.TriggerStatus != "available" || e.Trigger == nil ||
				e.Level.OpenTime != input[1].OpenTime || e.Level.AvailableAt != input[2].CloseTime ||
				e.Trigger.OpenTime != input[2].OpenTime || e.Trigger.AvailableAt != input[3].CloseTime ||
				e.Level.AvailableAt >= e.Candle.OpenTime || e.Trigger.AvailableAt >= e.Candle.OpenTime ||
				e.PenetrationPrice != 1 || e.CloseBackPrice != 1 || e.BarsSinceSweep != 0 || e.ResolvedAt != nil {
				t.Fatalf("incorrect sweep evidence: %+v", e)
			}
			row := [4]float64{11, 11.5, 7, 7.5}
			if direction == "bullish" {
				row = [4]float64{19, 23, 18.5, 22.5}
			}
			input = appendBar(input, row)
			resolved := find(t, Analyze(input), e.ID)
			if resolved.State != "follow_through" || resolved.ResolvedAt == nil || *resolved.ResolvedAt != input[5].CloseTime ||
				resolved.FollowThroughAt == nil || *resolved.FollowThroughAt <= e.ConfirmedAt ||
				resolved.FollowThroughClose == nil || *resolved.FollowThroughClose != input[5].Close ||
				resolved.BarsSinceSweep != 1 || resolved.AgeBars != 0 || resolved.BarsSinceResolution == nil ||
				*resolved.BarsSinceResolution != 0 || resolved.ConfirmedAt != e.ConfirmedAt || !reflect.DeepEqual(resolved.Level, e.Level) {
				t.Fatalf("incorrect later break: %+v", resolved)
			}
		})
	}
}

func TestStrictWicksAndPivotEquality(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func([]market.Candle)
	}{
		{"exact_level_touch", func(b []market.Candle) { b[4].High = 12 }},
		{"close_on_level", func(b []market.Candle) { b[4].Close = 12 }},
		{"close_beyond_level", func(b []market.Candle) { b[4].Close = 12.5 }},
		{"gap_open_beyond_level", func(b []market.Candle) { b[4].Open = 12.5 }},
		{"equal_left_high", func(b []market.Candle) { b[0].High = 12 }},
		{"equal_right_high", func(b []market.Candle) { b[2].High = 12 }},
	} {
		for _, direction := range []string{"bearish", "bullish"} {
			t.Run(tc.name+"/"+direction, func(t *testing.T) {
				input := bearish()
				tc.edit(input)
				if direction == "bullish" {
					input = mirror(input)
				}
				if result := Analyze(input); result.Status != "ready" || len(result.Events) != 0 {
					t.Fatalf("invalid wick/pivot accepted: %+v", result)
				}
			})
		}
	}
}

func TestTriggersMustPrecedeSweepAndRemainUnbroken(t *testing.T) {
	for _, tc := range []struct {
		name   string
		edit   func([]market.Candle)
		status string
	}{
		{"confirmed_on_sweep", func(b []market.Candle) { b[3].Low = 7.8 }, "no_intervening_pivot"},
		{"broken_on_sweep", func(b []market.Candle) { b[4].Low, b[4].Close = 7, 7.5 }, "already_crossed"},
		{"broken_before_sweep", func(b []market.Candle) {}, "already_crossed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := bearish()
			if tc.name == "broken_before_sweep" {
				// The low at candle2 becomes known at candle3. Break it on4,
				// then sweep the old high on5, so the trigger is already spent.
				input = input[:4]
				input = appendBar(input, [4]float64{10, 11, 7, 7.5})
				input = appendBar(input, [4]float64{7.5, 13, 7.4, 11})
			} else {
				tc.edit(input)
			}
			result := Analyze(input)
			if len(result.Events) != 1 || result.Events[0].Trigger != nil || result.Events[0].TriggerStatus != tc.status {
				t.Fatalf("unsafe trigger: %+v", result.Events)
			}
			if result.Events[0].FollowThroughAt != nil || result.Events[0].State != "confirmed" {
				t.Fatalf("same-bar or previous break promoted: %+v", result.Events[0])
			}
		})
	}
}

func TestLatestConfirmedSwingReplacesOldReference(t *testing.T) {
	input := bearish()[:4]
	// The high on2 is now12.5 and supersedes the original high1. Candle4
	// clears12 but not12.5: the older high must not create a new event.
	input[2].High = 12.5
	input = appendBar(input, [4]float64{10, 12.2, 9.2, 11})
	result := Analyze(input)
	if len(result.Events) != 0 || result.LatestHigh == nil || result.LatestHigh.Price != 12.5 ||
		result.LatestHigh.AvailableAt != input[3].CloseTime {
		t.Fatalf("used obsolete high: %+v", result)
	}
}

func TestInvalidationAndExactTouchAreDistinct(t *testing.T) {
	for _, direction := range []string{"bearish", "bullish"} {
		t.Run(direction, func(t *testing.T) {
			input := bearish()
			input = appendBar(input, [4]float64{11, 12.5, 10, 12})
			if direction == "bullish" {
				input = mirror(input)
			}
			sweep := Analyze(input[:5]).Events[0]
			if got := find(t, Analyze(input), sweep.ID); got.State != "confirmed" {
				t.Fatalf("exact touch invalidated: %+v", got)
			}
			row := [4]float64{12, 13, 11, 12.5}
			if direction == "bullish" {
				row = [4]float64{18, 19, 17, 17.5}
			}
			input = appendBar(input, row)
			got := find(t, Analyze(input), sweep.ID)
			if got.State != "invalidated" || got.ResolutionReason != "reclaimed_swing_level_lost_on_close" ||
				got.ResolvedAt == nil || got.FollowThroughAt != nil {
				t.Fatalf("closed reclaim loss not recorded: %+v", got)
			}
		})
	}
}

func TestInvalidationPrecedesBreakAndExpiry(t *testing.T) {
	// Directly stress transition priority even if a malformed caller-created
	// trigger makes both outcomes possible; no profitable outcome is inferred.
	p := pending{Event: Event{Direction: "bearish", State: "confirmed", Level: Pivot{Price: 10},
		Trigger: &Pivot{Price: 15}}, sweepIndex: 0, resolvedIndex: -1}
	previous := market.Candle{Close: 16}
	bar := market.Candle{Close: 12, CloseTime: 4499999}
	p.advance(previous, bar, 4, DefaultRules())
	if p.State != "invalidated" || p.FollowThroughAt != nil {
		t.Fatalf("invalidation lost priority: %+v", p)
	}
}

func TestFourthBarBreakCountsButLaterBreakDoesNot(t *testing.T) {
	for _, breakOnFourth := range []bool{true, false} {
		input := bearish()
		id := Analyze(input).Events[0].ID
		for n := 1; n <= 4; n++ {
			row := [4]float64{10, 11, 9, 10}
			if n == 4 && breakOnFourth {
				row = [4]float64{10, 11, 7, 7.5}
			}
			input = appendBar(input, row)
			if n < 4 && find(t, Analyze(input), id).State != "confirmed" {
				t.Fatal("expired before last eligible follow-through bar")
			}
		}
		want := "expired"
		if breakOnFourth {
			want = "follow_through"
		}
		resolved := find(t, Analyze(input), id)
		if resolved.State != want || resolved.ResolvedAt == nil || *resolved.ResolvedAt != input[8].CloseTime {
			t.Fatalf("fourth-bar boundary: %+v", resolved)
		}
		input = appendBar(input, [4]float64{10, 11, 7, 7.5})
		if got := find(t, Analyze(input), id); got.State != want || *got.ResolvedAt != *resolved.ResolvedAt || got.AgeBars != 1 {
			t.Fatalf("terminal observation changed later: %+v", got)
		}
		for n := 0; n < 3; n++ {
			input = appendBar(input, [4]float64{8, 9, 7, 8})
		}
		for _, got := range Analyze(input).Events {
			if got.ID == id {
				t.Fatalf("resolved event survived four newer bars: %+v", got)
			}
		}
	}
}

func TestBoundsOmissionsAndActivePriority(t *testing.T) {
	input := candles([4]float64{100, 110, 90, 100}, [4]float64{100, 120, 80, 100}, [4]float64{100, 110, 90, 100})
	for n := 1; n <= 12; n++ {
		input = appendBar(input, [4]float64{100, 120 + float64(n), 80 - float64(n), 100})
	}
	s := Analyze(input)
	if len(s.Events) != 8 || s.Total != 16 || s.Omitted != 8 {
		t.Fatalf("bounded counts: events=%d total=%d omitted=%d", len(s.Events), s.Total, s.Omitted)
	}
	seen := map[string]bool{}
	for _, e := range s.Events {
		if e.State != "confirmed" || seen[e.ID] || e.BarsSinceSweep >= s.Rules.ExpiryBars {
			t.Fatalf("bad active priority or identity: %+v", e)
		}
		seen[e.ID] = true
	}
}

func TestReadinessAndInvalidHistory(t *testing.T) {
	for n := 0; n < 4; n++ {
		got := Analyze(bearish()[:n])
		if got.Status != "insufficient" || got.WarmupBars != 4 || got.Total != 0 || len(got.Events) != 0 ||
			(n == 0) != (got.AsOf == nil) {
			t.Fatalf("readiness at%d: %+v", n, got)
		}
	}
	for _, tc := range []struct {
		name string
		edit func([]market.Candle)
	}{
		{"gap", func(b []market.Candle) { b[4].OpenTime += 900000; b[4].CloseTime += 900000 }},
		{"overlap", func(b []market.Candle) { b[4].OpenTime -= 900000; b[4].CloseTime -= 900000 }},
		{"duration", func(b []market.Candle) { b[4].CloseTime++ }},
		{"nan_price", func(b []market.Candle) { b[4].High = math.NaN() }},
		{"negative_volume", func(b []market.Candle) { b[4].Volume = -1 }},
		{"bad_envelope", func(b []market.Candle) { b[4].High = 5 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := bearish()
			tc.edit(input)
			got := Analyze(input)
			if got.Status != "invalid" || got.AsOf != nil || len(got.Events) != 0 || len(got.Warnings) != 1 ||
				got.LatestHigh != nil || got.LatestLow != nil {
				t.Fatalf("invalid history leaked evidence: %+v", got)
			}
		})
	}
}

func TestSnapshotAndInputOwnership(t *testing.T) {
	input := appendBar(bearish(), [4]float64{11, 11.5, 7, 7.5})
	before := append([]market.Candle{}, input...)
	s := Analyze(input)
	if !reflect.DeepEqual(input, before) {
		t.Fatal("analyzer mutated candles")
	}
	want, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	copy := CloneSnapshot(s)
	*copy.AsOf = 1
	if copy.LatestHigh != nil {
		copy.LatestHigh.Price = 1
	}
	if copy.LatestLow != nil {
		copy.LatestLow.Price = 1
	}
	e := &copy.Events[0]
	e.Level.Price, e.Candle.Close = 1, 1
	if e.Trigger != nil {
		e.Trigger.Price = 1
	}
	*e.FollowThroughAt, *e.FollowThroughClose, *e.ResolvedAt, *e.BarsSinceResolution = 1, 1, 1, 1
	copy.Warnings = append(copy.Warnings, "changed")
	input[0].High = 500
	got, _ := json.Marshal(s)
	if string(got) != string(want) {
		t.Fatalf("published snapshot aliases mutable data\n%s\n%s", want, got)
	}
}

func TestIDsDoNotDependOnInputIndices(t *testing.T) {
	input := bearish()
	first := Analyze(input).Events[0]
	// A harmless extra initial candle shifts all input-relative indices but
	// leaves the actual pivot/sweep timestamps and identity unchanged.
	for i := range input {
		input[i].OpenTime += 900000
		input[i].CloseTime += 900000
	}
	shifted := Analyze(input).Events[0]
	leading := candles([4]float64{9, 10, 8.5, 9})[0]
	withLeading := Analyze(append([]market.Candle{leading}, input...)).Events[0]
	if shifted.ID != withLeading.ID || first.ID == shifted.ID {
		t.Fatalf("unstable IDs: %s %s %s", first.ID, shifted.ID, withLeading.ID)
	}
}

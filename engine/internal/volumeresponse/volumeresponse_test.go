package volumeresponse

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func candle(i int, open, high, low, close, volume float64) market.Candle {
	return market.Candle{OpenTime: int64(i) * 60000, CloseTime: int64(i+1)*60000 - 1,
		Open: open, High: high, Low: low, Close: close, Volume: volume}
}

func history(count int) []market.Candle {
	bars := make([]market.Candle, count)
	for i := range bars {
		bars[i] = candle(i, 100, 103, 99, 101, 100)
	}
	return bars
}

func near(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-12 {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestBodySpreadAndFullRangeHaveDifferentMeanings(t *testing.T) {
	bars := history(21)
	bars[20] = candle(20, 100, 108, 98, 102, 200)
	before := append([]market.Candle(nil), bars...)
	s := Analyze(bars)
	if s.Status != "ready" || s.ShapeStatus != "ready" || s.Direction != "up" || s.AsOf == nil || *s.AsOf != bars[20].CloseTime {
		t.Fatalf("unexpected availability or provenance: %+v", s)
	}
	near(t, s.Body, 2)
	near(t, s.Range, 10)
	near(t, s.BodyFraction, .2)
	near(t, s.ClosePosition, .4)
	near(t, s.UpperWickFraction, .6)
	near(t, s.LowerWickFraction, .2)
	// Including the current candle in any baseline would change these values.
	near(t, s.RelativeBody, 2)
	near(t, s.RelativeRange, 2.5)
	near(t, s.RelativeVolume, 2)
	if s.VolumeVsPreviousTwo != "above_both" || s.BodyVsPreviousTwo != "above_both" {
		t.Fatalf("source comparison missing: %+v", s)
	}
	if !reflect.DeepEqual(bars, before) {
		t.Fatal("analysis changed supplied candle history")
	}
}

func TestIndependentWarmupAndStrictPreviousTwoComparisons(t *testing.T) {
	bars := history(21)
	for _, length := range []int{0, 1, 2, 3, 20, 21} {
		s := Analyze(bars[:length])
		want := "insufficient"
		if length == 21 {
			want = "ready"
		}
		if s.Status != want || s.BodyBaselineStatus != want || s.RangeBaselineStatus != want || s.VolumeBaselineStatus != want {
			t.Fatalf("%d bars: unexpected baseline readiness %+v", length, s)
		}
		if length < 3 && s.PreviousTwoStatus != "insufficient" || length >= 3 && s.PreviousTwoStatus != "ready" {
			t.Fatalf("%d bars: unexpected two-candle readiness %+v", length, s)
		}
		if length > 0 && s.ShapeStatus != "ready" {
			t.Fatalf("geometry needs only one candle, got %+v", s)
		}
	}
	bars = []market.Candle{candle(0, 100, 104, 99, 101, 80), candle(1, 100, 104, 99, 103, 120), candle(2, 100, 104, 99, 102, 100)}
	s := Analyze(bars)
	if s.BodyVsPreviousTwo != "between_or_equal" || s.VolumeVsPreviousTwo != "between_or_equal" {
		t.Fatalf("between is neither above nor below both: %+v", s)
	}
	bars[2].Close, bars[2].Volume = 101, 80
	s = Analyze(bars)
	if s.BodyVsPreviousTwo != "between_or_equal" || s.VolumeVsPreviousTwo != "between_or_equal" {
		t.Fatalf("ties must not become strict low/high observations: %+v", s)
	}
	bars[2].Close, bars[2].Volume = 100.5, 50
	s = Analyze(bars)
	if s.BodyVsPreviousTwo != "below_both" || s.VolumeVsPreviousTwo != "below_both" {
		t.Fatalf("strict below-both comparison missing: %+v", s)
	}
}

func TestFlatCandlesAndZeroBaselinesStayExplicit(t *testing.T) {
	bars := history(21)
	for i := range bars {
		bars[i] = candle(i, 100, 100, 100, 100, 0)
	}
	s := Analyze(bars)
	if s.Status != "ready" || s.ShapeStatus != "zero_range" || s.Direction != "flat" || s.BodyBaselineStatus != "zero_baseline" || s.RangeBaselineStatus != "zero_baseline" || s.VolumeBaselineStatus != "zero_baseline" {
		t.Fatalf("flat history misrepresented: %+v", s)
	}
	near(t, s.Body, 0)
	near(t, s.Range, 0)
	if s.BodyFraction != nil || s.ClosePosition != nil || s.UpperWickFraction != nil || s.LowerWickFraction != nil || s.RelativeBody != nil || s.RelativeRange != nil || s.RelativeVolume != nil || s.LatestResponse != nil {
		t.Fatalf("undefined math became a numeric observation: %+v", s)
	}
	// A real zero-volume latest candle is a measured ratio of zero when the
	// preceding volume baseline is valid. It is not a zero-baseline failure.
	bars = history(21)
	bars[20].Volume = 0
	s = Analyze(bars)
	if s.VolumeBaselineStatus != "ready" {
		t.Fatalf("zero current volume isn't missing history: %+v", s)
	}
	near(t, s.RelativeVolume, 0)
	// A doji still has useful close/wick geometry when its range is nonzero.
	bars[20] = candle(20, 100, 102, 99, 100, 100)
	s = Analyze(bars)
	if s.ShapeStatus != "ready" || s.Direction != "flat" {
		t.Fatalf("doji with wicks is not a zero-range bar: %+v", s)
	}
	near(t, s.BodyFraction, 0)
	near(t, s.ClosePosition, 1.0/3)
}

func responseHistory() []market.Candle {
	bars := history(22)
	bars[18] = candle(18, 100, 104, 98, 102, 100)
	bars[19] = candle(19, 100, 104, 98, 103, 80)
	bars[20] = candle(20, 102, 104, 98, 102.5, 200)
	// Close is below the setup's close, but this candle itself moves upward.
	// The observation's direction must not claim a breakout or continuation.
	bars[21] = candle(21, 100, 104, 98, 101, 100)
	return bars
}

func TestResponseIsObservedOnlyAtNextCloseAndThenAgesOut(t *testing.T) {
	bars := responseHistory()
	if got := Analyze(bars[:21]).LatestResponse; got != nil {
		t.Fatalf("setup alone must not produce the later response: %+v", got)
	}
	first := Analyze(bars).LatestResponse
	if first == nil || first.SetupAt != bars[20].CloseTime || first.ObservedAt != bars[21].CloseTime || first.BarsAgo != 0 || first.Direction != "up" || first.SetupVolume != 200 || first.ResponseVolume != 100 || first.SetupBody != .5 || first.ResponseBody != 1 {
		t.Fatalf("wrong response measurements or timing: %+v", first)
	}
	for i := 22; i <= 25; i++ {
		bars = append(bars, candle(i, 100, 104, 98, 103, 300))
		got := Analyze(bars).LatestResponse
		if i == 25 {
			if got != nil {
				t.Fatalf("observation aged beyond latest four candles: %+v", got)
			}
			continue
		}
		if got == nil || got.BarsAgo != i-21 || got.ObservedAt != first.ObservedAt || got.SetupVolume != first.SetupVolume || got.ResponseBody != first.ResponseBody {
			t.Fatalf("later candles altered historical observation: %+v", got)
		}
	}
	if first.BarsAgo != 0 {
		t.Fatal("later analyses mutated the earlier snapshot")
	}
}

func TestResponseIsSymmetricAndDoesNotNeedAHigherTimeframeVerdict(t *testing.T) {
	bars := responseHistory()
	for i, c := range bars {
		bars[i].Open, bars[i].Close = 300-c.Open, 300-c.Close
		bars[i].High, bars[i].Low = 300-c.Low, 300-c.High
	}
	s := Analyze(bars)
	if s.LatestResponse == nil || s.LatestResponse.Direction != "down" || s.Direction != "down" || s.LatestResponse.ResponseBody != 1 {
		t.Fatalf("mirrored bearish observation missing: %+v", s)
	}
}

func TestResponseConditionsExcludeTiesAndZeroVolume(t *testing.T) {
	cases := map[string]func([]market.Candle){
		"setup volume ties prior":    func(b []market.Candle) { b[20].Volume = 100 },
		"setup body ties prior":      func(b []market.Candle) { b[20].Open, b[20].Close = 100, 102 },
		"response volume ties setup": func(b []market.Candle) { b[21].Volume = 200 },
		"zero response volume":       func(b []market.Candle) { b[21].Volume = 0 },
		"response body shrinks":      func(b []market.Candle) { b[21].Close = 100.25 },
		"response has no direction":  func(b []market.Candle) { b[21].Close = b[21].Open },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bars := responseHistory()
			mutate(bars)
			if got := Analyze(bars).LatestResponse; got != nil {
				t.Fatalf("nonqualifying sequence produced an observation: %+v", got)
			}
		})
	}
	bars := responseHistory()
	bars[21].Close = bars[21].Open + .5
	if got := Analyze(bars).LatestResponse; got == nil {
		t.Fatal("equal body on lower volume is a valid measured response")
	}
}

func TestMalformedAndMissingCandlesDoNotLeakPartialEvidence(t *testing.T) {
	cases := map[string]func([]market.Candle){
		"gap":             func(b []market.Candle) { b[1].OpenTime++ },
		"duplicate":       func(b []market.Candle) { b[1] = b[0] },
		"duration":        func(b []market.Candle) { b[len(b)-1].CloseTime++ },
		"negative volume": func(b []market.Candle) { b[0].Volume = -1 },
		"NaN":             func(b []market.Candle) { b[0].Close = math.NaN() },
		"infinite volume": func(b []market.Candle) { b[0].Volume = math.Inf(1) },
		"invalid OHLC":    func(b []market.Candle) { b[0].High = b[0].Low - 1 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bars := responseHistory()
			mutate(bars)
			s := Analyze(bars)
			if s.Status != "invalid" || s.ShapeStatus != "invalid" || s.PreviousTwoStatus != "invalid" || s.BodyBaselineStatus != "invalid" || s.RangeBaselineStatus != "invalid" || s.VolumeBaselineStatus != "invalid" || s.AsOf != nil || s.Body != nil || s.RelativeVolume != nil || s.LatestResponse != nil {
				t.Fatalf("invalid input leaked convincing partial measurements: %+v", s)
			}
		})
	}
}

func TestExtremeFiniteInputsRemainSerializable(t *testing.T) {
	bars := history(21)
	for i := 0; i < 20; i++ {
		bars[i] = candle(i, 1e-300, 3e-300, 1e-300, 2e-300, math.MaxFloat64)
	}
	bars[20] = candle(20, 1, 1e100, 1, 1e100, math.MaxFloat64)
	s := Analyze(bars)
	if s.BodyBaselineStatus != "invalid" || s.RangeBaselineStatus != "invalid" || s.RelativeBody != nil || s.RelativeRange != nil {
		t.Fatalf("unrepresentable ratios should be withheld: %+v", s)
	}
	near(t, s.RelativeVolume, 1)
	if _, err := json.Marshal(s); err != nil {
		t.Fatalf("finite candles produced non-JSON numeric values: %v", err)
	}
}

func TestCloneOwnsEveryMutableValue(t *testing.T) {
	s := Analyze(responseHistory())
	before, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	cloned := CloneSnapshot(s)
	*cloned.AsOf = 0
	*cloned.Body, *cloned.Range = 0, 0
	*cloned.BodyFraction, *cloned.ClosePosition = 0, 0
	*cloned.UpperWickFraction, *cloned.LowerWickFraction = 0, 0
	*cloned.RelativeBody, *cloned.RelativeRange, *cloned.RelativeVolume = 0, 0, 0
	cloned.LatestResponse.Direction = "modified"
	after, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("published clone aliases original snapshot")
	}
	if !reflect.DeepEqual(CloneSnapshot(Snapshot{}), Snapshot{}) {
		t.Fatal("cloning empty snapshot should preserve missing values")
	}
}

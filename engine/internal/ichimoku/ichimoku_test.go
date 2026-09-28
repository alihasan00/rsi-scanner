package ichimoku

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func candlesWithPrice(n int, price float64) []market.Candle {
	candles := make([]market.Candle, n)
	for i := range candles {
		candles[i] = market.Candle{
			OpenTime: int64(i) * 60_000, CloseTime: int64(i+1)*60_000 - 1,
			Open: price, High: price, Low: price, Close: price, Volume: 10,
		}
	}
	return candles
}

// At the150th close the displayed spans must come from index119. The isolated
// extremes deliberately separate every relevant window boundary, and index120
// must have no effect on the displayed cloud despite its much larger range.
func extremeFixture() []market.Candle {
	candles := candlesWithPrice(150, 100)
	for i := range candles {
		candles[i].Low, candles[i].High = 90, 110
	}
	candles[0].High = 1000
	candles[59].Low = 10
	candles[60].High = 200
	candles[100].Low = 60
	candles[120].Low, candles[120].High = 5, 2000
	return candles
}

func TestCurrentCloudUsesExactThirtyBarDisplacement(t *testing.T) {
	candles := extremeFixture()
	original := append([]market.Candle(nil), candles...)
	s := Analyze(candles, pointer(10.0))
	if s.Status != "ready" || s.Cloud.Status != "ready" || s.Kijun.Status != "ready" {
		t.Fatalf("unexpected readiness: %+v", s)
	}
	// At119: Tenkan=(110+60)/2=85, Kijun=(200+60)/2=130,
	// A=(85+130)/2=107.5; B=(1000+10)/2=505.
	assertFloat(t, s.Cloud.SpanA, 107.5)
	assertFloat(t, s.Cloud.SpanB, 505)
	assertFloat(t, s.Cloud.Lower, 107.5)
	assertFloat(t, s.Cloud.Upper, 505)
	if *s.Cloud.CalculatedAt != candles[119].CloseTime ||
		*s.Cloud.DisplayedAt != candles[149].CloseTime || *s.AsOf != candles[149].CloseTime ||
		*s.Cloud.DisplayedAt-*s.Cloud.CalculatedAt != 30*60_000 {
		t.Fatalf("wrong calculation/display timing: %+v", s.Cloud)
	}
	// Current Kijun uses90..149, including the later extreme at120.
	assertFloat(t, s.Kijun.Value, 1002.5)
	assertFloat(t, s.Kijun.DistanceATR, -90.25)
	if s.Cloud.Position != "below" || !reflect.DeepEqual(candles, original) {
		t.Fatal("unexpected price position or input mutation")
	}
	// Advancing one completed candle moves the calculation index exactly once.
	candles = append(candles, market.Candle{OpenTime: 150 * 60_000, CloseTime: 151*60_000 - 1,
		Open: 100, High: 110, Low: 90, Close: 100, Volume: 10})
	next := Analyze(candles, pointer(10.0))
	assertFloat(t, next.Cloud.SpanA, 1002.5)
	assertFloat(t, next.Cloud.SpanB, 1002.5)
	if *next.Cloud.CalculatedAt != candles[120].CloseTime {
		t.Fatalf("calculation index did not advance: %+v", next.Cloud)
	}
}

func TestWarmupIsIndependent(t *testing.T) {
	for _, n := range []int{0, 1, 59, 60, 61, 149, 150} {
		t.Run(strconv.Itoa(n), func(t *testing.T) {
			s := Analyze(candlesWithPrice(n, 100), pointer(2.0))
			if s.Bars != n || s.TenkanLength != 20 || s.KijunLength != 60 ||
				s.SpanBLength != 120 || s.DisplacementBars != 30 ||
				s.Kijun.WarmupBars != 60 || s.Cloud.WarmupBars != 150 {
				t.Fatalf("wrong metadata: %+v", s)
			}
			assertReadiness(t, "overall", s.Status, n >= 150)
			assertReadiness(t, "Kijun", s.Kijun.Status, n >= 60)
			assertReadiness(t, "slope", s.Kijun.SlopeStatus, n >= 61)
			assertReadiness(t, "cloud", s.Cloud.Status, n >= 150)
			if (s.AsOf != nil) != (n > 0) || (s.Kijun.Value != nil) != (n >= 60) ||
				(s.Kijun.Change1Bar != nil) != (n >= 61) || (s.Kijun.FlatBars != nil) != (n >= 61) ||
				(s.Cloud.CalculatedAt != nil) != (n >= 150) || (s.Cloud.DisplayedAt != nil) != (n >= 150) {
				t.Fatalf("unexpected partial values: %+v", s)
			}
			if n >= 61 && (*s.Kijun.FlatBars != n-60 || !s.Kijun.FlatHistoryBounded || s.Kijun.Slope != "flat") {
				t.Fatalf("wrong bounded flat duration: %+v", s.Kijun)
			}
		})
	}
}

func TestCloudDoesNotUseLaterCalculationWindows(t *testing.T) {
	candles := extremeFixture()
	before := Analyze(candles, pointer(1.0))
	for i := 120; i < len(candles); i++ {
		candles[i].Low, candles[i].High = 1, 10000
	}
	after := Analyze(candles, pointer(1.0))
	if !reflect.DeepEqual(before.Cloud, after.Cloud) {
		t.Fatalf("later data changed displayed cloud: before=%+v after=%+v", before.Cloud, after.Cloud)
	}
	if *before.Kijun.Value == *after.Kijun.Value {
		t.Fatal("fixture did not distinguish current Kijun from older displayed spans")
	}
}

func TestCloudPositionMirrorsAndIncludesBothBoundaries(t *testing.T) {
	for _, tt := range []struct {
		close    float64
		position string
	}{
		{106.5, "below"}, {107.5, "inside"}, {250, "inside"}, {505, "inside"}, {506, "above"},
	} {
		candles := extremeFixture()
		last := &candles[len(candles)-1]
		last.Open, last.High, last.Low, last.Close = tt.close, tt.close, tt.close, tt.close
		s := Analyze(candles, pointer(2.0))
		if s.Cloud.Position != tt.position {
			t.Fatalf("close %v: want %s, got %s", tt.close, tt.position, s.Cloud.Position)
		}
		mirrored := Analyze(mirror(candles, 10000), pointer(2.0))
		want := map[string]string{"below": "above", "above": "below", "inside": "inside"}[tt.position]
		if mirrored.Cloud.Position != want {
			t.Fatalf("mirrored close %v: want %s, got %s", tt.close, want, mirrored.Cloud.Position)
		}
		assertFloat(t, mirrored.Cloud.Lower, 10000-*s.Cloud.Upper)
		assertFloat(t, mirrored.Cloud.Upper, 10000-*s.Cloud.Lower)
		assertFloat(t, mirrored.Kijun.DistanceATR, -*s.Kijun.DistanceATR)
	}
	flat := Analyze(candlesWithPrice(150, 100), pointer(1.0))
	if flat.Cloud.Position != "inside" || *flat.Cloud.Lower != *flat.Cloud.Upper {
		t.Fatalf("equal boundary of zero-width cloud must be inside: %+v", flat.Cloud)
	}
}

func TestKijunChangeCanComeFromAnOldExtremeLeaving(t *testing.T) {
	candles := candlesWithPrice(62, 100)
	for i := range candles {
		candles[i].Low, candles[i].High = 90, 110
	}
	candles[0].High = 150
	candles[60].High = 140
	changed := Analyze(candles[:61], nil)
	assertFloat(t, changed.Kijun.Value, 115)
	assertFloat(t, changed.Kijun.Change1Bar, -5)
	if changed.Kijun.Slope != "falling" || *changed.Kijun.FlatBars != 0 || changed.Kijun.FlatHistoryBounded {
		t.Fatalf("newly changed value mislabeled: %+v", changed.Kijun)
	}
	flat := Analyze(candles, nil)
	assertFloat(t, flat.Kijun.Change1Bar, 0)
	if flat.Kijun.Slope != "flat" || *flat.Kijun.FlatBars != 1 || flat.Kijun.FlatHistoryBounded {
		t.Fatalf("known-start flat duration wrong: %+v", flat.Kijun)
	}
	rising := Analyze(mirror(candles[:61], 1000), nil)
	assertFloat(t, rising.Kijun.Change1Bar, 5)
	if rising.Kijun.Slope != "rising" {
		t.Fatalf("mirrored Kijun failed: %+v", rising.Kijun)
	}
}

func TestInvalidHistoryWithholdsAllEvidence(t *testing.T) {
	tests := map[string]func([]market.Candle){
		"gap":        func(c []market.Candle) { c[75].OpenTime++ },
		"overlap":    func(c []market.Candle) { c[75].OpenTime-- },
		"duration":   func(c []market.Candle) { c[149].CloseTime++ },
		"reversed":   func(c []market.Candle) { c[74], c[75] = c[75], c[74] },
		"nan_price":  func(c []market.Candle) { c[0].High = math.NaN() },
		"inf_price":  func(c []market.Candle) { c[0].High = math.Inf(1) },
		"zero_price": func(c []market.Candle) { c[0].Low = 0 },
		"bad_ohlc":   func(c []market.Candle) { c[0].Close = 101 },
		"bad_volume": func(c []market.Candle) { c[0].Volume = -1 },
		"bad_time":   func(c []market.Candle) { c[0].OpenTime = -1 },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			candles := candlesWithPrice(150, 100)
			mutate(candles)
			s := Analyze(candles, pointer(1.0))
			if !reflect.DeepEqual(s, initial(150, "invalid")) {
				t.Fatalf("malformed history leaked context: %+v", s)
			}
		})
	}
}

func TestATRAvailabilityDoesNotInvalidateRawContext(t *testing.T) {
	candles := extremeFixture()
	for _, tt := range []struct {
		name   string
		atr    *float64
		status string
	}{
		{"missing", nil, "missing_atr"}, {"zero", pointer(0.0), "zero_atr"},
		{"negative", pointer(-1.0), "invalid_atr"}, {"nan", pointer(math.NaN()), "invalid_atr"},
		{"infinity", pointer(math.Inf(1)), "invalid_atr"},
		{"overflow", pointer(math.SmallestNonzeroFloat64), "unrepresentable"},
		{"ready", pointer(2.0), "ready"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := Analyze(candles, tt.atr)
			if s.Status != "ready" || s.Kijun.Status != "ready" || s.Cloud.Status != "ready" ||
				s.Kijun.DistanceATRStatus != tt.status || (s.Kijun.DistanceATR != nil) != (tt.status == "ready") {
				t.Fatalf("unexpected ATR handling: %+v", s)
			}
			if _, err := json.Marshal(s); err != nil {
				t.Fatalf("non-finite output: %v", err)
			}
		})
	}
}

func TestExtremeFinitePricesRemainFinite(t *testing.T) {
	for _, price := range []float64{math.SmallestNonzeroFloat64, math.MaxFloat64 / 2, math.MaxFloat64} {
		s := Analyze(candlesWithPrice(150, price), pointer(1.0))
		if s.Status != "ready" || *s.Kijun.Value != price || *s.Cloud.SpanA != price || *s.Cloud.SpanB != price || s.Cloud.Position != "inside" {
			t.Fatalf("bad midpoint for %v: %+v", price, s)
		}
		if _, err := json.Marshal(s); err != nil {
			t.Fatalf("non-finite output for %v: %v", price, err)
		}
	}
	candles := candlesWithPrice(150, math.MaxFloat64)
	candles[110].Low = math.SmallestNonzeroFloat64
	s := Analyze(candles, pointer(1.0))
	assertFloat(t, s.Kijun.Value, math.MaxFloat64/2)
	assertFloat(t, s.Cloud.SpanA, math.MaxFloat64/2)
	if _, err := json.Marshal(s); err != nil {
		t.Fatalf("extreme range produced non-finite output: %v", err)
	}
}

func TestCloneOwnsEveryPointer(t *testing.T) {
	s := Analyze(extremeFixture(), pointer(1.0))
	before, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	clone := CloneSnapshot(s)
	mutatePointers(t, reflect.ValueOf(s), reflect.ValueOf(&clone).Elem())
	after, err := json.Marshal(s)
	if err != nil || string(before) != string(after) {
		t.Fatal("mutating a clone changed its source")
	}
	empty := Analyze(nil, nil)
	if !reflect.DeepEqual(empty, CloneSnapshot(empty)) {
		t.Fatal("cloning changed unavailable context")
	}
}

func mutatePointers(t *testing.T, original, clone reflect.Value) {
	t.Helper()
	for i := 0; i < clone.NumField(); i++ {
		a, b := original.Field(i), clone.Field(i)
		if b.Kind() == reflect.Struct {
			mutatePointers(t, a, b)
		} else if b.Kind() == reflect.Pointer && !b.IsNil() {
			if a.Pointer() == b.Pointer() {
				t.Fatalf("shared pointer field %s", clone.Type().Field(i).Name)
			}
			b.Elem().Set(reflect.Zero(b.Elem().Type()))
		}
	}
}

func mirror(candles []market.Candle, around float64) []market.Candle {
	result := append([]market.Candle(nil), candles...)
	for i, candle := range candles {
		result[i].Open, result[i].Close = around-candle.Open, around-candle.Close
		result[i].High, result[i].Low = around-candle.Low, around-candle.High
	}
	return result
}

func assertFloat(t *testing.T, actual *float64, want float64) {
	t.Helper()
	if actual == nil || *actual != want {
		t.Fatalf("want %v, got %v", want, actual)
	}
}

func assertReadiness(t *testing.T, name, status string, ready bool) {
	t.Helper()
	want := "insufficient"
	if ready {
		want = "ready"
	}
	if status != want {
		t.Fatalf("%s: want %s, got %s", name, want, status)
	}
}

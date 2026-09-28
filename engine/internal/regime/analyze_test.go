// Derived source distributed under CC BY-NC-SA 4.0; see types.go and README.md.
package regime

import (
	"encoding/json"
	"math"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func fixture() []market.Candle {
	closes := []float64{
		100, 101, 99, 102, 105, 103, 106, 110, 108, 112, 115, 111, 107, 104, 100, 98, 95, 93, 96, 99,
		103, 107, 110, 106, 102, 100, 97, 93, 90, 92, 95, 100, 106, 113, 117, 114, 108, 103, 97, 90,
		86, 88, 93, 100, 109, 116, 121, 117, 112, 105, 97, 91, 87, 92, 99, 107, 116, 124, 120, 113,
		104, 96, 89, 94, 103, 114, 126, 131, 125, 117, 108, 98, 92, 101, 112, 125, 137, 133, 123, 111,
		100, 94, 105, 119, 134, 141, 136, 125, 112, 101, 97, 109, 124, 139, 147, 142, 132, 118, 105, 98,
	}
	bars := make([]market.Candle, len(closes))
	for i, close := range closes {
		open := close
		if i > 0 {
			open = closes[i-1]
		}
		bars[i] = market.Candle{
			OpenTime: int64(i) * 1000, CloseTime: int64(i+1)*1000 - 1,
			Open: open, High: math.Max(open, close) + 1 + float64(i%3),
			Low: math.Min(open, close) - 1 - float64(i%2), Close: close, Volume: 1000,
		}
	}
	return bars
}

func near(t *testing.T, name string, actual *float64, expected float64) {
	t.Helper()
	if actual == nil || !finite(*actual) || math.Abs(*actual-expected) > 1e-11*math.Max(1, math.Abs(expected)) {
		t.Fatalf("%s: got %v, expected %.15g", name, actual, expected)
	}
}

// Golden values were computed independently with a literal, full-series Python
// translation of the Pine equations, arithmetic-mean Wilder seeds, percentile
// cluster seeds and a non-empty-best-cluster guard. That calculation does not
// use this package's recurrence, normalization or helpers. The changing best
// factors and actual flips exercise adaptation rather than only a fixed band.
func TestAdaptiveSupertrendGolden(t *testing.T) {
	for _, expected := range []struct {
		bars                    int
		atr, factor, stop, perf float64
		direction               string
		flip                    int
	}{
		{10, 5.8, 3, 126.9, 0, Bearish, -1},
		{15, 6.3906019999999994, 3, 122.171806, .5554509837090227, Bearish, -1},
		{28, 6.645848830089596, 4, 110.9873896257338, .48825533658188053, Bearish, -1},
		{40, 8.050636903829004, 3.625, 122.18355877638014, .500353187963709, Bearish, 37},
		{60, 9.762178712252158, 2.875, 101.88734754457813, 0, Bullish, 57},
		{80, 12.389864833047712, 1, 104.61013516695229, .22176983926380284, Bullish, 74},
		{100, 13.67039374081919, 1.5, 94.9022309155289, 0, Bullish, 92},
	} {
		t.Run(strconv.Itoa(expected.bars)+"_bars", func(t *testing.T) {
			t.Parallel()
			got := Analyze(fixture()[:expected.bars], DefaultConfig())
			near(t, "ATR", got.Supertrend.ATR, expected.atr)
			near(t, "factor", got.Supertrend.Factor, expected.factor)
			near(t, "stop", got.Supertrend.Stop, expected.stop)
			near(t, "performance index", got.Supertrend.PerformanceIndex, expected.perf)
			if got.Direction != expected.direction || got.Supertrend.Direction != expected.direction {
				t.Fatalf("direction = %s, expected %s", got.Direction, expected.direction)
			}
			if got.ClosedAt == nil || *got.ClosedAt != int64(expected.bars)*1000-1 {
				t.Fatalf("closed evidence timestamp = %v", got.ClosedAt)
			}
			if expected.flip == -1 {
				if got.Supertrend.LastFlipAt != nil || got.Supertrend.BarsSinceFlip != nil {
					t.Fatal("first initialized direction is not an actual trend flip")
				}
			} else if got.Supertrend.LastFlipAt == nil || *got.Supertrend.LastFlipAt != int64(expected.flip+1)*1000-1 || got.Supertrend.BarsSinceFlip == nil || *got.Supertrend.BarsSinceFlip != expected.bars-1-expected.flip {
				t.Fatalf("wrong flip evidence: %+v", got.Supertrend)
			}
		})
	}
}

// These small periods permit direct hand calculation independent of package
// smoothing: TR=[2,3,3,4,4], +DM=[2,1,0,0], -DM=[0,0,2,1]. At candle 4,
// ATR2=3.375, smoothed directional TR=3.5, +DM=.75 and -DM=1.
func TestWilderATRAndADXHandCalculated(t *testing.T) {
	bars := []market.Candle{
		{Open: 9, High: 10, Low: 8, Close: 9},
		{Open: 10, High: 12, Low: 9, Close: 11},
		{Open: 11, High: 13, Low: 10, Close: 12},
		{Open: 10, High: 12, Low: 8, Close: 9},
		{Open: 9, High: 11, Low: 7, Close: 8},
	}
	for i := range bars {
		bars[i].OpenTime, bars[i].CloseTime = int64(i)*1000, int64(i+1)*1000-1
	}
	cfg := DefaultConfig()
	cfg.ATRLength, cfg.DILength, cfg.ADXSmoothing = 2, 2, 2
	third := Analyze(bars[:3], cfg)
	near(t, "third ATR", third.Volatility.ATR, 2.75)
	near(t, "third DI+", third.Momentum.DIPlus, 50)
	near(t, "third DI-", third.Momentum.DIMinus, 0)
	if third.Momentum.ADX != nil || third.Momentum.Ready {
		t.Fatal("ADX must wait for two DX observations")
	}
	fourth := Analyze(bars[:4], cfg)
	near(t, "fourth ATR", fourth.Volatility.ATR, 3.375)
	near(t, "fourth ATR percent", fourth.Volatility.ATRPercent, 37.5)
	near(t, "fourth DI+", fourth.Momentum.DIPlus, 150.0/7)
	near(t, "fourth DI-", fourth.Momentum.DIMinus, 200.0/7)
	near(t, "fourth ADX", fourth.Momentum.ADX, 400.0/7)
	if fourth.Momentum.Direction != Bearish {
		t.Fatalf("momentum direction = %s", fourth.Momentum.Direction)
	}
	fifth := Analyze(bars, cfg)
	near(t, "fifth ATR", fifth.Volatility.ATR, 3.6875)
	near(t, "fifth ATR percent", fifth.Volatility.ATRPercent, 46.09375)
	near(t, "fifth DI+", fifth.Momentum.DIPlus, 10)
	near(t, "fifth DI-", fifth.Momentum.DIMinus, 80.0/3)
	near(t, "fifth ADX", fifth.Momentum.ADX, (400.0/7+500.0/11)/2)
	cfg.ADXThreshold = *fourth.Momentum.ADX
	if atThreshold := Analyze(bars[:4], cfg); atThreshold.Momentum.Direction != Neutral {
		t.Fatal("ADX must strictly exceed the configured threshold")
	}
}

func TestWarmupAndNullFields(t *testing.T) {
	cfg := DefaultConfig()
	for _, n := range []int{0, 1, 9, 10, 13, 14, 15, 27, 28} {
		got := Analyze(fixture()[:n], cfg)
		if got.WarmupBars != 28 || got.Supertrend.WarmupBars != 10 || got.Momentum.WarmupBars != 28 {
			t.Fatalf("incorrect warm-up metadata: %+v", got)
		}
		if (got.Supertrend.Stop != nil) != (n >= 10) || got.Supertrend.Ready != (n >= 10) {
			t.Fatalf("supertrend warm-up at %d bars", n)
		}
		if (got.Volatility.ATR != nil) != (n >= 14) || got.Volatility.Ready != (n >= 14) {
			t.Fatalf("ATR warm-up at %d bars", n)
		}
		if (got.Momentum.DIPlus != nil) != (n >= 15) || (got.Momentum.ADX != nil) != (n >= 28) || got.Ready != (n >= 28) {
			t.Fatalf("DI/ADX warm-up at %d bars: %+v", n, got.Momentum)
		}
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if n < 10 && !strings.Contains(string(data), `"stop":null`) {
			t.Fatalf("unavailable numeric must be explicit null: %s", data)
		}
	}
}

func TestFlatSeriesHasNeutralDirectionAndDefinedZeroVolatility(t *testing.T) {
	bars := fixture()[:40]
	for i := range bars {
		bars[i].Open, bars[i].High, bars[i].Low, bars[i].Close = 100, 100, 100, 100
	}
	got := Analyze(bars, DefaultConfig())
	if !got.Ready || got.Direction != Neutral || got.Momentum.Direction != Neutral {
		t.Fatalf("flat series should be available and neutral: %+v", got)
	}
	near(t, "flat ATR", got.Volatility.ATR, 0)
	near(t, "flat ATR percent", got.Volatility.ATRPercent, 0)
	near(t, "flat ADX", got.Momentum.ADX, 0)
	near(t, "flat DI+", got.Momentum.DIPlus, 0)
	near(t, "flat DI-", got.Momentum.DIMinus, 0)
	near(t, "tied factors mean", got.Supertrend.Factor, 3)
	near(t, "flat stop", got.Supertrend.Stop, 100)
	if got.Supertrend.PerformanceIndex != nil || got.Supertrend.LastFlipAt != nil {
		t.Fatal("zero denominator and absent actual flip must remain null")
	}
	if !strings.Contains(strings.Join(got.Warnings, " "), "non-empty cluster") {
		t.Fatal("degenerate cluster fallback must be disclosed")
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatal(err)
	}
}

func TestDirectionalMovementTiesContributeNeitherSide(t *testing.T) {
	bars := fixture()[:30]
	for i := range bars {
		bars[i].Open, bars[i].Close = 100, 100
		bars[i].High, bars[i].Low = 101+float64(i), 99-float64(i)
	}
	got := Analyze(bars, DefaultConfig())
	near(t, "tied DI+", got.Momentum.DIPlus, 0)
	near(t, "tied DI-", got.Momentum.DIMinus, 0)
	near(t, "tied ADX", got.Momentum.ADX, 0)
	if got.Momentum.Direction != Neutral {
		t.Fatal("equally expanding highs/lows must not imply a directional trend")
	}
}

// Recomputing every prefix before and after a longer replay catches hidden
// global state and dependence on a subsequently supplied endpoint. Appending
// bars cannot change already-established closed evidence or mutate its input.
func TestPrefixCausalityAndInputImmutability(t *testing.T) {
	bars := fixture()
	original := append([]market.Candle(nil), bars...)
	before := make([]Snapshot, len(bars)+1)
	for i := range before {
		before[i] = Analyze(bars[:i], DefaultConfig())
	}
	Analyze(bars, DefaultConfig())
	for i := range before {
		if after := Analyze(bars[:i], DefaultConfig()); !reflect.DeepEqual(before[i], after) {
			t.Fatalf("prefix %d changed after longer replay", i)
		}
	}
	if !reflect.DeepEqual(bars, original) {
		t.Fatal("Analyze mutated the caller's candles")
	}
	*before[100].Supertrend.Stop = 1
	if after := Analyze(bars, DefaultConfig()); *after.Supertrend.Stop == 1 {
		t.Fatal("returned numeric pointers share mutable state across analyses")
	}
}

func TestInvalidInputsReturnUnavailableJSON(t *testing.T) {
	for name, mutate := range map[string]func([]market.Candle){
		"nan close":       func(c []market.Candle) { c[5].Close = math.NaN() },
		"infinite high":   func(c []market.Candle) { c[5].High = math.Inf(1) },
		"negative volume": func(c []market.Candle) { c[5].Volume = -1 },
		"bad high":        func(c []market.Candle) { c[5].High = c[5].Low },
		"gap":             func(c []market.Candle) { c[5].OpenTime++ },
		"overlap":         func(c []market.Candle) { c[5].OpenTime-- },
		"unordered":       func(c []market.Candle) { c[4], c[5] = c[5], c[4] },
	} {
		t.Run(name, func(t *testing.T) {
			bars := fixture()
			mutate(bars)
			got := Analyze(bars, DefaultConfig())
			if got.Ready || got.ClosedAt != nil || got.Direction != Unavailable || got.Supertrend.Stop != nil || got.Volatility.ATR != nil || got.Momentum.ADX != nil || len(got.Warnings) == 0 {
				t.Fatalf("invalid data produced usable evidence: %+v", got)
			}
			if _, err := json.Marshal(got); err != nil {
				t.Fatal(err)
			}
		})
	}
	cfg := DefaultConfig()
	cfg.ADXThreshold = math.NaN()
	got := Analyze(fixture(), cfg)
	if got.Direction != Unavailable || got.Ready || len(got.Warnings) == 0 {
		t.Fatal("invalid configuration was accepted")
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatal("invalid config leaked a non-finite numeric into JSON:", err)
	}
}

func TestExtremeFinitePricesCannotLeakNonFiniteNumbers(t *testing.T) {
	bars := fixture()[:30]
	for i := range bars {
		bars[i].Open, bars[i].Close = 1, 1
		bars[i].High, bars[i].Low = math.MaxFloat64, 1
	}
	got := Analyze(bars, DefaultConfig())
	if got.Ready || got.Direction != Unavailable || !strings.Contains(strings.Join(got.Warnings, " "), "finite numeric range") {
		t.Fatalf("unrepresentable bands were accepted: %+v", got)
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatal(err)
	}
}

func TestClusteringIterationLimitIsDisclosed(t *testing.T) {
	cfg := DefaultConfig()
	cfg.MaxClusterIterations = 1
	got := Analyze(fixture(), cfg)
	if !strings.Contains(strings.Join(got.Warnings, " "), "iteration limit") {
		t.Fatal("bounded approximation was not disclosed")
	}
	if _, err := json.Marshal(got); err != nil {
		t.Fatal(err)
	}
}

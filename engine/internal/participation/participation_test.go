package participation

import (
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func bars(n int, duration int64) []market.Candle {
	out := make([]market.Candle, n)
	for i := range out {
		open := int64(i) * duration
		out[i] = market.Candle{OpenTime: open, CloseTime: open + duration - 1, Open: 10, High: 12, Low: 8, Close: 10, Volume: 10}
	}
	return out
}

func near(t *testing.T, got *float64, want float64) {
	t.Helper()
	if got == nil || math.Abs(*got-want) > 1e-10 {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRelativeVolumeExcludesCurrentAndOlderCandles(t *testing.T) {
	b := bars(22, 3600000)
	b[0].Volume = 10000 // Outside the prior-20 baseline.
	b[21].Volume = 100  // Must not dilute its own relative-volume measurement.
	s := Analyze(b)
	if s.Status != "ready" || s.ReferenceBars != 20 || s.BaselineBars != 20 || *s.AsOf != b[21].CloseTime {
		t.Fatalf("unexpected availability: %+v", s)
	}
	near(t, s.CurrentBaseVolume, 100)
	near(t, s.PriorMeanBaseVolume, 10)
	near(t, s.RelativeVolume, 10)
	warm := Analyze(b[:20])
	if warm.Status != "insufficient" || warm.RelativeVolume != nil || warm.PriorMeanBaseVolume != nil || warm.ReferenceBars != 19 || warm.RollingVWAP.Status != "ready" {
		t.Fatalf("RVOL baseline incorrectly includes current candle: %+v", warm)
	}
}

func TestZeroVolumeIsValidAndZeroBaselineIsUnavailable(t *testing.T) {
	b := bars(24, 3600000)
	b[23].Volume = 0
	s := Analyze(b)
	if s.Status != "ready" {
		t.Fatalf("zero current volume rejected: %+v", s)
	}
	near(t, s.RelativeVolume, 0)
	for i := range b {
		b[i].Volume = 0
	}
	s = Analyze(b)
	if s.Status != "zero_baseline" || s.RelativeVolume != nil || s.RollingVWAP.Status != "zero_volume" || s.RollingVWAP.Value != nil || s.VWAPRelation != "unavailable" || s.QuoteTurnover24h.Status != "ready" {
		t.Fatalf("zero baseline became fictitious evidence: %+v", s)
	}
	near(t, s.PriorMeanBaseVolume, 0)
	near(t, s.QuoteTurnover24h.EstimatedValue, 0)
	b[23].Volume = 10
	s = Analyze(b)
	if s.Status != "zero_baseline" || s.RollingVWAP.Status != "ready" {
		t.Fatalf("independent metric availability was lost: %+v", s)
	}
}

func TestRollingVWAPUsesHLC3AndCurrentCandleVolume(t *testing.T) {
	b := bars(21, 3600000)
	b[0].Volume = 1000 // Outside the rolling window.
	for i := 1; i < len(b); i++ {
		b[i].Volume = 1
	}
	b[20].Open, b[20].High, b[20].Low, b[20].Close, b[20].Volume = 20, 24, 18, 21, 3
	s := Analyze(b)
	if s.RollingVWAP.Status != "ready" || s.RollingVWAP.Bars != 20 || s.VWAPRelation != "above" {
		t.Fatalf("unexpected VWAP: %+v", s)
	}
	near(t, s.RollingVWAP.Value, (19*10+3*21.0)/22)
}

func TestTurnoverRequiresExactlyCoveredCompleted24Hours(t *testing.T) {
	for _, test := range []struct {
		name     string
		count    int
		duration int64
		status   string
		value    float64
		counted  int
	}{
		{"hourly", 25, 3600000, "ready", 2400, 24},
		{"quarter hourly", 100, 900000, "ready", 9600, 96},
		{"daily", 1, dayMillis, "ready", 100, 1},
		{"short history", 23, 3600000, "insufficient", 0, 23},
		{"nondividing interval", 30, 5 * 3600000, "unsupported_interval", 0, 0},
		{"long interval", 30, 2 * dayMillis, "unsupported_interval", 0, 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			b := bars(test.count, test.duration)
			if test.count > test.counted && test.counted > 0 {
				b[0].Volume = 10000 // Must not leak into the trailing-24h sum.
			}
			got := Analyze(b).QuoteTurnover24h
			if got.Status != test.status || got.Bars != test.counted {
				t.Fatalf("unexpected turnover availability: %+v", got)
			}
			if test.status == "ready" {
				near(t, got.EstimatedValue, test.value)
			} else if got.EstimatedValue != nil {
				t.Fatal("partial turnover presented as a complete day")
			}
		})
	}
}

func TestGapsMalformedBarsAndOverflowNeverProduceUsableEvidence(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func([]market.Candle)
	}{
		{"gap", func(b []market.Candle) { b[10].OpenTime++; b[10].CloseTime++ }},
		{"unequal duration", func(b []market.Candle) { b[10].CloseTime-- }},
		{"negative volume", func(b []market.Candle) { b[10].Volume = -1 }},
		{"invalid price", func(b []market.Candle) { b[10].Close = math.NaN() }},
	} {
		t.Run(test.name, func(t *testing.T) {
			b := bars(25, 3600000)
			test.mutate(b)
			s := Analyze(b)
			if s.Status != "invalid" || s.RelativeVolume != nil || s.RollingVWAP.Value != nil || s.QuoteTurnover24h.EstimatedValue != nil {
				t.Fatalf("invalid history used: %+v", s)
			}
			if a := AnchoredVWAP(b, b[0].CloseTime); a.Status != "invalid" || a.Value != nil {
				t.Fatalf("anchored VWAP bridged invalid history: %+v", a)
			}
		})
	}
	b := bars(24, 3600000)
	for i := range b {
		b[i].Volume = math.MaxFloat64
	}
	s := Analyze(b)
	if s.QuoteTurnover24h.Status != "invalid" || s.QuoteTurnover24h.EstimatedValue != nil {
		t.Fatal("nonfinite turnover escaped")
	}
	if s.RollingVWAP.Status != "ready" {
		t.Fatal("normalized VWAP weighting overflowed")
	}
}

func TestAnchoredVWAPExcludesStraddlingCandleAndRequiresCoverage(t *testing.T) {
	b := bars(3, 3600000)
	b[0].Volume = 10000
	b[1].Volume, b[2].Volume = 1, 3
	b[2].Open, b[2].High, b[2].Low, b[2].Close = 20, 22, 18, 20
	for _, anchor := range []int64{1800000, b[0].CloseTime} {
		got := AnchoredVWAP(b, anchor)
		if got.Status != "ready" || got.Bars != 2 || *got.AsOf != b[2].CloseTime {
			t.Fatalf("incorrect fully post-anchor window: %+v", got)
		}
		near(t, got.Value, 17.5)
	}
	for _, input := range []struct {
		b      []market.Candle
		anchor int64
	}{
		{b[2:], b[0].CloseTime}, // Earlier post-anchor bar is unavailable.
		{b, b[2].CloseTime},     // No fully subsequent closed candle yet.
		{nil, 0},
	} {
		if got := AnchoredVWAP(input.b, input.anchor); got.Status != "insufficient" || got.Value != nil {
			t.Fatalf("missing history became anchored evidence: %+v", got)
		}
	}
}

func TestInputsFutureSuffixAndPublishedValuesAreIndependent(t *testing.T) {
	b := bars(30, 3600000)
	before := append([]market.Candle(nil), b...)
	s := Analyze(b[:25])
	a := AnchoredVWAP(b[:25], b[5].CloseTime)
	if !reflect.DeepEqual(b, before) {
		t.Fatal("analysis mutated input candles")
	}
	for i := 25; i < len(b); i++ {
		b[i].Volume = 1e12
		b[i].High = 1e12
	}
	if !reflect.DeepEqual(s, Analyze(b[:25])) || !reflect.DeepEqual(a, AnchoredVWAP(b[:25], b[5].CloseTime)) {
		t.Fatal("future suffix changed a completed prefix")
	}
	clone := CloneSnapshot(s)
	*clone.AsOf = 1
	*clone.CurrentBaseVolume = 2
	*clone.PriorMeanBaseVolume = 3
	*clone.RelativeVolume = 4
	*clone.RollingVWAP.Value = 5
	*clone.RollingVWAP.AsOf = 6
	*clone.QuoteTurnover24h.EstimatedValue = 7
	*clone.QuoteTurnover24h.AsOf = 8
	if !reflect.DeepEqual(s, Analyze(b[:25])) {
		t.Fatal("published snapshot retained shared pointers")
	}
}

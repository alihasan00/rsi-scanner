package selection

import (
	"math"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

func relativeFixture(now time.Time, n int) (scanner.Snapshot, map[string]scanner.History) {
	s, h := selectionFixture(now, "bullish", "TESTUSDT", "BTCUSDT", "ETHUSDT")
	for _, symbol := range []string{"TESTUSDT", "BTCUSDT", "ETHUSDT"} {
		rate := 1.001
		if symbol == "BTCUSDT" {
			rate = 1.002
		}
		if symbol == "ETHUSDT" {
			rate = 1.0005
		}
		for _, tf := range []string{"1h", "4h"} {
			f := selectionSeries(&s, symbol, tf)
			width, _ := time.ParseDuration(tf)
			bars := make([]market.Candle, n)
			for i := range bars {
				at := f.LastClosedAt - int64(n-1-i)*width.Milliseconds()
				v := 100 * math.Pow(rate, float64(i))
				bars[i] = market.Candle{OpenTime: at - width.Milliseconds() + 1, CloseTime: at, Open: v, High: v + 1, Low: v - 1, Close: v}
			}
			h[pair(symbol, tf)] = scanner.History{Candles: bars}
		}
	}
	return s, h
}

func relativeRow(t *testing.T, rows []strategies.RelativeStrength, benchmark, tf string) strategies.RelativeStrength {
	t.Helper()
	for _, r := range rows {
		if r.Benchmark == benchmark && r.Interval == tf {
			return r
		}
	}
	t.Fatal("missing ratio row")
	return strategies.RelativeStrength{}
}

func TestRelativeRatioReturnIsNotAbsoluteReturnOrRSIDifference(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 31, 0, 0, time.UTC)
	s, h := relativeFixture(now, 200)
	rows := relativeContexts("TESTUSDT", s, h, now, time.Minute)
	btc := relativeRow(t, rows, "BTCUSDT", "1h")
	eth := relativeRow(t, rows, "ETHUSDT", "1h")
	want := 100 * (math.Pow(1.001/1.002, 24) - 1)
	if btc.Status != "ready" || btc.RSI14 == nil || *btc.RSI14 != 0 || *btc.AbsoluteReturn24h <= 0 || math.Abs(*btc.RatioReturn24h-want) > 1e-10 || *eth.RSI14 != 100 || *eth.RatioReturn24h <= 0 {
		t.Fatalf("wrong relative context: BTC%+v ETH%+v", btc, eth)
	}
	if *btc.RSIChange3 != 0 || btc.Last50CrossAt != nil {
		t.Fatal("manufactured cross or RSI change")
	}
	self := relativeRow(t, relativeContexts("BTCUSDT", s, h, now, time.Minute), "BTCUSDT", "1h")
	if self.Status != "not_applicable" || self.RSI14 != nil || self.AbsoluteReturn24h == nil {
		t.Fatal("self benchmark should have only absolute context")
	}
}

func TestRelativeAvailabilityAndIndependentWarmup(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 31, 0, 0, time.UTC)
	for _, cause := range []string{"short", "missing", "gap", "duplicate", "stale", "preview"} {
		t.Run(cause, func(t *testing.T) {
			n := 200
			if cause == "short" {
				n = 30
			}
			s, h := relativeFixture(now, n)
			switch cause {
			case "missing":
				delete(h, "BTCUSDT/1h")
			case "gap":
				b := h["BTCUSDT/1h"].Candles
				h["BTCUSDT/1h"] = scanner.History{Candles: append(b[:10:10], b[11:]...)}
			case "duplicate":
				s.Series = append(s.Series, *selectionSeries(&s, "BTCUSDT", "1h"))
			case "stale":
				selectionSeries(&s, "BTCUSDT", "1h").Stale = true
			case "preview":
				v := h["BTCUSDT/1h"]
				v.Preview = &market.Candle{Close: 1e9}
				h["BTCUSDT/1h"] = v
			}
			r := relativeRow(t, relativeContexts("TESTUSDT", s, h, now, time.Minute), "BTCUSDT", "1h")
			if r.AbsoluteReturn24h == nil {
				t.Fatal("valid absolute return lost")
			}
			if cause == "short" {
				if r.Status != "partial" || r.RatioReturn7d != nil || r.RSI14 == nil {
					t.Fatalf("warmup: %+v", r)
				}
				return
			}
			if cause == "preview" {
				if r.Status != "ready" || *r.RSI14 != 0 {
					t.Fatal("preview leaked")
				}
				return
			}
			if r.Status != "benchmark_unavailable" || r.RatioReturn24h != nil || r.RSI14 != nil {
				t.Fatalf("missing evidence passed: %+v", r)
			}
		})
	}
}

func TestWilderRatioRSISeedAndCross(t *testing.T) {
	values := []float64{44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00}
	r := ratioRSI(values)
	if r[13] != nil || math.Abs(*r[14]-70.464135) > 1e-5 || math.Abs(*r[15]-66.249619) > 1e-5 {
		t.Fatalf("Wilder seed/update incorrect: %v %v", *r[14], *r[15])
	}
	flat := make([]float64, 18)
	for i := range flat {
		flat[i] = 1
	}
	f := ratioRSI(flat)
	if *f[17] != 50 {
		t.Fatal("flat ratio RSI must be50")
	}
	now := time.Date(2026, 9, 26, 12, 31, 0, 0, time.UTC)
	s, h := relativeFixture(now, 30)
	a, b := h["TESTUSDT/1h"].Candles, h["BTCUSDT/1h"].Candles
	for i := range a {
		a[i].Open, a[i].High, a[i].Low, a[i].Close = 100, 101, 99, 100
		b[i].Open, b[i].High, b[i].Low, b[i].Close = 100, 101, 99, 100
	}
	a[29].Open, a[29].High, a[29].Low, a[29].Close = 102, 103, 101, 102
	c := relativeRow(t, relativeContexts("TESTUSDT", s, h, now, time.Minute), "BTCUSDT", "1h")
	if c.Last50CrossAt == nil || *c.Last50CrossAt != a[29].CloseTime || c.Last50CrossDirection != "bullish" {
		t.Fatalf("cross time not preserved: %+v", c)
	}
}

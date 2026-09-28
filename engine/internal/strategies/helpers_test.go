package strategies

import (
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

func TestStrategyTargetUsesOnlyKnownUntouchedPivots(t *testing.T) {
	bars := []market.Candle{}
	for i := 0; i < 16; i++ {
		bars = revTestAppend(bars, [4]float64{100, 101, 99, 100})
	}
	in := revTestInput(bars)
	hourly := []market.Candle{}
	for i, high := range []float64{105, 110, 106} {
		open := int64(i) * 3600000
		hourly = append(hourly, market.Candle{OpenTime: open, CloseTime: open + 3599999, Open: 100, High: high, Low: 99, Close: 100, Volume: 100})
	}
	in.Histories["1h"] = scanner.History{Candles: hourly}
	in.Frames["1h"] = scanner.SeriesSummary{Symbol: in.Symbol, Interval: "1h", LastClosedAt: hourly[2].CloseTime, ObservedAt: time.UnixMilli(bars[15].CloseTime + 1)}
	if got := strategyTarget(in, "bullish", hourly[1].CloseTime, 100); got != nil {
		t.Fatalf("pivot borrowed future confirming candle: %v", *got)
	}
	if got := strategyTarget(in, "bullish", hourly[2].CloseTime, 100); got == nil || *got != 110 {
		t.Fatalf("known hourly pivot missing: %v", got)
	}
	// The next hourly candle is unfinished. Its completed 15m candle already
	// consumed the level and must prevent selecting the stale hourly target.
	bars[15].High = 110
	if got := strategyTarget(in, "bullish", bars[15].CloseTime, 100); got != nil {
		t.Fatalf("target survived completed lower-frame touch: %v", *got)
	}
	// A frozen earlier assessment cannot see that future touch.
	if got := strategyTarget(in, "bullish", hourly[2].CloseTime, 100); got == nil || *got != 110 {
		t.Fatal("future touch rewrote earlier target availability")
	}
}

func TestStrategyATRWithholdsUnseededAndZeroRiskScale(t *testing.T) {
	bars := []market.Candle{}
	for i := 0; i < 15; i++ {
		bars = revTestAppend(bars, [4]float64{100, 100, 100, 100})
	}
	if _, ok := strategyATR(bars, 12); ok {
		t.Fatal("ATR available before14 completed true ranges")
	}
	if _, ok := strategyATR(bars, 14); ok {
		t.Fatal("zero risk scale allowed")
	}
	bars[14].High = 114
	value, ok := strategyATR(bars, 14)
	if !ok || value != 1 {
		t.Fatalf("wrong frozen true-range mean: %v,%t", value, ok)
	}
}

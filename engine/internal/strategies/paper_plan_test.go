package strategies

import (
	"math"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func paperPlanBars(count int) []market.Candle {
	const day = int64(86_400_000)
	bars := make([]market.Candle, count)
	for i := range bars {
		bars[i] = market.Candle{OpenTime: int64(i) * day, CloseTime: int64(i+1)*day - 1,
			Open: 100, High: 102, Low: 98, Close: 100, Volume: 10}
	}
	return bars
}

func TestPaperFixedPlanFreezesSourceEntryAndRetiresOnLaterTouch(t *testing.T) {
	bars := paperPlanBars(56)
	plan, ok := paperFreezeFixed(bars, 55, "bullish", 90, 130)
	if !ok || math.Abs(plan.ATR-4) > 1e-12 || plan.EntryMin != 99 || plan.EntryMax != 101 ||
		plan.ExpiresAt != bars[55].CloseTime+4*86_400_000 {
		t.Fatalf("unexpected frozen plan: %+v, ok=%v", plan, ok)
	}
	if !paperAssessFixed(plan, bars, 55, "bullish", bars[55].CloseTime+1) {
		t.Fatal("fresh completed confirmation must qualify")
	}
	later := append(append([]market.Candle{}, bars...), market.Candle{OpenTime: 56 * 86_400_000,
		CloseTime: 57*86_400_000 - 1, Open: 100, High: 103, Low: 89, Close: 100, Volume: 10})
	if paperAssessFixed(plan, later, 55, "bullish", later[56].CloseTime+1) {
		t.Fatal("a later stop touch must permanently retire the plan")
	}
	if paperAssessFixed(plan, bars, 55, "bullish", plan.ExpiresAt) {
		t.Fatal("the four-source-bar window must expire")
	}
}

func TestPaperStructuralTargetUsesKnownStrictPivotsOnly(t *testing.T) {
	bars := paperPlanBars(20)
	bars[5].High = 120
	target, ok := paperStructuralTarget(bars, 12, 15, "bullish", 110)
	if !ok || target != 120 {
		t.Fatalf("expected known opposing pivot 120, got %v, %v", target, ok)
	}
	bars[14].High = 120
	if _, ok := paperStructuralTarget(bars, 12, 15, "bullish", 110); ok {
		t.Fatal("a consumed target must not be reused")
	}
	bars[14].High = 102
	bars[16].High = 112
	if target, ok := paperStructuralTarget(bars, 12, 15, "bullish", 110); !ok || target != 120 {
		t.Fatal("a future pivot must not revise the frozen target")
	}
}

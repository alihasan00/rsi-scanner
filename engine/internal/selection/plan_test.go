package selection

import (
	"math"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/structure"
)

func TestNetRiskIncludesCostsOnWinsAndLosses(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		sign := directionSign(direction)
		p := referencePlan(direction, 100, 100-sign*.5, 100+sign*.5, Config{FeeBPS: 20, MinNetRR: 1})
		if p.Status != "cost_blocked" || p.GrossRR == nil || *p.GrossRR != 1 || p.NetRR == nil || math.Abs(*p.NetRR-3.0/7.0) > 1e-12 || p.ExecutionVerified {
			t.Fatalf("cost handling wrong for %s: %+v", direction, p)
		}
	}
}

func TestAssessmentMatchesSelectionAndCostRejection(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		snapshot, histories := selectionFixture(now, direction, "BTCUSDT")
		quote := 100 + directionSign(direction)*5
		selectionSeries(&snapshot, "BTCUSDT", "1h").Price = quote
		row := snapshot.Rows[0]
		a := AssessCandidate(snapshot, histories, row, now, time.Minute)
		w := Build(snapshot, histories, []string{"BTCUSDT"}, now, time.Minute)
		if a.Eligible || a.Code != "cost_or_liquidity" || a.Candidate == nil || a.Candidate.Plan.Status != "cost_blocked" || len(w.Items) != 0 || w.CostFiltered != 1 {
			t.Fatalf("gross 1:1 escaped net gate: %+v %+v", a, w)
		}
		zero := Config{MinNetRR: 1}
		a = AssessCandidate(snapshot, histories, row, now, time.Minute, zero)
		if !a.Eligible {
			t.Fatalf("explicit zero-cost diagnostic differs: %+v", a)
		}
	}
}

func TestTurnoverGateFailsClosedWithoutMakingRvolDirectional(t *testing.T) {
	p := referencePlan("bullish", 100, 90, 120, DefaultConfig())
	v := participation.Snapshot{}
	cfg := DefaultConfig()
	cfg.MinTurnover24h = 1000000
	applyTurnover(&p, v, cfg)
	if p.Status != "liquidity_unavailable" {
		t.Fatal("missing turnover passed explicit floor")
	}
	p = referencePlan("bullish", 100, 90, 120, DefaultConfig())
	v.Status = "ready"
	v.RelativeVolume = number(0)
	applyTurnover(&p, v, DefaultConfig())
	if p.Status != "awaiting_trigger" {
		t.Fatal("low RVOL alone changed direction/eligibility")
	}
}

func TestSizingUsesCostsExposureFreshnessAndUserLimits(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	a := &Account{AsOf: now, Equity: 3000, RiskPercent: .25, MaxOpenRiskPercent: 1, MaxDailyLossPercent: 1, MaxPositions: 3, MaxSameDirection: 2, Positions: []Exposure{}}
	cfg := DefaultConfig()
	cfg.Account = a
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	p := referencePlan("bullish", 100, 99, 103, cfg)
	applySizing(&p, "BTCUSDT", "bullish", cfg, now)
	if p.SizingStatus != "indicative_exposure_unverified" || p.RiskBudgetQuote == nil || math.Abs(*p.RiskBudgetQuote-7.5) > 1e-10 || math.Abs(*p.Quantity-7.5/1.3) > 1e-10 {
		t.Fatalf("incorrect indicative sizing %+v", p)
	}
	a.ExposureVerified = true
	a.Positions = []Exposure{{Symbol: "ETHUSDT", Direction: "bullish", RiskQuote: 28}}
	p = referencePlan("bullish", 100, 99, 103, cfg)
	applySizing(&p, "BTCUSDT", "bullish", cfg, now)
	if p.RiskBudgetQuote == nil || math.Abs(*p.RiskBudgetQuote-2) > 1e-10 {
		t.Fatalf("aggregate risk exceeded: %+v", p)
	}
	for _, mutate := range []func(){func() { a.Positions[0].Symbol = "BTCUSDT" }, func() { a.Positions[0].Symbol = "ETHUSDT"; a.DailyLossQuote = 30 }, func() { a.DailyLossQuote = 0; a.AsOf = now.Add(-16 * time.Minute) }} {
		mutate()
		p = referencePlan("bullish", 100, 99, 103, cfg)
		applySizing(&p, "BTCUSDT", "bullish", cfg, now)
		if p.SizingStatus != "blocked" || p.Quantity != nil {
			t.Fatalf("risk limit bypassed %+v", p)
		}
	}
}

func TestPlansRequireRealReferenceLevels(t *testing.T) {
	for _, test := range []struct {
		stop, target float64
		want         string
	}{{0, 110, "invalid_stop"}, {99, 0, "no_target"}, {101, 110, "invalid_stop"}} {
		p := referencePlan("bullish", 100, test.stop, test.target, DefaultConfig())
		if p.Status != test.want || p.ExecutionVerified || p.NetRR != nil {
			t.Fatalf("manufactured reference %+v", p)
		}
	}
}

func TestRemainingDailyAllowanceCapsNewRisk(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 0, 0, time.UTC)
	cfg := DefaultConfig()
	cfg.Account = &Account{ExposureVerified: true, AsOf: now, Equity: 3000, RiskPercent: .25, MaxOpenRiskPercent: 1, MaxDailyLossPercent: 1, DailyLossQuote: 29, MaxPositions: 3, MaxSameDirection: 2}
	p := referencePlan("bullish", 100, 99, 103, cfg)
	applySizing(&p, "BTCUSDT", "bullish", cfg, now)
	if p.RiskBudgetQuote == nil || math.Abs(*p.RiskBudgetQuote-1) > 1e-10 {
		t.Fatalf("daily allowance exceeded: %+v", p)
	}
}

func TestExtremeReferenceArithmeticFailsClosed(t *testing.T) {
	p := referencePlan("bullish", 1e-300, math.Nextafter(1e-300, 0), 1e300, DefaultConfig())
	if p.Status != "invalid_arithmetic" || p.NetRR != nil {
		t.Fatalf("nonfinite ratio escaped: %+v", p)
	}
}

func TestOpposingTargetNeedsCompleteMatchingHistory(t *testing.T) {
	width := int64(4 * time.Hour / time.Millisecond)
	bars := []market.Candle{}
	for i := int64(0); i < 3; i++ {
		bars = append(bars, market.Candle{OpenTime: i * width, CloseTime: (i+1)*width - 1, Open: 100, High: 104, Low: 99, Close: 100, Volume: 1})
	}
	s := scanner.SeriesSummary{Symbol: "BTCUSDT", Interval: "4h", LastClosedAt: bars[2].CloseTime, Analysis: scanner.SeriesAnalysis{Structure: structure.Snapshot{Status: "ready", Internal: structure.State{High: &structure.Pivot{Price: 110, ConfirmedAt: bars[0].CloseTime}}}}}
	h := map[string]scanner.History{"BTCUSDT/4h": {Candles: bars}}
	if got := NearestObstacle("BTCUSDT", "bullish", 100, []scanner.SeriesSummary{s}, h); got == nil || *got != 110 {
		t.Fatal("known unbroken target lost")
	}
	h["BTCUSDT/4h"] = scanner.History{Candles: []market.Candle{bars[0], bars[2]}}
	if got := NearestObstacle("BTCUSDT", "bullish", 100, []scanner.SeriesSummary{s}, h); got != nil {
		t.Fatal("gap manufactured unbroken target")
	}
}

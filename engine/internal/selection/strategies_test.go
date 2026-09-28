package selection

import (
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

func strategyTestFixture(now time.Time) (scanner.Snapshot, map[string]scanner.History) {
	snapshot, histories := trendFixture(now, "bullish", "TESTUSDT")
	for _, tf := range intervals {
		frame := trendFixtureSeries(&snapshot, "TESTUSDT", tf)
		width, _ := time.ParseDuration(tf)
		if tf == "1d" {
			width = 24 * time.Hour
		}
		count := 60
		if tf == "15m" {
			count = 144
		}
		bars := make([]market.Candle, count)
		for i := range bars {
			closed := frame.LastClosedAt - int64(count-1-i)*width.Milliseconds()
			bars[i] = market.Candle{OpenTime: closed - width.Milliseconds() + 1, CloseTime: closed, Open: 100, High: 101, Low: 99, Close: 100, Volume: 1000}
		}
		frame.Price = 100
		frame.ClosedCandles = count
		frame.FirstOpenTime = bars[0].OpenTime
		histories["TESTUSDT/"+tf] = scanner.History{Candles: bars}
	}
	return snapshot, histories
}

func strategyTestPlan(t *testing.T, now time.Time, direction string) (strategies.Opportunity, strategies.Input) {
	t.Helper()
	s, h := strategyTestFixture(now)
	in, ok := strategyInput(s, h, "TESTUSDT", now, time.Minute)
	if !ok {
		t.Fatal("invalid strategy fixture")
	}
	trigger := in.Frames["1h"].LastClosedAt
	stop, target := 95.0, 110.0
	if direction == "bearish" {
		stop, target = 105, 90
	}
	o := strategies.Opportunity{Version: strategies.Version, ID: "fixture", ParentID: "fixture-parent", Family: strategies.FVGPullback, Symbol: "TESTUSDT", Interval: "1h", Direction: direction,
		State: "entry_confirmed", AvailableAt: trigger - time.Hour.Milliseconds(), LocationAvailableAt: trigger - 2*time.Hour.Milliseconds(), SourceStartAt: trigger - 3*time.Hour.Milliseconds(), SourceEndAt: trigger - time.Hour.Milliseconds(), AsOf: trigger,
		TriggerAt: strategyTestPtr(trigger), ExpiresAt: strategyTestPtr(trigger + 4*time.Hour.Milliseconds()), Stop: strategyTestPtr(stop), Target: strategyTestPtr(target), EntryReference: strategyTestPtr(100.0), ReferenceATR: strategyTestPtr(2.0), EntryMin: strategyTestPtr(99.0), EntryMax: strategyTestPtr(101.0), Reason: "fixture", Next: "review", Invalidation: "stop"}
	return o, in
}

func strategyTestPtr[T any](v T) *T { return &v }

func TestIndependentStrategyAssessmentSharesCostsBoundsAndSizing(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, mode := range []string{"ready", "quote", "closed", "cost", "account"} {
			o, in := strategyTestPlan(t, now, direction)
			cfg := DefaultConfig()
			want := "ready_for_review"
			switch mode {
			case "quote":
				frame := in.Frames["15m"]
				frame.Price = 101.1
				in.Frames["15m"] = frame
				want = "entry_distance_or_levels"
			case "closed":
				bars := in.Histories["15m"].Candles
				bars[len(bars)-1].High = 101.2
				bars[len(bars)-1].Close = 101.1
				want = "entry_distance_or_levels"
			case "cost":
				cfg.MinNetRR = 3
				want = "cost_blocked"
			case "account":
				cfg.Account = &Account{AsOf: now, Equity: 3000, RiskPercent: .25, MaxOpenRiskPercent: 1, MaxDailyLossPercent: 1, MaxPositions: 3, MaxSameDirection: 2, ExposureVerified: true, DailyLossQuote: 30}
				want = "account_blocked"
			}
			got := assessStrategy(o, in, now, cfg)
			if got.Status != want || got.Eligible != (mode == "ready") || got.Plan.ExecutionVerified {
				t.Fatalf("%s/%s: %+v", direction, mode, got)
			}
		}
	}
}

func TestIndependentStrategyPostTrigger15mTouchCannotRecover(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, mode := range []string{"stop", "target", "both", "pretrigger", "preview"} {
			o, in := strategyTestPlan(t, now, direction)
			bars := in.Histories["15m"].Candles
			index := len(bars) - 2
			if mode == "pretrigger" {
				index -= 2
			}
			bar := &bars[index]
			if mode == "preview" {
				preview := bars[len(bars)-1]
				preview.OpenTime += 900000
				preview.CloseTime += 900000
				h := in.Histories["15m"]
				h.Preview = &preview
				in.Histories["15m"] = h
				bar = h.Preview
			}
			if mode != "target" {
				if direction == "bullish" {
					bar.Low = *o.Stop
				} else {
					bar.High = *o.Stop
				}
			}
			if mode == "target" || mode == "both" {
				if direction == "bullish" {
					bar.High = *o.Target
				} else {
					bar.Low = *o.Target
				}
			}
			want := "invalidated"
			if mode == "target" {
				want = "target_reached"
			}
			if mode == "pretrigger" || mode == "preview" {
				want = "ready_for_review"
			}
			got := assessStrategy(o, in, now, DefaultConfig())
			if got.Status != want {
				t.Fatalf("%s/%s: %+v", direction, mode, got)
			}
			if want != "ready_for_review" && (got.Eligible || got.Opportunity.ResolvedAt == nil || got.Opportunity.State != want || got.Opportunity.Reason != got.Reason) {
				t.Fatalf("terminal price evidence inconsistent: %+v", got)
			}
			if o.State != "entry_confirmed" || o.ResolvedAt != nil {
				t.Fatal("assessment mutated source opportunity")
			}
		}
	}
}

func TestIndependentStrategyMissingHistoryAndExpiryAreExplicit(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	for _, mode := range []string{"missing_prefix", "missing_bars", "expired", "invalid_expiry", "future_trigger", "invalid_bounds"} {
		o, in := strategyTestPlan(t, now, "bullish")
		want := "invalid_evidence"
		switch mode {
		case "missing_prefix":
			h := in.Histories["15m"]
			h.Candles = h.Candles[len(h.Candles)-1:]
			in.Histories["15m"] = h
			want = "data_unavailable"
		case "missing_bars":
			in.Histories["15m"] = scanner.History{}
			want = "data_unavailable"
		case "expired":
			*o.ExpiresAt = now.Add(-time.Second).UnixMilli()
			want = "expired"
		case "invalid_expiry":
			*o.ExpiresAt = *o.TriggerAt - 1
		case "future_trigger":
			*o.TriggerAt = now.Add(time.Hour).UnixMilli()
		case "invalid_bounds":
			*o.EntryMax = math.NaN()
		}
		got := assessStrategy(o, in, now, DefaultConfig())
		if got.Status != want || got.Eligible {
			t.Fatalf("%s: %+v", mode, got)
		}
		if mode == "expired" && (got.Opportunity.State != "expired" || got.Opportunity.ResolvedAt == nil || *got.Opportunity.ResolvedAt != *o.ExpiresAt) {
			t.Fatalf("expiry missing from journal evidence: %+v", got)
		}
	}
}

func TestBuildStrategiesCoverageFailsClosedForEveryContextFrame(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	for _, mode := range []string{"missing_daily", "stale", "gap", "future", "timestamp", "duplicate", "running", "failure"} {
		s, h := strategyTestFixture(now)
		switch mode {
		case "missing_daily":
			delete(h, "TESTUSDT/1d")
		case "stale":
			trendFixtureSeries(&s, "TESTUSDT", "4h").Stale = true
		case "gap":
			bars := h["TESTUSDT/1h"].Candles
			bars[10].OpenTime += 3600000
			bars[10].CloseTime += 3600000
		case "future":
			frame := trendFixtureSeries(&s, "TESTUSDT", "15m")
			frame.ObservedAt = now.Add(time.Hour)
		case "timestamp":
			trendFixtureSeries(&s, "TESTUSDT", "1h").Analysis.AsOf--
		case "duplicate":
			s.Series = append(s.Series, s.Series[0])
		case "running":
			s.Running = true
		case "failure":
			s.Errors = append(s.Errors, scanner.ScanError{Symbol: "TESTUSDT", Interval: "1h", Error: "test"})
		}
		got := BuildStrategies(s, h, []string{"TESTUSDT", "TESTUSDT"}, now, time.Minute, 0, DefaultConfig())
		if len(got.Items) != 0 || len(got.Unavailable) != 1 || len(got.Contexts) != 1 {
			t.Fatalf("%s leaked partial context: %+v", mode, got)
		}
		for _, coverage := range got.Coverage {
			if coverage.Status != "data_unavailable" {
				t.Fatalf("%s false coverage: %+v", mode, coverage)
			}
		}
	}
}

func TestBuildStrategiesIndependentInventorySurvivesDisplayLimit(t *testing.T) {
	now := time.Date(2026, 9, 26, 12, 30, 30, 0, time.UTC)
	s, h := strategyTestFixture(now)
	bars := h["TESTUSDT/15m"].Candles
	start := len(bars) - 28
	// An earlier independent sweep fails before the current one. It must stay
	// in the full research inventory while the card bound favors the live one.
	for i, row := range [][4]float64{{9, 10, 8.5, 9}, {9, 12, 9, 11}, {10, 11, 8, 9}, {9, 10.5, 8.5, 10}, {10, 13, 9.2, 11}} {
		bar := &bars[start-10+i]
		bar.Open, bar.High, bar.Low, bar.Close = row[0], row[1], row[2], row[3]
	}
	for i := start; i < len(bars); i++ {
		bars[i].Open, bars[i].High, bars[i].Low, bars[i].Close = 9, 10, 8.5, 9
	}
	bars[start+2].Low = .5
	for i, row := range [][4]float64{{9, 10, 8.5, 9}, {9, 12, 9, 11}, {10, 11, 8, 9}, {9, 10.5, 8.5, 10}, {10, 13, 9.2, 11}, {11, 11.5, 7, 7.5}, {7.5, 8.2, 7.2, 7.6}, {7.6, 7.8, 6.8, 7}} {
		bar := &bars[start+20+i]
		bar.Open, bar.High, bar.Low, bar.Close = row[0], row[1], row[2], row[3]
	}
	trendFixtureSeries(&s, "TESTUSDT", "15m").Price = 7
	full := BuildStrategies(s, h, []string{"TESTUSDT"}, now, time.Minute, 0, DefaultConfig())
	limited := BuildStrategies(s, h, []string{"TESTUSDT"}, now, time.Minute, 1, DefaultConfig())
	if len(s.Rows) != 0 || len(full.Items) <= len(limited.Items) || len(limited.Items) != 1 {
		t.Fatalf("independent discovery/display bound failed full=%+v limited=%+v", full, limited)
	}
	if !reflect.DeepEqual(full.Coverage, limited.Coverage) {
		t.Fatal("display limit changed discovery coverage")
	}
	for i, summary := range full.Summary {
		other := limited.Summary[i]
		summary.Displayed = 0
		other.Displayed = 0
		if summary != other {
			t.Fatal("display bound changed family denominator")
		}
	}
	confirmed := false
	for _, candidate := range full.Items {
		if candidate.Opportunity.Family == strategies.SweepReversal && candidate.Opportunity.AvailableAt == bars[start+24].CloseTime {
			confirmed = candidate.Opportunity.State == "entry_confirmed"
		}
	}
	if !confirmed {
		t.Fatal("sweep family was not independently discovered")
	}
}

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

var ichSelectionTimeframes = []string{"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "3d", "1w"}

func ichSelectedFixture(now time.Time, timeframe string) (scanner.Snapshot, map[string]scanner.History) {
	snapshot := scanner.Snapshot{}
	histories := map[string]scanner.History{}
	frames := []string{timeframe}
	for _, tf := range frames {
		width, _ := market.IntervalDuration(tf)
		// The phase is an observed UTC opening, intentionally independent
		// from an epoch multiple for 3d. Other intervals ignore this anchor.
		anchor := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
		last, _ := market.ExpectedClosedTime(now, tf, anchor, market.BoundaryGrace)
		bars := make([]market.Candle, 500)
		for i := range bars {
			at := last - int64(len(bars)-1-i)*width.Milliseconds()
			bars[i] = market.Candle{OpenTime: at - width.Milliseconds() + 1, CloseTime: at,
				Open: 100, Close: 100, High: 101, Low: 99, Volume: 1000}
		}
		// Regime and structure are intentionally unseeded. The selected
		// methods need valid source bars, not an unrelated analysis gate.
		snapshot.Series = append(snapshot.Series, scanner.SeriesSummary{Symbol: "TESTUSDT", Interval: tf,
			Price: 100, ObservedAt: now, LastClosedAt: last, ClosedCandles: len(bars), FirstOpenTime: bars[0].OpenTime})
		histories["TESTUSDT/"+tf] = scanner.History{Candles: bars}
	}
	return snapshot, histories
}

func ichSelectedPlan(in strategies.Input, timeframe string) strategies.Opportunity {
	width, _ := market.IntervalDuration(timeframe)
	trigger := in.Frames[timeframe].LastClosedAt - 2*width.Milliseconds()
	return strategies.Opportunity{Version: strategies.Version, ID: "chosen:" + timeframe, ParentID: "chosen-parent", Family: strategies.TKCross,
		Symbol: in.Symbol, Interval: timeframe, Direction: "bullish", State: "entry_confirmed", AvailableAt: trigger - width.Milliseconds(),
		LocationAvailableAt: trigger - width.Milliseconds(), SourceStartAt: trigger - 3*width.Milliseconds() + 1,
		SourceEndAt: trigger - width.Milliseconds(), AsOf: in.Frames[timeframe].LastClosedAt, TriggerAt: strategyTestPtr(trigger),
		ExpiresAt: strategyTestPtr(trigger + 4*width.Milliseconds()), Stop: strategyTestPtr(95.0), Target: strategyTestPtr(110.0),
		EntryReference: strategyTestPtr(100.0), ReferenceATR: strategyTestPtr(2.0), EntryMin: strategyTestPtr(99.0), EntryMax: strategyTestPtr(101.0), Reason: "fixture", Next: "review", Invalidation: "stop"}
}

func TestChosenIchimokuAllTwelveFramesUseOnlyTheirOwnEntryAndLifecycle(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 30, 30, 0, time.UTC)
	for _, timeframe := range ichSelectionTimeframes {
		t.Run(timeframe, func(t *testing.T) {
			snapshot, histories := ichSelectedFixture(now, timeframe)
			snapshot.Series[0].Analysis.Regime.Direction = "bearish"
			if !IchimokuSeriesReady(snapshot.Series[0], histories["TESTUSDT/"+timeframe], now, time.Minute) {
				t.Fatal("valid source incorrectly waits for unrelated analysis warmup")
			}
			in, ready := ichimokuTimeframeInput(snapshot, histories, "TESTUSDT", timeframe, now, time.Minute)
			if !ready || len(in.Frames) != 1 || len(in.Histories) != 1 {
				t.Fatal("selected source was not independently ready")
			}
			op := ichSelectedPlan(in, timeframe)
			candidate := assessStrategyOnFrame(op, in, now, DefaultConfig(), timeframe, true)
			if !candidate.Eligible || candidate.Status != "ready_for_review" || candidate.Price != 100 {
				t.Fatalf("source-only confirmed entry incorrectly gated: %+v", candidate)
			}
			history := in.Histories[timeframe]
			history.Candles[len(history.Candles)-1].Low = 95
			candidate = assessStrategyOnFrame(op, in, now, DefaultConfig(), timeframe, true)
			if candidate.Eligible || candidate.Status != "invalidated" || candidate.Opportunity.ResolvedAt == nil {
				t.Fatalf("own-source protective touch was missed: %+v", candidate)
			}
		})
	}
	if _, ready := ichimokuTimeframeInput(scanner.Snapshot{}, nil, "TESTUSDT", "6h", now, time.Minute); ready {
		t.Fatal("unsupported selected timeframe accepted")
	}
}

func TestChosenIchimokuMissingFailedAndContradictoryOtherFramesAreIrrelevant(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 30, 30, 0, time.UTC)
	snapshot, histories := ichSelectedFixture(now, "4h")
	// Missing or failed unrelated frames cannot erase a usable source.
	snapshot.Errors = append(snapshot.Errors, scanner.ScanError{Symbol: "TESTUSDT", Interval: "1d", Error: "unrelated"}, scanner.ScanError{Symbol: "TESTUSDT", Interval: "15m", Error: "unrelated unavailable"})
	in, sourceReady := ichimokuTimeframeInput(snapshot, histories, "TESTUSDT", "4h", now, time.Minute)
	if !sourceReady {
		t.Fatal("unrelated frame failure contaminated source readiness")
	}
	confirmed := ichSelectedPlan(in, "4h")
	developing := cloneOpportunity(confirmed)
	developing.ID, developing.State, developing.TriggerAt = "developing", "waiting_for_retest", nil
	unrelated := cloneOpportunity(confirmed)
	unrelated.ID, unrelated.Family = "unrelated", strategies.FVGPullback
	otherFrame := cloneOpportunity(confirmed)
	otherFrame.ID, otherFrame.Interval = "other-frame", "1h"
	prepared := &Prepared{opportunities: map[string][]strategies.Opportunity{"TESTUSDT": {confirmed, developing, unrelated, otherFrame}}}
	before := cloneOpportunity(confirmed)
	out := buildIchimokuTimeframeStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, "4h", DefaultConfig(), prepared)
	if len(out.Items) != 2 || len(out.Unavailable) != 0 || len(out.Coverage) != 5 {
		t.Fatalf("chosen family filtering or source availability incorrect: %+v", out)
	}
	for _, candidate := range out.Items {
		if candidate.Opportunity.Interval != "4h" || candidate.Price != in.Frames["4h"].Price {
			t.Fatal("source result borrowed an unrelated timeframe or quote")
		}
		if candidate.Opportunity.ID == confirmed.ID && (candidate.Status != "ready_for_review" || !candidate.Eligible || candidate.Opportunity.State != "entry_confirmed") {
			t.Fatal("confirmed source must be independently eligible without another timeframe")
		}
		if candidate.Opportunity.ID == developing.ID && candidate.Status != "waiting_for_retest" {
			t.Fatal("developing source should remain an observation")
		}
	}
	// Contradictory 15m/1d quotes, direction and protective touches are also
	// ignored, even when those optional histories contain duplicates/errors.
	for _, extra := range []string{"15m", "1d"} {
		other, data := ichSelectedFixture(now, extra)
		other.Series[0].Price = 999
		other.Series[0].Analysis.Regime.Direction = "bearish"
		other.Series[0].ObservedAt = now.Add(-time.Hour)
		snapshot.Series = append(snapshot.Series, other.Series[0], other.Series[0])
		history := data["TESTUSDT/"+extra]
		last := &history.Candles[len(history.Candles)-1]
		last.Low, last.High = 1, 1000
		histories["TESTUSDT/"+extra] = history
	}
	again := buildIchimokuTimeframeStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, "4h", DefaultConfig(), prepared)
	if !reflect.DeepEqual(out, again) {
		t.Fatal("unrelated failed or contradictory histories changed source-only selection")
	}
	if !reflect.DeepEqual(confirmed, before) || prepared.opportunities["TESTUSDT"][0].State != "entry_confirmed" {
		t.Fatal("assessment mutated original opportunity")
	}
	snapshot.Errors = append(snapshot.Errors, scanner.ScanError{Symbol: "TESTUSDT", Interval: "4h", Error: "source unavailable"})
	blocked := buildIchimokuTimeframeStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, "4h", DefaultConfig(), prepared)
	if len(blocked.Items) != 0 || len(blocked.Unavailable) != 1 {
		t.Fatal("source transport failure must withhold both developing and confirmed observations")
	}
}

func TestChosenIchimokuSourcePrefixFreshnessCostsAndTerminalChecks(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 30, 30, 0, time.UTC)
	for _, mode := range []string{"stale", "gap", "prefix", "stop", "target", "both", "quote", "closed", "cost"} {
		t.Run(mode, func(t *testing.T) {
			snapshot, histories := ichSelectedFixture(now, "1h")
			in, _ := ichimokuTimeframeInput(snapshot, histories, "TESTUSDT", "1h", now, time.Minute)
			op := ichSelectedPlan(in, "1h")
			cfg := DefaultConfig()
			history := histories["TESTUSDT/1h"]
			frame := &snapshot.Series[0]
			last := &history.Candles[len(history.Candles)-1]
			want := "data_unavailable"
			switch mode {
			case "stale":
				frame.ObservedAt = now.Add(-2 * time.Minute)
			case "gap":
				history.Candles[len(history.Candles)-2].OpenTime++
			case "prefix":
				history.Candles = history.Candles[len(history.Candles)-1:]
				frame.ClosedCandles, frame.FirstOpenTime = 1, history.Candles[0].OpenTime
			case "stop":
				last.Low, want = 95, "invalidated"
			case "target":
				last.High, want = 110, "target_reached"
			case "both":
				last.Low, last.High, want = 95, 110, "invalidated"
			case "quote":
				frame.Price, want = 101.1, "entry_distance_or_levels"
			case "closed":
				last.Close, last.High, want = 101.1, 101.1, "entry_distance_or_levels"
			case "cost":
				cfg.MinNetRR, want = 3, "cost_blocked"
			}
			histories["TESTUSDT/1h"] = history
			in, sourceReady := ichimokuTimeframeInput(snapshot, histories, "TESTUSDT", "1h", now, time.Minute)
			if mode == "stale" || mode == "gap" {
				if sourceReady {
					t.Fatal("stale or gapped selected source must be unavailable")
				}
				return
			}
			if !sourceReady {
				t.Fatal("lifecycle fixture must provide valid source history")
			}
			candidate := assessStrategyOnFrame(op, in, now, cfg, "1h", true)
			if candidate.Eligible || candidate.Status != want {
				t.Fatalf("%s source lifecycle gate: want %s, got %+v", mode, want, candidate)
			}
			prepared := &Prepared{opportunities: map[string][]strategies.Opportunity{"TESTUSDT": {op}}}
			out := buildIchimokuTimeframeStrategies(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, "1h", cfg, prepared)
			terminal := oneOf(want, "invalidated", "target_reached")
			if terminal && len(out.Items) != 0 || !terminal && len(out.Items) != 1 {
				t.Fatal("active source display must exclude completed terminal outcomes while retaining blocked observations")
			}
		})
	}
}

func TestChosenIchimokuRawReadinessUsesCalendarIdentityAndExactCompletedHistory(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 30, 30, 0, time.UTC)
	for _, tf := range []string{"5m", "3d", "1w"} {
		for _, mode := range []string{"valid", "future", "old", "mismatch", "nan", "duplicate", "unrelated_error"} {
			t.Run(tf+"/"+mode, func(t *testing.T) {
				snapshot, histories := ichSelectedFixture(now, tf)
				source := &snapshot.Series[0]
				switch mode {
				case "future":
					source.ObservedAt = now.Add(6 * time.Second)
				case "old":
					source.ObservedAt = now.Add(-time.Hour)
				case "mismatch":
					source.FirstOpenTime++
				case "nan":
					source.Price = math.NaN()
				case "duplicate":
					snapshot.Series = append(snapshot.Series, *source)
				case "unrelated_error":
					snapshot.Errors = append(snapshot.Errors, scanner.ScanError{Symbol: "TESTUSDT", Interval: "4h", Error: "not this source"})
				}
				_, ready := ichimokuTimeframeInput(snapshot, histories, "TESTUSDT", tf, now, time.Minute)
				if ready != (mode == "valid" || mode == "unrelated_error") {
					t.Fatalf("wrong source availability for %s", mode)
				}
			})
		}
	}
}

func TestChosenIchimokuPublishesDevelopingKijunAtItsOwnWarmup(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 30, 30, 0, time.UTC)
	snapshot, histories := ichSelectedFixture(now, "5m")
	history := histories["TESTUSDT/5m"]
	history.Candles = history.Candles[len(history.Candles)-61:]
	for i := range history.Candles {
		history.Candles[i].Low, history.Candles[i].High = 98, 102
	}
	history.Candles[59].Close = 99
	history.Candles[60].Open, history.Candles[60].Close = 99, 101
	histories["TESTUSDT/5m"] = history
	snapshot.Series[0].ClosedCandles, snapshot.Series[0].FirstOpenTime = 61, history.Candles[0].OpenTime
	out := BuildIchimokuTimeframe(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute, "5m")
	if len(out.Strategies.Items) != 1 || out.Strategies.Items[0].Opportunity.Family != strategies.KijunReclaim || out.Strategies.Items[0].Status != "waiting_for_retest" {
		t.Fatalf("Kijun source waited for unrelated cloud/regime history: %+v", out.Strategies.Items)
	}
	for _, coverage := range out.Strategies.Coverage {
		want := "insufficient"
		if coverage.Family == strategies.KijunReclaim {
			want = "ready"
		}
		if coverage.Interval != "5m" || coverage.Status != want {
			t.Fatalf("wrong per-family source warmup: %+v", coverage)
		}
	}
}

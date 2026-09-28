package selection

import (
	"encoding/json"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
	"github.com/alihasan00/crypto/internal/structure"
	"strings"
	"testing"
	"time"
)

func TestCappedTargetTouchRetiresTheEffectivePlan(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		snapshot, histories := selectionFixture(now, direction, "BTCUSDT")
		row := &snapshot.Rows[0]
		selectionConfirm(row)
		bars := histories["BTCUSDT/15m"].Candles
		row.Decision.Confirmation.Event.ConfirmedAt = bars[len(bars)-2].CloseTime
		*row.Decision.Confirmation.BarsAgo = 1
		target := 100 + directionSign(direction)*11
		pivot := &structure.Pivot{Price: target, ConfirmedAt: bars[0].CloseTime}
		lower := selectionSeries(&snapshot, "BTCUSDT", "15m")
		if direction == "bullish" {
			lower.Analysis.Structure.Internal.High = pivot
		} else {
			lower.Analysis.Structure.Internal.Low = pivot
		}
		before := AssessCandidate(snapshot, histories, *row, now, time.Minute)
		if !before.Eligible || *before.Candidate.Plan.Target != target {
			t.Fatalf("fixture is not eligible: %+v", before)
		}
		if direction == "bullish" {
			bars[len(bars)-1].High = target + 1
		} else {
			bars[len(bars)-1].Low = target - 1
		}
		after := AssessCandidate(snapshot, histories, *row, now, time.Minute)
		if after.Eligible || after.Candidate == nil || after.Candidate.Plan.Status != "reference_unavailable_or_reached" {
			t.Fatalf("touched capped target still qualifies: %+v", after)
		}
	}
}

func TestCappedTargetCannotDisappearAfterCloseCrossAndReturn(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
		snapshot, histories := selectionFixture(now, direction, "BTCUSDT")
		bars := histories["BTCUSDT/15m"].Candles
		// A low leg followed by a high leg confirms an opposing pivot at 112.
		highs, lows := []float64{101, 103, 112, 110, 110, 110, 114, 105}, []float64{95, 98, 100, 99, 99, 99, 100, 99}
		for i := range bars {
			bars[i].Open, bars[i].Close, bars[i].High, bars[i].Low = 100, 100, highs[i], lows[i]
		}
		bars[6].Close = 113
		if direction == "bearish" {
			for i := range bars {
				b := &bars[i]
				b.Open, b.Close, b.High, b.Low = 200-b.Open, 200-b.Close, 200-b.Low, 200-b.High
			}
		}
		snapshot.AnalysisSettings = scanner.DefaultAnalysisSettings()
		snapshot.AnalysisSettings.Structure = structure.Config{InternalLength: 1, SwingLength: 2}
		completeHistoricalFrames(&snapshot, histories)
		frame := selectionSeries(&snapshot, "BTCUSDT", "15m")
		frame.Analysis.Structure = structure.Analyze(bars, snapshot.AnalysisSettings.Structure)
		row := &snapshot.Rows[0]
		row.Pattern.LevelsEstablishedAt = bars[5].CloseTime
		selectionConfirm(row)
		// Current structure has already crossed the old obstacle. Reconstruction
		// must retain it even with a newer confirmation and a recovered quote.
		oldTarget := 100 + directionSign(direction)*12
		a := AssessCandidate(snapshot, histories, *row, now, time.Minute)
		if a.Eligible || a.Candidate == nil || a.Candidate.Plan.Target == nil || *a.Candidate.Plan.Target != oldTarget || a.Candidate.Plan.Status != "reference_unavailable_or_reached" {
			t.Fatalf("%s cap revived after crossing: %+v", direction, a)
		}
	}
}

// The production scanner records a common replay start for each series. Fill
// the other frames with ready, featureless history so a missing obstacle is a
// verified absence rather than a side effect of an incomplete fixture.
func completeHistoricalFrames(snapshot *scanner.Snapshot, histories map[string]scanner.History) {
	for i := range snapshot.Series {
		frame := &snapshot.Series[i]
		key := pair(frame.Symbol, frame.Interval)
		bars := histories[key].Candles
		if len(bars) == 0 {
			width, _ := time.ParseDuration(frame.Interval)
			if frame.Interval == "1d" {
				width = 24 * time.Hour
			}
			bars = make([]market.Candle, 80)
			for j := range bars {
				close := frame.LastClosedAt - int64(len(bars)-1-j)*width.Milliseconds()
				bars[j] = market.Candle{OpenTime: close - width.Milliseconds() + 1, CloseTime: close, Open: 100, Close: 100, High: 101, Low: 99}
			}
			histories[key] = scanner.History{Candles: bars}
		}
		frame.FirstOpenTime, frame.ClosedCandles = bars[0].OpenTime, len(bars)
	}
}

func TestMissingHistoricalCapContextCannotRestoreTheRawTarget(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		for _, missing := range []string{"all pre-establishment bars", "replay start", "historical endpoint", "other timeframe", "warmup"} {
			t.Run(direction+"/"+missing, func(t *testing.T) {
				now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
				snapshot, histories := selectionFixture(now, direction, "BTCUSDT")
				snapshot.AnalysisSettings = scanner.DefaultAnalysisSettings()
				snapshot.AnalysisSettings.Structure = structure.Config{InternalLength: 1, SwingLength: 2}
				completeHistoricalFrames(&snapshot, histories)
				row := &snapshot.Rows[0]
				selectionConfirm(row)
				bars := histories["BTCUSDT/15m"].Candles
				row.Pattern.LevelsEstablishedAt = bars[5].CloseTime
				if a := AssessCandidate(snapshot, histories, *row, now, time.Minute); !a.Eligible {
					t.Fatalf("complete no-obstacle fixture must qualify: %+v", a)
				}
				switch missing {
				case "all pre-establishment bars":
					histories["BTCUSDT/15m"] = scanner.History{Candles: bars[6:]}
				case "replay start":
					histories["BTCUSDT/15m"] = scanner.History{Candles: bars[1:]}
				case "historical endpoint":
					histories["BTCUSDT/15m"] = scanner.History{Candles: append(append([]market.Candle{}, bars[:5]...), bars[6:]...)}
				case "other timeframe":
					delete(histories, "BTCUSDT/4h")
				case "warmup":
					snapshot.AnalysisSettings.Structure.SwingLength = 10
				}
				a := AssessCandidate(snapshot, histories, *row, now, time.Minute)
				if a.Eligible || a.Candidate == nil || a.Candidate.Plan.Status != "reference_unavailable_or_reached" || a.Candidate.Plan.Target != nil || a.Candidate.Plan.NetRR != nil {
					t.Fatalf("incomplete historical context restored a plan: %+v", a)
				}
			})
		}
	}
}

func TestLegacyHistoricalTargetFallbackIsExplicit(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	snapshot, histories := selectionFixture(now, "bullish", "BTCUSDT")
	a := AssessCandidate(snapshot, histories, snapshot.Rows[0], now, time.Minute)
	if !a.Eligible || !strings.Contains(strings.Join(a.Candidate.Plan.Reasons, " "), "historical target state is unverified") {
		t.Fatalf("legacy compatibility must disclose its historical limitation: %+v", a)
	}
}

func historicalTrendFixture(now time.Time, direction string) (scanner.Snapshot, map[string]scanner.History) {
	snapshot, histories := trendFixture(now, "bullish", "TESTUSDT")
	snapshot.AnalysisSettings = scanner.DefaultAnalysisSettings()
	snapshot.AnalysisSettings.Structure = structure.Config{InternalLength: 1, SwingLength: 2}
	completeHistoricalFrames(&snapshot, histories)
	bars := histories["TESTUSDT/15m"].Candles
	n := len(bars)
	bars[n-11].Low = 101
	bars[n-9].High = 116
	bars[n-4].Low = 99
	bars[n-3].Close, bars[n-3].High = 106, 107
	if direction == "bearish" {
		for i := range snapshot.Series {
			f := &snapshot.Series[i]
			f.Price = 200 - f.Price
			f.Analysis.Regime.Direction = direction
			f.Analysis.Structure.Internal.Bias, f.Analysis.Structure.Swing.Bias = direction, direction
			if f.Analysis.Structure.Internal.LastBreak != nil {
				f.Analysis.Structure.Internal.LastBreak.Direction = direction
			}
		}
		for _, h := range histories {
			for i := range h.Candles {
				c := &h.Candles[i]
				c.Open, c.Close, c.High, c.Low = 200-c.Open, 200-c.Close, 200-c.Low, 200-c.High
			}
		}
	}
	return snapshot, histories
}

func TestContinuationTargetAndATRUseTheTriggerContext(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			snapshot, histories := historicalTrendFixture(now, direction)
			before := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			target := 100 + directionSign(direction)*16
			if len(before) != 1 || before[0].Plan.Status != "ready_for_review" || before[0].Plan.Target == nil || *before[0].Plan.Target != target {
				t.Fatalf("fixture lacks a confirmed target: %+v", before)
			}
			stop := *before[0].Plan.Stop
			bars := histories["TESTUSDT/15m"].Candles
			crossed := &bars[len(bars)-2]
			if direction == "bullish" {
				crossed.High, crossed.Close = 118, 117
			} else {
				crossed.Low, crossed.Close = 82, 83
			}
			lower := trendFixtureSeries(&snapshot, "TESTUSDT", "15m")
			*lower.Analysis.Regime.Volatility.ATR = 1000
			after := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(after) != 1 || after[0].Plan.Status != "reference_unavailable_or_reached" || after[0].Plan.Target == nil || *after[0].Plan.Target != target || after[0].Plan.Stop == nil || *after[0].Plan.Stop != stop {
				t.Fatalf("crossed target or current ATR changed the old plan: %+v", after)
			}
			// A fresh retest after the old target touch creates a new cycle.
			trendFixtureTouch(&bars[len(bars)-1], direction)
			reset := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(reset) != 1 || reset[0].TriggerClosedAt != nil || reset[0].RetestClosedAt == nil || *reset[0].RetestClosedAt != bars[len(bars)-1].CloseTime || reset[0].Plan.Status == "reference_unavailable_or_reached" {
				t.Fatalf("old-cycle touch retired a new retest: %+v", reset)
			}
		})
	}
}

func TestContinuationIgnoresPrePlanTouchesAndBlocksMissingPrefix(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			snapshot, histories := historicalTrendFixture(now, direction)
			bars := histories["TESTUSDT/15m"].Candles
			prior := &bars[len(bars)-5]
			if direction == "bullish" {
				prior.High = 116
			} else {
				prior.Low = 84
			}
			before := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(before) != 1 || before[0].Plan.Status != "ready_for_review" {
				t.Fatalf("pre-plan touch retired new trigger: %+v", before)
			}
			delete(histories, "TESTUSDT/4h")
			after := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(after) != 1 || after[0].Plan.Status != "reference_unavailable_or_reached" || after[0].Plan.Target != nil || after[0].Plan.NetRR != nil {
				t.Fatalf("missing original target context was treated as no obstacle: %+v", after)
			}
		})
	}
}

func TestPreparedReturnedContextCannotMutateCachedDiscovery(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	snapshot, histories := strategyTestFixture(now)
	symbols := []string{"TESTUSDT"}
	p := Prepare(snapshot, histories, symbols, now, time.Minute)
	at := int64(123)
	p.contexts["TESTUSDT"] = strategies.Context{Symbol: "TESTUSDT", AsOf: &at, Range: &strategies.Range{High: 120}}
	first := p.Build(symbols, now, time.Minute, 0, DefaultConfig())
	*first.Strategies.Contexts[0].AsOf, first.Strategies.Contexts[0].Range.High = 999, 999
	second := p.Build(symbols, now, time.Minute, 0, DefaultConfig())
	if *second.Strategies.Contexts[0].AsOf != 123 || second.Strategies.Contexts[0].Range.High != 120 {
		t.Fatal("a returned context mutated cached discovery")
	}
}

func TestAdversePreviewRetainsWatchAndBlocksEntryUntilClosedInvalidation(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		snapshot, histories := trendFixture(now, direction, "TESTUSDT")
		frame := trendFixtureSeries(&snapshot, "TESTUSDT", "1h")
		frame.Price = 100 - directionSign(direction)
		w := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
		if len(w) != 1 || !w[0].QuoteAdverse || w[0].Plan.Status != "quote_beyond_level" {
			t.Fatalf("adverse quote lost watch or allowed entry: %+v", w)
		}
		bars := histories["TESTUSDT/15m"].Candles
		bars[len(bars)-1].Close = frame.Price
		bars[len(bars)-1].Low = min(bars[len(bars)-1].Low, frame.Price)
		bars[len(bars)-1].High = max(bars[len(bars)-1].High, frame.Price)
		if got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute); len(got) != 0 {
			t.Fatalf("closed invalidation retained watch: %+v", got)
		}
	}
}

func TestAccountReloadFailureAndCostDominanceAreExplicit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.AccountUnavailable = "malformed account file"
	p := ReferencePlan("BTCUSDT", "bullish", 100, 99.9, 102, time.Now(), cfg)
	if p.SizingStatus != "blocked" || p.Quantity != nil || !strings.Contains(strings.Join(p.Reasons, " "), "equal or exceed") {
		t.Fatalf("missing block/cost warning: %+v", p)
	}
}

func TestHarmonicPlanUsesPublishedConfirmationExpiry(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	snapshot, histories := selectionFixture(now, "bullish", "BTCUSDT")
	row := &snapshot.Rows[0]
	selectionConfirm(row)
	row.Decision.Confirmation.Event.ConfirmedAt -= 6 * (15 * time.Minute).Milliseconds()
	*row.Decision.Confirmation.BarsAgo = 6
	row.Pattern.ConfirmedAt = row.Decision.Confirmation.Event.ConfirmedAt
	row.Pattern.DetectedAt = row.Pattern.ConfirmedAt
	expiry := row.Decision.Confirmation.Event.ConfirmedAt + 8*(15*time.Minute).Milliseconds()
	row.Decision.Confirmation.ExpiresAt = &expiry
	a := AssessCandidate(snapshot, histories, *row, now, time.Minute)
	if !a.Eligible || a.Candidate.Plan.Status != "ready_for_review" || *a.Candidate.Plan.ExpiresAt != expiry {
		t.Fatalf("configured eight-bar confirmation was truncated: %+v", a)
	}
}

func TestPreparedDiscoveryRechecksTimeAndMatchesUncachedSelection(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	snapshot, histories := strategyTestFixture(now)
	symbols := []string{"TESTUSDT"}
	p := Prepare(snapshot, histories, symbols, now, time.Minute)
	for _, at := range []time.Time{now, now.Add(2 * time.Minute)} {
		got, err := json.Marshal(p.Build(symbols, at, time.Minute, 0, DefaultConfig()))
		if err != nil {
			t.Fatal(err)
		}
		want, err := json.Marshal(BuildAll(snapshot, histories, symbols, at, time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(want) {
			t.Fatalf("prepared eligibility differs from fresh evaluation at %s", at)
		}
	}
}

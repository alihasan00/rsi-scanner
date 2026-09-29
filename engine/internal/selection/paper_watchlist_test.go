package selection

import (
	"strings"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

const paperWatchlistSymbol = "TESTUSDT"

func paperWatchlistSources(t *testing.T, now time.Time, frames ...string) (scanner.Snapshot, map[string]scanner.History) {
	t.Helper()
	snapshot := scanner.Snapshot{}
	histories := map[string]scanner.History{}
	for _, frame := range frames {
		width, supported := market.IntervalDuration(frame)
		last, closed := market.ExpectedClosedTime(now, frame, 0, market.BoundaryGrace)
		if !supported || !closed {
			t.Fatalf("unsupported paper fixture frame %q", frame)
		}
		bars := make([]market.Candle, 500)
		for i := range bars {
			closeTime := last - int64(len(bars)-1-i)*width.Milliseconds()
			bars[i] = market.Candle{OpenTime: closeTime - width.Milliseconds() + 1, CloseTime: closeTime,
				Open: 100, High: 102, Low: 98, Close: 100, Volume: 10}
		}
		snapshot.Series = append(snapshot.Series, scanner.SeriesSummary{
			Symbol: paperWatchlistSymbol, Interval: frame, Price: 100, ObservedAt: now,
			LastClosedAt: last, ClosedCandles: len(bars), FirstOpenTime: bars[0].OpenTime,
		})
		histories[paperWatchlistSymbol+"/"+frame] = scanner.History{Candles: bars}
	}
	return snapshot, histories
}

func paperWatchlistCandidate(items []StrategyCandidate, family string) (StrategyCandidate, bool) {
	for _, item := range items {
		if item.Opportunity.Family == family {
			return item, true
		}
	}
	return StrategyCandidate{}, false
}

func TestPaperWatchlistCoversTwelveFamiliesOnIndependentSources(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 30, 0, 0, time.UTC)
	wantFrame := map[string]string{
		strategies.PaperDonchianBase:            "1d",
		strategies.PaperDonchianStoch:           "1d",
		strategies.PaperDonchianMACD:            "1d",
		strategies.PaperDonchianADXRange:        "1d",
		strategies.PaperCloudVolume2R:           "1d",
		strategies.PaperCloudVolume2REMA:        "1d",
		strategies.PaperCloudVolume2RSMA:        "1d",
		strategies.PaperCloudVolume2RSupertrend: "1d",
		strategies.PaperCloudVolume2RAO:         "1d",
		strategies.PaperCloudVolume2RStack:      "1d",
		strategies.PaperFreshWeeklyRangeLong:    "4h",
		strategies.PaperTKCrossRSI:              "1d",
	}
	if len(wantFrame) != 12 {
		t.Fatal("paper roster fixture must name twelve distinct families")
	}
	for _, scenario := range []struct {
		name    string
		present []string
		failed  string
	}{
		{name: "both", present: []string{"1d", "4h"}},
		{name: "daily_only", present: []string{"1d"}},
		{name: "four_hour_only", present: []string{"4h"}},
		{name: "failed_daily", present: []string{"1d", "4h"}, failed: "1d"},
		{name: "failed_four_hour", present: []string{"1d", "4h"}, failed: "4h"},
		{name: "none"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			snapshot, histories := paperWatchlistSources(t, now, scenario.present...)
			if scenario.failed != "" {
				snapshot.Errors = append(snapshot.Errors, scanner.ScanError{Symbol: paperWatchlistSymbol,
					Interval: scenario.failed, Error: "source failed"})
			}
			result := BuildPaperWatchlist(snapshot, histories, []string{paperWatchlistSymbol}, now, time.Minute)
			if len(result.Strategies.Summary) != 12 || len(result.Strategies.Coverage) != 12 || len(result.Strategies.Contexts) != 1 {
				t.Fatalf("each symbol needs all twelve family summaries and coverage rows: %+v", result.Strategies)
			}
			ready := map[string]bool{}
			for _, frame := range scenario.present {
				ready[frame] = true
			}
			delete(ready, scenario.failed)
			context := result.Strategies.Contexts[0]
			if available := ready["1d"] || ready["4h"]; (context.Availability == "ready") != available ||
				(len(result.Strategies.Unavailable) == 0) != available {
				t.Fatalf("one missing source changed symbol availability: context=%+v unavailable=%+v", context, result.Strategies.Unavailable)
			}
			seen := map[string]bool{}
			for _, row := range result.Strategies.Coverage {
				frame, belongs := wantFrame[row.Family]
				if !belongs || seen[row.Family] || row.Symbol != paperWatchlistSymbol || row.Interval != frame {
					t.Fatalf("missing, duplicated, or misplaced family coverage: %+v", row)
				}
				seen[row.Family] = true
				wantStatus := "data_unavailable"
				if ready[frame] {
					wantStatus = "ready"
				}
				if row.Status != wantStatus || ready[frame] && (row.HistoryBars != 500 || row.AsOf == nil) {
					t.Fatalf("%s source coverage depends on another frame: %+v", frame, row)
				}
			}
			if len(seen) != len(wantFrame) {
				t.Fatalf("coverage omitted a paper family: %+v", seen)
			}
			for _, summary := range result.Strategies.Summary {
				if !seen[summary.Family] {
					t.Fatalf("summary omitted or invented family %q", summary.Family)
				}
			}
		})
	}
}

func TestPaperWatchlistRejectsCandleAtExactCloseEvenWithoutBrowserFeed(t *testing.T) {
	snapshot, histories := paperWatchlistSources(t, time.Date(2026, 9, 29, 0, 0, 2, 0, time.UTC), "1d", "4h")
	now := time.UnixMilli(snapshot.Series[0].LastClosedAt)
	for i := range snapshot.Series {
		snapshot.Series[i].ObservedAt = now
	}
	result := BuildPaperWatchlist(snapshot, histories, []string{paperWatchlistSymbol}, now, time.Minute)
	if len(result.Strategies.Items) != 0 || len(result.Strategies.Unavailable) != 1 {
		t.Fatalf("an exact-close source entered the paper Watchlist: %+v", result.Strategies)
	}
	for _, coverage := range result.Strategies.Coverage {
		if coverage.Status != "data_unavailable" {
			t.Fatalf("exact-close source was marked ready: %+v", coverage)
		}
	}
}

func TestPaperWatchlistPreservesDonchianManagedExitWithoutFixedTarget(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 30, 0, 0, time.UTC)
	snapshot, histories := paperWatchlistSources(t, now, "1d")
	history := histories[paperWatchlistSymbol+"/1d"]
	last := &history.Candles[len(history.Candles)-1]
	last.Close, last.High = 110, 112
	histories[paperWatchlistSymbol+"/1d"] = history
	snapshot.Series[0].Price = last.Close
	result := BuildPaperWatchlist(snapshot, histories, []string{paperWatchlistSymbol}, now, time.Minute)
	base, found := paperWatchlistCandidate(result.Strategies.Items, strategies.PaperDonchianBase)
	if !found || !base.Eligible || base.Status != "ready_for_review" || base.Opportunity.Target != nil || base.Plan.Target != nil ||
		base.Opportunity.Stop == nil || base.Opportunity.TriggerAt == nil ||
		!strings.Contains(base.Plan.Management, "3.5-ATR") || !strings.Contains(base.Plan.Management, "96 daily bars") {
		t.Fatalf("daily breakout lost its managed exit or acquired a fixed target: %+v", base)
	}
	for _, item := range result.Strategies.Items {
		if strings.HasPrefix(item.Opportunity.Family, strategies.PaperDonchianBase) &&
			(item.Opportunity.Target != nil || item.Plan.Target != nil) {
			t.Fatalf("filtered Donchian profile invented a fixed target: %+v", item)
		}
	}
}

func TestPaperWatchlistRequiresAWholeMinuteBeforeEntryExpiry(t *testing.T) {
	for _, test := range []struct {
		name     string
		minute   int
		eligible bool
	}{
		{name: "one minute remains", minute: 58, eligible: true},
		{name: "next minute reaches deadline", minute: 59, eligible: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			now := time.Date(2026, 9, 28, 23, test.minute, 30, 0, time.UTC)
			snapshot, histories := paperWatchlistSources(t, now, "1d")
			history := histories[paperWatchlistSymbol+"/1d"]
			last := &history.Candles[len(history.Candles)-1]
			last.Close, last.High = 110, 112
			histories[paperWatchlistSymbol+"/1d"] = history
			snapshot.Series[0].Price = last.Close
			result := BuildPaperWatchlist(snapshot, histories, []string{paperWatchlistSymbol}, now, time.Minute)
			base, found := paperWatchlistCandidate(result.Strategies.Items, strategies.PaperDonchianBase)
			if !found || base.Opportunity.ExpiresAt == nil || *base.Opportunity.ExpiresAt != time.Date(2026, 9, 29, 0, 0, 0, 0, time.UTC).UnixMilli() ||
				base.Eligible != test.eligible || (base.Status == "ready_for_review") != test.eligible {
				t.Fatalf("next whole-minute opening was not checked against expiry: %+v", base)
			}
		})
	}
}

func TestPaperWatchlistKeepsCloudStructuralTargetBeforeExecutionCap(t *testing.T) {
	now := time.Date(2026, 9, 29, 12, 30, 0, 0, time.UTC)
	snapshot, histories := paperWatchlistSources(t, now, "1d")
	history := histories[paperWatchlistSymbol+"/1d"]
	bars := history.Candles
	start := len(bars) - 162
	set := func(at int, open, high, low, close float64) {
		bar := &bars[start+at]
		bar.Open, bar.High, bar.Low, bar.Close = open, high, low, close
	}
	set(15, 100, 125, 98, 100)
	for at := 110; at < 133; at++ {
		set(at, 109, 110, 108, 109)
	}
	set(159, 109, 110, 108, 109)
	set(160, 109, 115, 108, 114)
	set(161, 114, 115, 111, 114)
	history.Candles = bars
	histories[paperWatchlistSymbol+"/1d"] = history
	snapshot.Series[0].Price = bars[len(bars)-1].Close
	result := BuildPaperWatchlist(snapshot, histories, []string{paperWatchlistSymbol}, now, time.Minute)
	base, found := paperWatchlistCandidate(result.Strategies.Items, strategies.PaperCloudVolume2R)
	if !found || !base.Eligible || base.Status != "ready_for_review" || base.Opportunity.Target == nil ||
		*base.Opportunity.Target != 125 || base.Plan.Target == nil || *base.Plan.Target != 125 ||
		base.Opportunity.EntryReference == nil || *base.Opportunity.EntryReference != 114 ||
		base.Opportunity.RetestAt == nil || *base.Opportunity.RetestAt != bars[len(bars)-1].CloseTime ||
		!strings.Contains(base.Plan.Management, "net 2R after actual slipped entry") {
		t.Fatalf("cloud watchlist lost its frozen source target or priced an unobserved fill: %+v", base)
	}
}

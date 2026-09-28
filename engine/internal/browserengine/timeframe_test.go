package browserengine_test

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	browser "github.com/alihasan00/crypto/internal/browserengine"
	"github.com/alihasan00/crypto/internal/market"
)

var selectedTimeframes = []string{"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "3d", "1w"}

// Reuse known causal price geometry with exchange-correct timestamps. Three-day
// input intentionally uses its own midnight phase, not Unix-epoch divisibility.
func retimeLectureHistory(t *testing.T, history browser.InputHistory, timeframe string, now int64) browser.InputHistory {
	t.Helper()
	duration, ok := market.IntervalDuration(timeframe)
	if !ok || duration <= 0 {
		t.Fatal("unsupported test interval")
	}
	anchor := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC).UnixMilli()
	last, ok := market.ExpectedClosedTime(time.UnixMilli(now), timeframe, anchor, market.BoundaryGrace)
	if !ok {
		t.Fatal("cannot determine expected fixture close")
	}
	history.Timeframe = timeframe
	history.Candles = append([]market.Candle{}, history.Candles...)
	for i := range history.Candles {
		open := last + 1 - int64(len(history.Candles)-i)*duration.Milliseconds()
		history.Candles[i].OpenTime = open
		history.Candles[i].CloseTime = open + duration.Milliseconds() - 1
	}
	preview := history.Candles[len(history.Candles)-1]
	preview.OpenTime += duration.Milliseconds()
	preview.CloseTime += duration.Milliseconds()
	history.Preview = &preview
	history.ReceivedAt = now - 1000
	return history
}

func selectedLectureFixture(t *testing.T, timeframe string, developing bool) browser.Request {
	t.Helper()
	base := lectureScopeFixture(t)
	out := browser.Request{Now: base.Now, Scope: "ichimoku", Timeframe: timeframe, Symbols: base.Symbols}
	for _, history := range base.Histories {
		if history.Timeframe == "1h" {
			if developing {
				history.Candles = history.Candles[:len(history.Candles)-1]
			}
			out.Histories = append(out.Histories, retimeLectureHistory(t, history, timeframe, base.Now))
		}
	}
	return out
}

func TestIchimokuScansAndConfirmsEachChosenTimeframeWithoutOtherFrames(t *testing.T) {
	for _, timeframe := range selectedTimeframes {
		t.Run(timeframe, func(t *testing.T) {
			request := selectedLectureFixture(t, timeframe, false)
			response := browser.Run(request)
			requireSuccessful(t, response, 1)
			if response.Timeframe != timeframe || response.Scope != "ichimoku" || response.Scan.Progress.Total != 1 {
				t.Fatalf("selected timeframe identity or requested feed count lost: %+v", response.Scan.Progress)
			}
			found := map[string]bool{}
			for _, candidate := range response.Result.Strategies.Items {
				if candidate.Opportunity.Interval != timeframe || !ichimokuFamily(candidate.Opportunity.Family) {
					t.Fatal("a different timeframe or method entered the selected screener")
				}
				if candidate.Eligible && candidate.Plan.Status == "ready_for_review" {
					found[candidate.Opportunity.Family] = true
				}
			}
			if !found["tk_cross"] || !found["pk_cross"] {
				t.Fatalf("chosen-frame entries did not reach the selector: %+v", response.Result.Strategies.Items)
			}
			for _, series := range response.Scan.Series {
				if series.Interval != timeframe || series.Ichimoku == nil {
					t.Fatal("unrelated series requested or selected readings absent")
				}
			}
		})
	}
}

func TestIchimokuOptionalUnrelatedFailuresDoNotGateSelectedSource(t *testing.T) {
	request := selectedLectureFixture(t, "1h", false)
	baseline := browser.Run(request)
	extra := lectureScopeFixture(t).Histories[0]
	extra.ReceivedAt = request.Now - int64(24*time.Hour/time.Millisecond)
	extra.Status = "error"
	request.Histories = append(request.Histories, extra)
	after := browser.Run(request)
	if !reflect.DeepEqual(after, baseline) {
		t.Fatal("an optional stale daily feed changed the chosen-hourly result")
	}
}

func TestIchimokuMissingStaleOrContradictoryFifteenMinuteDataHasNoEffect(t *testing.T) {
	for _, timeframe := range []string{"1m", "1h", "4h", "1d", "1w"} {
		for _, developing := range []bool{false, true} {
			request := selectedLectureFixture(t, timeframe, developing)
			baseline := browser.Run(request)
			requireSuccessful(t, baseline, 1)
			found := false
			for _, candidate := range baseline.Result.Strategies.Items {
				if candidate.Opportunity.Family == "tk_cross" {
					found = true
					if developing && candidate.Opportunity.State != "waiting_for_retest" ||
						!developing && (!candidate.Eligible || candidate.Plan.Status != "ready_for_review") {
						t.Fatalf("source-only lifecycle is wrong: %+v", candidate)
					}
				}
			}
			if !found {
				t.Fatal("source setup requires an unrelated fifteen-minute confirmation")
			}
			for _, mode := range []string{"stale", "failed", "opposing_quote", "stop_target_excursion"} {
				extra := lectureScopeFixture(t).Histories[3]
				if extra.Timeframe != "15m" {
					t.Fatal("fixture's fourth history should be fifteen-minute")
				}
				switch mode {
				case "stale":
					extra.ReceivedAt = request.Now - 120001
				case "failed":
					extra.Status = "error"
				case "opposing_quote":
					extra.Preview.Open, extra.Preview.High, extra.Preview.Low, extra.Preview.Close = 10, 11, 1, 2
				case "stop_target_excursion":
					for i := len(extra.Candles) - 20; i < len(extra.Candles); i++ {
						extra.Candles[i].Low, extra.Candles[i].High = 1, 1000
					}
				}
				withExtra := request
				withExtra.Histories = append(append([]browser.InputHistory{}, request.Histories...), extra)
				if got := browser.Run(withExtra); !reflect.DeepEqual(got, baseline) {
					t.Fatalf("%s/%s optional fifteen-minute data changed selected source result", timeframe, mode)
				}
			}
		}
	}
}

func TestIchimokuSourceWarmupDoesNotDependOnUnrelatedAnalyzers(t *testing.T) {
	request := selectedLectureFixture(t, "1h", true)
	request.Histories = request.Histories[:1]
	source := &request.Histories[0]
	source.Candles = source.Candles[len(source.Candles)-81:]
	response := browser.Run(request)
	if response.Error != "" || len(response.Scan.Series) != 1 || !response.Scan.Series[0].Ready ||
		response.Scan.Series[0].Ichimoku == nil || response.Scan.Series[0].Ichimoku.Kijun.Status != "ready" {
		t.Fatal("usable Kijun source was blocked by another analyzer's longer warmup")
	}
	found := false
	for _, candidate := range response.Result.Strategies.Items {
		if candidate.Opportunity.Family == "kijun_reclaim" && candidate.Opportunity.State == "waiting_for_retest" {
			found = true
		}
	}
	if !found {
		t.Fatal("developing Kijun setup was hidden before full cloud warmup")
	}
}

func TestIchimokuTimeframeValidationAndDefaultIdentity(t *testing.T) {
	request := selectedLectureFixture(t, "1h", false)
	request.Timeframe = ""
	implicit := browser.Run(request)
	request.Timeframe = "1h"
	explicit := browser.Run(request)
	if implicit.Timeframe != "1h" || !reflect.DeepEqual(implicit, explicit) {
		t.Fatal("empty Ichimoku timeframe did not preserve the default hourly result")
	}
	for _, timeframe := range []string{"1M", "6h", "12h", "1H", "2d", " 1h "} {
		request.Timeframe = timeframe
		response := browser.Run(request)
		if response.Error == "" || response.Result != nil || len(response.Scan.Series) != 0 {
			t.Fatalf("unsupported selected timeframe accepted: %s", timeframe)
		}
	}
	mixed := fixture("BTCUSDT")
	before := browser.Run(mixed)
	mixed.Timeframe = "1w"
	after := browser.Run(mixed)
	if after.Timeframe != "" || !reflect.DeepEqual(before, after) {
		t.Fatal("a timeframe field changed the original mixed watchlist")
	}
	raw, _ := json.Marshal(after)
	var encoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &encoded); err != nil {
		t.Fatal(err)
	}
	if _, exists := encoded["timeframe"]; exists {
		t.Fatal("mixed response should omit the selected Ichimoku timeframe")
	}
}

func TestIchimokuWeeklyAndThreeDayGeometryAndLatestCloseRemainStrict(t *testing.T) {
	for _, timeframe := range []string{"3d", "1w"} {
		for _, invalid := range []string{"phase", "latest"} {
			request := selectedLectureFixture(t, timeframe, false)
			history := &request.Histories[0]
			if invalid == "phase" {
				shift := int64(time.Hour / time.Millisecond)
				for i := range history.Candles {
					history.Candles[i].OpenTime += shift
					history.Candles[i].CloseTime += shift
				}
				history.Preview = nil
			} else {
				history.Candles = history.Candles[:len(history.Candles)-1]
				history.Preview = nil
			}
			response := browser.Run(request)
			if response.Error != "" || len(response.Scan.Errors) != 1 || response.Scan.Errors[0].Interval != timeframe || len(response.Result.Strategies.Items) != 0 {
				t.Fatalf("%s/%s invalid geometry supplied an Ichimoku setup: %+v", timeframe, invalid, response.Scan.Errors)
			}
		}
	}
}

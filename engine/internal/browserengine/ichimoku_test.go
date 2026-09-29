package browserengine_test

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	browser "github.com/alihasan00/crypto/internal/browserengine"
	"github.com/alihasan00/crypto/internal/ichimoku"
)

func TestLectureFamiliesReachTheSelectedBrowserResult(t *testing.T) {
	raw, err := os.ReadFile("testdata/ichimoku-selection.json")
	if err != nil {
		t.Fatal(err)
	}
	var request browser.Request
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	request.Scope = "ichimoku"
	found := map[string]bool{}
	for _, timeframe := range []string{"1d", "4h", "1h", "15m"} {
		request.Timeframe = timeframe
		response := browser.Run(request)
		requireSuccessful(t, response, 1)
		for _, item := range response.Result.Strategies.Items {
			if item.Plan.Status == "ready_for_review" {
				found[item.Opportunity.Family] = true
			}
		}
		for _, series := range response.Scan.Series {
			if len(response.Result.Strategies.Items) > 0 && len(series.IchimokuSeries) != 500 {
				t.Fatal("selected lecture setup has no complete chart")
			}
		}
	}
	for _, family := range []string{"tk_cross", "pk_cross", "cloud_edge_to_edge"} {
		if !found[family] {
			t.Fatalf("lecture method did not reach selection: %s", family)
		}
	}
}

func TestLectureReadingsAndSelectedChartsUseExactCompletedHistories(t *testing.T) {
	request := fixture("BTCUSDT", "ETHUSDT")
	response := browser.Run(request)
	requireSuccessful(t, response, 4)
	selected := map[string]bool{}
	for _, item := range response.Result.Items {
		selected[item.Setup.Symbol] = true
	}
	for _, item := range response.Result.Trends {
		selected[item.Symbol] = true
	}
	for _, item := range response.Result.Strategies.Items {
		selected[item.Opportunity.Symbol] = true
	}
	for _, frame := range response.Scan.Series {
		if frame.Ichimoku == nil || frame.Ichimoku.AsOf == nil || *frame.Ichimoku.AsOf != frame.LastClosedAt {
			t.Fatalf("completed lecture context missing from %s/%s", frame.Symbol, frame.Interval)
		}
		for _, history := range request.Histories {
			if history.Symbol != frame.Symbol || history.Timeframe != frame.Interval {
				continue
			}
			// ATR normalization belongs to the scanner. The underlying prices,
			// event times and cloud projection must match the exact closed input.
			want := ichimoku.AnalyzeLecture(history.Candles, nil)
			if !reflect.DeepEqual(want.Tenkan.Value, frame.Ichimoku.Tenkan.Value) ||
				!reflect.DeepEqual(want.Kijun.Value, frame.Ichimoku.Kijun.Value) ||
				!reflect.DeepEqual(want.TKCross, frame.Ichimoku.TKCross) ||
				!reflect.DeepEqual(want.PKCross, frame.Ichimoku.PKCross) ||
				!reflect.DeepEqual(want.Projection, frame.Ichimoku.Projection) {
				t.Fatal("transport changed lecture values or their availability")
			}
			if selected[frame.Symbol] {
				if !reflect.DeepEqual(ichimoku.Series(history.Candles), frame.IchimokuSeries) {
					t.Fatal("selected chart does not match evaluated closed prices")
				}
			} else if len(frame.IchimokuSeries) != 0 {
				t.Fatal("unselected chart inventory was unnecessarily published")
			}
		}
	}
}

func TestLectureTransportExcludesPreviewAndOwnsItsState(t *testing.T) {
	request := fixture("BTCUSDT")
	before := browser.Run(request)
	requireSuccessful(t, before, 2)
	for i := range request.Histories {
		request.Histories[i].Preview.High = 100000
		request.Histories[i].Preview.Close = 100000
	}
	after := browser.Run(request)
	requireSuccessful(t, after, 2)
	for i := range before.Scan.Series {
		if !reflect.DeepEqual(before.Scan.Series[i].Ichimoku, after.Scan.Series[i].Ichimoku) {
			t.Fatal("provisional prices changed completed lecture readings")
		}
		*before.Scan.Series[i].Ichimoku.Kijun.Value = 1
		if *after.Scan.Series[i].Ichimoku.Kijun.Value == 1 {
			t.Fatal("published lecture readings share mutable state")
		}
	}
}

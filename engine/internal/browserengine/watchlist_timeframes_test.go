package browserengine_test

import (
	"reflect"
	"testing"

	browser "github.com/alihasan00/crypto/internal/browserengine"
	"github.com/alihasan00/crypto/internal/strategies"
)

func TestMixedWatchlistUsesOnlyItsThreeIndependentSources(t *testing.T) {
	request := lectureScopeFixture(t)
	response := browser.Run(request)
	requireSuccessful(t, response, 3)
	if response.Scan.Progress.Total != 3 || response.Scan.Progress.Done != 3 {
		t.Fatal("legacy hourly feeds were scanned")
	}
	if len(response.Result.Items) != 0 || len(response.Result.Trends) != 0 || len(response.Result.Breadth) != 0 {
		t.Fatal("a legacy setup section entered the mixed Watchlist")
	}
	for _, item := range response.Result.Strategies.Items {
		if strategies.PaperFamilyFrame(item.Opportunity.Family) != item.Opportunity.Interval {
			t.Fatal("a legacy method entered the mixed Watchlist")
		}
	}
	for _, frame := range response.Scan.Series {
		if frame.Interval != "1d" && frame.Interval != "4h" && frame.Interval != "15m" {
			t.Fatal("an unrelated timeframe was scanned")
		}
	}
	// Old callers may still provide cached 1h histories. They cannot alter
	// the source-only paper results or chart evidence.
	filtered := request
	filtered.Histories = nil
	for _, history := range request.Histories {
		if history.Timeframe == "1d" || history.Timeframe == "4h" || history.Timeframe == "15m" {
			filtered.Histories = append(filtered.Histories, history)
		}
	}
	if !reflect.DeepEqual(browser.Run(filtered), response) {
		t.Fatal("unused legacy histories changed the paper Watchlist")
	}
}

func TestDedicatedIchimokuRetainsFifteenMinuteSetups(t *testing.T) {
	response := browser.Run(selectedLectureFixture(t, "15m", false))
	requireSuccessful(t, response, 1)
	if len(response.Result.Strategies.Items) == 0 {
		t.Fatal("the general watchlist origin filter removed dedicated 15m Ichimoku setups")
	}
	for _, item := range response.Result.Strategies.Items {
		if item.Opportunity.Interval != "15m" {
			t.Fatal("dedicated Ichimoku selection changed its requested timeframe")
		}
	}
}

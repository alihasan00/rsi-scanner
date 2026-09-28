package browserengine_test

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	browser "github.com/alihasan00/crypto/internal/browserengine"
)

func lectureScopeFixture(t *testing.T) browser.Request {
	t.Helper()
	raw, err := os.ReadFile("testdata/ichimoku-selection.json")
	if err != nil {
		t.Fatal(err)
	}
	var request browser.Request
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	return request
}

func ichimokuFamily(family string) bool {
	switch family {
	case "kijun_reclaim", "cloud_reclaim", "tk_cross", "pk_cross", "cloud_edge_to_edge":
		return true
	}
	return false
}

func TestRequestScopeDefaultsToUnchangedMixedWatchlist(t *testing.T) {
	request := fixture("BTCUSDT")
	implicit := browser.Run(request)
	request.Scope = "all"
	explicit := browser.Run(request)
	requireSuccessful(t, implicit, 4)
	if implicit.Scope != "all" || !reflect.DeepEqual(implicit, explicit) {
		t.Fatal("omitted and explicit all scopes produce different publications")
	}
	if explicit.Result.Limit != 12 || explicit.Result.Strategies.Limit != 12 {
		t.Fatal("the original mixed watchlist lost its display limit")
	}
	// The adapter's default still matches the direct scanner/selector result.
	if expected := directSelection(t, request); !reflect.DeepEqual(expected, *explicit.Result) {
		t.Fatal("scope support altered the default selection")
	}
}

func TestRequestRejectsUnknownScopeAndReturnsSupportedResponseScope(t *testing.T) {
	for _, scope := range []string{"harmonics", "ICHIMOKU", " ichimoku ", "all,ichimoku"} {
		request := fixture("BTCUSDT")
		request.Scope = scope
		response := browser.Run(request)
		if response.Error == "" || !strings.Contains(response.Error, "Scope") || response.Result != nil || len(response.Scan.Series) != 0 || response.Scope != "all" {
			t.Fatalf("unknown scope did not fail before scanning: %+v", response)
		}
	}
	var malformed browser.Response
	if err := json.Unmarshal([]byte(browser.RunJSON("{")), &malformed); err != nil || malformed.Error == "" || malformed.Scope != "all" {
		t.Fatal("malformed response lost its supported scope")
	}
	request := lectureScopeFixture(t)
	request.Scope = "ichimoku"
	request.Now = 0
	response := browser.Run(request)
	if response.Error == "" || response.Scope != "ichimoku" || response.Result != nil {
		t.Fatal("valid scope identity was lost when another request field failed")
	}
}

func TestIchimokuScopeSelectsOnlyItsFamiliesBeforeAnyDisplayCap(t *testing.T) {
	base := lectureScopeFixture(t)
	request := browser.Request{Now: base.Now, Scope: "ichimoku"}
	for i := 0; i < 14; i++ {
		symbol := fmt.Sprintf("LECTURE%02dUSDT", i)
		request.Symbols = append(request.Symbols, symbol)
		for _, history := range base.Histories {
			history.Symbol = symbol
			request.Histories = append(request.Histories, history)
		}
	}
	scoped := browser.Run(request)
	requireSuccessful(t, scoped, 14)
	if scoped.Timeframe != "1h" {
		t.Fatal("omitted Ichimoku timeframe did not default to 1h")
	}
	if scoped.Scope != "ichimoku" || scoped.Result.Limit != 0 || scoped.Result.Strategies.Limit != 0 ||
		len(scoped.Result.Items) != 0 || len(scoped.Result.Trends) != 0 || len(scoped.Result.Strategies.Items) <= 12 {
		t.Fatal("dedicated scope contains other sources or retained an arbitrary display cap")
	}
	selected := map[string]map[string]bool{}
	for _, candidate := range scoped.Result.Strategies.Items {
		if !ichimokuFamily(candidate.Opportunity.Family) {
			t.Fatalf("unrelated family entered Ichimoku scope: %s", candidate.Opportunity.Family)
		}
		if selected[candidate.Opportunity.Symbol] == nil {
			selected[candidate.Opportunity.Symbol] = map[string]bool{}
		}
		if candidate.Eligible {
			selected[candidate.Opportunity.Symbol][candidate.Opportunity.Family] = true
		}
	}
	for _, symbol := range request.Symbols {
		for _, family := range []string{"tk_cross", "pk_cross"} {
			if !selected[symbol][family] {
				t.Fatalf("qualifying %s/%s was crowded out of the dedicated scope", symbol, family)
			}
		}
	}
	for _, series := range scoped.Scan.Series {
		if len(series.IchimokuSeries) != 500 {
			t.Fatal("an asset beyond the old cap lost its selected chart evidence")
		}
	}
	request.Scope = "all"
	mixed := browser.Run(request)
	if mixed.Scope != "all" || len(mixed.Result.Strategies.Items) != 12 {
		t.Fatal("mixed watchlist no longer follows its existing cap")
	}
	request.Scope = "ichimoku"
	for i := range request.Histories {
		if request.Histories[i].Symbol == request.Symbols[0] && request.Histories[i].Timeframe == "1h" {
			request.Histories[i].Status = "error"
		}
	}
	failed := browser.Run(request)
	for _, candidate := range failed.Result.Strategies.Items {
		if candidate.Opportunity.Symbol == request.Symbols[0] {
			t.Fatal("dedicated scope bypassed the selected source history gate")
		}
	}
}

func TestIchimokuScopeDoesNotPromoteUnrelatedOrTerminalInventory(t *testing.T) {
	request := fixture("BTCUSDT")
	request.Scope = "ichimoku"
	response := browser.Run(request)
	requireSuccessful(t, response, 1)
	if len(response.Result.Strategies.Items) != 0 || len(response.Result.Items) != 0 || len(response.Result.Trends) != 0 {
		t.Fatal("the unrelated sweep fixture leaked setups into the dedicated scope")
	}
	for _, summary := range response.Result.Strategies.Summary {
		if !ichimokuFamily(summary.Family) {
			t.Fatal("scope summary included an unrelated method")
		}
	}
}

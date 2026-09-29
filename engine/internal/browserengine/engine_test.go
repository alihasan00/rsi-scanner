package browserengine_test

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	browser "github.com/alihasan00/crypto/internal/browserengine"
	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/selection"
	"github.com/alihasan00/crypto/internal/strategies"
)

func fixtureAt(now time.Time, symbols ...string) browser.Request {
	request := browser.Request{Now: now.UnixMilli(), Symbols: symbols}
	for symbolIndex, symbol := range symbols {
		for frameIndex, timeframe := range scanner.DefaultRequest().Timeframes {
			duration, _ := market.IntervalDuration(timeframe)
			width := duration.Milliseconds()
			lastClose, _ := market.ExpectedClosedTime(now, timeframe, 0, market.BoundaryGrace)
			bars := make([]market.Candle, 500)
			for i := range bars {
				// Integer-generated prices keep the input identical on native Go
				// and WASM; platform trigonometric functions can differ slightly.
				triangle := i % 40
				if triangle > 20 {
					triangle = 40 - triangle
				}
				price := float64(10000+symbolIndex*1000+i*3+triangle*30) / 100
				openTime := lastClose + 1 - int64(len(bars)-i)*width
				bars[i] = market.Candle{OpenTime: openTime, CloseTime: openTime + width - 1,
					Open: price, High: price + 2, Low: price - 2, Close: price + .3, Volume: float64(1000 + i%20*50)}
			}
			preview := bars[len(bars)-1]
			preview.OpenTime += width
			preview.CloseTime += width
			request.Histories = append(request.Histories, browser.InputHistory{
				Symbol: symbol, Timeframe: timeframe, Candles: bars, Preview: &preview,
				ReceivedAt: now.Add(-time.Duration(30+symbolIndex*4+frameIndex) * time.Second).UnixMilli(), Status: "ready",
			})
		}
	}
	return request
}

func fixture(symbols ...string) browser.Request {
	return fixtureAt(time.Date(2026, 9, 28, 12, 7, 0, 0, time.UTC), symbols...)
}

// This independent feed deliberately bypasses the browser adapter. Comparing
// its complete selector output detects changed rules, options, or candle input.
type referenceFeed struct{ request browser.Request }

func (f referenceFeed) Candles(ctx context.Context, symbol, timeframe string, limit int) ([]market.Candle, *market.Candle, error) {
	closed, preview, _, err := f.CandlesWithEvidence(ctx, symbol, timeframe, limit)
	return closed, preview, err
}

func (f referenceFeed) CandlesWithEvidence(_ context.Context, symbol, timeframe string, _ int) ([]market.Candle, *market.Candle, scanner.Evidence, error) {
	for _, history := range f.request.Histories {
		if history.Symbol == symbol && history.Timeframe == timeframe {
			observed := time.UnixMilli(history.ReceivedAt).UTC()
			age := time.UnixMilli(f.request.Now).Sub(observed)
			return append([]market.Candle(nil), history.Candles...), history.Preview,
				scanner.Evidence{ObservedAt: observed, DataAgeSeconds: age.Seconds(), Warnings: []string{}}, nil
		}
	}
	return nil, nil, scanner.Evidence{}, errors.New("fixture history is missing")
}

func directSelection(t *testing.T, request browser.Request) selection.Result {
	t.Helper()
	engine := scanner.New(referenceFeed{request}, request.Symbols, "Independent test feed", 1, harmonic.DefaultConfig())
	scanRequest := scanner.DefaultRequest()
	scanRequest.Timeframes = []string{"1d", "4h"}
	done, err := engine.Start(context.Background(), scanRequest)
	if err != nil {
		t.Fatal(err)
	}
	<-done
	snapshot := engine.Snapshot()
	if len(snapshot.Errors) != 0 {
		t.Fatalf("reference scan failed: %+v", snapshot.Errors)
	}
	histories := map[string]scanner.History{}
	for _, symbol := range request.Symbols {
		for _, timeframe := range scanRequest.Timeframes {
			value, ok := engine.History(symbol, timeframe)
			if !ok {
				t.Fatalf("reference history absent: %s/%s", symbol, timeframe)
			}
			histories[symbol+"/"+timeframe] = value
		}
	}
	return selection.BuildPaperWatchlist(snapshot, histories, request.Symbols, time.UnixMilli(request.Now).UTC(), 2*time.Minute, selection.DefaultConfig())
}

func requireSuccessful(t *testing.T, response browser.Response, series int) {
	t.Helper()
	if response.Error != "" || response.Result == nil || len(response.Scan.Errors) != 0 || len(response.Scan.Series) != series {
		t.Fatalf("unexpected scan outcome: error=%q, result=%t, series=%d, failures=%+v", response.Error, response.Result != nil, len(response.Scan.Series), response.Scan.Errors)
	}
	for _, frame := range response.Scan.Series {
		if !frame.Ready {
			t.Fatalf("valid fixture was not ready: %+v", frame)
		}
	}
}

func TestRunMatchesScannerAndWatchlistSelector(t *testing.T) {
	request := fixture("BTCUSDT", "ETHUSDT")
	before, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	want := directSelection(t, request)
	response := browser.Run(request)
	requireSuccessful(t, response, 4)
	if !reflect.DeepEqual(*response.Result, want) {
		t.Fatal("browser adapter changed the scanner/watchlist selector result")
	}
	if response.Result.Limit != 0 || response.Result.Strategies.Limit != 0 ||
		len(response.Result.Items) != 0 || len(response.Result.Trends) != 0 {
		t.Fatal("mixed Watchlist retained a legacy display cap or old strategy section")
	}
	if len(response.Result.Strategies.Summary) != len(strategies.PaperFamilies) {
		t.Fatal("mixed Watchlist lost an active paper profile")
	}
	for i, summary := range response.Result.Strategies.Summary {
		if summary.Family != strategies.PaperFamilies[i] {
			t.Fatalf("unexpected paper profile at %d: %s", i, summary.Family)
		}
	}
	if response.Version != browser.Version || response.SourceHash != browser.SourceHash || response.MaxAgeMS != 120000 || response.Now != request.Now {
		t.Fatal("response lost frozen-source provenance or freshness policy")
	}
	if response.Scan.Progress.Done != 4 || response.Scan.Progress.Total != 4 {
		t.Fatalf("incomplete scan publication: %+v", response.Scan.Progress)
	}
	for _, frame := range response.Scan.Series {
		for _, history := range request.Histories {
			if frame.Symbol == history.Symbol && frame.Interval == history.Timeframe {
				if frame.ObservedAt != history.ReceivedAt || frame.ClosedCandles != 500 || frame.LastClosedAt != history.Candles[499].CloseTime {
					t.Fatalf("original candle/receipt evidence changed: %+v", frame)
				}
			}
		}
	}
	after, _ := json.Marshal(request)
	if string(before) != string(after) {
		t.Fatal("scan mutated the supplied publication")
	}
}

func TestReceiptFreshnessIsNotRenewedByReading(t *testing.T) {
	for _, test := range []struct {
		name  string
		delta time.Duration
		valid bool
	}{
		{"two minutes old", -2 * time.Minute, true},
		{"past two minutes", -2*time.Minute - time.Millisecond, false},
		{"clock skew grace", 5 * time.Second, true},
		{"past clock skew grace", 5*time.Second + time.Millisecond, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := fixture("BTCUSDT")
			for i := range request.Histories {
				request.Histories[i].ReceivedAt = request.Now + test.delta.Milliseconds()
			}
			response := browser.Run(request)
			if test.valid {
				requireSuccessful(t, response, 2)
				for _, frame := range response.Scan.Series {
					if frame.ObservedAt != request.Now+test.delta.Milliseconds() {
						t.Fatal("receipt timestamp was renewed or clamped")
					}
				}
			} else if response.Error != "" || len(response.Scan.Errors) != 2 || len(response.Scan.Series) != 0 {
				t.Fatalf("expired/future receipts escaped feed rejection: %+v", response.Scan)
			}
		})
	}
	request := fixture("BTCUSDT")
	requireSuccessful(t, browser.Run(request), 2)
	request.Now += (2 * time.Minute).Milliseconds()
	response := browser.Run(request)
	if len(response.Scan.Errors) != 2 || len(response.Scan.Series) != 0 {
		t.Fatal("re-reading the same candles renewed their original receipts")
	}
}

func TestPaperSourceMustCloseBeforeEvaluationTime(t *testing.T) {
	request := fixtureAt(time.Date(2026, 9, 29, 0, 0, 2, 0, time.UTC), "BTCUSDT")
	request.Now = request.Histories[0].Candles[len(request.Histories[0].Candles)-1].CloseTime
	for i := range request.Histories {
		request.Histories[i].ReceivedAt = request.Now
	}
	response := browser.Run(request)
	if response.Error != "" || len(response.Scan.Errors) != 2 || len(response.Scan.Series) != 0 || response.Result == nil {
		t.Fatalf("a candle at the exact close millisecond entered the paper Watchlist: %+v", response.Scan)
	}
	for _, failure := range response.Scan.Errors {
		if !strings.Contains(failure.Error, "before the paper evaluation time") {
			t.Fatalf("wrong paper close-boundary rejection: %+v", failure)
		}
	}
	request.Scope, request.Timeframe = "ichimoku", "1d"
	requireSuccessful(t, browser.Run(request), 1)
}

func TestInvalidHistoryCannotSupplyASetup(t *testing.T) {
	tests := []struct {
		name    string
		change  func(*browser.InputHistory)
		message string
	}{
		{"request still loading", func(h *browser.InputHistory) { h.Status = "loading" }, "request failed"},
		{"request error with retained candles", func(h *browser.InputHistory) {
			h.Status = "error"
			message := "provider unavailable"
			h.Error = &message
		}, "provider unavailable"},
		{"ready flag with error", func(h *browser.InputHistory) { message := "provider timeout"; h.Error = &message }, "provider timeout"},
		{"missing receipt", func(h *browser.InputHistory) { h.ReceivedAt = 0 }, "receipt time"},
		{"unsafe receipt", func(h *browser.InputHistory) { h.ReceivedAt = 1 << 53 }, "receipt time"},
		{"no completed history", func(h *browser.InputHistory) { h.Candles = nil }, "completed candles"},
		{"too much history", func(h *browser.InputHistory) { h.Candles = append(h.Candles, *h.Preview) }, "completed candles"},
		{"invalid price geometry", func(h *browser.InputHistory) { h.Candles[10].High = h.Candles[10].Low - 1 }, "invalid OHLCV"},
		{"nonfinite price", func(h *browser.InputHistory) { h.Candles[10].Close = math.NaN() }, "invalid OHLCV"},
		{"wrong candle duration", func(h *browser.InputHistory) { h.Candles[10].CloseTime-- }, "duration"},
		{"duplicate candle", func(h *browser.InputHistory) { h.Candles[10] = h.Candles[9] }, "gap, overlap or duplicate"},
		{"out of order candles", func(h *browser.InputHistory) { h.Candles[10], h.Candles[11] = h.Candles[11], h.Candles[10] }, "gap, overlap or duplicate"},
		{"interior gap", func(h *browser.InputHistory) { h.Candles = append(h.Candles[:10], h.Candles[11:]...) }, "gap, overlap or duplicate"},
		{"latest closed candle missing", func(h *browser.InputHistory) { h.Candles = h.Candles[:499]; h.Preview = nil }, "latest completed candle is missing"},
		{"provisional falsely finalized", func(h *browser.InputHistory) { h.Candles = append(h.Candles[1:], *h.Preview); h.Preview = nil }, "ends in the future"},
		{"invalid preview", func(h *browser.InputHistory) { h.Preview.Volume = -1 }, "Provisional candle"},
		{"overlapping preview", func(h *browser.InputHistory) { preview := h.Candles[499]; h.Preview = &preview }, "immediately follow"},
		{"future preview gap", func(h *browser.InputHistory) {
			h.Preview.OpenTime += int64(24 * time.Hour / time.Millisecond)
			h.Preview.CloseTime += int64(24 * time.Hour / time.Millisecond)
		}, "immediately follow"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := fixture("BTCUSDT")
			test.change(&request.Histories[0])
			response := browser.Run(request)
			if response.Error != "" || response.Result == nil || len(response.Scan.Errors) != 1 || len(response.Scan.Series) != 1 {
				t.Fatalf("invalid history was not isolated: %+v", response.Scan)
			}
			failure := response.Scan.Errors[0]
			if failure.Symbol != "BTCUSDT" || failure.Interval != "1d" || !strings.Contains(failure.Error, test.message) {
				t.Fatalf("wrong failure: %+v; wanted %q", failure, test.message)
			}
			for _, item := range response.Result.Strategies.Items {
				if item.Opportunity.Interval == "1d" {
					t.Fatal("invalid daily history produced a daily paper setup")
				}
			}
			if len(response.Result.Items) != 0 || len(response.Result.Trends) != 0 {
				t.Fatal("legacy setup entered the mixed Watchlist")
			}
		})
	}
}

func TestMissingTimeframeAndCandleBoundaryRemainUnavailable(t *testing.T) {
	request := fixture("BTCUSDT", "ETHUSDT")
	request.Histories = request.Histories[1:]
	response := browser.Run(request)
	if response.Error != "" || response.Result == nil || len(response.Scan.Errors) != 1 || len(response.Scan.Series) != 3 {
		t.Fatalf("missing timeframe coverage was hidden: %+v", response.Scan)
	}
	if len(response.Result.Breadth) != 0 {
		t.Fatal("legacy breadth entered the paper Watchlist")
	}
	for _, coverage := range response.Result.Strategies.Coverage {
		if coverage.Symbol == "BTCUSDT" && coverage.Interval == "1d" && coverage.Status != "data_unavailable" {
			t.Fatalf("missing daily history changed the paper coverage denominator: %+v", coverage)
		}
	}
	for _, item := range response.Result.Items {
		if item.Setup.Symbol == "BTCUSDT" {
			t.Fatal("missing context produced a harmonic item")
		}
	}
	for _, item := range response.Result.Trends {
		if item.Symbol == "BTCUSDT" {
			t.Fatal("missing context produced a trend item")
		}
	}
	for _, item := range response.Result.Strategies.Items {
		if item.Opportunity.Symbol == "BTCUSDT" && item.Opportunity.Interval == "1d" {
			t.Fatal("missing daily history produced a daily paper setup")
		}
	}
	// During delivery grace, an older close may be ready. Once grace passes,
	// the same recently received data cannot stand in for the missing close.
	request = fixtureAt(time.Date(2026, 9, 28, 12, 0, 2, 0, time.UTC), "BTCUSDT")
	requireSuccessful(t, browser.Run(request), 2)
	request.Now += (4 * time.Second).Milliseconds()
	response = browser.Run(request)
	if len(response.Scan.Errors) != 1 || response.Scan.Errors[0].Interval != "4h" {
		t.Fatalf("new 4h close was not required after grace: %+v", response.Scan.Errors)
	}
}

func TestPreviewChangesQuoteWithoutBecomingCompletedEvidence(t *testing.T) {
	request := fixture("BTCUSDT")
	before := browser.Run(request)
	requireSuccessful(t, before, 2)
	for i := range request.Histories {
		request.Histories[i].Preview.High = 100000
		request.Histories[i].Preview.Close = 100000
	}
	after := browser.Run(request)
	requireSuccessful(t, after, 2)
	for i, frame := range after.Scan.Series {
		previous := before.Scan.Series[i]
		if frame.Price != 100000 || frame.PriceSource != "provisional_candle" {
			t.Fatal("current preview was not used as a provisional quote")
		}
		if frame.LastClosedAt != previous.LastClosedAt || frame.ClosedCandles != previous.ClosedCandles || frame.Trend != previous.Trend || frame.Momentum != previous.Momentum || frame.InternalBias != previous.InternalBias {
			t.Fatal("preview changed completed-candle trend or structure evidence")
		}
	}
	for i := range request.Histories {
		request.Histories[i].Preview = nil
	}
	without := browser.Run(request)
	requireSuccessful(t, without, 2)
	for _, frame := range without.Scan.Series {
		if frame.PriceSource != "closed_candle" || frame.ClosedCandles != 500 || frame.Price == 100000 {
			t.Fatal("absent preview did not retain the final completed-candle quote")
		}
	}
}

func TestInvalidRequestHasNoSelectionResult(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*browser.Request)
	}{
		{"invalid now", func(r *browser.Request) { r.Now = 0 }},
		{"unsafe now", func(r *browser.Request) { r.Now = 1 << 53 }},
		{"no symbols", func(r *browser.Request) { r.Symbols = nil }},
		{"duplicate symbols", func(r *browser.Request) { r.Symbols = append(r.Symbols, r.Symbols[0]) }},
		{"ambiguous symbol", func(r *browser.Request) { r.Symbols[0] = "BTC/USDT" }},
		{"duplicate histories", func(r *browser.Request) { r.Histories[1] = r.Histories[0] }},
		{"unexpected symbol", func(r *browser.Request) { r.Histories[0].Symbol = "ETHUSDT" }},
		{"unsupported timeframe", func(r *browser.Request) { r.Histories[0].Timeframe = "5m" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := fixture("BTCUSDT")
			test.change(&request)
			response := browser.Run(request)
			if response.Error == "" || response.Result != nil || len(response.Scan.Series) != 0 {
				t.Fatal("invalid request was presented as a valid selection publication")
			}
		})
	}
}

func TestRunJSONPreservesResultAndReportsMalformedInput(t *testing.T) {
	request := fixture("BTCUSDT")
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var response browser.Response
	if err := json.Unmarshal([]byte(browser.RunJSON(string(raw))), &response); err != nil {
		t.Fatal(err)
	}
	requireSuccessful(t, response, 2)
	want, _ := json.Marshal(browser.Run(request))
	got, _ := json.Marshal(response)
	if string(got) != string(want) {
		t.Fatal("JSON transport changed the public engine result")
	}
	for _, raw := range []string{"{", `{"now":"yesterday"}`, "null"} {
		var failure browser.Response
		if err := json.Unmarshal([]byte(browser.RunJSON(raw)), &failure); err != nil {
			t.Fatal(err)
		}
		if failure.Error == "" || failure.Result != nil {
			t.Fatal("malformed JSON was treated as a completed scan")
		}
	}
}

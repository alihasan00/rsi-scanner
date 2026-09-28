package market

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const sampleKlines = `[[0,"100","120","90","110","12.5",59999],[60000,"110","125","105","120","9",119999]]`

func TestCandlesRequestKeepsNewestBarProvisional(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v3/klines" || r.URL.Query().Get("symbol") != "币安人生USDT" || r.URL.Query().Get("interval") != "1m" || r.URL.Query().Get("limit") != "350" {
			t.Errorf("unexpected request: %s", r.URL.String())
		}
		fmt.Fprint(w, sampleKlines)
	}))
	defer server.Close()
	client := testClient(server.URL+"/api/v3/", server.Client())
	closed, preview, err := client.Candles(context.Background(), "币安人生USDT", "1m", 350)
	if err != nil {
		t.Fatal(err)
	}
	if len(closed) != 1 || closed[0].Close != 110 || closed[0].Volume != 12.5 {
		t.Fatalf("unexpected closed bars: %+v", closed)
	}
	// Both timestamps are long past. The newest bar must still stay provisional.
	if preview == nil || preview.OpenTime != 60000 || preview.Close != 120 {
		t.Fatalf("unexpected preview: %+v", preview)
	}
}

func TestCandlesSinceUsesInclusiveStartAndKeepsLastPageBarProvisional(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Query().Get("startTime") != "0" || r.URL.Query().Get("limit") != "1000" {
			t.Errorf("unexpected incremental query: %s", r.URL.String())
		}
		fmt.Fprint(w, sampleKlines)
	}))
	defer server.Close()
	client := testClient(server.URL, server.Client())
	closed, preview, err := client.CandlesSince(context.Background(), "BTCUSDT", "1m", 0, 1000)
	if err != nil || len(closed) != 1 || preview == nil || preview.OpenTime != 60000 {
		t.Fatalf("incremental response: final=%+v preview=%+v err=%v", closed, preview, err)
	}
	for _, start := range []int64{-1, 1 << 53} {
		if _, _, err := client.CandlesSince(context.Background(), "BTCUSDT", "1m", start, 1000); err == nil {
			t.Fatalf("accepted invalid start time %d", start)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("invalid start time reached exchange: %d calls", calls.Load())
	}
}

func TestParseKlinesRejectsMalformedMarketData(t *testing.T) {
	cases := map[string]string{
		"empty":            `[]`,
		"null":             `null`,
		"object":           `{"code":-1}`,
		"short row":        `[[0,"100"]]`,
		"non numeric":      `[[0,"oops","120","90","110","1",59999]]`,
		"null price":       `[[0,null,"120","90","110","1",59999]]`,
		"nan":              `[[0,"NaN","120","90","110","1",59999]]`,
		"infinity":         `[[0,"100","+Inf","90","110","1",59999]]`,
		"zero price":       `[[0,"0","120","90","110","1",59999]]`,
		"negative volume":  `[[0,"100","120","90","110","-1",59999]]`,
		"high below close": `[[0,"100","105","90","110","1",59999]]`,
		"low above open":   `[[0,"100","120","105","110","1",59999]]`,
		"fractional time":  `[[0.5,"100","120","90","110","1",59999]]`,
		"negative time":    `[[-1,"100","120","90","110","1",59999]]`,
		"unsafe time":      `[[0,"100","120","90","110","1",9007199254740992]]`,
		"reversed time":    `[[60000,"100","120","90","110","1",59999]]`,
		"duplicate":        `[[0,"100","120","90","110","1",59999],[0,"100","120","90","110","1",59999]]`,
		"gap":              `[[0,"100","120","90","110","1",59999],[120000,"100","120","90","110","1",179999]]`,
		"overlap":          `[[0,"100","120","90","110","1",59999],[50000,"100","120","90","110","1",119999]]`,
		"out of order":     `[[60000,"100","120","90","110","1",119999],[0,"100","120","90","110","1",59999]]`,
		"invalid preview":  `[[0,"100","120","90","110","1",59999],[60000,"100","120","90","-1","1",119999]]`,
		"trailing data":    sampleKlines + `[]`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, _, err := parseKlines([]byte(body)); err == nil {
				t.Fatalf("accepted malformed data: %s", body)
			}
		})
	}
}

func TestParseKlinesSingleBarAndCalendarMonth(t *testing.T) {
	closed, preview, err := parseKlines([]byte(`[["0",100,100,100,100,0,"59999"]]`))
	if err != nil || len(closed) != 0 || preview == nil || preview.Volume != 0 {
		t.Fatalf("single provisional candle: closed=%+v preview=%+v err=%v", closed, preview, err)
	}
	// January and February do not have equal millisecond durations.
	closed, preview, err = parseKlines([]byte(`[[1704067200000,"100","120","90","110","1",1706745599999],[1706745600000,"100","120","90","110","1",1709251199999]]`))
	if err != nil || len(closed) != 1 || preview == nil {
		t.Fatalf("calendar month bars should be contiguous: %v", err)
	}
}

func TestCandleValidRejectsNonFiniteVolume(t *testing.T) {
	for _, volume := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), -1} {
		if (Candle{Open: 1, High: 1, Low: 1, Close: 1, Volume: volume}).Valid() {
			t.Errorf("accepted volume %v", volume)
		}
	}
}

func TestCandlesValidatesArgumentsBeforeHTTP(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, sampleKlines)
	}))
	defer server.Close()
	client := testClient(server.URL, server.Client())
	for _, args := range []struct {
		symbol, interval string
		limit            int
	}{
		{"BTCUSDT&limit=1", "1m", 100}, {"BTCUSDT", "1H", 100},
		{"BTCUSDT", "1m", 0}, {"BTCUSDT", "1m", 1001}, {"USDT", "1m", 100},
	} {
		if _, _, err := client.Candles(context.Background(), args.symbol, args.interval, args.limit); err == nil {
			t.Errorf("accepted arguments %+v", args)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid arguments made %d requests", calls.Load())
	}
}

func TestCandlesRetriesTransientStatusesAndBoundsAttempts(t *testing.T) {
	for _, status := range []int{429, 500, 503} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if calls.Add(1) <= 2 {
					w.WriteHeader(status)
					return
				}
				fmt.Fprint(w, sampleKlines)
			}))
			defer server.Close()
			client := testClient(server.URL, server.Client())
			client.requestSpacing = 0
			client.retryBackoff = time.Millisecond
			if _, _, err := client.Candles(context.Background(), "BTCUSDT", "1m", 100); err != nil || calls.Load() != 3 {
				t.Fatalf("retry result: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
	for _, status := range []int{400, 403, 451, 503} {
		t.Run("persistent "+fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(status)
			}))
			defer server.Close()
			client := testClient(server.URL, server.Client())
			client.requestSpacing = 0
			client.retryBackoff = time.Millisecond
			_, _, err := client.Candles(context.Background(), "BTCUSDT", "1m", 100)
			wantCalls := int32(1)
			if status >= 500 {
				wantCalls = 3
			}
			if err == nil || !strings.Contains(err.Error(), fmt.Sprint(status)) || calls.Load() != wantCalls {
				t.Fatalf("unexpected result: calls=%d err=%v", calls.Load(), err)
			}
		})
	}
}

func TestRateLimitCooldownSharedAndCancellable(t *testing.T) {
	for _, status := range []int{429, 418} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if status == 429 {
					w.Header().Set("Retry-After", "3600")
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			client := testClient(server.URL, server.Client())
			client.requestSpacing = 0
			client.retryBackoff = time.Millisecond
			for _, symbol := range []string{"BTCUSDT", "ETHUSDT"} {
				ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
				_, _, err := client.Candles(ctx, symbol, "1m", 100)
				cancel()
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("cooldown should be cancellable: %v", err)
				}
			}
			if calls.Load() != 1 {
				t.Fatalf("shared cooldown did not suppress new requests: %d", calls.Load())
			}
		})
	}
}

func TestConcurrentRequestsSharePacing(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		fmt.Fprint(w, sampleKlines)
	}))
	defer server.Close()
	client := testClient(server.URL, server.Client())
	client.requestSpacing = 10 * time.Millisecond
	start := time.Now()
	var group sync.WaitGroup
	for i := 0; i < 8; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			if _, _, err := client.Candles(context.Background(), "BTCUSDT", "1m", 100); err != nil {
				t.Error(err)
			}
		}()
	}
	group.Wait()
	if elapsed := time.Since(start); elapsed < 70*time.Millisecond || calls.Load() != 8 {
		t.Fatalf("requests were not paced: calls=%d elapsed=%v", calls.Load(), elapsed)
	}
}

func TestCancelledRequestDoesNotReachExchange(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := testClient(server.URL, server.Client()).Candles(ctx, "BTCUSDT", "1m", 100)
	if !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("cancellation result: calls=%d err=%v", calls.Load(), err)
	}
}

func TestClientAddsTimeoutWithoutMutatingCaller(t *testing.T) {
	provided := &http.Client{}
	client := testClient("", provided)
	if provided.Timeout != 0 || client.httpClient.Timeout != 15*time.Second || client.baseURL != DefaultBaseURL {
		t.Fatalf("unexpected client defaults: provided=%v owned=%v", provided.Timeout, client.httpClient.Timeout)
	}
}

func TestRetryAfter(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	for value, expected := range map[string]time.Duration{
		"2": 2 * time.Second, "0": 0, "-1": 0, "invalid": 0,
		"259200": 72 * time.Hour,
		now.Add(10 * time.Second).Format(http.TimeFormat): 10 * time.Second,
		now.Add(-time.Second).Format(http.TimeFormat):     0,
	} {
		if got := retryAfter(value, now); got != expected {
			t.Errorf("Retry-After %q: got %v want %v", value, got, expected)
		}
	}
}

func testClient(baseURL string, httpClient *http.Client) *Client {
	client := NewClient(baseURL, httpClient)
	client.now = func() time.Time { return time.UnixMilli(90000) }
	return client
}

package scanner

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
)

type feedFunc func(context.Context, string, string, int) ([]market.Candle, *market.Candle, error)

func (f feedFunc) Candles(ctx context.Context, symbol, interval string, limit int) ([]market.Candle, *market.Candle, error) {
	return f(ctx, symbol, interval, limit)
}

func flatCandles() []market.Candle {
	candles := make([]market.Candle, 100)
	for i := range candles {
		candles[i] = market.Candle{OpenTime: int64(i) * 60_000, CloseTime: int64(i+1)*60_000 - 1, Open: 100, High: 100, Low: 100, Close: 100, Volume: 2}
	}
	return candles
}

func waitScan(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("scan did not finish")
	}
}

func TestRequestValidate(t *testing.T) {
	cases := []struct {
		name   string
		modify func(*Request)
	}{
		{"missing timeframes", func(r *Request) { r.Timeframes = nil }},
		{"unsupported timeframe", func(r *Request) { r.Timeframes = []string{"7m"} }},
		{"duplicate timeframe", func(r *Request) { r.Timeframes = []string{"1h", "1h"} }},
		{"too many timeframes", func(r *Request) { r.Timeframes = []string{"1m", "3m", "5m", "15m", "30m", "1h", "4h"} }},
		{"short history", func(r *Request) { r.Limit = 99 }},
		{"excess history", func(r *Request) { r.Limit = 1001 }},
		{"negative score", func(r *Request) { r.MinScore = -1 }},
		{"excess score", func(r *Request) { r.MinScore = 101 }},
		{"NaN score", func(r *Request) { r.MinScore = math.NaN() }},
		{"infinite score", func(r *Request) { r.MinScore = math.Inf(1) }},
		{"unknown direction", func(r *Request) { r.Direction = "long" }},
		{"unknown family", func(r *Request) { r.Kinds = []string{"unknown"} }},
		{"duplicate family", func(r *Request) { r.Kinds = []string{"bat", "bat"} }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			req := DefaultRequest()
			test.modify(&req)
			if err := req.Validate(); err == nil {
				t.Fatal("expected invalid request to be rejected")
			}
		})
	}
	for _, score := range []float64{0, 90, 100} {
		for _, limit := range []int{100, 500, 1000} {
			req := DefaultRequest()
			req.MinScore, req.Limit = score, limit
			req.Kinds = []string{"gartley", "bat", "butterfly", "crab", "shark", "cypher"}
			if err := req.Validate(); err != nil {
				t.Fatalf("valid boundary request rejected: %v", err)
			}
		}
	}
}

func TestScanReportsEveryPairAndPreservesEvidence(t *testing.T) {
	var mu sync.Mutex
	calls := make(map[string]int)
	feed := feedFunc(func(_ context.Context, symbol, interval string, limit int) ([]market.Candle, *market.Candle, error) {
		if limit != 500 {
			t.Errorf("feed limit = %d, want 500", limit)
		}
		mu.Lock()
		calls[symbol+"/"+interval]++
		mu.Unlock()
		switch symbol {
		case "BADUSDT":
			return nil, nil, errors.New("upstream unavailable")
		case "EMPTYUSDT":
			return []market.Candle{}, nil, nil
		default:
			preview := market.Candle{OpenTime: 6_000_000, CloseTime: 6_059_999, Open: 100, High: 102, Low: 100, Close: 101, Volume: 1}
			return flatCandles(), &preview, nil
		}
	})
	s := New(feed, []string{"BTCUSDT", "ETHUSDT", "BADUSDT", "EMPTYUSDT"}, "test source", 3, harmonic.DefaultConfig())
	done, err := s.Start(context.Background(), DefaultRequest())
	if err != nil {
		t.Fatal(err)
	}
	waitScan(t, done)
	state := s.Snapshot()
	if state.Running || state.Progress.Done != 16 || state.Progress.Total != 16 || state.SymbolCount != 4 {
		t.Fatalf("unexpected finished progress: %+v", state)
	}
	if state.StartedAt == nil || state.FinishedAt == nil || state.FinishedAt.Before(*state.StartedAt) {
		t.Fatal("missing or invalid scan timestamps")
	}
	if state.Source != "test source" || len(state.Errors) != 8 {
		t.Fatalf("source/errors = %q/%+v", state.Source, state.Errors)
	}
	if len(state.Rows) != 0 {
		t.Fatalf("flat candles unexpectedly produced patterns: %+v", state.Rows)
	}
	for _, symbol := range s.Symbols() {
		for _, interval := range DefaultRequest().Timeframes {
			if calls[symbol+"/"+interval] != 1 {
				t.Errorf("expected exactly one feed request for %s/%s", symbol, interval)
			}
		}
	}
	for _, e := range state.Errors {
		if e.Symbol == "BADUSDT" && e.Error != "upstream unavailable" {
			t.Errorf("lost upstream error: %+v", e)
		}
		if e.Symbol == "EMPTYUSDT" && e.Error != "no closed candles returned" {
			t.Errorf("missing empty-history error: %+v", e)
		}
	}
	history, ok := s.History("btcusdt", "1h")
	if !ok || len(history.Candles) != 100 || history.Preview == nil || history.Preview.Close != 101 {
		t.Fatalf("missing exact scan history: %+v, found=%v", history, ok)
	}
	history.Candles[0].Close = 999
	history.Preview.Close = 999
	fresh, _ := s.History("BTCUSDT", "1h")
	if fresh.Candles[0].Close != 100 || fresh.Preview.Close != 101 {
		t.Fatal("history caller can mutate stored scan evidence")
	}
	if _, ok := s.History("BADUSDT", "1h"); ok {
		t.Fatal("failed pair unexpectedly has history")
	}
}

func TestSingleFlightAndCanceledPairs(t *testing.T) {
	entered := make(chan struct{}, 1)
	feed := feedFunc(func(ctx context.Context, _, _ string, _ int) ([]market.Candle, *market.Candle, error) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-ctx.Done()
		return nil, nil, ctx.Err()
	})
	s := New(feed, []string{"BTCUSDT", "ETHUSDT", "SOLUSDT"}, "fixture", 1, harmonic.DefaultConfig())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := DefaultRequest()
	done, err := s.Start(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("feed never received scan")
	}
	if another, err := s.Start(ctx, req); !errors.Is(err, ErrRunning) || another != nil {
		t.Fatalf("overlapping scan returned channel=%v, error=%v", another, err)
	}
	running := s.Snapshot()
	if !running.Running || running.Progress.Done != 0 || running.Progress.Total != 12 || running.FinishedAt != nil {
		t.Fatalf("incorrect running state: %+v", running)
	}
	req.Timeframes[0] = "mutated"
	cancel()
	waitScan(t, done)
	state := s.Snapshot()
	if state.Running || state.Progress.Done != 12 || len(state.Errors) != 12 {
		t.Fatalf("canceled scan hides skipped pairs: %+v", state)
	}
	if state.Config.Timeframes[0] != "1d" {
		t.Fatal("caller mutated active request")
	}
	seen := make(map[string]bool)
	for _, e := range state.Errors {
		key := e.Symbol + "/" + e.Interval
		if seen[key] || !strings.Contains(e.Error, "context canceled") {
			t.Errorf("unexpected canceled-pair error: %+v", e)
		}
		seen[key] = true
	}
	if _, err := s.Start(ctx, DefaultRequest()); !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-canceled start error = %v", err)
	}
}

func TestWorkerConcurrencyIsBounded(t *testing.T) {
	for _, test := range []struct{ requested, expected int }{{0, 1}, {3, 3}, {99, 12}} {
		t.Run(fmt.Sprint(test.requested), func(t *testing.T) {
			entered := make(chan struct{}, 20)
			release := make(chan struct{})
			var active, maximum atomic.Int32
			feed := feedFunc(func(_ context.Context, _, _ string, _ int) ([]market.Candle, *market.Candle, error) {
				current := active.Add(1)
				for previous := maximum.Load(); current > previous; previous = maximum.Load() {
					if maximum.CompareAndSwap(previous, current) {
						break
					}
				}
				entered <- struct{}{}
				<-release
				active.Add(-1)
				return nil, nil, errors.New("fixture")
			})
			symbols := make([]string, 20)
			for i := range symbols {
				symbols[i] = fmt.Sprintf("COIN%dUSDT", i)
			}
			s := New(feed, symbols, "fixture", test.requested, harmonic.DefaultConfig())
			req := DefaultRequest()
			req.Timeframes = []string{"1h"}
			done, err := s.Start(context.Background(), req)
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < test.expected; i++ {
				select {
				case <-entered:
				case <-time.After(5 * time.Second):
					close(release)
					t.Fatal("configured workers did not begin")
				}
			}
			close(release)
			waitScan(t, done)
			if got := int(maximum.Load()); got != test.expected {
				t.Fatalf("maximum concurrency = %d, want %d", got, test.expected)
			}
		})
	}
}

func TestSnapshotsOwnTheirMutableData(t *testing.T) {
	symbols := []string{"BTCUSDT"}
	s := New(nil, symbols, "fixture", 1, harmonic.DefaultConfig())
	symbols[0] = "MUTATED"
	copySymbols := s.Symbols()
	copySymbols[0] = "ALSO MUTATED"
	if got := s.Symbols()[0]; got != "BTCUSDT" {
		t.Fatalf("caller mutated symbols: %s", got)
	}
	now := time.Now().UTC()
	entryC, entryD, dScore := 100.0, 101.0, 95.0
	s.state.StartedAt, s.state.FinishedAt = &now, &now
	s.state.Rows = []Row{
		{Symbol: "ETHUSDT", Pattern: harmonic.Pattern{ID: "z", Score: 91}},
		{Symbol: "BTCUSDT", Pattern: harmonic.Pattern{ID: "b", Score: 99}},
		{Symbol: "BTCUSDT", Pattern: harmonic.Pattern{ID: "a", Score: 99,
			D: &harmonic.Point{Price: 100}, Ratios: map[string]float64{"AB/XA": .618},
			EntryAfterC: &entryC, EntryAfterD: &entryD, EntryScore: &dScore,
			ScoreComponents: harmonic.ScoreComponents{DConfluence: &dScore}}},
	}
	s.state.Errors = []ScanError{{"BTCUSDT", "1h", "original"}}
	s.state.Config.Kinds = []string{"bat"}
	before := s.Snapshot()
	if before.Rows[0].Pattern.ID != "a" || before.Rows[1].Pattern.ID != "b" || before.Rows[2].Pattern.ID != "z" {
		t.Fatalf("rows are not deterministic: %+v", before.Rows)
	}
	before.Rows[0].Symbol = "MUTATED"
	before.Errors[0].Error = "MUTATED"
	before.Config.Timeframes[0] = "MUTATED"
	before.Config.Kinds[0] = "MUTATED"
	before.Rows[0].Pattern.D.Price = 999
	before.Rows[0].Pattern.Ratios["AB/XA"] = 999
	*before.Rows[0].Pattern.EntryAfterC = 999
	*before.Rows[0].Pattern.EntryAfterD = 999
	*before.Rows[0].Pattern.EntryScore = 999
	*before.Rows[0].Pattern.ScoreComponents.DConfluence = 999
	*before.StartedAt = time.Time{}
	*before.FinishedAt = time.Time{}
	after := s.Snapshot()
	if after.Rows[0].Symbol != "BTCUSDT" || after.Errors[0].Error != "original" || after.Config.Timeframes[0] != "1d" || after.Config.Kinds[0] != "bat" {
		t.Fatal("snapshot mutations leaked into scanner state")
	}
	if after.StartedAt.IsZero() || after.FinishedAt.IsZero() {
		t.Fatal("snapshot timestamps share mutable pointers with scanner state")
	}
	p := after.Rows[0].Pattern
	if p.D.Price != 100 || p.Ratios["AB/XA"] != .618 || *p.EntryAfterC != 100 || *p.EntryAfterD != 101 || *p.EntryScore != 95 || *p.ScoreComponents.DConfluence != 95 {
		t.Fatal("snapshot pattern maps or pointers share mutable state")
	}
}

func TestSettingsAreIsolatedFromCallerMutation(t *testing.T) {
	cfg := harmonic.DefaultConfig()
	s := New(nil, []string{"BTCUSDT"}, "fixture", 1, cfg)
	cfg.Types[0] = "mutated"
	copyConfig := s.Settings()
	copyConfig.Types[1] = "also mutated"
	actual := s.Settings()
	if actual.Types[0] != "gartley" || actual.Types[1] != "bat" {
		t.Fatalf("caller can change scanner settings after construction: %+v", actual.Types)
	}
}

func TestNewScanClearsPreviousEvidence(t *testing.T) {
	var fail atomic.Bool
	feed := feedFunc(func(_ context.Context, _, _ string, _ int) ([]market.Candle, *market.Candle, error) {
		if fail.Load() {
			return nil, nil, errors.New("unavailable")
		}
		return flatCandles(), nil, nil
	})
	s := New(feed, []string{"BTCUSDT"}, "fixture", 1, harmonic.DefaultConfig())
	req := DefaultRequest()
	req.Timeframes = []string{"1h"}
	done, err := s.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	waitScan(t, done)
	if _, ok := s.History("BTCUSDT", "1h"); !ok {
		t.Fatal("first scan did not retain evidence")
	}
	fail.Store(true)
	done, err = s.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	waitScan(t, done)
	if _, ok := s.History("BTCUSDT", "1h"); ok {
		t.Fatal("failed rescan retained stale evidence")
	}
	state := s.Snapshot()
	if state.Progress.Done != 1 || state.Progress.Total != 1 || len(state.Errors) != 1 || len(state.Rows) != 0 {
		t.Fatalf("rescan mixed previous progress or results: %+v", state)
	}
}

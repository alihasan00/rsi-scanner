package scanner

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
)

func TestIchimokuUsesOnlyRequestedClosedHourlyContextsAndOwnsState(t *testing.T) {
	frames := []string{"1d", "4h", "1h", "15m"}
	histories := map[string][]market.Candle{}
	start := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	for _, frame := range frames {
		width := 24 * time.Hour
		if frame != "1d" {
			width, _ = time.ParseDuration(frame)
		}
		for i := 0; i < 160; i++ {
			open, value := start+int64(i)*width.Milliseconds(), 100+float64(i)/3
			histories[frame] = append(histories[frame], market.Candle{OpenTime: open, CloseTime: open + width.Milliseconds() - 1,
				Open: value, High: value + 2, Low: value - 2, Close: value + 1, Volume: 10})
		}
	}
	calls := 0
	engine := New(feedFunc(func(_ context.Context, symbol, frame string, _ int) ([]market.Candle, *market.Candle, error) {
		calls++
		bars, ok := histories[frame]
		if symbol != "TESTUSDT" || !ok {
			t.Fatalf("hidden request for %s/%s", symbol, frame)
		}
		last := bars[len(bars)-1]
		preview := market.Candle{OpenTime: last.CloseTime + 1, CloseTime: last.CloseTime + last.CloseTime - last.OpenTime + 1,
			Open: last.Close, High: 1e8, Low: 1, Close: 1e8, Volume: 1e8}
		return bars, &preview, nil
	}), []string{"TESTUSDT"}, "fixture", 1, harmonic.DefaultConfig())
	req := DefaultRequest()
	req.Timeframes = frames
	done, err := engine.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	waitScan(t, done)
	if calls != len(frames) {
		t.Fatalf("extra data requests: %d", calls)
	}
	wants := map[string]ichimoku.Snapshot{}
	for _, series := range engine.Snapshot().Series {
		if series.Interval != "4h" && series.Interval != "1h" {
			if series.Analysis.Ichimoku != nil {
				t.Fatal("Ichimoku added outside its comparison frames")
			}
			continue
		}
		want := ichimoku.Analyze(histories[series.Interval], series.Analysis.Regime.Volatility.ATR)
		wants[series.Interval] = want
		got := series.Analysis.Ichimoku
		if got == nil || got.Status != "ready" || !reflect.DeepEqual(*got, want) || *got.AsOf != series.LastClosedAt {
			t.Fatalf("%s uses a preview or different history/ATR", series.Interval)
		}
		*got.AsOf = 1
		*got.Kijun.Value = -1
		*got.Cloud.Lower = -1
		*got.Cloud.CalculatedAt = 1
	}
	for _, series := range engine.Snapshot().Series {
		if want, ok := wants[series.Interval]; ok && !reflect.DeepEqual(*series.Analysis.Ichimoku, want) {
			t.Fatal("published Ichimoku aliases scanner-owned pointers")
		}
	}
}

func TestCloneSeriesAnalysisPreservesUnavailableShape(t *testing.T) {
	for _, source := range []SeriesAnalysis{{}, {
		Ichimoku: func() *ichimoku.Snapshot { s := ichimoku.Analyze(nil, nil); return &s }(),
	}} {
		if got := CloneSeriesAnalysis(source); !reflect.DeepEqual(got, source) {
			t.Fatal("downstream publication changed nil/empty evidence semantics")
		}
	}
}

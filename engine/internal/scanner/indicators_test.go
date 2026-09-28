package scanner

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/momentum"
	"github.com/alihasan00/crypto/internal/technical"
)

func TestScannerSupplementalEvidenceUsesClosedHistoryAndOwnsState(t *testing.T) {
	start := time.Date(2026, 9, 25, 0, 0, 0, 0, time.UTC).UnixMilli()
	bars := make([]market.Candle, 140)
	for i := range bars {
		open := start + int64(i)*3600000
		value := 100 + float64(i%9)
		bars[i] = market.Candle{OpenTime: open, CloseTime: open + 3600000 - 1, Open: value, High: value + 2, Low: value - 2, Close: value + 1, Volume: 10}
	}
	preview := market.Candle{OpenTime: bars[139].CloseTime + 1, CloseTime: bars[139].CloseTime + 3600000, Open: 100, High: 1e8, Low: 1, Close: 1e8, Volume: 1e8}
	s := New(feedFunc(func(context.Context, string, string, int) ([]market.Candle, *market.Candle, error) {
		return bars, &preview, nil
	}), []string{"BTCUSDT"}, "fixture", 1, harmonic.DefaultConfig())
	req := DefaultRequest()
	req.Timeframes = []string{"1h"}
	done, err := s.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	waitScan(t, done)
	one := s.Snapshot().Series[0]
	wantM, wantT := momentum.Analyze(bars), technical.Analyze(bars)
	if !reflect.DeepEqual(one.Analysis.Oscillator, wantM) || !reflect.DeepEqual(one.Analysis.Technical, wantT) {
		t.Fatal("supplemental indicators did not use exactly the completed history")
	}
	if one.Analysis.Calendar.Status != "insufficient" || len(one.Analysis.Calendar.Levels) != 0 {
		t.Fatal("single-timeframe scan invented daily calendar history")
	}
	*one.Analysis.Oscillator.RSI = -123
	*one.Analysis.Technical.Bollinger.WidthPercentile = -456
	one.Analysis.Calendar.Sources[0].Status = "caller-changed"
	two := s.Snapshot().Series[0]
	if !reflect.DeepEqual(two.Analysis.Oscillator, wantM) || !reflect.DeepEqual(two.Analysis.Technical, wantT) || two.Analysis.Calendar.Sources[0].Status == "caller-changed" {
		t.Fatal("published supplemental evidence aliases scanner state")
	}
}

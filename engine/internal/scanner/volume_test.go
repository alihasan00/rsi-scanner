package scanner

import (
	"context"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/participation"
)

func TestScannerVolumeUsesClosedHistoryAndOwnsPointers(t *testing.T) {
	bars := make([]market.Candle, 100)
	for i := range bars {
		open := int64(i) * 3600000
		bars[i] = market.Candle{OpenTime: open, CloseTime: open + 3600000 - 1, Open: 100, High: 102, Low: 98, Close: 100, Volume: 10}
	}
	bars[99].Volume = 20
	preview := market.Candle{OpenTime: bars[99].CloseTime + 1, CloseTime: bars[99].CloseTime + 3600000, Open: 100, High: 1000, Low: 98, Close: 999, Volume: 1e12}
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
	one := s.Snapshot()
	want := participation.Analyze(bars)
	if len(one.Series) != 1 || !reflect.DeepEqual(one.Series[0].Analysis.Volume, want) || *want.RelativeVolume != 2 {
		t.Fatalf("volume did not use exact completed history: %+v", one.Series)
	}
	v := &one.Series[0].Analysis.Volume
	*v.AsOf = 1
	*v.CurrentBaseVolume = 2
	*v.PriorMeanBaseVolume = 3
	*v.RelativeVolume = 4
	*v.RollingVWAP.Value = 5
	*v.RollingVWAP.AsOf = 6
	*v.QuoteTurnover24h.EstimatedValue = 7
	*v.QuoteTurnover24h.AsOf = 8
	if got := s.Snapshot().Series[0].Analysis.Volume; !reflect.DeepEqual(got, want) {
		t.Fatalf("caller mutated shared volume evidence: %+v", got)
	}
}

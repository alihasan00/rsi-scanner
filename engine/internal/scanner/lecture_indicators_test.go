package scanner

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/fairvaluegaps"
	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/swingfailure"
	"github.com/alihasan00/crypto/internal/volumeresponse"
)

func TestScannerLectureIndicatorsExcludePreviewAndOwnPublishedState(t *testing.T) {
	start := time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC).UnixMilli()
	bars := make([]market.Candle, 130)
	for i := range bars {
		open := start + int64(i)*3600000
		bars[i] = market.Candle{OpenTime: open, CloseTime: open + 3600000 - 1, Open: 100, High: 102, Low: 99, Close: 101, Volume: 100}
	}
	// The final prefix contains a confirmed SFP with a known opposite trigger,
	// a later touched but unretired FVG, and a completed volume/body response.
	for _, row := range [][5]float64{
		{100, 110, 90, 100, 100},
		{100, 120, 90, 110, 100},
		{110, 115, 80, 90, 100},
		{90, 100, 85, 95, 100},
		{95, 125, 90, 115, 100},
		{115, 116, 105, 110, 100},
		{110, 114, 104, 110.5, 200},
		{110.5, 113, 106, 112, 90},
	} {
		open := bars[len(bars)-1].CloseTime + 1
		bars = append(bars, market.Candle{OpenTime: open, CloseTime: open + 3600000 - 1,
			Open: row[0], High: row[1], Low: row[2], Close: row[3], Volume: row[4]})
	}
	last := bars[len(bars)-1]
	preview := market.Candle{OpenTime: last.CloseTime + 1, CloseTime: last.CloseTime + 3600000,
		Open: 112, High: 1e8, Low: 1, Close: 1e8, Volume: 1e8}
	calls := 0
	s := New(feedFunc(func(_ context.Context, symbol, interval string, _ int) ([]market.Candle, *market.Candle, error) {
		calls++
		if symbol != "BTCUSDT" || interval != "1h" {
			t.Errorf("hidden feed request for %s/%s", symbol, interval)
		}
		return bars, &preview, nil
	}), []string{"BTCUSDT"}, "fixture", 1, harmonic.DefaultConfig())
	req := DefaultRequest()
	req.Timeframes = []string{"1h"}
	done, err := s.Start(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	waitScan(t, done)
	if calls != 1 {
		t.Fatalf("supplemental evidence caused extra feed requests: %d", calls)
	}
	wantS, wantV, wantG := swingfailure.Analyze(bars), volumeresponse.Analyze(bars), fairvaluegaps.Analyze(bars)
	if len(wantS.Events) != 1 || wantS.Events[0].Trigger == nil || wantS.Events[0].State != "confirmed" ||
		wantV.LatestResponse == nil || len(wantG.Gaps) != 1 || wantG.Gaps[0].FirstTouchedAt == nil || wantG.Gaps[0].State != "touched" {
		t.Fatal("fixture lacks pointer-rich lecture evidence")
	}
	// Prove this preview would materially alter each analysis if accidentally
	// included; an equality check with a harmless preview would miss that bug.
	withPreview := append(append([]market.Candle{}, bars...), preview)
	if reflect.DeepEqual(swingfailure.Analyze(withPreview), wantS) ||
		reflect.DeepEqual(volumeresponse.Analyze(withPreview), wantV) ||
		reflect.DeepEqual(fairvaluegaps.Analyze(withPreview), wantG) {
		t.Fatal("preview canary did not alter all three analyzers")
	}
	one := s.Snapshot().Series[0]
	if !reflect.DeepEqual(one.Analysis.SwingFailure, wantS) || !reflect.DeepEqual(one.Analysis.VolumeResponse, wantV) ||
		!reflect.DeepEqual(one.Analysis.FairValueGaps, wantG) || *one.Analysis.SwingFailure.AsOf != last.CloseTime ||
		*one.Analysis.VolumeResponse.AsOf != last.CloseTime || *one.Analysis.FairValueGaps.AsOf != last.CloseTime {
		t.Fatal("lecture evidence includes preview facts or a different input prefix")
	}
	*one.Analysis.SwingFailure.AsOf = 1
	one.Analysis.SwingFailure.Events[0].Level.Price = 1
	one.Analysis.SwingFailure.Events[0].Trigger.Price = 1
	one.Analysis.SwingFailure.Events[0].Candle.Close = 1
	if one.Analysis.SwingFailure.LatestHigh != nil {
		one.Analysis.SwingFailure.LatestHigh.Price = 1
	}
	*one.Analysis.VolumeResponse.AsOf = 1
	*one.Analysis.VolumeResponse.RelativeBody = 1
	*one.Analysis.VolumeResponse.ClosePosition = 1
	one.Analysis.VolumeResponse.LatestResponse.ObservedAt = 1
	*one.Analysis.FairValueGaps.AsOf = 1
	one.Analysis.FairValueGaps.Gaps[0].Lower = 1
	*one.Analysis.FairValueGaps.Gaps[0].FirstTouchedAt = 1
	two := s.Snapshot().Series[0]
	if !reflect.DeepEqual(two.Analysis.SwingFailure, wantS) || !reflect.DeepEqual(two.Analysis.VolumeResponse, wantV) ||
		!reflect.DeepEqual(two.Analysis.FairValueGaps, wantG) {
		t.Fatal("published lecture evidence aliases mutable scanner state")
	}
}

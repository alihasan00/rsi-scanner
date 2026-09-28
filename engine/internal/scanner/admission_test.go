package scanner

import (
	"context"
	"testing"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
)

func TestScannerPreservesEntryScoreAdmissionAfterDConfirmation(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			// The projected Butterfly scores above 90 when its PRZ is touched.
			// D then extends to the edge of valid tolerance, lowering current
			// geometry below 90 while staying above/below the frozen stop.
			knots := []struct {
				index int
				price float64
			}{{0, 120}, {6, 100}, {16, 200}, {26, 121.4}, {36, 176.42}, {46, 54}, {47, 55}}
			candles := make([]market.Candle, 48)
			for k := 1; k < len(knots); k++ {
				a, b := knots[k-1], knots[k]
				for i := a.index; i <= b.index; i++ {
					price := 1000 + a.price + (b.price-a.price)*float64(i-a.index)/float64(b.index-a.index)
					if direction == "bearish" {
						price = 2400 - price
					}
					openAt := int64(1_700_000_000_000) + int64(i)*60_000
					candles[i] = market.Candle{OpenTime: openAt, CloseTime: openAt + 59_999, Open: price, High: price, Low: price, Close: price, Volume: 10}
				}
			}
			feed := feedFunc(func(context.Context, string, string, int) ([]market.Candle, *market.Candle, error) {
				return candles, nil, nil
			})
			cfg := harmonic.DefaultConfig()
			cfg.PivotMin, cfg.PivotMax = 3, 3
			cfg.Types = []string{"butterfly"}
			engine := New(feed, []string{"TESTUSDT"}, "test", 1, cfg)
			req := DefaultRequest()
			req.Timeframes, req.Direction, req.MinScore = []string{"1m"}, direction, 90
			done, err := engine.Start(context.Background(), req)
			if err != nil {
				t.Fatal(err)
			}
			waitScan(t, done)
			snapshot := engine.Snapshot()
			if len(snapshot.Errors) != 0 {
				t.Fatalf("scan failed: %+v", snapshot.Errors)
			}
			for _, row := range snapshot.Rows {
				p := row.Pattern
				if p.Kind != "butterfly" || p.X.Index != 6 || p.C.Index != 36 {
					continue
				}
				if p.Direction != direction || p.Stage != "confirmed" || p.Status != "active" || !p.EntryTouched ||
					p.EntryStage != "potential" || p.EntryScore == nil || *p.EntryScore < 90 || p.Score >= 90 {
					t.Fatalf("entry evidence was not retained separately from later geometry: %+v", p)
				}
				return
			}
			t.Fatalf("scanner discarded an entry admitted above 90 after D lowered its current score: %+v", snapshot.Rows)
		})
	}
}

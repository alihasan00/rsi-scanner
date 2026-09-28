package market_test

import (
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/fairvaluegaps"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/momentum"
	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/swingfailure"
	"github.com/alihasan00/crypto/internal/technical"
	"github.com/alihasan00/crypto/internal/volumeresponse"
)

func TestSupplementalAnalysisAcceptsCalendarMonths(t *testing.T) {
	start := time.Date(2010, 1, 1, 0, 0, 0, 0, time.UTC)
	candles := make([]market.Candle, 160)
	for i := range candles {
		a, b := start.AddDate(0, i, 0), start.AddDate(0, i+1, 0)
		candles[i] = market.Candle{OpenTime: a.UnixMilli(), CloseTime: b.UnixMilli() - 1, Open: 100, High: 102, Low: 98, Close: 101, Volume: 10}
	}
	analyzers := map[string]func([]market.Candle) string{
		"momentum":       func(b []market.Candle) string { return momentum.Analyze(b).Status },
		"technical":      func(b []market.Candle) string { return technical.Analyze(b).Status },
		"participation":  func(b []market.Candle) string { return participation.Analyze(b).Status },
		"swingfailure":   func(b []market.Candle) string { return swingfailure.Analyze(b).Status },
		"fairvaluegaps":  func(b []market.Candle) string { return fairvaluegaps.Analyze(b).Status },
		"volumeresponse": func(b []market.Candle) string { return volumeresponse.Analyze(b).Status },
	}
	for name, analyze := range analyzers {
		t.Run(name, func(t *testing.T) {
			if status := analyze(candles); status != "ready" {
				t.Fatalf("valid months: %s", status)
			}
			bad := append([]market.Candle(nil), candles...)
			bad[1].CloseTime--
			if status := analyze(bad); status != "invalid" {
				t.Fatalf("malformed February: %s", status)
			}
		})
	}
	if status := participation.Analyze(candles).QuoteTurnover24h.Status; status != "unsupported_interval" {
		t.Fatalf("monthly bars cannot establish 24-hour turnover: %s", status)
	}
}

package selection

import (
	"time"

	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

// Relative context uses matched close/close prices only. No synthetic ratio
// highs/lows, RSI subtraction or hidden benchmark fetch is performed.
func relativeContexts(symbol string, snapshot scanner.Snapshot, histories map[string]scanner.History, now time.Time, maxAge time.Duration) []strategies.RelativeStrength {
	out := []strategies.RelativeStrength{}
	frame := func(symbol, tf string) (scanner.SeriesSummary, bool) {
		var found scanner.SeriesSummary
		count := 0
		for _, s := range snapshot.Series {
			if s.Symbol == symbol && s.Interval == tf {
				found = s
				count++
			}
		}
		for _, e := range snapshot.Errors {
			if e.Symbol == symbol && e.Interval == tf {
				return found, false
			}
		}
		return found, !snapshot.Running && count == 1 && strategyFrameReady(found, histories[pair(symbol, tf)], now, maxAge)
	}
	for _, benchmark := range []string{"BTCUSDT", "ETHUSDT"} {
		for _, tf := range []string{"1h", "4h"} {
			r := strategies.RelativeStrength{Benchmark: benchmark, Interval: tf, Status: "data_unavailable"}
			coin, ok := frame(symbol, tf)
			if !ok {
				out = append(out, r)
				continue
			}
			at := coin.LastClosedAt
			r.AsOf = &at
			bars := histories[pair(symbol, tf)].Candles
			width, _ := time.ParseDuration(tf)
			day := int((24 * time.Hour) / width)
			week := 7 * day
			if len(bars) > day {
				r.AbsoluteReturn24h = number(100 * (bars[len(bars)-1].Close/bars[len(bars)-1-day].Close - 1))
			}
			if len(bars) > week {
				r.AbsoluteReturn7d = number(100 * (bars[len(bars)-1].Close/bars[len(bars)-1-week].Close - 1))
			}
			if symbol == benchmark {
				r.Status = "not_applicable"
				out = append(out, r)
				continue
			}
			bench, ok := frame(benchmark, tf)
			if !ok {
				r.Status = "benchmark_unavailable"
				out = append(out, r)
				continue
			}
			if coin.LastClosedAt != bench.LastClosedAt {
				r.Status = "endpoint_mismatch"
				out = append(out, r)
				continue
			}
			other := histories[pair(benchmark, tf)].Candles
			n := min(len(bars), len(other))
			ratios := make([]float64, 0, n)
			valid := true
			for j := 0; j < n; j++ {
				a, b := bars[len(bars)-n+j], other[len(other)-n+j]
				v := a.Close / b.Close
				if a.CloseTime != b.CloseTime || !positive(v) {
					valid = false
					break
				}
				ratios = append(ratios, v)
			}
			if !valid {
				r.Status = "alignment_unavailable"
				out = append(out, r)
				continue
			}
			if n > day {
				r.RatioReturn24h = number(100 * (ratios[n-1]/ratios[n-1-day] - 1))
			}
			if n > week {
				r.RatioReturn7d = number(100 * (ratios[n-1]/ratios[n-1-week] - 1))
			}
			rsi := ratioRSI(ratios)
			if n > 0 {
				r.RSI14 = rsi[n-1]
			}
			if n >= 4 && rsi[n-1] != nil && rsi[n-4] != nil {
				r.RSIChange3 = number(*rsi[n-1] - *rsi[n-4])
			}
			for j := 15; j < n; j++ {
				if rsi[j] == nil || rsi[j-1] == nil {
					continue
				}
				direction := ""
				if *rsi[j-1] <= 50 && *rsi[j] > 50 {
					direction = "bullish"
				}
				if *rsi[j-1] >= 50 && *rsi[j] < 50 {
					direction = "bearish"
				}
				if direction != "" {
					cross := bars[len(bars)-n+j].CloseTime
					r.Last50CrossAt = &cross
					r.Last50CrossDirection = direction
				}
			}
			r.Status = "ready"
			if r.RSI14 == nil {
				r.Status = "insufficient"
			} else if r.RatioReturn24h == nil || r.RatioReturn7d == nil || r.RSIChange3 == nil {
				r.Status = "partial"
			}
			out = append(out, r)
		}
	}
	return out
}

// Wilder RSI uses the first14 close changes as its seed; flat seeds are50.
func ratioRSI(values []float64) []*float64 {
	out := make([]*float64, len(values))
	gain, loss := 0.0, 0.0
	for i := 1; i < len(values); i++ {
		d := values[i] - values[i-1]
		g, l := max(d, 0), max(-d, 0)
		if i <= 14 {
			gain += g / 14
			loss += l / 14
		} else {
			gain = (13*gain + g) / 14
			loss = (13*loss + l) / 14
		}
		if i < 14 {
			continue
		}
		rsi := 50.0
		if gain+loss > 0 {
			rsi = 100 * (gain / (gain + loss))
		}
		out[i] = number(rsi)
	}
	return out
}

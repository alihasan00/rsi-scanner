package momentum

import (
	"fmt"
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

type rsiBar struct {
	market.Candle
	rsi float64
}

// Analyze reads only the supplied completed prefix. market.Candle has no
// finality, symbol or interval identifier: the caller owns those guarantees.
// This package rejects invalid prices/volume, changed duration and every gap,
// overlap or ordering error rather than smoothing across unknown evidence.
func Analyze(candles []market.Candle) Snapshot {
	s := Snapshot{Status: "insufficient", ClosedBars: len(candles), WarmupBars: RSILength + 1,
		RSIState: "unavailable", SMAStatus: "insufficient", ChangeStatus: "insufficient",
		DivergenceStatus: "insufficient", DivergenceRules: DefaultRules(),
		Divergences: []Divergence{}, Warnings: []string{}}
	if len(candles) == 0 {
		return s
	}
	if warning := validateHistory(candles); warning != "" {
		s.Status, s.SMAStatus, s.ChangeStatus, s.DivergenceStatus = "invalid", "invalid", "invalid", "invalid"
		s.Warnings = append(s.Warnings, warning)
		return s
	}
	s.AsOf = pointer(candles[len(candles)-1].CloseTime)
	if len(candles) < s.WarmupBars {
		return s
	}
	bars := buildRSIBars(candles)
	last := bars[len(bars)-1].rsi
	s.Status, s.RSI = "ready", pointer(last)
	s.RSIState = "at50"
	if last < 50 {
		s.RSIState = "below50"
	} else if last > 50 {
		s.RSIState = "above50"
	}
	if len(bars) >= SMALength {
		mean := 0.0
		for _, bar := range bars[len(bars)-SMALength:] {
			mean += bar.rsi / SMALength
		}
		s.SMAStatus, s.RSISMA14 = "ready", pointer(mean)
	}
	if len(bars) > ChangeBars {
		s.ChangeStatus, s.RSIChange3 = "ready", pointer(last-bars[len(bars)-1-ChangeBars].rsi)
	}
	for i := 1; i < len(bars); i++ {
		previous, current := bars[i-1].rsi, bars[i].rsi
		direction := ""
		if previous <= 50 && current > 50 {
			direction = "bullish"
		} else if previous >= 50 && current < 50 {
			direction = "bearish"
		}
		if direction != "" {
			s.Last50Cross = &Cross{Direction: direction, At: bars[i].CloseTime, From: previous, To: current}
		}
	}
	rules := s.DivergenceRules
	if len(bars) >= rules.LeftBars+rules.RightBars+1 {
		s.DivergenceStatus = "ready"
	}
	s.Divergences, s.DivergenceTotal, s.DivergenceOmitted = findDivergences(bars, rules)
	return s
}

func validateHistory(candles []market.Candle) string {
	for i, candle := range candles {
		if !candle.Valid() {
			return fmt.Sprintf("invalid candle at index %d; momentum evidence unavailable", i)
		}
		if !market.SameInterval(candles[0], candle) {
			return fmt.Sprintf("changed candle duration at index %d; momentum evidence unavailable", i)
		}
		if i > 0 && candle.OpenTime != candles[i-1].CloseTime+1 {
			return fmt.Sprintf("candle gap, overlap or ordering error at index %d; momentum evidence unavailable", i)
		}
	}
	return ""
}

func buildRSIBars(candles []market.Candle) []rsiBar {
	bars := make([]rsiBar, 0, len(candles)-RSILength)
	gain, loss := 0.0, 0.0
	for i := 1; i < len(candles); i++ {
		change := candles[i].Close - candles[i-1].Close
		up, down := math.Max(0, change), math.Max(0, -change)
		if i <= RSILength {
			gain += up / RSILength
			loss += down / RSILength
		} else {
			// Equivalent Wilder recurrence, with divided terms preventing overflow
			// for valid but very large positive prices.
			gain = gain*(float64(RSILength-1)/RSILength) + up/RSILength
			loss = loss*(float64(RSILength-1)/RSILength) + down/RSILength
		}
		if i >= RSILength {
			bars = append(bars, rsiBar{Candle: candles[i], rsi: rsiValue(gain, loss)})
		}
	}
	return bars
}

func rsiValue(gain, loss float64) float64 {
	if loss == 0 {
		if gain == 0 {
			return 50
		}
		return 100
	}
	if gain <= loss {
		ratio := gain / loss
		return 100 * ratio / (1 + ratio)
	}
	return 100 / (1 + loss/gain)
}

func pointer[T any](v T) *T { return &v }

func clonePointer[T any](v *T) *T {
	if v == nil {
		return nil
	}
	return pointer(*v)
}

// CloneSnapshot gives the caller ownership of every mutable published value.
func CloneSnapshot(s Snapshot) Snapshot {
	s.AsOf = clonePointer(s.AsOf)
	s.RSI = clonePointer(s.RSI)
	s.RSISMA14 = clonePointer(s.RSISMA14)
	s.RSIChange3 = clonePointer(s.RSIChange3)
	s.Last50Cross = clonePointer(s.Last50Cross)
	s.Warnings = append([]string{}, s.Warnings...)
	s.Divergences = append([]Divergence{}, s.Divergences...)
	for i := range s.Divergences {
		d := &s.Divergences[i]
		d.ConfirmedAt = clonePointer(d.ConfirmedAt)
		d.ResolvedAt = clonePointer(d.ResolvedAt)
		d.Confirmation = clonePointer(d.Confirmation)
		d.BarsSinceResolution = clonePointer(d.BarsSinceResolution)
	}
	return s
}

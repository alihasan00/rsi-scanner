package strategies

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

func strategyPointer[T any](v T) *T { return &v }

func strategyFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func strategyDuration(interval string) int64 {
	switch interval {
	case "15m":
		return 900000
	case "1h":
		return 3600000
	case "4h":
		return 14400000
	case "1d":
		return 86400000
	}
	return 0
}

// strategyCandles validates the complete supplied history. In particular it
// does not discard a bad tail and silently represent an earlier prefix as now.
// Frame observation time is the finality boundary; wall-clock freshness is the
// shared selection adapter's responsibility.
func strategyCandles(in Input, interval string) ([]market.Candle, bool) {
	duration := strategyDuration(interval)
	f, exists := in.Frames[interval]
	bars := in.Histories[interval].Candles
	if duration == 0 || !exists || len(bars) == 0 || f.Stale || f.Symbol != in.Symbol || f.Interval != interval ||
		f.ObservedAt.IsZero() || f.LastClosedAt != bars[len(bars)-1].CloseTime || f.ObservedAt.UnixMilli() < f.LastClosedAt {
		return nil, false
	}
	for i, bar := range bars {
		if !bar.Valid() || bar.OpenTime%duration != 0 || bar.CloseTime-bar.OpenTime+1 != duration ||
			i > 0 && bar.OpenTime != bars[i-1].CloseTime+1 {
			return nil, false
		}
	}
	return bars, true
}

func strategyPrefix(bars []market.Candle, at int64) []market.Candle {
	end := len(bars)
	for end > 0 && bars[end-1].CloseTime > at {
		end--
	}
	return bars[:end]
}

// A simple trailing 14 true-range mean is an explicit strategy convention,
// not the separately published Wilder ATR or a probability measurement.
func strategyATR(bars []market.Candle, index int) (float64, bool) {
	if index < 13 || index >= len(bars) {
		return 0, false
	}
	value := 0.0
	for i := index - 13; i <= index; i++ {
		tr := bars[i].High - bars[i].Low
		if i > 0 {
			tr = math.Max(tr, math.Max(math.Abs(bars[i].High-bars[i-1].Close), math.Abs(bars[i].Low-bars[i-1].Close)))
		}
		value += tr / 14
	}
	return value, strategyFinite(value) && value > 0
}

// strategyTarget returns the nearest opposing strict three-candle pivot among
// the trailing160 source candles at at (with its preceding neighbor) that was
// known and remains untouched. Every input is truncated at signal time,
// including higher frames: a later pivot cannot improve a plan. The bounded
// target search survives a rolling500-bar cache throughout signal retention.
func strategyTarget(in Input, direction string, at int64, entry float64) *float64 {
	var target *float64
	bullish := direction == "bullish"
	recent, _ := strategyCandles(in, "15m")
	recent = strategyPrefix(recent, at)
	for _, interval := range []string{"15m", "1h", "4h", "1d"} {
		bars, ok := strategyCandles(in, interval)
		if !ok {
			continue
		}
		bars = strategyPrefix(bars, at)
		for i := max(1, len(bars)-ReversalSourceBars); i+1 < len(bars); i++ {
			price := bars[i].High
			pivot := price > bars[i-1].High && price > bars[i+1].High
			if !bullish {
				price = bars[i].Low
				pivot = price < bars[i-1].Low && price < bars[i+1].Low
			}
			if !pivot || bullish && price <= entry || !bullish && price >= entry {
				continue
			}
			touched := false
			for _, bar := range bars[i+2:] {
				if bullish && bar.High >= price || !bullish && bar.Low <= price {
					touched = true
					break
				}
			}
			// A higher-frame target may already have been consumed by a fully
			// completed 15m candle inside its still-open next source candle.
			for _, bar := range recent {
				if bar.OpenTime > bars[i+1].CloseTime && (bullish && bar.High >= price || !bullish && bar.Low <= price) {
					touched = true
					break
				}
			}
			if !touched && (target == nil || bullish && price < *target || !bullish && price > *target) {
				target = strategyPointer(price)
			}
		}
	}
	return target
}

func strategyResolve(op *Opportunity, state, reason string, at int64) {
	op.State, op.Reason, op.ResolvedAt = state, reason, strategyPointer(at)
	op.Next = "This observation ended; a new event must create a new opportunity."
}

// strategyFreeze creates a reference plan only at an observed price trigger.
// Stops, target, ATR and entry bounds are immutable even if a newer pivot later
// offers a more attractive target. These are references, never assumed fills.
func strategyFreeze(in Input, op *Opportunity, bars []market.Candle, index int, adverse float64) {
	bar := bars[index]
	op.TriggerAt = strategyPointer(bar.CloseTime)
	op.ExpiresAt = strategyPointer(bar.CloseTime + 4*strategyDuration(op.Interval))
	atr, ok := strategyATR(bars, index)
	if !ok {
		strategyResolve(op, "rejected", "The completed trigger lacks a finite 14-bar risk scale.", bar.CloseTime)
		return
	}
	stop := adverse - .1*atr
	if op.Direction == "bearish" {
		stop = adverse + .1*atr
	}
	op.EntryReference, op.ReferenceATR, op.Stop = strategyPointer(bar.Close), strategyPointer(atr), strategyPointer(stop)
	op.Target = strategyTarget(in, op.Direction, bar.CloseTime, bar.Close)
	if op.Target == nil {
		strategyResolve(op, "rejected", "No unconsumed opposing structural target was known at the trigger.", bar.CloseTime)
		return
	}
	valid := strategyFinite(stop) && stop > 0 && (op.Direction == "bullish" && stop < bar.Close && *op.Target > bar.Close ||
		op.Direction == "bearish" && stop > bar.Close && *op.Target < bar.Close)
	if !valid {
		strategyResolve(op, "rejected", "The frozen structural stop and target do not bracket the trigger close.", bar.CloseTime)
		return
	}
	low, high := math.Min(stop, *op.Target), math.Max(stop, *op.Target)
	minimum := math.Max(bar.Close-.5*atr, math.Nextafter(low, high))
	maximum := math.Min(bar.Close+.5*atr, math.Nextafter(high, low))
	if !strategyFinite(minimum) || !strategyFinite(maximum) || minimum >= maximum {
		strategyResolve(op, "rejected", "The frozen reference entry window is empty.", bar.CloseTime)
		return
	}
	op.EntryMin, op.EntryMax = strategyPointer(minimum), strategyPointer(maximum)
	op.State, op.Reason = "entry_confirmed", "A completed price trigger confirmed this experimental opportunity."
	op.Next = "Review the current price inside the frozen entry window, costs and account limits; no fill is assumed."
}

// Loss of the protective reference wins any same-bar ambiguity. A target touch
// is a reference outcome, not profit; prices do not establish a modeled fill.
func strategyAdvancePlan(op *Opportunity, bar market.Candle) {
	if op.TriggerAt == nil || bar.CloseTime <= *op.TriggerAt || op.ResolvedAt != nil || op.Stop == nil || op.Target == nil {
		return
	}
	bullish := op.Direction == "bullish"
	if bullish && bar.Low <= *op.Stop || !bullish && bar.High >= *op.Stop {
		strategyResolve(op, "invalidated", "The frozen protective stop reference was touched after the trigger.", bar.CloseTime)
	} else if bullish && bar.High >= *op.Target || !bullish && bar.Low <= *op.Target {
		strategyResolve(op, "target_reached", "The frozen target reference was touched; this does not establish a fill or profit.", bar.CloseTime)
	} else if op.ExpiresAt != nil && bar.CloseTime >= *op.ExpiresAt {
		strategyResolve(op, "expired", "The four-bar entry window elapsed.", bar.CloseTime)
	}
}

package strategies

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

// PaperFixedPlan reproduces the crypto project's source-frame reference plan.
// It is a completed-candle screening reference, never evidence of an order fill.
type PaperFixedPlan struct {
	Entry       float64
	Stop        float64
	Target      float64
	ATR         float64
	EntryMin    float64
	EntryMax    float64
	ConfirmedAt int64
	ExpiresAt   int64
}

// paperSimpleATR follows trade_plan::atr: fourteen equally weighted true
// ranges, each divided before addition. The separate Donchian research ATR
// deliberately uses a different arithmetic order.
func paperSimpleATR(bars []market.Candle, at int) (float64, bool) {
	if at < 14 || at >= len(bars) {
		return 0, false
	}
	average := 0.0
	for i := at - 13; i <= at; i++ {
		bar := bars[i]
		tr := math.Max(bar.High-bar.Low, math.Max(math.Abs(bar.High-bars[i-1].Close), math.Abs(bar.Low-bars[i-1].Close)))
		average += tr / 14.0
	}
	return average, strategyFinite(average) && average > 0
}

func paperFixedRatios(direction string, price, stop, target float64) (gross, net float64, ok bool) {
	sign := 1.0
	if direction == "bearish" {
		sign = -1
	} else if direction != "bullish" {
		return 0, 0, false
	}
	if !strategyFinite(price) || !strategyFinite(stop) || !strategyFinite(target) || price <= 0 || stop <= 0 || target <= 0 {
		return 0, 0, false
	}
	risk, reward := sign*(price-stop), sign*(target-price)
	cost := 0.003 * price
	gross, net = reward/risk, (reward-cost)/(risk+cost)
	return gross, net, risk > 0 && reward > 0 && strategyFinite(cost) && risk+cost > 0 && strategyFinite(gross) && strategyFinite(net)
}

func paperFreezeFixed(bars []market.Candle, at int, direction string, stop, target float64) (PaperFixedPlan, bool) {
	var empty PaperFixedPlan
	if at < 0 || at >= len(bars) {
		return empty, false
	}
	bar := bars[at]
	atr, ok := paperSimpleATR(bars, at)
	if !ok {
		return empty, false
	}
	if _, _, ok = paperFixedRatios(direction, bar.Close, stop, target); !ok {
		return empty, false
	}
	duration := bar.CloseTime - bar.OpenTime + 1
	if duration <= 0 || duration > (math.MaxInt64-bar.CloseTime)/4 {
		return empty, false
	}
	minimum, maximum := math.Min(stop, target), math.Max(stop, target)
	entryMin := math.Max(bar.Close-0.25*atr, math.Nextafter(minimum, math.Inf(1)))
	entryMax := math.Min(bar.Close+0.25*atr, math.Nextafter(maximum, math.Inf(-1)))
	if !strategyFinite(entryMin) || !strategyFinite(entryMax) || entryMin <= 0 || entryMax <= 0 || entryMin > entryMax || bar.Close < entryMin || bar.Close > entryMax {
		return empty, false
	}
	return PaperFixedPlan{Entry: bar.Close, Stop: stop, Target: target, ATR: atr, EntryMin: entryMin, EntryMax: entryMax,
		ConfirmedAt: bar.CloseTime, ExpiresAt: bar.CloseTime + 4*duration}, true
}

// paperAssessFixed uses the latest completed source close. Later stop or target
// touches permanently retire the frozen plan; the stop wins an ambiguous bar.
func paperAssessFixed(plan PaperFixedPlan, bars []market.Candle, at int, direction string, asOf int64) bool {
	if at < 0 || at >= len(bars) || len(bars) == 0 || bars[at].CloseTime != plan.ConfirmedAt || bars[at].Close != plan.Entry {
		return false
	}
	latest := bars[len(bars)-1]
	if latest.CloseTime >= asOf || asOf >= plan.ExpiresAt || latest.Close < plan.EntryMin || latest.Close > plan.EntryMax {
		return false
	}
	for _, bar := range bars[at+1:] {
		if direction == "bullish" && (bar.Low <= plan.Stop || bar.High >= plan.Target) ||
			direction == "bearish" && (bar.High >= plan.Stop || bar.Low <= plan.Target) {
			return false
		}
	}
	_, net, ok := paperFixedRatios(direction, latest.Close, plan.Stop, plan.Target)
	return ok && net >= 1
}

// paperStructuralTarget chooses the nearest untouched strict two-left/two-right
// opposing pivot already known at discovery. A later pivot cannot improve it.
func paperStructuralTarget(bars []market.Candle, known, trigger int, direction string, entry float64) (float64, bool) {
	if known < 4 || known > trigger || trigger >= len(bars) || !strategyFinite(entry) || entry <= 0 || (direction != "bullish" && direction != "bearish") {
		return 0, false
	}
	start := max(2, known-160)
	var target float64
	found := false
	for i := start; i <= known-2; i++ {
		level := bars[i].High
		if direction == "bearish" {
			level = bars[i].Low
		}
		pivot := true
		for j := i - 2; j <= i+2; j++ {
			if j == i {
				continue
			}
			if direction == "bullish" && bars[j].High >= level || direction == "bearish" && bars[j].Low <= level {
				pivot = false
				break
			}
		}
		if !pivot || !strategyFinite(level) || level <= 0 || direction == "bullish" && level <= entry || direction == "bearish" && level >= entry {
			continue
		}
		consumed := false
		for j := i + 3; j <= trigger; j++ {
			if direction == "bullish" && bars[j].High >= level || direction == "bearish" && bars[j].Low <= level {
				consumed = true
				break
			}
		}
		if !consumed && (!found || math.Abs(level-entry) < math.Abs(target-entry)) {
			target, found = level, true
		}
	}
	return target, found
}

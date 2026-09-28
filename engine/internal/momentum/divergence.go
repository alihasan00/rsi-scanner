package momentum

import (
	"fmt"
	"math"
	"sort"
)

type trackedDivergence struct {
	value         Divergence
	detectedIndex int
	stateIndex    int
	resolvedIndex int
}

// findDivergences replays observable closes. Previously detected endpoints and
// confirmation evidence are never moved to a better future pivot. Only the
// immediate next close can confirm a provisional second pivot.
func findDivergences(bars []rsiBar, rules Rules) ([]Divergence, int, int) {
	records := []trackedDivergence{}
	active := []int{}
	previousLow, previousHigh := -1, -1
	resolve := func(record *trackedDivergence, state, reason string, index int) {
		record.value.State, record.value.ResolutionReason = state, reason
		record.value.ResolvedAt = pointer(bars[index].CloseTime)
		record.value.AvailableAt = bars[index].CloseTime
		record.stateIndex, record.resolvedIndex = index, index
	}
	for index, current := range bars {
		remaining := active[:0]
		for _, recordIndex := range active {
			record := &records[recordIndex]
			setup := &record.value
			bullish := setup.Direction == "bullish"
			if setup.State == "confirmed" {
				setup.BarsElapsed++
			}
			if bullish && current.rsi < setup.InvalidationRSI || !bullish && current.rsi > setup.InvalidationRSI {
				resolve(record, "harmonised", "rsi-anchor", index)
				continue
			}
			if setup.State == "forming" {
				confirms := bullish && current.Close > current.Open || !bullish && current.Close < current.Open
				if !confirms {
					resolve(record, "unconfirmed", "confirmation-missed", index)
					continue
				}
				strength := "ordinary"
				if bullish && current.Close > bars[index-1].Open || !bullish && current.Close < bars[index-1].Open {
					strength = "strong"
				}
				setup.State, setup.ConfirmedAt, setup.AvailableAt = "confirmed", pointer(current.CloseTime), current.CloseTime
				setup.Confirmation = &Confirmation{OpenTime: current.OpenTime, CloseTime: current.CloseTime,
					Open: current.Open, Close: current.Close, RSI: current.rsi, Strength: strength}
				record.stateIndex = index
			}
			if bullish && current.rsi >= 50 || !bullish && current.rsi <= 50 {
				resolve(record, "completed", "rsi-50", index)
				continue
			}
			if setup.BarsElapsed >= rules.ExpiryBars {
				resolve(record, "expired", "window-elapsed", index)
				continue
			}
			remaining = append(remaining, recordIndex)
		}
		active = remaining

		// The current closed bar is the last right-hand observation for a first
		// pivot. Forming a setup cannot use that pivot before this exact point.
		pivot := index - rules.RightBars
		if pivot >= rules.LeftBars {
			if strictPivot(bars, pivot, rules.LeftBars, rules.RightBars, true) {
				previousLow = pivot
			}
			if strictPivot(bars, pivot, rules.LeftBars, rules.RightBars, false) {
				previousHigh = pivot
			}
		}
		if index+1 < rules.ProvisionalBars {
			continue
		}
		for _, bullish := range []bool{true, false} {
			if !strictPivot(bars, index, rules.ProvisionalBars-1, 0, bullish) {
				continue
			}
			first := previousHigh
			if bullish {
				first = previousLow
			}
			setup, ok := makeDivergence(bars, first, index, bullish, rules)
			if !ok {
				continue
			}
			records = append(records, trackedDivergence{value: setup, detectedIndex: index, stateIndex: index, resolvedIndex: -1})
			active = append(active, len(records)-1)
		}
	}
	return selectDivergences(records, len(bars)-1, rules)
}

func strictPivot(bars []rsiBar, index, left, right int, low bool) bool {
	if index-left < 0 || index+right >= len(bars) {
		return false
	}
	for other := index - left; other <= index+right; other++ {
		if other == index {
			continue
		}
		if low && bars[other].rsi <= bars[index].rsi || !low && bars[other].rsi >= bars[index].rsi {
			return false
		}
	}
	return true
}

func makeDivergence(bars []rsiBar, firstIndex, index int, bullish bool, rules Rules) (Divergence, bool) {
	distance := index - firstIndex
	if firstIndex < 0 || distance < rules.MinBars || distance > rules.MaxBars {
		return Divergence{}, false
	}
	first, second := bars[firstIndex], bars[index]
	firstPrice, secondPrice := first.High, second.High
	firstBody, secondBody := math.Max(first.Open, first.Close), math.Max(second.Open, second.Close)
	direction := "bearish"
	if bullish {
		firstPrice, secondPrice = first.Low, second.Low
		firstBody, secondBody = math.Min(first.Open, first.Close), math.Min(second.Open, second.Close)
		direction = "bullish"
	}
	priceChange, rsiChange := secondPrice-firstPrice, second.rsi-first.rsi
	kind := ""
	if bullish && priceChange < 0 && rsiChange > 0 || !bullish && priceChange > 0 && rsiChange < 0 {
		kind = "regular-" + direction
	} else if rules.IncludeHidden && (bullish && priceChange > 0 && rsiChange < 0 || !bullish && priceChange < 0 && rsiChange > 0) {
		kind = "hidden-" + direction
	}
	if kind == "" || bullish && second.rsi >= 50 || !bullish && second.rsi <= 50 {
		return Divergence{}, false
	}
	bodyChange := secondBody - firstBody
	if rules.RequireBodyAgreement && (bodyChange == 0 || (bodyChange > 0) != (priceChange > 0)) {
		return Divergence{}, false
	}
	if rules.RequireSameRSICycle {
		for _, bar := range bars[firstIndex : index+1] {
			if bullish && bar.rsi >= 50 || !bullish && bar.rsi <= 50 {
				return Divergence{}, false
			}
		}
	}
	return Divergence{ID: fmt.Sprintf("%s:%d:%d", kind, first.OpenTime, second.OpenTime),
		Kind: kind, Direction: direction, State: "forming",
		Start: Pivot{OpenTime: first.OpenTime, CloseTime: first.CloseTime, AvailableAt: bars[firstIndex+rules.RightBars].CloseTime,
			Mature: true, Price: firstPrice, BodyPrice: firstBody, RSI: first.rsi},
		End: Pivot{OpenTime: second.OpenTime, CloseTime: second.CloseTime, AvailableAt: second.CloseTime,
			Mature: false, Price: secondPrice, BodyPrice: secondBody, RSI: second.rsi},
		DetectedAt: second.CloseTime, AvailableAt: second.CloseTime, ExpiryBars: rules.ExpiryBars, InvalidationRSI: second.rsi}, true
}

func selectDivergences(records []trackedDivergence, lastIndex int, rules Rules) ([]Divergence, int, int) {
	out := []Divergence{}
	for _, record := range records {
		if record.resolvedIndex >= 0 && lastIndex-record.resolvedIndex >= rules.RecentResolvedBars {
			continue
		}
		setup := record.value
		setup.AgeBars = lastIndex - record.stateIndex
		setup.BarsSinceDetection = lastIndex - record.detectedIndex
		if record.resolvedIndex >= 0 {
			setup.BarsSinceResolution = pointer(lastIndex - record.resolvedIndex)
		}
		out = append(out, setup)
	}
	// Active evidence precedes recently resolved evidence, then newest current
	// state, then identity. Truncation never presents a partial set as complete.
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.ResolvedAt == nil) != (b.ResolvedAt == nil) {
			return a.ResolvedAt == nil
		}
		if a.AvailableAt != b.AvailableAt {
			return a.AvailableAt > b.AvailableAt
		}
		return a.ID < b.ID
	})
	total := len(out)
	if total > rules.MaxDivergences {
		out = out[:rules.MaxDivergences]
	}
	return out, total, total - len(out)
}

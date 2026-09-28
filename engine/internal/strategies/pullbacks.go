package strategies

import (
	"fmt"
	"math"

	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
)

// PullbackOpportunities contains independent location experiments, not
// alternative labels requiring an underlying harmonic candidate.
func PullbackOpportunities(in Input) []Opportunity {
	out := []Opportunity{}
	for _, interval := range []string{"1h", "4h"} {
		b, ok := pbCandles(in, interval)
		if !ok {
			continue
		}
		for _, op := range pbFVG(in, interval, b) {
			if pbRetained(op, b) {
				out = append(out, op)
			}
		}
		for _, op := range pbFibonacci(in, interval, b) {
			if pbRetained(op, b) {
				out = append(out, op)
			}
		}
		for _, family := range []string{KijunReclaim, CloudReclaim} {
			for _, op := range pbIchimoku(in, interval, b, family) {
				if pbRetained(op, b) {
					out = append(out, op)
				}
			}
		}
	}
	return out
}

func pbFVG(in Input, interval string, b []market.Candle) []Opportunity {
	out := []Opportunity{}
	for i := 21; i < len(b); i++ {
		first, middle, third := b[i-2], b[i-1], b[i]
		var direction string
		var low, high float64
		if third.Low > first.High {
			direction, low, high = "bullish", first.High, third.Low
		} else if third.High < first.Low {
			direction, low, high = "bearish", third.High, first.Low
		} else {
			continue
		}
		priorLow, priorHigh := pbBounds(b[i-21 : i-1])
		if direction == "bullish" && (middle.Close <= priorHigh || middle.Close <= middle.Open) || direction == "bearish" && (middle.Close >= priorLow || middle.Close >= middle.Open) {
			continue
		}
		op := pbBase(in, interval, FVGPullback, direction, b, i, low+(high-low)/2, low, high)
		op.SourceStartAt, op.SourceEndAt = first.OpenTime, third.CloseTime
		op.ID = fmt.Sprintf("%s:%d", op.ID, first.OpenTime)
		op.State, op.Reason, op.Next = "waiting_for_retest", "A three-candle wick gap followed a directional close beyond the prior 20-bar boundary.", "Observe the first later gap revisit; midpoint overlap or passage retires an untriggered gap."
		op.Invalidation = "Midpoint overlap/passage before confirmation, a failed first revisit, or the frozen protective stop after confirmation."
		for j := i + 1; j < len(b) && j <= i+pbObserveBars; j++ {
			if pbAdverse(direction, b[j], op.Level) {
				pbResolve(&op, "invalidated", "The gap midpoint was overlapped or passed before an entry trigger; the gap cannot be resurrected.", b[j].CloseTime)
				break
			}
			if !pbOverlap(b[j], low, high) {
				continue
			}
			op.RetestAt = pbPtr(b[j].CloseTime)
			favorable := high
			confirmation := b[j].High
			if direction == "bearish" {
				favorable, confirmation = low, b[j].Low
			}
			if !pbBreak(direction, b[j].Close, favorable) || !pbBreak(direction, b[j].Close, b[j].Open) {
				pbResolve(&op, "rejected", "The first gap revisit did not close directionally beyond its near edge.", b[j].CloseTime)
				break
			}
			op.State, op.Reason, op.Next = "awaiting_confirmation", "The first shallow gap revisit reacted before midpoint retirement.", "Wait for a later close beyond the first reaction candle's opposite extreme."
			for k := j + 1; k < len(b) && k <= i+pbObserveBars; k++ {
				if pbAdverse(direction, b[k], op.Level) {
					pbResolve(&op, "invalidated", "The gap reached midpoint retirement before reaction confirmation.", b[k].CloseTime)
					break
				}
				if !pbBreak(direction, b[k].Close, confirmation) {
					continue
				}
				atr, ok := pbATR(b, k)
				stop := low
				if direction == "bearish" {
					stop = high
					if ok {
						stop += .1 * atr
					}
				} else if ok {
					stop -= .1 * atr
				}
				pbTrigger(&op, b, k, stop, pbTarget(b, i, k, direction, b[k].Close))
				break
			}
			break // The first revisit is the only discovery attempt for this gap.
		}
		pbFinishObservation(&op, b)
		out = append(out, op)
	}
	return out
}

func pbFibonacci(in Input, interval string, b []market.Candle) []Opportunity {
	out := []Opportunity{}
	for end := 22; end+2 < len(b); end++ {
		for _, direction := range []string{"bullish", "bearish"} {
			bull := direction == "bullish"
			known := end + 2
			if !pbPivot(b[:known+1], end, bull) {
				continue
			}
			origin := -1
			for j := end - 3; j >= max(2, end-80); j-- {
				if pbPivot(b[:end+1], j, !bull) {
					origin = j
					break
				}
			}
			if origin < 20 {
				continue
			}
			startPrice, endPrice := b[origin].Low, b[end].High
			if !bull {
				startPrice, endPrice = b[origin].High, b[end].Low
			}
			amplitude := math.Abs(endPrice - startPrice)
			atr, ok := pbATR(b, known)
			if !ok || amplitude < 2*atr || !pbBreak(direction, endPrice, startPrice) {
				continue
			}
			priorLow, priorHigh := pbBounds(b[origin-20 : origin])
			if bull && endPrice <= priorHigh || !bull && endPrice >= priorLow {
				continue
			}
			low, high := endPrice-.666*amplitude, endPrice-.618*amplitude
			if !bull {
				low, high = endPrice+.618*amplitude, endPrice+.666*amplitude
			}
			op := pbBase(in, interval, FibonacciPullback, direction, b, known, low+(high-low)/2, low, high)
			op.SourceStartAt, op.SourceEndAt = b[origin].OpenTime, b[end].CloseTime
			op.ID = fmt.Sprintf("%s:%d:%d", op.ID, b[origin].OpenTime, b[end].OpenTime)
			op.State, op.Reason, op.Next = "waiting_for_retest", "A 2-left/2-right confirmed impulse broke its origin's prior 20-bar extreme; its .618–.666 pullback zone is frozen.", "Wait for the first later golden-pocket reaction and a subsequent close confirming that reaction."
			op.Invalidation = "Loss of the frozen impulse origin or a failed first golden-pocket reaction; a new impulse receives a new identity."
			// Do not label a reaction that happened before the impulse was
			// knowable as a later first revisit.
			premature := false
			for j := end + 1; j <= known; j++ {
				if pbOverlap(b[j], low, high) || pbAdverse(direction, b[j], startPrice) {
					premature = true
				}
			}
			if premature {
				pbResolve(&op, "rejected", "The pullback zone was already visited before its impulse endpoint became confirmed.", b[known].CloseTime)
				out = append(out, op)
				continue
			}
			for j := known + 1; j < len(b) && j <= known+pbObserveBars; j++ {
				if pbAdverse(direction, b[j], startPrice) {
					pbResolve(&op, "invalidated", "Price reached the frozen impulse origin before confirmation.", b[j].CloseTime)
					break
				}
				if pbFavorable(direction, b[j], endPrice) {
					pbResolve(&op, "extended_before_entry", "The frozen impulse endpoint was reached before a fresh pullback entry.", b[j].CloseTime)
					break
				}
				if !pbOverlap(b[j], low, high) {
					continue
				}
				op.RetestAt = pbPtr(b[j].CloseTime)
				favorable, confirmation := high, b[j].High
				if !bull {
					favorable, confirmation = low, b[j].Low
				}
				if !pbBreak(direction, b[j].Close, favorable) || !pbBreak(direction, b[j].Close, b[j].Open) {
					pbResolve(&op, "rejected", "The first golden-pocket revisit did not react beyond its favorable edge.", b[j].CloseTime)
					break
				}
				op.State, op.Reason, op.Next = "awaiting_confirmation", "The frozen golden pocket produced its first completed directional reaction.", "Wait for a later close beyond the reaction candle's opposite extreme."
				for k := j + 1; k < len(b) && k <= known+pbObserveBars; k++ {
					if pbAdverse(direction, b[k], startPrice) {
						pbResolve(&op, "invalidated", "Price reached the frozen impulse origin before reaction confirmation.", b[k].CloseTime)
						break
					}
					if pbFavorable(direction, b[k], endPrice) {
						pbResolve(&op, "extended_before_entry", "The frozen endpoint was reached before confirmation.", b[k].CloseTime)
						break
					}
					if !pbBreak(direction, b[k].Close, confirmation) {
						continue
					}
					triggerATR, atrOK := pbATR(b, k)
					stop := startPrice
					if atrOK {
						if bull {
							stop -= .1 * triggerATR
						} else {
							stop += .1 * triggerATR
						}
					}
					pbTrigger(&op, b, k, stop, pbPtr(endPrice))
					break
				}
				break
			}
			pbFinishObservation(&op, b)
			out = append(out, op)
		}
	}
	return out
}

func pbIchimoku(in Input, interval string, b []market.Candle, family string) []Opportunity {
	out := []Opportunity{}
	warmup := ichimoku.KijunLength
	if family == CloudReclaim {
		warmup = ichimoku.CloudWarmupBars
	}
	for i := warmup; i < len(b); i++ {
		low, high := pbIchimokuZone(b, i-1, family)
		for _, direction := range []string{"bullish", "bearish"} {
			level := high
			if direction == "bearish" {
				level = low
			}
			if pbBreak(direction, b[i-1].Close, level) || !pbBreak(direction, b[i].Close, level) ||
				family == KijunReclaim && !pbBreak(direction, b[i].Close, b[i].Open) {
				continue
			}
			currentLow, currentHigh := pbIchimokuZone(b, i, family)
			currentEdge := currentHigh
			if direction == "bearish" {
				currentEdge = currentLow
			}
			// Kijun and the cloud may move between closes. Crossing yesterday's
			// boundary alone is not a reclaim of the indicator at this close.
			if !pbBreak(direction, b[i].Close, currentEdge) {
				continue
			}
			op := pbBase(in, interval, family, direction, b, i, level, low, high)
			op.LocationAvailableAt, op.SourceEndAt = b[i-1].CloseTime, b[i-1].CloseTime
			op.SourceStartAt = b[i-ichimoku.KijunLength].OpenTime
			if family == CloudReclaim {
				op.SourceStartAt = b[i-ichimoku.CloudWarmupBars].OpenTime
				op.SourceEndAt = b[i-1-ichimoku.DisplacementBars].CloseTime
			}
			op.State, op.Reason, op.Next = "waiting_for_retest", "A completed directional close reclaimed both the previously known and current Kijun; the prior boundary is now frozen.", "Wait for a later retest of both the frozen and current Kijun that closes on their favorable side."
			op.Invalidation = "A completed close back through the frozen or current Kijun before confirmation, then the frozen retest stop."
			if family == CloudReclaim {
				op.Reason = "A completed close broke through the previously known cloud and the cloud displayed at that close; the source zone is frozen."
				op.Next = "Wait for a held retest of both the frozen cloud zone and the cloud displayed at the retest; either cloud edge or its interior may provide the bounce."
				op.Invalidation = "A completed close through the adverse edge of either the frozen or currently displayed cloud before confirmation, then the frozen retest stop."
			}
			for j := i + 1; j < len(b) && j <= i+pbObserveBars; j++ {
				currentLow, currentHigh := pbIchimokuZone(b, j, family)
				adverse, currentAdverse := level, currentLow
				if family == CloudReclaim {
					adverse, currentAdverse = low, currentLow
					if direction == "bearish" {
						adverse, currentAdverse = high, currentHigh
					}
				}
				if !pbBreak(direction, b[j].Close, adverse) || !pbBreak(direction, b[j].Close, currentAdverse) {
					pbResolve(&op, "invalidated", "Price closed back through the frozen or current reclaim boundary.", b[j].CloseTime)
					break
				}
				if !pbOverlap(b[j], low, high) || !pbOverlap(b[j], currentLow, currentHigh) {
					continue
				}
				// A close still inside the cloud needs an observed rejection
				// toward the breakout side. This candle-body convention defines
				// "hold" without requiring an invented minimum candle size.
				if family == CloudReclaim {
					outside := b[j].Close > math.Max(high, currentHigh)
					if direction == "bearish" {
						outside = b[j].Close < math.Min(low, currentLow)
					}
					if !outside && !pbBreak(direction, b[j].Close, b[j].Open) {
						continue
					}
				}
				op.RetestAt = pbPtr(b[j].CloseTime)
				atr, ok := pbATR(b, j)
				stop := math.Min(math.Min(low, currentLow), b[j].Low)
				if direction == "bearish" {
					stop = math.Max(math.Max(high, currentHigh), b[j].High)
					if ok {
						stop += .1 * atr
					}
				} else if ok {
					stop -= .1 * atr
				}
				pbTrigger(&op, b, j, stop, pbTarget(b, i-1, j, direction, b[j].Close))
				break
			}
			pbFinishObservation(&op, b)
			out = append(out, op)
		}
	}
	return out
}

func pbBounds(b []market.Candle) (float64, float64) {
	low, high := b[0].Low, b[0].High
	for _, c := range b[1:] {
		low, high = math.Min(low, c.Low), math.Max(high, c.High)
	}
	return low, high
}
func pbMidpoint(b []market.Candle) float64 { lo, hi := pbBounds(b); return lo + (hi-lo)/2 }
func pbIchimokuZone(b []market.Candle, known int, family string) (float64, float64) {
	if family == KijunReclaim {
		v := pbMidpoint(b[known+1-ichimoku.KijunLength : known+1])
		return v, v
	}
	// This is the cloud DISPLAYED at known, calculated30bars earlier.
	// Newly calculated forward spans never enter this reclaim location.
	at := known - ichimoku.DisplacementBars
	tenkan := pbMidpoint(b[at+1-ichimoku.TenkanLength : at+1])
	kijun := pbMidpoint(b[at+1-ichimoku.KijunLength : at+1])
	spanA := math.Min(tenkan, kijun) + math.Abs(tenkan-kijun)/2
	spanB := pbMidpoint(b[at+1-ichimoku.SpanBLength : at+1])
	return math.Min(spanA, spanB), math.Max(spanA, spanB)
}

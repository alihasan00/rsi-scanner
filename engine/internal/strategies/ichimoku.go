package strategies

import (
	"math"

	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
)

// IchimokuOpportunities makes the lecture's TK, PK and cloud edge-to-edge
// observations independently reviewable. All prices come from completed
// candles and the same +30-bar displayed cloud used by the indicator. A
// projected cloud never substitutes for the cloud at an event's timestamp.
func IchimokuOpportunities(in Input) []Opportunity {
	out := []Opportunity{}
	for _, interval := range []string{"1h", "4h"} {
		bars, ok := pbCandles(in, interval)
		if !ok {
			continue
		}
		points := ichimoku.Series(bars)
		for _, family := range []string{TKCross, PKCross} {
			for _, op := range ichCrossOpportunities(in, interval, bars, points, family) {
				if pbRetained(op, bars) {
					out = append(out, op)
				}
			}
		}
		for _, op := range ichEdgeOpportunities(in, interval, bars, points) {
			if pbRetained(op, bars) {
				out = append(out, op)
			}
		}
	}
	return out
}

func ichCloud(point ichimoku.Point) (float64, float64, bool) {
	if point.SpanA == nil || point.SpanB == nil {
		return 0, 0, false
	}
	return math.Min(*point.SpanA, *point.SpanB), math.Max(*point.SpanA, *point.SpanB), true
}

func ichInside(value, low, high float64) bool { return value >= low && value <= high }

func ichSide(value float64) int {
	if value > 0 {
		return 1
	}
	if value < 0 {
		return -1
	}
	return 0
}

// Equal-line plateaus preserve the last established side. An initial equality
// departure or touching then receding is not a proven crossover. The moving
// line must itself advance in the crossover direction; a moving Kijun crossing
// a stationary Tenkan/price is the lecture's excluded KT geometry.
func ichCrossOpportunities(in Input, interval string, bars []market.Candle, points []ichimoku.Point, family string) []Opportunity {
	out := []Opportunity{}
	priorSide := 0
	for i, point := range points {
		if point.Kijun == nil || point.Tenkan == nil {
			priorSide = 0
			continue
		}
		moving := *point.Tenkan
		if family == PKCross {
			moving = bars[i].Close
		}
		side := ichSide(moving - *point.Kijun)
		if side == 0 {
			continue
		}
		before := priorSide
		priorSide = side
		if i == 0 || before == 0 || before == side || points[i-1].Kijun == nil || points[i-1].Tenkan == nil {
			continue
		}
		previousMoving := *points[i-1].Tenkan
		if family == PKCross {
			previousMoving = bars[i-1].Close
		}
		if float64(side)*(moving-previousMoving) <= 0 {
			continue
		}
		low, high, cloudReady := ichCloud(point)
		if !cloudReady || ichInside(*point.Kijun, low, high) || ichInside(bars[i].Close, low, high) {
			continue
		}
		direction := "bullish"
		if side < 0 {
			direction = "bearish"
		}
		level := *point.Kijun
		op := pbBase(in, interval, family, direction, bars, i, level, level, level)
		op.SourceStartAt = bars[i+1-ichimoku.CloudWarmupBars].OpenTime
		op.SourceEndAt, op.LocationAvailableAt = bars[i].CloseTime, bars[i].CloseTime
		kind := "price/Kijun"
		if family == TKCross {
			kind = "Tenkan/Kijun"
		}
		stacked := side > 0 && level > high && bars[i].Close > high && *point.SpanA > *point.SpanB ||
			side < 0 && level < low && bars[i].Close < low && *point.SpanA < *point.SpanB
		mild := family == TKCross && side > 0 && *point.Kijun < *points[i-1].Kijun
		context := "Less-confluent cross: the displayed cloud's location or color does not support the crossing direction."
		if stacked {
			context = "Stacked Ichimoku context: the crossed Kijun and price are outside the cloud on the favorable side, and its color agrees."
		}
		if mild {
			context = "Mild cross: Tenkan moves through an oppositely moving Kijun; the lecture treats this as weaker than the usual TK setup."
		}
		op.Caution += " " + context + " These are related observations from the same prices, not independent confirmations."
		signalReason := "A completed " + kind + " cross moved in the indicated direction outside the displayed cloud. " + context
		op.State, op.Reason = "waiting_for_retest", signalReason
		op.Next = "Wait for a later candle to retest the frozen cross-time Kijun and the current Kijun, then close on the favorable side."
		op.Invalidation = "A completed close through the frozen or current Kijun, or a reversed line relationship, before retest; then the frozen protective stop."
		for j := i + 1; j < len(bars) && j <= i+pbObserveBars; j++ {
			current := points[j]
			if current.Kijun == nil || current.Tenkan == nil {
				break
			}
			movingNow := *current.Tenkan
			if family == PKCross {
				movingNow = bars[j].Close
			}
			if !pbBreak(direction, bars[j].Close, level) || !pbBreak(direction, bars[j].Close, *current.Kijun) ||
				float64(side)*(movingNow-*current.Kijun) < 0 {
				pbResolve(&op, "invalidated", "The cross failed to hold its frozen/current Kijun or its directional line relationship before retest.", bars[j].CloseTime)
				break
			}
			if !pbOverlap(bars[j], level, level) || !pbOverlap(bars[j], *current.Kijun, *current.Kijun) {
				continue
			}
			op.RetestAt = pbPtr(bars[j].CloseTime)
			stop := ichStop(bars, j, direction, math.Min(level, *current.Kijun), math.Max(level, *current.Kijun))
			pbTrigger(&op, bars, j, stop, pbTarget(bars, i, j, direction, bars[j].Close))
			if op.State == "entry_confirmed" {
				op.Reason = signalReason + " A later held Kijun retest established the frozen entry, stop and opposing structural target."
			}
			break
		}
		pbFinishObservation(&op, bars)
		out = append(out, op)
	}
	return out
}

// The lecture supplies no numerical definition of "significant" width or a
// minimum flat duration. We require nonzero width and exactly one unchanged
// adjacent far-edge transition. Economic significance remains the selector's
// existing reward/risk-after-costs gate, not an invented lecture threshold.
func ichEdgeOpportunities(in Input, interval string, bars []market.Candle, points []ichimoku.Point) []Opportunity {
	out := []Opportunity{}
	for i := ichimoku.CloudWarmupBars; i < len(bars); i++ {
		priorLow, priorHigh, priorReady := ichCloud(points[i-1])
		low, high, ready := ichCloud(points[i])
		if !priorReady || !ready || low >= high || bars[i].Close <= low || bars[i].Close >= high {
			continue
		}
		for _, direction := range []string{"bullish", "bearish"} {
			near, previousFar := low, priorHigh
			entered := bars[i-1].Close < priorLow && bars[i].Close > bars[i-1].Close
			if direction == "bearish" {
				near, previousFar = high, priorLow
				entered = bars[i-1].Close > priorHigh && bars[i].Close < bars[i-1].Close
			}
			if !entered {
				continue
			}
			op := pbBase(in, interval, CloudEdgeToEdge, direction, bars, i, near, low, high)
			op.SourceStartAt = bars[i+1-ichimoku.CloudWarmupBars].OpenTime
			op.SourceEndAt = bars[i-ichimoku.DisplacementBars].CloseTime
			op.LocationAvailableAt = bars[i].CloseTime
			op.State, op.Reason = "waiting_for_retest", "A completed directional close entered the displayed cloud. Its far edge is not yet flat; the target is not established."
			op.Next = "Wait for a held near-edge retest while the opposite edge becomes flat; the target will be frozen only at that completed trigger."
			op.Invalidation = "A completed close back outside the entry edge, or a touch of the prospective far edge before confirmation; then the frozen protective stop."
			op.Caution += " Cloud color is irrelevant to edge-to-edge. Flat means an exactly unchanged adjacent far-edge value; significant width is assessed by the shared net reward/risk gate."
			for j := i; j < len(bars) && j <= i+pbObserveBars; j++ {
				currentLow, currentHigh, currentReady := ichCloud(points[j])
				if !currentReady || currentLow >= currentHigh {
					pbResolve(&op, "invalidated", "The displayed cloud no longer has usable nonzero width.", bars[j].CloseTime)
					break
				}
				currentNear, target := currentLow, currentHigh
				if direction == "bearish" {
					currentNear, target = currentHigh, currentLow
				}
				if !pbBreak(direction, bars[j].Close, near) || !pbBreak(direction, bars[j].Close, currentNear) {
					pbResolve(&op, "invalidated", "Price closed back outside the frozen or current cloud entry edge.", bars[j].CloseTime)
					break
				}
				// The current far edge is prospective until the trigger. Reject
				// it if ANY candle since entry has already touched that price;
				// a later flattening cannot resurrect a consumed target.
				consumed := false
				for k := i; k <= j; k++ {
					if pbFavorable(direction, bars[k], target) {
						consumed = true
						break
					}
				}
				if consumed {
					pbResolve(&op, "extended_before_entry", "The prospective opposite cloud edge was touched before a fresh entry could be confirmed.", bars[j].CloseTime)
					break
				}
				if bars[j].Close <= currentLow || bars[j].Close >= currentHigh {
					pbResolve(&op, "extended_before_entry", "Price left the displayed cloud before an edge-to-edge trigger.", bars[j].CloseTime)
					break
				}
				flat := target == previousFar
				previousFar = target
				if !flat {
					continue
				}
				if j > i {
					if !pbOverlap(bars[j], near, near) || !pbOverlap(bars[j], currentNear, currentNear) {
						continue
					}
					op.RetestAt = pbPtr(bars[j].CloseTime)
				}
				stopLow, stopHigh := math.Min(near, currentNear), math.Max(near, currentNear)
				pbTrigger(&op, bars, j, ichStop(bars, j, direction, stopLow, stopHigh), pbPtr(target))
				if op.State == "entry_confirmed" {
					op.Reason = "A completed close entered the cloud and its opposite edge was flat at confirmation; the opposite-edge target and entry/stop are now frozen regardless of later cloud movement."
				}
				break
			}
			pbFinishObservation(&op, bars)
			out = append(out, op)
		}
	}
	return out
}

func ichStop(bars []market.Candle, at int, direction string, low, high float64) float64 {
	stop := math.Min(low, bars[at].Low)
	atr, ok := pbATR(bars, at)
	if direction == "bearish" {
		stop = math.Max(high, bars[at].High)
		if ok {
			stop += .1 * atr
		}
	} else if ok {
		stop -= .1 * atr
	}
	return stop
}

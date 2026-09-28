package strategies

import (
	"fmt"
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

const rngLookback = 20
const rngObserveBars = 24

type rngSeed struct {
	box        Range
	known      int
	compressed bool
}

// RangeOpportunities enumerates only interactions with previously frozen
// ranges. The signal candle is never included in its own range boundaries.
func RangeOpportunities(in Input) []Opportunity {
	out := []Opportunity{}
	for _, interval := range []string{"1h", "4h"} {
		bars, ok := pbCandles(in, interval)
		if !ok {
			continue
		}
		seen := map[string]bool{}
		retainFirst := func(op Opportunity, ok bool) {
			if !ok {
				return
			}
			key := fmt.Sprintf("%s:%s:%d", op.Family, op.Direction, op.AvailableAt)
			if seen[key] {
				return
			}
			// Identity belongs to the earliest known box, even after that
			// event leaves the retained display window. A later box must not
			// inherit its ID, frozen plan or terminal state.
			seen[key] = true
			if pbRetained(op, bars) {
				out = append(out, op)
			}
		}
		for _, seed := range rngSeeds(in.Symbol, interval, bars) {
			for _, direction := range []string{"bullish", "bearish"} {
				retainFirst(rngRejection(in, interval, bars, seed, direction))
				if seed.compressed {
					retainFirst(rngBreakout(in, interval, bars, seed, direction))
				}
			}
		}
	}
	return out
}

func rngSeeds(symbol, interval string, b []market.Candle) []rngSeed {
	out := []rngSeed{}
	seen := map[string]bool{}
	for end := rngLookback - 1; end < len(b); end++ {
		start := end + 1 - rngLookback
		lo, hi, lowAt, highAt := b[start].Low, b[start].High, start, start
		for j := start + 1; j <= end; j++ {
			if b[j].Low < lo {
				lo, lowAt = b[j].Low, j
			}
			if b[j].High > hi {
				hi, highAt = b[j].High, j
			}
		}
		width := hi - lo
		atr, ok := pbATR(b, end)
		if !ok || width <= 0 || width > 6*atr || width < 1.5*atr || math.Abs(b[end].Close-b[start].Close) > .35*width {
			continue
		}
		lowTouches, highTouches, lastLow, lastHigh := 0, 0, -100, -100
		for j := start; j <= end; j++ {
			if b[j].Low <= lo+.1*width && j-lastLow >= 3 {
				lowTouches++
				lastLow = j
			}
			if b[j].High >= hi-.1*width && j-lastHigh >= 3 {
				highTouches++
				lastHigh = j
			}
		}
		if lowTouches < 2 || highTouches < 2 {
			continue
		}
		id := fmt.Sprintf("range:%s:%s:%d:%d", symbol, interval, b[lowAt].OpenTime, b[highAt].OpenTime)
		if seen[id] {
			continue
		}
		seen[id] = true
		compressed := false
		if start >= rngLookback {
			priorLow, priorHigh := b[start-rngLookback].Low, b[start-rngLookback].High
			for j := start - rngLookback + 1; j < start; j++ {
				priorLow = math.Min(priorLow, b[j].Low)
				priorHigh = math.Max(priorHigh, b[j].High)
			}
			compressed = width <= .75*(priorHigh-priorLow) && width <= 4*atr
		}
		out = append(out, rngSeed{box: Range{ID: id, Interval: interval, AvailableAt: b[end].CloseTime, StartAt: b[start].OpenTime, EndAt: b[end].CloseTime, Low: lo, High: hi, Midpoint: lo + width/2, State: "active"}, known: end, compressed: compressed})
	}
	return out
}

func rngRejection(in Input, interval string, b []market.Candle, s rngSeed, direction string) (Opportunity, bool) {
	var empty Opportunity
	for j := s.known + 1; j < len(b) && j <= s.known+rngObserveBars; j++ {
		c := b[j]
		if c.Close < s.box.Low || c.Close > s.box.High {
			return empty, false
		}
		matches := c.Low < s.box.Low && c.Close > s.box.Low && c.Close < s.box.Midpoint && c.High < s.box.High
		if direction == "bearish" {
			matches = c.High > s.box.High && c.Close < s.box.High && c.Close > s.box.Midpoint && c.Low > s.box.Low
		}
		if !matches {
			continue
		}
		level, target, stop, confirmation := s.box.Low, s.box.High, c.Low, c.High
		if direction == "bearish" {
			level, target, stop, confirmation = s.box.High, s.box.Low, c.High, c.Low
		}
		op := pbBase(in, interval, RangeRejection, direction, b, j, level, s.box.Low, s.box.High)
		op.LocationAvailableAt, op.SourceStartAt, op.SourceEndAt = s.box.AvailableAt, s.box.StartAt, s.box.EndAt
		op.ParentID = fmt.Sprintf("price:%s:%s:%s:%d", in.Symbol, interval, direction, c.CloseTime)
		op.State, op.Reason, op.Next = "awaiting_confirmation", "A completed candle swept and reclaimed an already-known 20-bar range edge.", "Wait for a later close beyond the rejection candle's opposite extreme."
		op.RetestAt = pbPtr(c.CloseTime)
		op.Invalidation = "A close outside the reclaimed range edge before confirmation, or the frozen protective stop after confirmation."
		for k := j + 1; k < len(b) && k <= j+pbObserveBars; k++ {
			if pbBeyond(direction, b[k], s.box.Low, s.box.High) {
				pbResolve(&op, "invalidated", "Price closed outside the reclaimed frozen range edge.", b[k].CloseTime)
				break
			}
			if pbFavorable(direction, b[k], target) {
				pbResolve(&op, "extended_before_entry", "The opposite frozen range boundary was reached before fresh confirmation.", b[k].CloseTime)
				break
			}
			if pbBreak(direction, b[k].Close, confirmation) {
				atr, ok := pbATR(b, k)
				if ok {
					if direction == "bullish" {
						stop -= .1 * atr
					} else {
						stop += .1 * atr
					}
				}
				pbTrigger(&op, b, k, stop, pbPtr(target))
				break
			}
		}
		pbFinishObservation(&op, b)
		return op, true
	}
	return empty, false
}

func rngBreakout(in Input, interval string, b []market.Candle, s rngSeed, direction string) (Opportunity, bool) {
	var empty Opportunity
	for j := s.known + 1; j < len(b) && j <= s.known+rngObserveBars; j++ {
		c := b[j]
		if c.Close >= s.box.Low && c.Close <= s.box.High {
			continue
		}
		level := s.box.High
		if direction == "bearish" {
			level = s.box.Low
		}
		if !pbBreak(direction, c.Close, level) {
			return empty, false
		}
		op := pbBase(in, interval, CompressionBreakout, direction, b, j, level, s.box.Low, s.box.High)
		op.LocationAvailableAt, op.SourceStartAt, op.SourceEndAt = s.box.AvailableAt, s.box.StartAt, s.box.EndAt
		op.State, op.Reason, op.Next = "waiting_for_retest", "A completed close broke a frozen range that was compressed before the break.", "Wait for a later boundary retest closing on the breakout side."
		op.Invalidation = "A completed close back through the frozen breakout boundary before confirmation, then the frozen retest stop."
		for k := j + 1; k < len(b) && k <= j+pbObserveBars; k++ {
			if !pbBreak(direction, b[k].Close, level) {
				pbResolve(&op, "invalidated", "The breakout failed to hold its frozen range boundary.", b[k].CloseTime)
				break
			}
			if b[k].Low <= level && b[k].High >= level {
				op.RetestAt = pbPtr(b[k].CloseTime)
				stop := math.Min(level, b[k].Low)
				atr, ok := pbATR(b, k)
				if direction == "bearish" {
					stop = math.Max(level, b[k].High)
					if ok {
						stop += .1 * atr
					}
				} else if ok {
					stop -= .1 * atr
				}
				pbTrigger(&op, b, k, stop, pbTarget(b, s.known, k, direction, b[k].Close))
				break
			}
		}
		pbFinishObservation(&op, b)
		return op, true
	}
	return empty, false
}

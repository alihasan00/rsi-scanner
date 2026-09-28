package strategies

import (
	"fmt"
	"math"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/technical"
)

// Describe keeps trend and volatility separate. These research labels never
// suppress a reversal and are calculated from the same completed hourly prefix.
func Describe(in Input) Context {
	out := Context{Symbol: in.Symbol, Availability: "unavailable", DirectionalState: "mixed", VolatilityState: "unavailable", Relative: []RelativeStrength{}}
	bars, ok := pbCandles(in, "1h")
	if !ok || len(bars) < 20 {
		return out
	}
	out.Availability, out.AsOf = "ready", pbPtr(bars[len(bars)-1].CloseTime)
	tech := technical.Analyze(bars)
	if tech.Bollinger.WidthPercentile != nil {
		out.VolatilityState = "ordinary"
	}
	if tech.Bollinger.WidthPercentile != nil && *tech.Bollinger.WidthPercentile <= 20 {
		out.VolatilityState = "compressed"
	} else if tech.Bollinger.WidthChange3Bars != nil && *tech.Bollinger.WidthChange3Bars > 0 && tech.Bollinger.WidthPercentile != nil && *tech.Bollinger.WidthPercentile >= 80 {
		out.VolatilityState = "expanding"
	}
	for _, seed := range rngSeeds(in.Symbol, "1h", bars) {
		if len(bars)-1-seed.known > rngObserveBars {
			continue
		}
		r := seed.box
		r.State = "active"
		for j := seed.known + 1; j < len(bars); j++ {
			if bars[j].Close > r.High || bars[j].Close < r.Low {
				r.State = "broken"
				break
			}
		}
		if r.State == "active" && (out.Range == nil || r.AvailableAt < out.Range.AvailableAt) {
			out.Range = &r
		}
	}
	if out.Range != nil {
		out.DirectionalState = "range"
		return out
	}
	// A mixed state is intentional when the two measured trend descriptions disagree.
	frame, exists := in.Frames["1h"]
	if exists && frame.Analysis.Structure.Status == "ready" && frame.Analysis.Regime.Ready {
		a, b := frame.Analysis.Regime.Direction, frame.Analysis.Structure.Internal.Bias
		if a == b && a == "bullish" {
			out.DirectionalState = "up"
		}
		if a == b && a == "bearish" {
			out.DirectionalState = "down"
		}
	}
	return out
}

func pbPtr[T any](v T) *T     { return &v }
func pbFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func pbDuration(interval string) int64 {
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
func pbCandles(in Input, interval string) ([]market.Candle, bool) {
	h, exists := in.Histories[interval]
	if !exists || len(h.Candles) == 0 {
		return nil, false
	}
	bars := h.Candles
	d := pbDuration(interval)
	for i, c := range bars {
		if !c.Valid() || c.CloseTime-c.OpenTime+1 != d || c.OpenTime%d != 0 || i > 0 && c.OpenTime != bars[i-1].CloseTime+1 {
			return nil, false
		}
	}
	if f, exists := in.Frames[interval]; exists {
		if f.Stale || f.Symbol != "" && f.Symbol != in.Symbol || f.Interval != "" && f.Interval != interval || f.LastClosedAt != 0 && f.LastClosedAt != bars[len(bars)-1].CloseTime || f.Analysis.AsOf != 0 && f.Analysis.AsOf != bars[len(bars)-1].CloseTime || !f.ObservedAt.IsZero() && f.ObservedAt.UnixMilli() < bars[len(bars)-1].CloseTime {
			return nil, false
		}
	}
	return bars, true
}

// A simple 14-bar true-range mean is frozen on the trigger, distinct from the
// screener's Wilder ATR. It supplies scale, never a probability or target.
func pbATR(bars []market.Candle, at int) (float64, bool) {
	if at < 14 {
		return 0, false
	}
	var total float64
	for j := at - 13; j <= at; j++ {
		total += math.Max(bars[j].High-bars[j].Low, math.Max(math.Abs(bars[j].High-bars[j-1].Close), math.Abs(bars[j].Low-bars[j-1].Close))) / 14
	}
	return total, pbFinite(total) && total > 0
}
func pbID(symbol, interval, family, direction string, at int64) string {
	return fmt.Sprintf("v%d:%s:%s:%s:%s:%d", Version, symbol, interval, family, direction, at)
}
func pbBase(in Input, interval, family, direction string, bars []market.Candle, known int, level, low, high float64) Opportunity {
	return Opportunity{Version: Version, ID: pbID(in.Symbol, interval, family, direction, bars[known].CloseTime), ParentID: fmt.Sprintf("price:%s:%s:%s:%d", in.Symbol, interval, direction, bars[known].CloseTime), Family: family, Symbol: in.Symbol, Interval: interval, Direction: direction, State: "observing", AvailableAt: bars[known].CloseTime, LocationAvailableAt: bars[known].CloseTime, SourceStartAt: bars[known].OpenTime, SourceEndAt: bars[known].CloseTime, AsOf: bars[len(bars)-1].CloseTime, Level: level, ZoneLow: pbPtr(low), ZoneHigh: pbPtr(high), ExpiresAt: pbPtr(bars[known].CloseTime + int64(pbObserveBars)*pbDuration(interval)), Caution: "Experimental closed-candle definition; no validated edge or assumed execution."}
}

const pbObserveBars = 24
const pbEntryBars = 4
const pbRecentTerminal = 8

func pbResolve(op *Opportunity, state, reason string, at int64) {
	op.State, op.Reason, op.ResolvedAt, op.Next = state, reason, pbPtr(at), "No fresh entry from this opportunity."
}
func pbRetained(op Opportunity, bars []market.Candle) bool {
	return op.ResolvedAt == nil || bars[len(bars)-1].CloseTime-*op.ResolvedAt < int64(pbRecentTerminal)*pbDuration(op.Interval)
}
func pbFinishObservation(op *Opportunity, bars []market.Candle) {
	if op.ResolvedAt == nil && op.TriggerAt == nil && op.ExpiresAt != nil && bars[len(bars)-1].CloseTime >= *op.ExpiresAt {
		pbResolve(op, "expired", "The 24-bar observation window ended without a complete trigger.", *op.ExpiresAt)
	}
}
func pbBeyond(direction string, c market.Candle, low, high float64) bool {
	if direction == "bullish" {
		return c.Close < low
	}
	return c.Close > high
}
func pbBreak(direction string, close, level float64) bool {
	if direction == "bullish" {
		return close > level
	}
	return close < level
}
func pbOverlap(c market.Candle, low, high float64) bool { return c.Low <= high && c.High >= low }
func pbAdverse(direction string, c market.Candle, level float64) bool {
	if direction == "bullish" {
		return c.Low <= level
	}
	return c.High >= level
}
func pbFavorable(direction string, c market.Candle, level float64) bool {
	if direction == "bullish" {
		return c.High >= level
	}
	return c.Low <= level
}
func pbPivot(b []market.Candle, i int, high bool) bool {
	if i < 2 || i+2 >= len(b) {
		return false
	}
	for j := i - 2; j <= i+2; j++ {
		if j == i {
			continue
		}
		if high && b[j].High >= b[i].High || !high && b[j].Low <= b[i].Low {
			return false
		}
	}
	return true
}

// Only targets already confirmed when the location became available may be
// used. An intervening touch from the next candle through trigger rejects that
// target. Missing structure stays missing instead of inventing an R multiple.
func pbTarget(b []market.Candle, known, trigger int, direction string, entry float64) *float64 {
	var target *float64
	for i := max(2, known-160); i+2 <= known; i++ {
		if !pbPivot(b[:known+1], i, direction == "bullish") {
			continue
		}
		v := b[i].High
		if direction == "bearish" {
			v = b[i].Low
		}
		if !pbBreak(direction, v, entry) {
			continue
		}
		touched := false
		for j := i + 3; j <= trigger; j++ {
			if pbFavorable(direction, b[j], v) {
				touched = true
				break
			}
		}
		if touched {
			continue
		}
		if target == nil || math.Abs(v-entry) < math.Abs(*target-entry) {
			target = pbPtr(v)
		}
	}
	return target
}

// pbTrigger freezes a plan at the completed trigger close. All later candles
// apply independent protective-price rules, even if the source indicator has
// already reached a historical terminal state.
func pbTrigger(op *Opportunity, b []market.Candle, at int, stop float64, target *float64) {
	when, entry := b[at].CloseTime, b[at].Close
	op.TriggerAt, op.EntryReference = pbPtr(when), pbPtr(entry)
	op.ExpiresAt = pbPtr(when + int64(pbEntryBars)*pbDuration(op.Interval))
	atr, ok := pbATR(b, at)
	if !ok || target == nil || !pbFinite(stop) || stop <= 0 || !pbFinite(*target) || !pbBreak(op.Direction, entry, stop) || !pbBreak(op.Direction, *target, entry) {
		pbResolve(op, "rejected", "Price confirmation exists but a finite structural stop, available opposing target or ATR is missing.", when)
		return
	}
	op.Stop, op.Target, op.ReferenceATR = pbPtr(stop), pbPtr(*target), pbPtr(atr)
	lo, hi := entry-0.25*atr, entry+0.25*atr
	// Every price in the advertised entry interval must retain the frozen
	// protective ordering. Nextafter makes the boundary strictly interior.
	lo = math.Max(lo, math.Nextafter(math.Min(stop, *target), math.Inf(1)))
	hi = math.Min(hi, math.Nextafter(math.Max(stop, *target), math.Inf(-1)))
	if lo <= 0 || lo > hi || !pbFinite(lo) || !pbFinite(hi) {
		pbResolve(op, "rejected", "Entry bounds are unrepresentable.", when)
		return
	}
	op.EntryMin, op.EntryMax = pbPtr(lo), pbPtr(hi)
	op.State, op.Reason, op.Next = "entry_confirmed", "The family's completed price confirmation is present; entry, stop and opposing target are frozen.", "Assess the current quote, costs and shared risk limits before any paper entry."
	for j := at + 1; j < len(b); j++ {
		if pbAdverse(op.Direction, b[j], stop) {
			pbResolve(op, "invalidated", "A later completed candle reached the frozen protective stop; stop takes precedence if both references were touched.", b[j].CloseTime)
			return
		}
		if pbFavorable(op.Direction, b[j], *target) {
			pbResolve(op, "target_reached", "A later completed candle reached the frozen target reference; this is an observation, not an execution.", b[j].CloseTime)
			return
		}
		if b[j].CloseTime >= *op.ExpiresAt {
			pbResolve(op, "expired", "The four-bar entry window ended.", b[j].CloseTime)
			return
		}
	}
}

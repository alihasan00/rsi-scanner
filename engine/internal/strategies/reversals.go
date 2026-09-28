package strategies

import (
	"fmt"
	"math"
	"strings"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/momentum"
	"github.com/alihasan00/crypto/internal/structure"
	"github.com/alihasan00/crypto/internal/swingfailure"
)

// ReversalObservationBars is the terminal retention window, not the amount of
// indicator history used. Discovery reconstructs another 20 bars before this
// window to cover the longest possible development and entry lifecycle.
const ReversalObservationBars = 96

// ReversalSourceBars fixes discovery/target warmup at event time. A rolling
// outer cache must not reseed a historical RSI or replace its chosen target.
const ReversalSourceBars = 160

// Source readiness is separate from a usable reference plan. A sweep can be
// observed before the fourteen-bar risk scale is available. Hidden divergence
// additionally needs an actual agreeing hourly internal break, not only bars.
const (
	SweepMinimumBars       = 4
	DivergenceMinimumBars  = ReversalSourceBars
	HiddenTrendMinimumBars = 51
)

const revMaximumLifecycleBars = 20

type revSweep struct {
	op                         Opportunity
	source                     swingfailure.Event
	detected, broken, retested int
	retestExtreme              float64
}

type revDivergence struct {
	op            Opportunity
	source        momentum.Divergence
	detected      int
	bodyConfirmed bool
}

// ReversalOpportunities replays only completed prefixes. Each source analyzer
// can publish at most two NEW events per close and sorts those before older
// events within its active group, so selecting only same-close detections
// recovers all new observations despite its eight-row display bound. Neither
// a disappearing source row nor its terminal follow_through/rsi-50 state is
// treated as current trade eligibility.
func ReversalOpportunities(in Input) []Opportunity {
	bars, ok := strategyCandles(in, "15m")
	if !ok {
		return []Opportunity{}
	}
	start := max(0, len(bars)-ReversalObservationBars-revMaximumLifecycleBars)
	sweeps := []revSweep{}
	divergences := []revDivergence{}
	for index := start; index < len(bars); index++ {
		bar := bars[index]
		prefix := bars[max(0, index+1-ReversalSourceBars) : index+1]
		rsi := momentum.Snapshot{}
		if len(prefix) == ReversalSourceBars {
			rsi = momentum.Analyze(prefix)
		}
		for i := range sweeps {
			revAdvanceSweep(in, &sweeps[i], bars, index)
		}
		for i := range divergences {
			revAdvanceDivergence(in, &divergences[i], bars, index, rsi.RSI)
		}
		for _, event := range swingfailure.Analyze(prefix).Events {
			if event.ConfirmedAt != bar.CloseTime {
				continue
			}
			op := revBase(in, SweepReversal, event.Direction, event.ConfirmedAt, event.Level.Price)
			op.LocationAvailableAt, op.SourceStartAt, op.SourceEndAt = event.Level.AvailableAt, event.Level.OpenTime, event.Candle.CloseTime
			op.Reason = "A completed candle swept a known swing and closed back through it."
			op.Next = "Wait for a close through the frozen intervening pivot, a later retest, and later follow-through."
			op.Invalidation = "Lost reclaim, adverse sweep-extreme breach, failed retest, protective reference touch or entry expiry."
			if event.Direction == "bullish" {
				op.ZoneLow, op.ZoneHigh = strategyPointer(event.Candle.Low), strategyPointer(event.Level.Price)
			} else {
				op.ZoneLow, op.ZoneHigh = strategyPointer(event.Level.Price), strategyPointer(event.Candle.High)
			}
			op.ExpiresAt = strategyPointer(event.ConfirmedAt + 4*strategyDuration("15m"))
			if event.Trigger == nil {
				strategyResolve(&op, "rejected", "The sweep had no unbroken intervening price pivot known before its candle.", bar.CloseTime)
			}
			sweeps = append(sweeps, revSweep{op: op, source: event, detected: index, broken: -1, retested: -1})
		}
		for _, event := range rsi.Divergences {
			if event.DetectedAt != bar.CloseTime {
				continue
			}
			divergences = append(divergences, revNewDivergence(in, event, bars, index))
		}
	}
	out := []Opportunity{}
	cutoff := bars[max(0, len(bars)-ReversalObservationBars)].CloseTime
	keep := func(op Opportunity) {
		if op.ResolvedAt != nil && *op.ResolvedAt < cutoff {
			return
		}
		op.AsOf = bars[len(bars)-1].CloseTime
		out = append(out, op)
	}
	for _, observation := range sweeps {
		keep(observation.op)
	}
	for _, observation := range divergences {
		keep(observation.op)
	}
	return out
}

func revBase(in Input, family, direction string, at int64, level float64) Opportunity {
	parent := fmt.Sprintf("%s/15m/%s/%d", in.Symbol, direction, at)
	return Opportunity{Version: Version, ID: fmt.Sprintf("%s/v%d/%s", family, Version, parent), ParentID: parent,
		Family: family, Symbol: in.Symbol, Interval: "15m", Direction: direction, State: "observing",
		AvailableAt: at, AsOf: at, Level: level,
		Caution: "Experimental completed-candle rule; no demonstrated edge or assumed fill. Bearish Spot observations are hypothetical short comparisons."}
}

func revAdvanceSweep(in Input, tracked *revSweep, bars []market.Candle, index int) {
	op, source := &tracked.op, tracked.source
	if op.ResolvedAt != nil || index <= tracked.detected {
		return
	}
	bar := bars[index]
	if op.TriggerAt != nil {
		strategyAdvancePlan(op, bar)
		if op.ResolvedAt != nil {
			return
		}
	}
	bullish := op.Direction == "bullish"
	lost := bullish && bar.Close < source.Level.Price || !bullish && bar.Close > source.Level.Price
	adverse := source.Candle.Low
	if !bullish {
		adverse = source.Candle.High
	}
	if lost || op.TriggerAt == nil && (bullish && bar.Low < adverse || !bullish && bar.High > adverse) {
		strategyResolve(op, "invalidated", "The reclaimed swing level or original sweep extreme failed after discovery.", bar.CloseTime)
		return
	}
	if op.TriggerAt != nil {
		return
	}
	if tracked.broken < 0 {
		previous := bars[index-1]
		broken := source.Trigger != nil && (bullish && previous.Close <= source.Trigger.Price && bar.Close > source.Trigger.Price ||
			!bullish && previous.Close >= source.Trigger.Price && bar.Close < source.Trigger.Price)
		if broken && index-tracked.detected <= 4 {
			tracked.broken = index
			op.State, op.Reason = "waiting_for_retest", "A later close broke the frozen intervening pivot after the sweep."
			op.Next = "Wait for a later closed-candle retest of the broken pivot."
			op.ExpiresAt = strategyPointer(bar.CloseTime + 8*strategyDuration("15m"))
			return
		}
		if index-tracked.detected >= 4 {
			strategyResolve(op, "expired", "No later close broke the frozen intervening pivot within four bars.", bar.CloseTime)
		}
		return
	}
	level := source.Trigger.Price
	if bullish && bar.Close <= level || !bullish && bar.Close >= level {
		strategyResolve(op, "invalidated", "The broken price pivot was lost on a later close before entry confirmation.", bar.CloseTime)
		return
	}
	if tracked.retested < 0 {
		if index-tracked.broken <= 8 && (bullish && bar.Low <= level || !bullish && bar.High >= level) {
			tracked.retested = index
			tracked.retestExtreme = bar.High
			if !bullish {
				tracked.retestExtreme = bar.Low
			}
			op.RetestAt, op.State = strategyPointer(bar.CloseTime), "awaiting_confirmation"
			op.Reason = "A later completed candle retested and held the broken pivot."
			op.Next = "Wait for a separate later close through the retest candle's favorable extreme."
			op.ExpiresAt = strategyPointer(bar.CloseTime + 4*strategyDuration("15m"))
			return
		}
		if index-tracked.broken >= 8 {
			strategyResolve(op, "expired", "No held retest occurred within eight bars of the structure break.", bar.CloseTime)
		}
		return
	}
	if index-tracked.retested <= 4 && (bullish && bar.Close > tracked.retestExtreme || !bullish && bar.Close < tracked.retestExtreme) {
		strategyFreeze(in, op, bars, index, adverse)
		return
	}
	if index-tracked.retested >= 4 {
		strategyResolve(op, "expired", "No separate follow-through close occurred within four bars of the retest.", bar.CloseTime)
	}
}

func revNewDivergence(in Input, event momentum.Divergence, bars []market.Candle, index int) revDivergence {
	family := DivergenceReversal
	if strings.HasPrefix(event.Kind, "hidden-") {
		family = DivergenceContinuation
	}
	op := revBase(in, family, event.Direction, event.DetectedAt, event.End.Price)
	op.LocationAvailableAt, op.SourceStartAt, op.SourceEndAt = event.End.AvailableAt, event.Start.OpenTime, event.DetectedAt
	op.Reason = "A causal RSI divergence formed; its provisional second anchor still needs price confirmation."
	op.Next = "Wait for the immediately following body confirmation and a close through the frozen intervening price pivot."
	op.Invalidation = "Missing next-body confirmation, adverse RSI anchor or second price extreme before trigger, protective reference touch or expiry."
	op.ExpiresAt = strategyPointer(event.DetectedAt + 14*strategyDuration("15m"))
	low, high := math.Min(event.Start.Price, event.End.Price), math.Max(event.Start.Price, event.End.Price)
	op.ZoneLow, op.ZoneHigh = strategyPointer(low), strategyPointer(high)
	trigger := revInterveningPivot(bars[:index+1], event)
	if trigger == nil {
		strategyResolve(&op, "rejected", "No unbroken intervening price pivot was known when this divergence formed.", event.DetectedAt)
	} else {
		op.Level = *trigger
	}
	if op.ResolvedAt == nil && family == DivergenceContinuation && !revTrendAt(in, event.Direction, event.DetectedAt) {
		strategyResolve(&op, "rejected", "Hidden divergence lacked agreeing confirmed hourly structure at discovery.", event.DetectedAt)
	}
	return revDivergence{op: op, source: event, detected: index}
}

// The most recent opposite strict three-candle price pivot between the RSI
// anchors must have become known before the second anchor candle opened.
func revInterveningPivot(bars []market.Candle, event momentum.Divergence) *float64 {
	bullish := event.Direction == "bullish"
	for i := len(bars) - 3; i >= 1; i-- {
		if bars[i].OpenTime <= event.Start.OpenTime {
			break
		}
		price := bars[i].High
		pivot := price > bars[i-1].High && price > bars[i+1].High
		if !bullish {
			price = bars[i].Low
			pivot = price < bars[i-1].Low && price < bars[i+1].Low
		}
		if !pivot {
			continue
		}
		for _, bar := range bars[i+2:] {
			if bullish && bar.Close > price || !bullish && bar.Close < price {
				return nil
			}
		}
		return strategyPointer(price)
	}
	return nil
}

func revTrendAt(in Input, direction string, at int64) bool {
	bars, ok := strategyCandles(in, "1h")
	if !ok {
		return false
	}
	bars = strategyPrefix(bars, at)
	bars = bars[max(0, len(bars)-ReversalSourceBars):]
	snapshot := structure.Analyze(bars, structure.DefaultConfig())
	return snapshot.Internal.Ready && snapshot.Internal.Bias == direction
}

func revAdvanceDivergence(in Input, tracked *revDivergence, bars []market.Candle, index int, rsi *float64) {
	op, source := &tracked.op, tracked.source
	if op.ResolvedAt != nil || index <= tracked.detected {
		return
	}
	bar := bars[index]
	if op.TriggerAt != nil {
		// Oscillator completion (including RSI50) never resolves a price plan.
		strategyAdvancePlan(op, bar)
		return
	}
	bullish := op.Direction == "bullish"
	if rsi == nil || !strategyFinite(*rsi) {
		strategyResolve(op, "rejected", "RSI evidence became unavailable before price confirmation.", bar.CloseTime)
		return
	}
	if bullish && (*rsi < source.InvalidationRSI || bar.Low < source.End.Price) ||
		!bullish && (*rsi > source.InvalidationRSI || bar.High > source.End.Price) {
		strategyResolve(op, "invalidated", "The frozen RSI anchor or second price extreme failed before the trigger.", bar.CloseTime)
		return
	}
	if !tracked.bodyConfirmed {
		if index != tracked.detected+1 || !(bullish && bar.Close > bar.Open || !bullish && bar.Close < bar.Open) {
			strategyResolve(op, "rejected", "The immediately following completed candle did not confirm the divergence body.", bar.CloseTime)
			return
		}
		tracked.bodyConfirmed = true
		op.State, op.Reason = "awaiting_confirmation", "The next candle confirmed direction; the frozen price-pivot break is still required."
		op.Next = "Wait for a completed close through the frozen intervening price pivot."
	}
	previous := bars[index-1]
	if index-tracked.detected <= 14 && (bullish && previous.Close <= op.Level && bar.Close > op.Level ||
		!bullish && previous.Close >= op.Level && bar.Close < op.Level) {
		strategyFreeze(in, op, bars, index, source.End.Price)
		return
	}
	if index-tracked.detected >= 14 {
		strategyResolve(op, "expired", "No price-pivot confirmation occurred within fourteen bars of divergence discovery.", bar.CloseTime)
	}
}

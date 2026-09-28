// Derived from Smart Money Concepts [LuxAlgo], © LuxAlgo.
// Licensed under CC BY-NC-SA 4.0:
// https://creativecommons.org/licenses/by-nc-sa/4.0/
package structure

import (
	"fmt"

	"github.com/alihasan00/crypto/internal/market"
)

type replayState struct {
	State
	bullishLeg bool // Pine initializes leg to BEARISH_LEG (0).
}

// Analyze replays valid, contiguous, ascending CLOSED OHLCV candles. It never
// reads wall-clock time, mutates its arguments, sorts/drops malformed candles,
// or consults later bars while processing an earlier one. A Candle has no
// finality bit: callers, including the cache adapter, must exclude previews.
//
// This deliberately ports only source leg discovery and close-cross structure
// breaks, with the default optional wick filter disabled. Internal breaks are
// suppressed when their corresponding swing level is missing or identical,
// matching the source's comparison and Pine's missing-value behavior.
func Analyze(candles []market.Candle, cfg Config) Snapshot {
	result := Snapshot{
		Config: cfg, Bars: len(candles), Status: "warming_up",
		Internal: State{Length: cfg.InternalLength, Bias: BiasUnknown},
		Swing:    State{Length: cfg.SwingLength, Bias: BiasUnknown},
	}
	if err := cfg.Validate(); err != nil {
		result.Status, result.Reason = "invalid", err.Error()
		return result
	}
	if err := validateCandles(candles); err != nil {
		result.Status, result.Reason = "invalid", err.Error()
		return result
	}
	internal := replayState{State: result.Internal}
	swing := replayState{State: result.Swing}
	for i := range candles {
		// Save the prior candle's levels for ta.crossover/ta.crossunder semantics.
		previousInternalHigh, previousInternalLow := internal.High, internal.Low
		previousSwingHigh, previousSwingLow := swing.High, swing.Low
		// Source discovers both scales before processing internal, then swing,
		// breaks. Consequently an internal event uses today's confirmed swing.
		swing.discover(candles, i)
		internal.discover(candles, i)
		if i > 0 {
			internal.observe(candles[i-1], candles[i], previousInternalHigh, previousInternalLow,
				distinctLevel(internal.High, swing.High), distinctLevel(internal.Low, swing.Low))
			swing.observe(candles[i-1], candles[i], previousSwingHigh, previousSwingLow, true, true)
		}
	}
	result.Internal, result.Swing = internal.State, swing.State
	if len(candles) > 0 {
		result.AsOf = candles[len(candles)-1].CloseTime
	}
	if result.Internal.Ready && result.Swing.Ready {
		result.Status = "ready"
	}
	return result
}

func validateCandles(candles []market.Candle) error {
	for i, candle := range candles {
		if !candle.Valid() {
			return fmt.Errorf("invalid candle at index %d", i)
		}
		if i > 0 && candle.OpenTime != candles[i-1].CloseTime+1 {
			return fmt.Errorf("candles must be contiguous and ascending at index %d", i)
		}
	}
	return nil
}

func (s *replayState) discover(candles []market.Candle, i int) {
	if i < s.Length {
		return
	}
	s.Ready = true
	j := i - s.Length
	highest, lowest := candles[j+1].High, candles[j+1].Low
	for k := j + 2; k <= i; k++ {
		if candles[k].High > highest {
			highest = candles[k].High
		}
		if candles[k].Low < lowest {
			lowest = candles[k].Low
		}
	}
	nextLeg := s.bullishLeg
	if candles[j].High > highest {
		nextLeg = false
	} else if candles[j].Low < lowest {
		nextLeg = true
	}
	if nextLeg == s.bullishLeg {
		return
	}
	s.bullishLeg = nextLeg
	pivot := &Pivot{Index: j, OccurredAt: candles[j].OpenTime, ConfirmedAt: candles[i].CloseTime}
	if nextLeg {
		pivot.Price = candles[j].Low
		s.Low = pivot
	} else {
		pivot.Price = candles[j].High
		s.High = pivot
	}
}

func distinctLevel(internal, swing *Pivot) bool {
	return internal != nil && swing != nil && internal.Price != swing.Price
}

func (s *replayState) observe(previous, current market.Candle, previousHigh, previousLow *Pivot, allowHigh, allowLow bool) {
	if allowHigh && s.High != nil && previousHigh != nil && !s.High.Crossed &&
		current.Close > s.High.Price && previous.Close <= previousHigh.Price {
		s.recordBreak(s.High, current, BiasBullish)
	}
	if allowLow && s.Low != nil && previousLow != nil && !s.Low.Crossed &&
		current.Close < s.Low.Price && previous.Close >= previousLow.Price {
		s.recordBreak(s.Low, current, BiasBearish)
	}
}

func (s *replayState) recordBreak(pivot *Pivot, current market.Candle, direction string) {
	kind := "BOS"
	if s.Bias != BiasUnknown && s.Bias != direction {
		kind = "CHoCH"
	}
	s.LastBreak = &Break{
		Type: kind, Direction: direction, PreviousBias: s.Bias, Level: pivot.Price,
		ConfirmedAt: current.CloseTime, PivotOccurredAt: pivot.OccurredAt, PivotConfirmedAt: pivot.ConfirmedAt,
	}
	pivot.Crossed, pivot.CrossedAt = true, current.CloseTime
	s.Bias = direction
}

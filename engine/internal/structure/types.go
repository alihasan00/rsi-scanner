// Package structure derives closed-candle market structure from the leg and
// break rules in Smart Money Concepts [LuxAlgo], © LuxAlgo.
// This adaptation is licensed under CC BY-NC-SA 4.0:
// https://creativecommons.org/licenses/by-nc-sa/4.0/
//
// It reports causal price observations, not a probability of trade success.
package structure

import "fmt"

const (
	BiasUnknown = "unknown"
	BiasBullish = "bullish"
	BiasBearish = "bearish"
)

// Config selects how many subsequent closed bars must be below/above a leg
// candidate. These are confirmation lengths, not left-hand pivot strengths.
type Config struct {
	InternalLength int `json:"internalLength"`
	SwingLength    int `json:"swingLength"`
}

func DefaultConfig() Config { return Config{InternalLength: 5, SwingLength: 50} }

func (c Config) Validate() error {
	if c.InternalLength < 1 || c.InternalLength > 10000 {
		return fmt.Errorf("internalLength must be between 1 and 10000")
	}
	if c.SwingLength < 1 || c.SwingLength > 10000 {
		return fmt.Errorf("swingLength must be between 1 and 10000")
	}
	return nil
}

// Pivot is a confirmed leg extreme. OccurredAt is the extreme candle's opening
// time; ConfirmedAt is the inclusive closing time of the candle that made it
// knowable. Timestamps are Unix milliseconds. Index is input-window relative.
// A wick through a level does not set Crossed; a qualifying close break does.
type Pivot struct {
	Index       int     `json:"index"`
	Price       float64 `json:"price"`
	OccurredAt  int64   `json:"occurredAt"`
	ConfirmedAt int64   `json:"confirmedAt"`
	Crossed     bool    `json:"crossed"`
	CrossedAt   int64   `json:"crossedAt,omitempty"`
}

// Break is the latest qualifying close crossing a previously confirmed pivot.
// Type is BOS or CHoCH. As in the source, a first break from unknown bias is BOS;
// PreviousBias explicitly distinguishes that initialization from continuation.
// ConfirmedAt is the crossing candle's inclusive close, never the pivot time.
type Break struct {
	Type             string  `json:"type"`
	Direction        string  `json:"direction"`
	PreviousBias     string  `json:"previousBias"`
	Level            float64 `json:"level"`
	ConfirmedAt      int64   `json:"confirmedAt"`
	PivotOccurredAt  int64   `json:"pivotOccurredAt"`
	PivotConfirmedAt int64   `json:"pivotConfirmedAt"`
}

// State describes one structure scale. Ready means enough bars exist to test
// a leg; it does not imply that a pivot or directional break has occurred.
// Bias remains unknown until a qualifying break. Nil pivots/events are unknown,
// and equal-length configurations suppress internal breaks at swing levels.
type State struct {
	Length    int    `json:"length"`
	Ready     bool   `json:"ready"`
	Bias      string `json:"bias"`
	High      *Pivot `json:"high"`
	Low       *Pivot `json:"low"`
	LastBreak *Break `json:"lastBreak"`
}

// Snapshot describes the final state of a chronological replay. Status is
// ready, warming_up, or invalid. Invalid input/config yields no observations.
// AsOf is the last input candle's inclusive closing time for valid input, or 0
// for empty/invalid input; the caller must supply only completed candles.
type Snapshot struct {
	Config   Config `json:"config"`
	Status   string `json:"status"`
	Reason   string `json:"reason,omitempty"`
	Bars     int    `json:"bars"`
	AsOf     int64  `json:"asOf"`
	Internal State  `json:"internal"`
	Swing    State  `json:"swing"`
}

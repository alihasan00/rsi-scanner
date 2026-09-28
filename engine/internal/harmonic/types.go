// Package harmonic reconstructs a harmonic-pattern screener from the public
// orchestration in harmonic.pine. Its imported TradingView libraries are absent;
// the standard ratios, pivot search, PRZ and scoring formulas here are explicitly
// independent implementations, not an assertion of TradingView parity.
//
// Analyze replays closed candles in order. A pivot uses PivotMin..PivotMax bars
// to its left and ConfirmationBars to its right; D always uses three bars to its
// left. Signals cannot observe a candle after their detection time. Entry, stop
// and target levels are screening references, never exchange orders or fills.
// Inspired by harmonic.pine, © reees, licensed under MPL-2.0.
// This file is distributed under the Mozilla Public License 2.0.
package harmonic

import (
	"fmt"
	"math"
	"strings"
)

// Config uses percentages on a 0..100 scale, except that temporal asymmetry may
// exceed 100% and EntryOffsetATR is an ATR multiplier. Targets and the
// nearest-confluent-PRZ entry follow Pine defaults; ATR offsets are optional.
type Config struct {
	PivotMin          int      `json:"pivotMin"`
	PivotMax          int      `json:"pivotMax"`
	ConfirmationBars  int      `json:"confirmationBars"`
	RatioTolerance    float64  `json:"ratioTolerance"`
	MaxLegAsymmetry   float64  `json:"maxLegAsymmetry"`
	MinScore          float64  `json:"minScore"`
	IncludePotential  bool     `json:"includePotential"`
	Bullish           bool     `json:"bullish"`
	Bearish           bool     `json:"bearish"`
	Types             []string `json:"types"`
	EntryAfterC       bool     `json:"entryAfterC"`
	EntryAfterD       bool     `json:"entryAfterD"`
	EntryLimitPercent float64  `json:"entryLimitPercent"`
	EntryOffsetMode   string   `json:"entryOffsetMode"`
	EntryOffsetATR    float64  `json:"entryOffsetATR"`
	EntryWindow       float64  `json:"entryWindow"`
	PatternTimeout    float64  `json:"patternTimeout"`
	StopPercent       float64  `json:"stopPercent"`
}

func DefaultConfig() Config {
	return Config{
		PivotMin: 3, PivotMax: 20, ConfirmationBars: 1,
		RatioTolerance: 15, MaxLegAsymmetry: 250, MinScore: 90,
		IncludePotential: true, Bullish: true, Bearish: true,
		Types:       []string{"gartley", "bat", "butterfly", "crab", "shark", "cypher"},
		EntryAfterC: true, EntryAfterD: true, EntryLimitPercent: 1,
		EntryOffsetMode: "percent", EntryOffsetATR: .25,
		EntryWindow: .5, PatternTimeout: 3, StopPercent: 75,
	}
}

func (c Config) Validate() error {
	if c.PivotMin < 3 || c.PivotMax > 100 || c.PivotMax < c.PivotMin {
		return fmt.Errorf("pivot strengths must satisfy 3 <= pivotMin <= pivotMax <= 100")
	}
	if c.ConfirmationBars < 1 || c.ConfirmationBars > 100 {
		return fmt.Errorf("confirmationBars must be between 1 and 100")
	}
	for _, value := range []struct {
		name        string
		v, min, max float64
	}{
		{"ratioTolerance", c.RatioTolerance, 0, 50},
		{"maxLegAsymmetry", c.MaxLegAsymmetry, 0, 1000},
		{"minScore", c.MinScore, 0, 100},
		{"entryLimitPercent", c.EntryLimitPercent, 0, 100},
		{"entryOffsetATR", c.EntryOffsetATR, 0, 100},
		{"entryWindow", c.EntryWindow, 0, 100},
		{"patternTimeout", c.PatternTimeout, .1, 100},
		{"stopPercent", c.StopPercent, 0, 10000},
	} {
		if !finite(value.v) || value.v < value.min || value.v > value.max {
			return fmt.Errorf("%s must be between %g and %g", value.name, value.min, value.max)
		}
	}
	if c.EntryOffsetMode != "" && c.EntryOffsetMode != "percent" && c.EntryOffsetMode != "atr" {
		return fmt.Errorf("entryOffsetMode must be percent or atr")
	}
	if !c.Bullish && !c.Bearish {
		return fmt.Errorf("at least one direction must be enabled")
	}
	if len(c.Types) == 0 {
		return fmt.Errorf("at least one harmonic type must be enabled")
	}
	seen := make(map[string]bool)
	for _, kind := range c.Types {
		kind = strings.ToLower(strings.TrimSpace(kind))
		if _, ok := definitions[kind]; !ok {
			return fmt.Errorf("unknown harmonic type %q", kind)
		}
		if seen[kind] {
			return fmt.Errorf("duplicate harmonic type %q", kind)
		}
		seen[kind] = true
	}
	return nil
}

type Point struct {
	Index int     `json:"index"`
	Time  int64   `json:"time"`
	Price float64 `json:"price"`
}

// Zone is the envelope of the permissible BC and XA projections, expanded by
// RatioTolerance. Cypher has a single XC projection. The nominal closest levels
// determine the entry and confluence score; the envelope is for invalidation.
type Zone struct {
	Low  float64 `json:"low"`
	High float64 `json:"high"`
}

// ScoreComponents are percentages, not probability estimates. Range ratios
// incur no error inside their nominal bounds; outside them, error is relative
// to the nearest bound. PRZ gap and D distance are normalized by XA length.
// Score is the weighted mean of ratio accuracy (4), PRZ confluence (2) and
// D confluence (3). Potentials omit D; Cypher also omits PRZ confluence.
type ScoreComponents struct {
	RatioAccuracy float64  `json:"ratioAccuracy"`
	PRZConfluence float64  `json:"przConfluence"`
	DConfluence   *float64 `json:"dConfluence"`
	RatioWeight   float64  `json:"ratioWeight"`
	PRZWeight     float64  `json:"przWeight"`
	DWeight       float64  `json:"dWeight"`
}

// Pattern describes a price setup. pending means an entry reference has not
// been observed since detection; active means price reached that reference;
// completed means target 2 was later reached; invalidated means its structure
// or stop was breached; expired means its time window elapsed. These are OHLC
// observations, not simulated execution or trade performance. Same-bar stop
// and target ambiguity is resolved in favor of the stop, and targets on the
// entry-touch bar are not credited. D remains nil until its pivot is confirmed.
// EntryStage and EntryScore freeze the evidence at the first entry observation;
// later D confirmation/revision can change Stage and Score but not that snapshot.
type Pattern struct {
	ID                  string             `json:"id"`
	Kind                string             `json:"kind"`
	Direction           string             `json:"direction"`
	Stage               string             `json:"stage"`
	Status              string             `json:"status"`
	Score               float64            `json:"score"`
	Ratios              map[string]float64 `json:"ratios"`
	ScoreComponents     ScoreComponents    `json:"scoreComponents"`
	X                   Point              `json:"x"`
	A                   Point              `json:"a"`
	B                   Point              `json:"b"`
	C                   Point              `json:"c"`
	D                   *Point             `json:"d"`
	Zone                Zone               `json:"zone"`
	Entry               float64            `json:"entry"`
	Stop                float64            `json:"stop"`
	Target1             float64            `json:"target1"`
	Target2             float64            `json:"target2"`
	ReferenceD          float64            `json:"referenceD"`
	LevelsBasedOn       string             `json:"levelsBasedOn"`
	ReferenceStatus     string             `json:"referenceStatus,omitempty"`
	LevelsEstablishedAt int64              `json:"levelsEstablishedAt"`
	EntryAfterC         *float64           `json:"entryAfterC"`
	EntryAfterD         *float64           `json:"entryAfterD"`
	DetectedAt          int64              `json:"detectedAt"`
	ConfirmedAt         int64              `json:"confirmedAt"`
	LastUpdatedAt       int64              `json:"lastUpdatedAt"`
	AgeBars             int                `json:"ageBars"`
	EntryTouched        bool               `json:"entryTouched"`
	EntryTouchedAt      int64              `json:"entryTouchedAt,omitempty"`
	EntryStage          string             `json:"entryStage,omitempty"`
	EntryScore          *float64           `json:"entryScore,omitempty"`
	Target1Reached      bool               `json:"target1Reached"`
	Target2Reached      bool               `json:"target2Reached"`
	EndedAt             int64              `json:"endedAt,omitempty"`
	Reason              string             `json:"reason,omitempty"`
	dEntryOffset        float64
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func clamp(v float64) float64 { return math.Max(0, math.Min(100, v)) }

func ptr(v float64) *float64 { return &v }

// Package regime calculates trend, directional strength and volatility from
// closed candles. Analyze is deterministic: callers supply only the completed
// bars available at the decision time, in uninterrupted chronological order.
// It never reads a clock, fetches data, or changes the supplied candles.
//
// The adaptive SuperTrend calculation is derived from SuperTrend AI
// (Clustering), © LuxAlgo, scripts/supertrend.pine, licensed CC BY-NC-SA 4.0:
// https://creativecommons.org/licenses/by-nc-sa/4.0/ . The source's Signal Forge
// (also © LuxAlgo, CC BY-NC-SA 4.0) supplies the ATR/ADX defaults. This package's
// derived source is distributed under CC BY-NC-SA 4.0; see README.md for the
// intentionally documented numerical and warm-up differences.
package regime

import (
	"fmt"
	"math"
)

const (
	Bullish     = "bullish"
	Bearish     = "bearish"
	Neutral     = "neutral"
	Unavailable = "unavailable"
)

// Config preserves the supplied Pine scripts' calculation defaults, except
// clustering is bounded at 100 iterations by default instead of 1,001.
// The highest-scoring non-empty cluster supplies the SuperTrend factor.
type Config struct {
	SupertrendATRLength  int     `json:"supertrendAtrLength"`
	MinFactor            float64 `json:"minFactor"`
	MaxFactor            float64 `json:"maxFactor"`
	FactorStep           float64 `json:"factorStep"`
	PerformanceMemory    float64 `json:"performanceMemory"`
	MaxClusterIterations int     `json:"maxClusterIterations"`
	ATRLength            int     `json:"atrLength"`
	DILength             int     `json:"diLength"`
	ADXSmoothing         int     `json:"adxSmoothing"`
	ADXThreshold         float64 `json:"adxThreshold"`
}

func DefaultConfig() Config {
	return Config{
		SupertrendATRLength: 10, MinFactor: 1, MaxFactor: 5, FactorStep: .5,
		PerformanceMemory: 10, MaxClusterIterations: 100,
		ATRLength: 14, DILength: 14, ADXSmoothing: 14, ADXThreshold: 20,
	}
}

func (c Config) Validate() error {
	for _, p := range []struct {
		name  string
		value int
	}{
		{"supertrendAtrLength", c.SupertrendATRLength},
		{"atrLength", c.ATRLength}, {"diLength", c.DILength},
		{"adxSmoothing", c.ADXSmoothing}, {"maxClusterIterations", c.MaxClusterIterations},
	} {
		if p.value < 1 || p.value > 1000 {
			return fmt.Errorf("%s must be between 1 and 1000", p.name)
		}
	}
	if !finite(c.MinFactor) || !finite(c.MaxFactor) || c.MinFactor < 0 || c.MaxFactor > 100 || c.MaxFactor < c.MinFactor {
		return fmt.Errorf("factors must satisfy 0 <= minFactor <= maxFactor <= 100")
	}
	if !finite(c.FactorStep) || c.FactorStep <= 0 || c.FactorStep > 100 {
		return fmt.Errorf("factorStep must be greater than 0 and no greater than 100")
	}
	steps := (c.MaxFactor - c.MinFactor) / c.FactorStep
	if !finite(steps) || math.Floor(steps) > 200 {
		return fmt.Errorf("factor range must contain at most 201 candidates")
	}
	if !finite(c.PerformanceMemory) || c.PerformanceMemory < 2 || c.PerformanceMemory > 1000 {
		return fmt.Errorf("performanceMemory must be between 2 and 1000")
	}
	if !finite(c.ADXThreshold) || c.ADXThreshold < 0 || c.ADXThreshold > 100 {
		return fmt.Errorf("adxThreshold must be between 0 and 100")
	}
	return nil
}

// Snapshot describes evidence at the final supplied candle's inclusive close
// time in Unix milliseconds. Ready means all indicators have enough seed bars;
// it is not a quality rating, a trading signal, or a statistical confidence.
// WarmupBars reports the minimum total candles needed, not bars still needed.
type Snapshot struct {
	Direction  string     `json:"direction"`
	ClosedAt   *int64     `json:"closedAt"`
	ClosedBars int        `json:"closedBars"`
	WarmupBars int        `json:"warmupBars"`
	Ready      bool       `json:"ready"`
	Supertrend Supertrend `json:"supertrend"`
	Volatility Volatility `json:"volatility"`
	Momentum   Momentum   `json:"momentum"`
	Warnings   []string   `json:"warnings"`
}

// Supertrend contains adaptive ATR bands and their directional state. The
// PerformanceIndex is a ratio of recent signed changes to smoothed absolute
// changes, never a win probability. It is null if the denominator is zero.
// Initializing the first usable state does not constitute a trend flip.
type Supertrend struct {
	Direction        string   `json:"direction"`
	ATR              *float64 `json:"atr"`
	Stop             *float64 `json:"stop"`
	Factor           *float64 `json:"factor"`
	PerformanceIndex *float64 `json:"performanceIndex"`
	LastFlipAt       *int64   `json:"lastFlipAt"`
	BarsSinceFlip    *int     `json:"barsSinceFlip"`
	WarmupBars       int      `json:"warmupBars"`
	Ready            bool     `json:"ready"`
}

type Volatility struct {
	ATR        *float64 `json:"atr"`
	ATRPercent *float64 `json:"atrPercent"`
	Length     int      `json:"length"`
	Ready      bool     `json:"ready"`
}

// Momentum.Direction is neutral unless ADX is strictly greater than the
// configured threshold and one directional index is strictly greater than the
// other. ATR and DI/ADX use Wilder smoothing with explicit arithmetic seeds.
type Momentum struct {
	ADX          *float64 `json:"adx"`
	DIPlus       *float64 `json:"diPlus"`
	DIMinus      *float64 `json:"diMinus"`
	ADXThreshold float64  `json:"adxThreshold"`
	Direction    string   `json:"direction"`
	DILength     int      `json:"diLength"`
	ADXSmoothing int      `json:"adxSmoothing"`
	WarmupBars   int      `json:"warmupBars"`
	Ready        bool     `json:"ready"`
}

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func number(v float64) *float64 {
	if !finite(v) {
		return nil
	}
	return &v
}

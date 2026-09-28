// Adaptive SuperTrend derived from SuperTrend AI (Clustering), © LuxAlgo,
// CC BY-NC-SA 4.0. https://creativecommons.org/licenses/by-nc-sa/4.0/
package regime

import (
	"fmt"
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

type trendCandidate struct {
	upper, lower float64
	output       float64
	performance  float64
	factor       float64
	bullish      bool
}

// Analyze replays the entire supplied prefix. It assumes every supplied bar is
// closed; Candle has no finality bit and this pure package cannot consult time
// to establish finality. Invalid configuration or malformed/discontinuous bars
// return unavailable evidence with warnings, never a partial indicator state.
func Analyze(candles []market.Candle, cfg Config) Snapshot {
	out := Snapshot{
		Direction: Unavailable, ClosedBars: len(candles), Warnings: []string{},
		Supertrend: Supertrend{Direction: Unavailable},
		Momentum:   Momentum{Direction: Unavailable},
	}
	if err := cfg.Validate(); err != nil {
		out.Warnings = append(out.Warnings, "invalid regime configuration: "+err.Error())
		return out
	}
	out.Supertrend.WarmupBars = cfg.SupertrendATRLength
	out.Volatility.Length = cfg.ATRLength
	out.Momentum.DILength = cfg.DILength
	out.Momentum.ADXSmoothing = cfg.ADXSmoothing
	out.Momentum.ADXThreshold = cfg.ADXThreshold
	// The first candle has no directional movement observation. DI needs
	// DILength subsequent observations, then ADX needs ADXSmoothing DX values.
	out.Momentum.WarmupBars = cfg.DILength + cfg.ADXSmoothing
	out.WarmupBars = max(cfg.SupertrendATRLength, cfg.ATRLength, out.Momentum.WarmupBars)
	if len(candles) == 0 {
		out.Warnings = append(out.Warnings, "no closed candles supplied")
		return out
	}
	for i, c := range candles {
		if !c.Valid() {
			out.Warnings = append(out.Warnings, fmt.Sprintf("invalid candle at index %d", i))
			return out
		}
		if i > 0 && c.OpenTime != candles[i-1].CloseTime+1 {
			out.Warnings = append(out.Warnings, fmt.Sprintf("candle gap, overlap or ordering error at index %d", i))
			return out
		}
	}
	closedAt := candles[len(candles)-1].CloseTime
	out.ClosedAt = &closedAt
	atrTrend := wilder{length: cfg.SupertrendATRLength}
	atrRisk := wilder{length: cfg.ATRLength}
	trDI := wilder{length: cfg.DILength}
	plusDM := wilder{length: cfg.DILength}
	minusDM := wilder{length: cfg.DILength}
	adx := wilder{length: cfg.ADXSmoothing}
	denominator := ema{alpha: 2 / float64(int(cfg.PerformanceMemory)+1)}
	alpha := 2 / (cfg.PerformanceMemory + 1)
	firstMid := candles[0].High/2 + candles[0].Low/2
	candidates := make([]trendCandidate, int(math.Floor((cfg.MaxFactor-cfg.MinFactor)/cfg.FactorStep))+1)
	for i := range candidates {
		candidates[i] = trendCandidate{
			upper: firstMid, lower: firstMid, output: math.NaN(),
			factor: cfg.MinFactor + float64(i)*cfg.FactorStep,
		}
	}
	upper, lower := firstMid, firstMid
	bullish, initialized := false, false
	lastFlip := -1
	clusterLimits := 0
	var selected clusterResult
	var selectedStop float64
	var diPlus, diMinus float64
	for i, candle := range candles {
		previousClose := math.NaN()
		change := 0.0
		tr := candle.High - candle.Low
		if i > 0 {
			previous := candles[i-1]
			previousClose = previous.Close
			change = candle.Close - previousClose
			tr = math.Max(tr, math.Max(math.Abs(candle.High-previousClose), math.Abs(candle.Low-previousClose)))
			denominator.add(math.Abs(change))
			up, down := candle.High-previous.High, previous.Low-candle.Low
			plus, minus := 0.0, 0.0
			if up > down && up > 0 {
				plus = up
			}
			if down > up && down > 0 {
				minus = down
			}
			trDI.add(tr)
			plusDM.add(plus)
			minusDM.add(minus)
			if trDI.ready() {
				diPlus, diMinus = 0, 0
				if trDI.value > 0 {
					diPlus = 100 * (plusDM.value / trDI.value)
					diMinus = 100 * (minusDM.value / trDI.value)
				}
				dx := 0.0
				if sum := diPlus + diMinus; sum > 0 {
					dx = 100 * (math.Abs(diPlus-diMinus) / sum)
				}
				adx.add(dx)
			}
		}
		atrTrend.add(tr)
		atrRisk.add(tr)
		atr := math.NaN()
		if atrTrend.ready() {
			atr = atrTrend.value
		}
		mid := candle.High/2 + candle.Low/2
		for j := range candidates {
			candidate := &candidates[j]
			// The source's candidates compare price with PREVIOUS bands,
			// whereas the selected trend below compares with updated bands.
			if candle.Close > candidate.upper {
				candidate.bullish = true
			} else if candle.Close < candidate.lower {
				candidate.bullish = false
			}
			candidate.upper, candidate.lower = bands(mid, atr, candidate.factor, previousClose, candidate.upper, candidate.lower)
			sign := 0.0
			if previousClose > candidate.output {
				sign = 1
			} else if previousClose < candidate.output {
				sign = -1
			}
			candidate.performance = (1-alpha)*candidate.performance + alpha*(change*sign)
			candidate.output = candidate.upper
			if candidate.bullish {
				candidate.output = candidate.lower
			}
			if atrTrend.ready() && (!finite(candidate.upper) || !finite(candidate.lower) || !finite(candidate.performance)) {
				return arithmeticFailure(out)
			}
		}
		selected = clusterBest(candidates, cfg.MaxClusterIterations)
		if selected.iterationLimit {
			clusterLimits++
		}
		upper, lower = bands(mid, atr, selected.factor, previousClose, upper, lower)
		previousBullish := bullish
		if candle.Close > upper {
			bullish = true
		} else if candle.Close < lower {
			bullish = false
		}
		if atrTrend.ready() {
			if initialized && bullish != previousBullish {
				lastFlip = i
			}
			initialized = true
		}
		selectedStop = upper
		if bullish {
			selectedStop = lower
		}
	}
	if atrTrend.ready() {
		out.Supertrend.Ready = true
		out.Supertrend.ATR = number(atrTrend.value)
		out.Supertrend.Stop = number(selectedStop)
		out.Supertrend.Factor = number(selected.factor)
		out.Supertrend.Direction = Bearish
		if bullish {
			out.Supertrend.Direction = Bullish
		}
		if atrTrend.value == 0 {
			out.Supertrend.Direction = Neutral
		}
		if denominator.ready && denominator.value > 0 {
			out.Supertrend.PerformanceIndex = number(math.Max(selected.performance, 0) / denominator.value)
		} else {
			out.Warnings = append(out.Warnings, "supertrend performance index unavailable: smoothed absolute price change is zero")
		}
		if lastFlip >= 0 {
			timestamp := candles[lastFlip].CloseTime
			age := len(candles) - 1 - lastFlip
			out.Supertrend.LastFlipAt, out.Supertrend.BarsSinceFlip = &timestamp, &age
		}
		out.Direction = out.Supertrend.Direction
		if selected.bestWasEmpty {
			out.Warnings = append(out.Warnings, "supertrend best cluster empty: using the highest-scoring non-empty cluster")
		}
	}
	if atrRisk.ready() {
		out.Volatility.ATR = number(atrRisk.value)
		out.Volatility.ATRPercent = number(100 * (atrRisk.value / candles[len(candles)-1].Close))
		out.Volatility.Ready = out.Volatility.ATRPercent != nil
		if !out.Volatility.Ready {
			out.Warnings = append(out.Warnings, "ATR percentage is outside the finite numeric range")
		}
	}
	if trDI.ready() {
		out.Momentum.DIPlus = number(diPlus)
		out.Momentum.DIMinus = number(diMinus)
	}
	if adx.ready() {
		out.Momentum.ADX = number(adx.value)
		out.Momentum.Ready = true
		out.Momentum.Direction = Neutral
		if adx.value > cfg.ADXThreshold {
			if diPlus > diMinus {
				out.Momentum.Direction = Bullish
			} else if diMinus > diPlus {
				out.Momentum.Direction = Bearish
			}
		}
	}
	if clusterLimits > 0 {
		out.Warnings = append(out.Warnings, fmt.Sprintf("supertrend clustering reached its iteration limit on %d candle(s)", clusterLimits))
	}
	if len(candles) < out.WarmupBars {
		out.Warnings = append(out.Warnings, fmt.Sprintf("indicator warm-up needs %d closed candles; received %d", out.WarmupBars, len(candles)))
	}
	out.Ready = out.Supertrend.Ready && out.Volatility.Ready && out.Momentum.Ready
	return out
}

func bands(mid, atr, factor, previousClose, previousUpper, previousLower float64) (float64, float64) {
	upper, lower := mid+atr*factor, mid-atr*factor
	if previousClose < previousUpper {
		upper = math.Min(upper, previousUpper)
	}
	if previousClose > previousLower {
		lower = math.Max(lower, previousLower)
	}
	return upper, lower
}

func arithmeticFailure(out Snapshot) Snapshot {
	out.Warnings = append(out.Warnings, "indicator arithmetic exceeded the finite numeric range")
	return out
}

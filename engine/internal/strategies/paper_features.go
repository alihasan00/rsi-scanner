package strategies

// Completed-candle Signal Forge states, translated from the audited local
// research implementation. Defaults and selection derive from Signal Forge
// [LuxAlgo], © LuxAlgo, CC BY-NC-SA 4.0:
// https://creativecommons.org/licenses/by-nc-sa/4.0/
// Indicators use complete contiguous history and reset at quote gaps. This
// implementation does not claim TradingView numeric parity.

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

// PaperFeatures holds directional indicator states at one completed source
// candle. Zero means the state is unavailable or neutral.
type PaperFeatures struct {
	EMA        int8
	SMA        int8
	MACD       int8
	Stoch      int8
	RSI        int8
	Supertrend int8
	AO         int8
	ADXRange   bool
}

func paperFinite(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}

func paperDirection(a, b float64) int8 {
	if !paperFinite(a) || !paperFinite(b) {
		return 0
	}
	if a > b {
		return 1
	}
	if a < b {
		return -1
	}
	return 0
}

// paperPreciseSum matches the source's Python math.fsum-style partial summation,
// including its final half-even correction. Seed rounding can change a state
// when an indicator sits exactly on a directional threshold.
func paperPreciseSum(values []float64) float64 {
	partials := make([]float64, 0, len(values))
	for _, value := range values {
		x := value
		i := 0
		for j := 0; j < len(partials); j++ {
			y := partials[j]
			if math.Abs(x) < math.Abs(y) {
				x, y = y, x
			}
			high := x + y
			low := y - (high - x)
			if low != 0 {
				partials[i] = low
				i++
			}
			x = high
		}
		partials = partials[:i]
		if x != 0 {
			partials = append(partials, x)
		}
	}
	high, low := 0.0, 0.0
	n := len(partials)
	if n > 0 {
		n--
		high = partials[n]
		for n > 0 {
			x := high
			n--
			y := partials[n]
			high = x + y
			low = y - (high - x)
			if low != 0 {
				break
			}
		}
		if n > 0 && (low < 0 && partials[n-1] < 0 || low > 0 && partials[n-1] > 0) {
			y := low * 2
			x := high + y
			if y == x-high {
				high = x
			}
		}
	}
	return high
}

func paperSMA(values []float64, length int) []float64 {
	window := make([]float64, 0, length)
	result := make([]float64, len(values))
	for i, value := range values {
		if paperFinite(value) {
			window = append(window, value)
			if len(window) > length {
				window = window[1:]
			}
		}
		result[i] = math.NaN()
		if len(window) == length {
			result[i] = paperPreciseSum(window) / float64(length)
		}
	}
	return result
}

func paperEMA(values []float64, length int) []float64 {
	alpha := 2.0 / float64(length+1)
	previous := math.NaN()
	result := make([]float64, len(values))
	for i, value := range values {
		if paperFinite(value) {
			if paperFinite(previous) {
				previous = alpha*value + (1-alpha)*previous
			} else {
				previous = value
			}
		}
		result[i] = previous
	}
	return result
}

func paperRMA(values []float64, length int) []float64 {
	alpha := 1.0 / float64(length)
	previous := math.NaN()
	seed := make([]float64, 0, length)
	result := make([]float64, len(values))
	for i, value := range values {
		if paperFinite(value) {
			if paperFinite(previous) {
				previous = alpha*value + (1-alpha)*previous
			} else {
				seed = append(seed, value)
				if len(seed) == length {
					previous = paperPreciseSum(seed) / float64(length)
				}
			}
		}
		result[i] = previous
	}
	return result
}

func paperFeatureSegment(bars []market.Candle) []PaperFeatures {
	n := len(bars)
	if n == 0 {
		return nil
	}
	close := make([]float64, n)
	middle := make([]float64, n)
	tr := make([]float64, n)
	gains := make([]float64, n)
	losses := make([]float64, n)
	plus := make([]float64, n)
	minus := make([]float64, n)
	for i, bar := range bars {
		close[i] = bar.Close
		middle[i] = (bar.High + bar.Low) / 2
		tr[i] = bar.High - bar.Low
		gains[i], losses[i], plus[i], minus[i] = math.NaN(), math.NaN(), math.NaN(), math.NaN()
	}
	ema10, ema20 := paperEMA(close, 10), paperEMA(close, 20)
	sma10, sma20 := paperSMA(close, 10), paperSMA(close, 20)
	ema12, ema26 := paperEMA(close, 12), paperEMA(close, 26)
	macd := make([]float64, n)
	for i := range macd {
		macd[i] = ema12[i] - ema26[i]
	}
	macdSignal := paperEMA(macd, 9)
	middle5, middle34 := paperSMA(middle, 5), paperSMA(middle, 34)
	for i := 1; i < n; i++ {
		change := close[i] - close[i-1]
		gains[i] = math.Max(change, 0)
		losses[i] = math.Max(-change, 0)
		tr[i] = math.Max(tr[i], math.Abs(bars[i].High-close[i-1]))
		tr[i] = math.Max(tr[i], math.Abs(bars[i].Low-close[i-1]))
		up := bars[i].High - bars[i-1].High
		down := bars[i-1].Low - bars[i].Low
		plus[i], minus[i] = 0, 0
		if up > down && up > 0 {
			plus[i] = up
		}
		if down > up && down > 0 {
			minus[i] = down
		}
	}
	gain, loss := paperRMA(gains, 14), paperRMA(losses, 14)
	atr10 := paperRMA(tr, 10)
	tr[0] = math.NaN()
	dmiTR := paperRMA(tr, 14)
	plusRMA, minusRMA := paperRMA(plus, 14), paperRMA(minus, 14)
	dx := make([]float64, n)
	previousPlus, previousMinus := math.NaN(), math.NaN()
	for i := range dx {
		dx[i] = math.NaN()
		if dmiTR[i] > 0 && paperFinite(plusRMA[i]) {
			previousPlus = 100 * plusRMA[i] / dmiTR[i]
			previousMinus = 100 * minusRMA[i] / dmiTR[i]
		}
		if paperFinite(previousPlus) && paperFinite(previousMinus) {
			total := previousPlus + previousMinus
			denominator := 1.0
			if total != 0 {
				denominator = total
			}
			dx[i] = math.Abs(previousPlus-previousMinus) / denominator
		}
	}
	adx := paperRMA(dx, 14)
	rawK := make([]float64, n)
	for i := range rawK {
		start := max(0, i+1-14)
		high, low := math.Inf(-1), math.Inf(1)
		for j := start; j <= i; j++ {
			high = math.Max(high, bars[j].High)
			low = math.Min(low, bars[j].Low)
		}
		rawK[i] = math.NaN()
		if high > low {
			rawK[i] = 100 * (close[i] - low) / (high - low)
		}
	}
	stoch := paperSMA(rawK, 3)
	oldUpper, oldLower, oldLine := math.NaN(), math.NaN(), math.NaN()
	result := make([]PaperFeatures, n)
	for i := range result {
		upper := middle[i] + 3*atr10[i]
		lower := middle[i] - 3*atr10[i]
		previousUpper, previousLower := oldUpper, oldLower
		if !paperFinite(previousUpper) {
			previousUpper = 0
		}
		if !paperFinite(previousLower) {
			previousLower = 0
		}
		if !(upper < previousUpper || i > 0 && close[i-1] > previousUpper) {
			upper = previousUpper
		}
		if !(lower > previousLower || i > 0 && close[i-1] < previousLower) {
			lower = previousLower
		}
		stDirection := int8(1)
		if i == 0 || !paperFinite(atr10[i-1]) {
			stDirection = 1
		} else if oldLine == previousUpper {
			if close[i] > upper {
				stDirection = -1
			}
		} else if close[i] < lower {
			stDirection = 1
		} else {
			stDirection = -1
		}
		line := upper
		if stDirection == -1 {
			line = lower
		}
		oldUpper, oldLower, oldLine = upper, lower, line
		u, d := gain[i], loss[i]
		rsi := math.NaN()
		if d == 0 && u > 0 {
			rsi = 100
		} else if u == 0 && d > 0 {
			rsi = 0
		} else if d > 0 {
			rsi = 100 - 100/(1+u/d)
		}
		feature := PaperFeatures{
			EMA:      paperDirection(ema10[i], ema20[i]),
			SMA:      paperDirection(sma10[i], sma20[i]),
			MACD:     paperDirection(macd[i], macdSignal[i]),
			Stoch:    paperDirection(stoch[i], 50),
			RSI:      paperDirection(rsi, 50),
			AO:       paperDirection(middle5[i], middle34[i]),
			ADXRange: paperFinite(adx[i]) && 100*adx[i] <= 20,
		}
		if paperFinite(line) && paperFinite(atr10[i]) {
			feature.Supertrend = -stDirection
		}
		result[i] = feature
	}
	return result
}

// paperSourceFeatures evaluates every completed candle using only that
// candle's contiguous source prefix. A real quote gap starts a fresh segment.
func paperSourceFeatures(bars []market.Candle) []PaperFeatures {
	result := make([]PaperFeatures, 0, len(bars))
	start := 0
	for i := 1; i <= len(bars); i++ {
		if i == len(bars) || bars[i-1].CloseTime+1 != bars[i].OpenTime {
			result = append(result, paperFeatureSegment(bars[start:i])...)
			start = i
		}
	}
	return result
}

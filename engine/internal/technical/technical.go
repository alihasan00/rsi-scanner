// Package technical describes completed-candle moving-average and volatility
// context. The SMA 10/20 defaults follow Signal Forge [LuxAlgo], CC BY-NC-SA
// 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/); Bollinger compression
// statistics are independent informational features.
// Neither agreement nor a percentile is a trading signal or win probability.
package technical

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

const (
	FastLength          = 10
	SlowLength          = 20
	BandLength          = 20
	BandMultiplier      = 2.0
	PercentileLookback  = 100
	WidthChangeLookback = 3
)

// Snapshot.Status is ready when all history requirements have been met. Each
// nested field reports its own availability before that point. The caller must
// supply completed candles; Analyze never reads a clock or provisional data.
type Snapshot struct {
	Status    string           `json:"status"`
	AsOf      *int64           `json:"asOf"`
	Bars      int              `json:"bars"`
	SMA       SMAContext       `json:"sma"`
	Bollinger BollingerContext `json:"bollinger"`
}

type SMAContext struct {
	Status             string   `json:"status"`
	FastLength         int      `json:"fastLength"`
	SlowLength         int      `json:"slowLength"`
	WarmupBars         int      `json:"warmupBars"`
	Fast               *float64 `json:"fast"`
	Slow               *float64 `json:"slow"`
	Direction          string   `json:"direction"`
	SeparationPercent  *float64 `json:"separationPercent"`
	LastCrossDirection string   `json:"lastCrossDirection"`
	LastCrossAt        *int64   `json:"lastCrossAt"`
	BarsSinceCross     *int     `json:"barsSinceCross"`
}

type BollingerContext struct {
	Status                  string   `json:"status"`
	Length                  int      `json:"length"`
	Multiplier              float64  `json:"multiplier"`
	WarmupBars              int      `json:"warmupBars"`
	Middle                  *float64 `json:"middle"`
	Upper                   *float64 `json:"upper"`
	Lower                   *float64 `json:"lower"`
	BandWidthPercent        *float64 `json:"bandWidthPercent"`
	PercentBStatus          string   `json:"percentBStatus"`
	PercentB                *float64 `json:"percentB"`
	WidthPercentileStatus   string   `json:"widthPercentileStatus"`
	WidthPercentile         *float64 `json:"widthPercentile"`
	PercentileLookbackBars  int      `json:"percentileLookbackBars"`
	PercentileObservations  int      `json:"percentileObservations"`
	PercentileWarmupBars    int      `json:"percentileWarmupBars"`
	WidthChangeStatus       string   `json:"widthChangeStatus"`
	WidthChange3Bars        *float64 `json:"widthChange3Bars"`
	WidthChangeLookbackBars int      `json:"widthChangeLookbackBars"`
	WidthChangeWarmupBars   int      `json:"widthChangeWarmupBars"`
}

func initial(bars int, status string) Snapshot {
	return Snapshot{Status: status, Bars: bars,
		SMA: SMAContext{Status: status, FastLength: FastLength, SlowLength: SlowLength, WarmupBars: SlowLength, Direction: "unavailable", LastCrossDirection: "unavailable"},
		Bollinger: BollingerContext{Status: status, Length: BandLength, Multiplier: BandMultiplier, WarmupBars: BandLength, PercentBStatus: status,
			WidthPercentileStatus: status, PercentileLookbackBars: PercentileLookback, PercentileWarmupBars: BandLength + PercentileLookback - 1,
			WidthChangeStatus: status, WidthChangeLookbackBars: WidthChangeLookback, WidthChangeWarmupBars: BandLength + WidthChangeLookback}}
}

// Analyze uses close prices. SMA separation is (fast-slow)/slow*100. A cross
// requires two fully seeded observations: fast>slow following fast<=slow is
// bullish, and fast<slow following fast>=slow is bearish. Initial direction is
// not a cross. Its age counts completed bars since the confirming candle.
//
// Bands use population standard deviation, matching ta.bb's default convention.
// Band width is (upper-lower)/middle*100 and percentB is (close-lower)/(upper-lower).
// PercentB is unavailable for zero-width bands. WidthChange3Bars is the current
// band-width percentage minus its value three completed bars earlier, expressed
// in percentage points (not relative percent change).
//
// The width percentile uses the latest 100 fully seeded width observations,
// including the current observation. Exact ties use midrank:
// 100*(count(width<current)+0.5*count(width==current))/100. A fully flat reference
// window therefore has percentile 50. No missing observations are skipped.
func Analyze(candles []market.Candle) Snapshot {
	s := initial(len(candles), "insufficient")
	if len(candles) == 0 {
		return s
	}
	if !validHistory(candles) {
		return initial(len(candles), "invalid")
	}
	s.AsOf = pointer(candles[len(candles)-1].CloseTime)
	var previousFast, previousSlow float64
	lastCrossIndex := -1
	widths := make([]float64, 0, max(0, len(candles)-BandLength+1))
	for i := range candles {
		if i+1 < FastLength {
			continue
		}
		fast := meanClose(candles[i+1-FastLength : i+1])
		if !finite(fast) || fast <= 0 {
			return initial(len(candles), "invalid")
		}
		s.SMA.Fast = pointer(fast)
		if i+1 < SlowLength {
			continue
		}
		slow := meanClose(candles[i+1-SlowLength : i+1])
		separation := ((fast - slow) / slow) * 100
		if !finite(slow) || slow <= 0 || !finite(separation) {
			return initial(len(candles), "invalid")
		}
		s.SMA.Status, s.SMA.Slow, s.SMA.SeparationPercent = "ready", pointer(slow), pointer(separation)
		s.SMA.Direction = "neutral"
		if fast > slow {
			s.SMA.Direction = "bullish"
		} else if fast < slow {
			s.SMA.Direction = "bearish"
		}
		if i+1 > SlowLength && (fast > slow && previousFast <= previousSlow || fast < slow && previousFast >= previousSlow) {
			s.SMA.LastCrossDirection, s.SMA.LastCrossAt = s.SMA.Direction, pointer(candles[i].CloseTime)
			lastCrossIndex = i
		}
		previousFast, previousSlow = fast, slow
		middle, upper, lower, width, percentB, ok := bands(candles[i+1-BandLength : i+1])
		if !ok {
			return initial(len(candles), "invalid")
		}
		s.Bollinger.Status = "ready"
		s.Bollinger.Middle, s.Bollinger.Upper, s.Bollinger.Lower = pointer(middle), pointer(upper), pointer(lower)
		s.Bollinger.BandWidthPercent, s.Bollinger.PercentB = pointer(width), percentB
		s.Bollinger.PercentBStatus = "ready"
		if percentB == nil {
			s.Bollinger.PercentBStatus = "zero_width"
		}
		widths = append(widths, width)
	}
	if lastCrossIndex >= 0 {
		s.SMA.BarsSinceCross = pointer(len(candles) - 1 - lastCrossIndex)
	}
	s.Bollinger.PercentileObservations = min(len(widths), PercentileLookback)
	if len(widths) > WidthChangeLookback {
		change := widths[len(widths)-1] - widths[len(widths)-1-WidthChangeLookback]
		s.Bollinger.WidthChangeStatus, s.Bollinger.WidthChange3Bars = "ready", pointer(change)
	}
	if len(widths) >= PercentileLookback {
		current := widths[len(widths)-1]
		less, equal := 0, 0
		for _, width := range widths[len(widths)-PercentileLookback:] {
			if width < current {
				less++
			} else if width == current {
				equal++
			}
		}
		percentile := 100 * (float64(less) + 0.5*float64(equal)) / PercentileLookback
		s.Bollinger.WidthPercentileStatus, s.Bollinger.WidthPercentile = "ready", pointer(percentile)
		s.Status = "ready"
	}
	return s
}

func validHistory(candles []market.Candle) bool {
	for i, candle := range candles {
		if !candle.Valid() || !market.SameInterval(candles[0], candle) || i > 0 && candle.OpenTime != candles[i-1].CloseTime+1 {
			return false
		}
	}
	return true
}

func meanClose(candles []market.Candle) float64 {
	mean := 0.0
	for i, candle := range candles {
		mean += (candle.Close - mean) / float64(i+1)
	}
	return mean
}

func bands(candles []market.Candle) (middle, upper, lower, width float64, percentB *float64, ok bool) {
	scale := 0.0
	for _, candle := range candles {
		scale = math.Max(scale, candle.Close)
	}
	// Normalizing before squaring prevents finite prices from overflowing the
	// variance calculation. The price outputs still must be representable.
	mean := 0.0
	for i, candle := range candles {
		mean += (candle.Close/scale - mean) / float64(i+1)
	}
	variance := 0.0
	for _, candle := range candles {
		difference := candle.Close/scale - mean
		variance += difference * difference / float64(len(candles))
	}
	deviation := BandMultiplier * math.Sqrt(variance)
	middle, upper, lower = mean*scale, (mean+deviation)*scale, (mean-deviation)*scale
	width = 2 * deviation / mean * 100
	if !finite(middle) || middle <= 0 || !finite(upper) || !finite(lower) || !finite(width) {
		return 0, 0, 0, 0, nil, false
	}
	if upper == lower {
		// Extremely small representable prices can round both bands to the
		// same value even when normalized variance is nonzero. The published
		// price interval has zero width and cannot define percentB.
		return middle, upper, lower, 0, nil, true
	}
	if deviation > 0 {
		value := (candles[len(candles)-1].Close/scale - (mean - deviation)) / (2 * deviation)
		if !finite(value) {
			return 0, 0, 0, 0, nil, false
		}
		percentB = pointer(value)
	}
	return middle, upper, lower, width, percentB, true
}

func finite(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) }
func pointer[T any](value T) *T { return &value }
func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return pointer(*value)
}

// CloneSnapshot gives a published snapshot independent ownership of every
// nullable field; callers may safely retain or adapt the clone.
func CloneSnapshot(s Snapshot) Snapshot {
	s.AsOf = clonePointer(s.AsOf)
	s.SMA.Fast, s.SMA.Slow = clonePointer(s.SMA.Fast), clonePointer(s.SMA.Slow)
	s.SMA.SeparationPercent = clonePointer(s.SMA.SeparationPercent)
	s.SMA.LastCrossAt, s.SMA.BarsSinceCross = clonePointer(s.SMA.LastCrossAt), clonePointer(s.SMA.BarsSinceCross)
	s.Bollinger.Middle, s.Bollinger.Upper, s.Bollinger.Lower = clonePointer(s.Bollinger.Middle), clonePointer(s.Bollinger.Upper), clonePointer(s.Bollinger.Lower)
	s.Bollinger.BandWidthPercent, s.Bollinger.PercentB = clonePointer(s.Bollinger.BandWidthPercent), clonePointer(s.Bollinger.PercentB)
	s.Bollinger.WidthPercentile, s.Bollinger.WidthChange3Bars = clonePointer(s.Bollinger.WidthPercentile), clonePointer(s.Bollinger.WidthChange3Bars)
	return s
}

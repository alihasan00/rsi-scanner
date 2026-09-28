// Package ichimoku measures completed-candle range-midpoint context. The
// 20/60/120 lookbacks follow the supplied Ichimoku lecture. DisplacementBars is
// an actual 30-bar forward display offset; exact chart-input parity is not
// claimed. These observations are not independent confirmations or trade rules.
package ichimoku

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

const (
	TenkanLength     = 20
	KijunLength      = 60
	SpanBLength      = 120
	DisplacementBars = 30
	CloudWarmupBars  = SpanBLength + DisplacementBars
)

// Snapshot reports independent Kijun and current displayed-cloud availability.
// Status becomes ready once both have their required history. Missing or zero
// ATR only withholds normalized Kijun distance, not the underlying observations.
// Every timestamp is an inclusive completed-candle close in Unix milliseconds.
type Snapshot struct {
	Status           string       `json:"status"`
	AsOf             *int64       `json:"asOf"`
	Bars             int          `json:"bars"`
	TenkanLength     int          `json:"tenkanLength"`
	KijunLength      int          `json:"kijunLength"`
	SpanBLength      int          `json:"spanBLength"`
	DisplacementBars int          `json:"displacementBars"`
	Kijun            KijunContext `json:"kijun"`
	Cloud            CloudContext `json:"cloud"`
}

// KijunContext.Value is the midpoint of the highest high and lowest low across
// the latest 60 candles. DistanceATR is signed (latest close - Value) / ATR.
// Slope compares the current midpoint with the immediately previous midpoint;
// Change1Bar is that raw price change, without fitting a trend or threshold.
//
// FlatBars counts consecutive unchanged one-bar transitions, excluding the first
// midpoint observation itself. It is unavailable without two seeded midpoints.
// FlatHistoryBounded is true when all available transitions are unchanged: the
// count is then a lower bound and the actual flat run could have started before
// the supplied history. Exact floating-point equality defines unchanged.
type KijunContext struct {
	Status             string   `json:"status"`
	WarmupBars         int      `json:"warmupBars"`
	Value              *float64 `json:"value"`
	DistanceATRStatus  string   `json:"distanceATRStatus"`
	DistanceATR        *float64 `json:"distanceATR"`
	SlopeStatus        string   `json:"slopeStatus"`
	Slope              string   `json:"slope"`
	Change1Bar         *float64 `json:"change1Bar"`
	FlatBars           *int     `json:"flatBars"`
	FlatHistoryBounded bool     `json:"flatHistoryBounded"`
}

// CloudContext contains only the cloud displayed at the latest supplied
// candle. Its spans were calculated 30 completed bars earlier, at CalculatedAt;
// DisplayedAt is the current candle's close. Span A is the mean of that older
// candle's 20- and 60-bar midpoints, and Span B is its 120-bar midpoint.
// Current close equal to either boundary is inside, including a zero-width
// cloud. A forward display offset does not incorporate future prices.
type CloudContext struct {
	Status       string   `json:"status"`
	WarmupBars   int      `json:"warmupBars"`
	SpanA        *float64 `json:"spanA"`
	SpanB        *float64 `json:"spanB"`
	Lower        *float64 `json:"lower"`
	Upper        *float64 `json:"upper"`
	Position     string   `json:"position"`
	CalculatedAt *int64   `json:"calculatedAt"`
	DisplayedAt  *int64   `json:"displayedAt"`
}

func initial(bars int, status string) Snapshot {
	return Snapshot{
		Status: status, Bars: bars, TenkanLength: TenkanLength,
		KijunLength: KijunLength, SpanBLength: SpanBLength, DisplacementBars: DisplacementBars,
		Kijun: KijunContext{Status: status, WarmupBars: KijunLength,
			DistanceATRStatus: status, SlopeStatus: status, Slope: "unavailable"},
		Cloud: CloudContext{Status: status, WarmupBars: CloudWarmupBars, Position: "unavailable"},
	}
}

// Analyze uses only its supplied history, without reading a clock or modifying
// candles. Callers must supply completed contiguous candles and, when available,
// the latest completed same-timeframe ATR. Invalid candles, gaps, overlaps and
// changing durations withhold all observations. Each midpoint requires its
// complete window; no partial windows or future projected spans are published.
func Analyze(candles []market.Candle, atr *float64) Snapshot {
	s := initial(len(candles), "insufficient")
	if len(candles) == 0 {
		return s
	}
	if !validHistory(candles) {
		return initial(len(candles), "invalid")
	}
	last := len(candles) - 1
	s.AsOf = pointer(candles[last].CloseTime)
	if len(candles) >= KijunLength {
		value := midpoint(candles[last+1-KijunLength : last+1])
		s.Kijun.Status, s.Kijun.Value = "ready", pointer(value)
		s.Kijun.DistanceATRStatus, s.Kijun.DistanceATR = normalizedDistance(candles[last].Close-value, atr)
		if len(candles) > KijunLength {
			previous := midpoint(candles[last-KijunLength : last])
			change := value - previous
			s.Kijun.SlopeStatus, s.Kijun.Change1Bar = "ready", pointer(change)
			s.Kijun.Slope = "flat"
			if change > 0 {
				s.Kijun.Slope = "rising"
			} else if change < 0 {
				s.Kijun.Slope = "falling"
			}
			flatBars := 0
			for i := last - 1; i >= KijunLength-1; i-- {
				if midpoint(candles[i+1-KijunLength:i+1]) != value {
					break
				}
				flatBars++
			}
			s.Kijun.FlatBars = pointer(flatBars)
			s.Kijun.FlatHistoryBounded = flatBars == len(candles)-KijunLength
		}
	}
	if len(candles) >= CloudWarmupBars {
		calculatedIndex := last - DisplacementBars
		tenkan := midpoint(candles[calculatedIndex+1-TenkanLength : calculatedIndex+1])
		kijun := midpoint(candles[calculatedIndex+1-KijunLength : calculatedIndex+1])
		spanA := average(tenkan, kijun)
		spanB := midpoint(candles[calculatedIndex+1-SpanBLength : calculatedIndex+1])
		lower, upper := math.Min(spanA, spanB), math.Max(spanA, spanB)
		s.Cloud.Status = "ready"
		s.Cloud.SpanA, s.Cloud.SpanB = pointer(spanA), pointer(spanB)
		s.Cloud.Lower, s.Cloud.Upper = pointer(lower), pointer(upper)
		s.Cloud.CalculatedAt = pointer(candles[calculatedIndex].CloseTime)
		s.Cloud.DisplayedAt = pointer(candles[last].CloseTime)
		s.Cloud.Position = "inside"
		if candles[last].Close > upper {
			s.Cloud.Position = "above"
		} else if candles[last].Close < lower {
			s.Cloud.Position = "below"
		}
		s.Status = "ready"
	}
	return s
}

func validHistory(candles []market.Candle) bool {
	duration := candles[0].CloseTime - candles[0].OpenTime + 1
	for i, candle := range candles {
		if !candle.Valid() || candle.CloseTime-candle.OpenTime+1 != duration ||
			i > 0 && candle.OpenTime != candles[i-1].CloseTime+1 {
			return false
		}
	}
	return true
}

func midpoint(candles []market.Candle) float64 {
	low, high := candles[0].Low, candles[0].High
	for _, candle := range candles[1:] {
		low, high = math.Min(low, candle.Low), math.Max(high, candle.High)
	}
	return average(low, high)
}

func average(a, b float64) float64 {
	// Prices are positive finite numbers. This order avoids overflowing a+b
	// and preserves a positive midpoint even for subnormal inputs.
	low, high := math.Min(a, b), math.Max(a, b)
	return low + (high-low)/2
}

func normalizedDistance(distance float64, atr *float64) (string, *float64) {
	if atr == nil {
		return "missing_atr", nil
	}
	if math.IsNaN(*atr) || math.IsInf(*atr, 0) || *atr < 0 {
		return "invalid_atr", nil
	}
	if *atr == 0 {
		return "zero_atr", nil
	}
	normalized := distance / *atr
	if math.IsNaN(normalized) || math.IsInf(normalized, 0) {
		return "unrepresentable", nil
	}
	return "ready", pointer(normalized)
}

func pointer[T any](value T) *T { return &value }

func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return pointer(*value)
}

// CloneSnapshot gives the returned value independent ownership of every
// nullable field, including timestamps even when their numeric values match.
func CloneSnapshot(s Snapshot) Snapshot {
	s.AsOf = clonePointer(s.AsOf)
	s.Kijun.Value = clonePointer(s.Kijun.Value)
	s.Kijun.DistanceATR = clonePointer(s.Kijun.DistanceATR)
	s.Kijun.Change1Bar = clonePointer(s.Kijun.Change1Bar)
	s.Kijun.FlatBars = clonePointer(s.Kijun.FlatBars)
	s.Cloud.SpanA, s.Cloud.SpanB = clonePointer(s.Cloud.SpanA), clonePointer(s.Cloud.SpanB)
	s.Cloud.Lower, s.Cloud.Upper = clonePointer(s.Cloud.Lower), clonePointer(s.Cloud.Upper)
	s.Cloud.CalculatedAt, s.Cloud.DisplayedAt = clonePointer(s.Cloud.CalculatedAt), clonePointer(s.Cloud.DisplayedAt)
	return s
}

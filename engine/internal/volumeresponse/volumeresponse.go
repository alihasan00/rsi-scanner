// Package volumeresponse describes the relationship between completed-candle
// volume and price movement. The supplied VSA lecture calls the open-to-close
// body "spread"; the full high-to-low range is measured separately here.
// These measurements cannot identify traders, order flow, or absorption.
package volumeresponse

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

const (
	BaselineBars       = 20
	RecentResponseBars = 4
)

// Snapshot.Status describes history availability for the prior-20 baselines.
// Shape and denominator availability remain independent: a ready history can
// have a zero body/volume baseline or a current candle with no price range.
// Ratios use the 20 candles strictly before the latest candle. They are raw
// measurements, without fitted high/low thresholds or a directional verdict.
type Snapshot struct {
	Status               string    `json:"status"`
	AsOf                 *int64    `json:"asOf"`
	Bars                 int       `json:"bars"`
	BaselineBars         int       `json:"baselineBars"`
	ShapeStatus          string    `json:"shapeStatus"`
	Direction            string    `json:"direction"`
	Body                 *float64  `json:"body"`
	Range                *float64  `json:"range"`
	BodyFraction         *float64  `json:"bodyFraction"`
	ClosePosition        *float64  `json:"closePosition"`
	UpperWickFraction    *float64  `json:"upperWickFraction"`
	LowerWickFraction    *float64  `json:"lowerWickFraction"`
	BodyBaselineStatus   string    `json:"bodyBaselineStatus"`
	RangeBaselineStatus  string    `json:"rangeBaselineStatus"`
	VolumeBaselineStatus string    `json:"volumeBaselineStatus"`
	RelativeBody         *float64  `json:"relativeBody"`
	RelativeRange        *float64  `json:"relativeRange"`
	RelativeVolume       *float64  `json:"relativeVolume"`
	PreviousTwoStatus    string    `json:"previousTwoStatus"`
	VolumeVsPreviousTwo  string    `json:"volumeVsPreviousTwo"`
	BodyVsPreviousTwo    string    `json:"bodyVsPreviousTwo"`
	LatestResponse       *Response `json:"latestResponse"`
}

// Response records a two-candle sequence, not a trade confirmation. The setup
// volume exceeded each preceding candle's volume while its body was smaller
// than each preceding body. The immediately following candle closed with a
// nonzero, equal-or-larger body on lower nonzero volume. Direction describes
// only that following candle's open-to-close movement. The sequence can occur
// away from a meaningful price level, so it is never a standalone entry rule.
//
// This is a conservative implementation choice for the lecturer's qualitative
// high-volume/narrow-body followed by lower-volume/larger-body example. It does
// not claim to reproduce all examples, identify an actor, or establish a phase.
// ObservedAt is when the following candle closed; no event is backdated to the
// setup candle, and no future candle is needed to recognize the observation.
type Response struct {
	SetupAt        int64   `json:"setupAt"`
	ObservedAt     int64   `json:"observedAt"`
	BarsAgo        int     `json:"barsAgo"`
	Direction      string  `json:"direction"`
	SetupBody      float64 `json:"setupBody"`
	ResponseBody   float64 `json:"responseBody"`
	SetupVolume    float64 `json:"setupVolume"`
	ResponseVolume float64 `json:"responseVolume"`
}

func initial(bars int, status string) Snapshot {
	return Snapshot{Status: status, Bars: bars, BaselineBars: BaselineBars,
		ShapeStatus: status, Direction: "unavailable", BodyBaselineStatus: status,
		RangeBaselineStatus: status, VolumeBaselineStatus: status,
		PreviousTwoStatus: status, VolumeVsPreviousTwo: "unavailable", BodyVsPreviousTwo: "unavailable"}
}

// Analyze reads only its supplied history. The caller must supply completed,
// contiguous candles; provisional candles must be withheld by the caller.
// Neither Analyze nor its response detector reads a clock or changes input.
func Analyze(candles []market.Candle) Snapshot {
	s := initial(len(candles), "insufficient")
	if len(candles) == 0 {
		return s
	}
	if !validHistory(candles) {
		return initial(len(candles), "invalid")
	}
	current := candles[len(candles)-1]
	body, spread := bodyOf(current), rangeOf(current)
	s.AsOf, s.Body, s.Range = pointer(current.CloseTime), pointer(body), pointer(spread)
	s.Direction = direction(current)
	if spread == 0 {
		s.ShapeStatus = "zero_range"
	} else {
		s.ShapeStatus = "ready"
		s.BodyFraction = pointer(body / spread)
		s.ClosePosition = pointer((current.Close - current.Low) / spread)
		s.UpperWickFraction = pointer((current.High - math.Max(current.Open, current.Close)) / spread)
		s.LowerWickFraction = pointer((math.Min(current.Open, current.Close) - current.Low) / spread)
	}
	if len(candles) >= 3 {
		prior := candles[len(candles)-3 : len(candles)-1]
		s.PreviousTwoStatus = "ready"
		s.VolumeVsPreviousTwo = compareTwo(current.Volume, prior[0].Volume, prior[1].Volume)
		s.BodyVsPreviousTwo = compareTwo(body, bodyOf(prior[0]), bodyOf(prior[1]))
	}
	if len(candles) > BaselineBars {
		prior := candles[len(candles)-1-BaselineBars : len(candles)-1]
		meanBody, meanRange, meanVolume := 0.0, 0.0, 0.0
		for i, candle := range prior {
			n := float64(i + 1)
			meanBody += (bodyOf(candle) - meanBody) / n
			meanRange += (rangeOf(candle) - meanRange) / n
			meanVolume += (candle.Volume - meanVolume) / n
		}
		s.Status = "ready"
		s.BodyBaselineStatus, s.RelativeBody = relative(body, meanBody)
		s.RangeBaselineStatus, s.RelativeRange = relative(spread, meanRange)
		s.VolumeBaselineStatus, s.RelativeVolume = relative(current.Volume, meanVolume)
	}
	// Only a recent observation is useful in a current snapshot. Newer unrelated
	// candles neither overwrite its original measurements nor imply validity.
	for i := len(candles) - 1; i >= max(3, len(candles)-RecentResponseBars); i-- {
		setup, next := candles[i-1], candles[i]
		left1, left2 := candles[i-2], candles[i-3]
		setupBody, nextBody := bodyOf(setup), bodyOf(next)
		if compareTwo(setup.Volume, left1.Volume, left2.Volume) != "above_both" ||
			compareTwo(setupBody, bodyOf(left1), bodyOf(left2)) != "below_both" ||
			next.Volume <= 0 || next.Volume >= setup.Volume || nextBody == 0 || nextBody < setupBody {
			continue
		}
		s.LatestResponse = &Response{SetupAt: setup.CloseTime, ObservedAt: next.CloseTime,
			BarsAgo: len(candles) - 1 - i, Direction: direction(next), SetupBody: setupBody,
			ResponseBody: nextBody, SetupVolume: setup.Volume, ResponseVolume: next.Volume}
		break
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

func relative(value, mean float64) (string, *float64) {
	if mean == 0 {
		return "zero_baseline", nil
	}
	ratio := value / mean
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) {
		return "invalid", nil
	}
	return "ready", pointer(ratio)
}

func compareTwo(current, first, second float64) string {
	if current > first && current > second {
		return "above_both"
	}
	if current < first && current < second {
		return "below_both"
	}
	return "between_or_equal"
}

func direction(candle market.Candle) string {
	if candle.Close > candle.Open {
		return "up"
	}
	if candle.Close < candle.Open {
		return "down"
	}
	return "flat"
}

func bodyOf(c market.Candle) float64  { return math.Abs(c.Close - c.Open) }
func rangeOf(c market.Candle) float64 { return c.High - c.Low }
func pointer[T any](value T) *T       { return &value }

func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return pointer(*value)
}

// CloneSnapshot returns an independently owned snapshot for publication.
func CloneSnapshot(s Snapshot) Snapshot {
	s.AsOf = clonePointer(s.AsOf)
	s.Body, s.Range = clonePointer(s.Body), clonePointer(s.Range)
	s.BodyFraction, s.ClosePosition = clonePointer(s.BodyFraction), clonePointer(s.ClosePosition)
	s.UpperWickFraction, s.LowerWickFraction = clonePointer(s.UpperWickFraction), clonePointer(s.LowerWickFraction)
	s.RelativeBody, s.RelativeRange, s.RelativeVolume = clonePointer(s.RelativeBody), clonePointer(s.RelativeRange), clonePointer(s.RelativeVolume)
	s.LatestResponse = clonePointer(s.LatestResponse)
	return s
}

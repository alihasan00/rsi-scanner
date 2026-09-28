// Package participation describes completed-candle volume participation.
// HLC3-weighted VWAP and quote turnover are candle approximations; neither
// measures aggressor buying/selling or reconstructs individual trades.
package participation

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

const BaselineBars = 20

const dayMillis = int64(24 * 60 * 60 * 1000)

// VWAP is an HLC3 price weighted by completed-candle base volume.
type VWAP struct {
	Status string   `json:"status"`
	Value  *float64 `json:"value"`
	Bars   int      `json:"bars"`
	AsOf   *int64   `json:"asOf"`
}

// Turnover is an estimate of quote-asset turnover, not exchange-reported quote
// volume. Ready means the supplied candles cover a complete contiguous 24h.
type Turnover struct {
	Status         string   `json:"status"`
	EstimatedValue *float64 `json:"estimatedValue"`
	Bars           int      `json:"bars"`
	AsOf           *int64   `json:"asOf"`
}

// Snapshot.Status describes relative-volume availability. VWAP and turnover
// carry independent statuses because their required histories differ.
type Snapshot struct {
	Status              string   `json:"status"`
	AsOf                *int64   `json:"asOf"`
	BaselineBars        int      `json:"baselineBars"`
	ReferenceBars       int      `json:"referenceBars"`
	CurrentBaseVolume   *float64 `json:"currentBaseVolume"`
	PriorMeanBaseVolume *float64 `json:"priorMeanBaseVolume"`
	RelativeVolume      *float64 `json:"relativeVolume"`
	RollingVWAP         VWAP     `json:"rollingVwap"`
	VWAPRelation        string   `json:"vwapRelation"`
	QuoteTurnover24h    Turnover `json:"quoteTurnover24h"`
}

// Analyze reads only candles supplied by the caller. The caller must provide
// completed candles through its desired as-of time; previews belong elsewhere.
// The RVOL baseline is exactly the 20 candles before the current candle. The
// rolling VWAP instead includes the current candle in its 20-candle window.
func Analyze(candles []market.Candle) Snapshot {
	s := Snapshot{Status: "insufficient", BaselineBars: BaselineBars, VWAPRelation: "unavailable",
		RollingVWAP: VWAP{Status: "insufficient"}, QuoteTurnover24h: Turnover{Status: "insufficient"}}
	if len(candles) == 0 {
		return s
	}
	duration, valid := validHistory(candles)
	if !valid {
		s.Status, s.RollingVWAP.Status, s.QuoteTurnover24h.Status = "invalid", "invalid", "invalid"
		return s
	}
	current := candles[len(candles)-1]
	s.AsOf, s.CurrentBaseVolume = pointer(current.CloseTime), pointer(current.Volume)
	s.ReferenceBars = min(BaselineBars, len(candles)-1)
	if s.ReferenceBars == BaselineBars {
		mean := 0.0
		for _, bar := range candles[len(candles)-1-BaselineBars : len(candles)-1] {
			mean += bar.Volume / BaselineBars
		}
		switch {
		case !finite(mean):
			s.Status = "invalid"
		case mean == 0:
			s.Status, s.PriorMeanBaseVolume = "zero_baseline", pointer(mean)
		default:
			s.PriorMeanBaseVolume = pointer(mean)
			ratio := current.Volume / mean
			if finite(ratio) {
				s.Status, s.RelativeVolume = "ready", pointer(ratio)
			} else {
				s.Status = "invalid"
			}
		}
	}
	rolling := candles[max(0, len(candles)-BaselineBars):]
	if len(rolling) == BaselineBars {
		s.RollingVWAP = weightedVWAP(rolling)
	} else {
		s.RollingVWAP.Bars, s.RollingVWAP.AsOf = len(rolling), pointer(current.CloseTime)
	}
	if s.RollingVWAP.Value != nil {
		s.VWAPRelation = "at"
		if current.Close > *s.RollingVWAP.Value {
			s.VWAPRelation = "above"
		} else if current.Close < *s.RollingVWAP.Value {
			s.VWAPRelation = "below"
		}
	}
	s.QuoteTurnover24h = turnover24h(candles, duration)
	return s
}

// AnchoredVWAP includes only completed candles whose open is strictly after
// anchor confirmation. A straddling candle is excluded. Missing anchor coverage
// is insufficient, and gaps/invalid bars are invalid rather than partial data.
func AnchoredVWAP(candles []market.Candle, after int64) VWAP {
	if after < 0 {
		return VWAP{Status: "invalid"}
	}
	if len(candles) == 0 {
		return VWAP{Status: "insufficient"}
	}
	if _, valid := validHistory(candles); !valid {
		return VWAP{Status: "invalid"}
	}
	// Subtraction avoids overflowing after+1 for a malformed anchor.
	if candles[0].OpenTime > after && candles[0].OpenTime-after > 1 {
		return VWAP{Status: "insufficient"}
	}
	first := 0
	for first < len(candles) && candles[first].OpenTime <= after {
		first++
	}
	return weightedVWAP(candles[first:])
}

func validHistory(candles []market.Candle) (int64, bool) {
	if len(candles) == 0 {
		return 0, false
	}
	duration := candles[0].CloseTime - candles[0].OpenTime + 1
	for i, bar := range candles {
		if !bar.Valid() || !market.SameInterval(candles[0], bar) || i > 0 && bar.OpenTime != candles[i-1].CloseTime+1 {
			return 0, false
		}
	}
	return duration, true
}

func weightedVWAP(candles []market.Candle) VWAP {
	v := VWAP{Status: "insufficient", Bars: len(candles)}
	if len(candles) == 0 {
		return v
	}
	v.AsOf = pointer(candles[len(candles)-1].CloseTime)
	maxVolume := 0.0
	for _, bar := range candles {
		maxVolume = math.Max(maxVolume, bar.Volume)
	}
	if maxVolume == 0 {
		v.Status = "zero_volume"
		return v
	}
	// Normalize weights and update the mean incrementally to avoid overflow in
	// price*volume while preserving zero-volume candles as valid observations.
	mean, weight := 0.0, 0.0
	for _, bar := range candles {
		w := bar.Volume / maxVolume
		if w == 0 {
			continue
		}
		weight += w
		mean += (hlc3(bar) - mean) * (w / weight)
	}
	if !finite(mean) || mean <= 0 {
		v.Status = "invalid"
		return v
	}
	v.Status, v.Value = "ready", pointer(mean)
	return v
}

func turnover24h(candles []market.Candle, duration int64) Turnover {
	t := Turnover{Status: "unsupported_interval"}
	if duration > dayMillis || dayMillis%duration != 0 {
		return t
	}
	needed := int(dayMillis / duration)
	t.Bars = min(needed, len(candles))
	t.AsOf = pointer(candles[len(candles)-1].CloseTime)
	if len(candles) < needed {
		t.Status = "insufficient"
		return t
	}
	total := 0.0
	for _, bar := range candles[len(candles)-needed:] {
		total += hlc3(bar) * bar.Volume
	}
	if !finite(total) {
		t.Status = "invalid"
		return t
	}
	t.Status, t.EstimatedValue = "ready", pointer(total)
	return t
}

func hlc3(bar market.Candle) float64 { return bar.High/3 + bar.Low/3 + bar.Close/3 }
func finite(v float64) bool          { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func pointer[T any](v T) *T          { return &v }

func clonePointer[T any](v *T) *T {
	if v == nil {
		return nil
	}
	return pointer(*v)
}

// CloneSnapshot gives a published snapshot ownership of every nullable value.
func CloneSnapshot(s Snapshot) Snapshot {
	s.AsOf = clonePointer(s.AsOf)
	s.CurrentBaseVolume = clonePointer(s.CurrentBaseVolume)
	s.PriorMeanBaseVolume = clonePointer(s.PriorMeanBaseVolume)
	s.RelativeVolume = clonePointer(s.RelativeVolume)
	s.RollingVWAP.Value = clonePointer(s.RollingVWAP.Value)
	s.RollingVWAP.AsOf = clonePointer(s.RollingVWAP.AsOf)
	s.QuoteTurnover24h.EstimatedValue = clonePointer(s.QuoteTurnover24h.EstimatedValue)
	s.QuoteTurnover24h.AsOf = clonePointer(s.QuoteTurnover24h.AsOf)
	return s
}

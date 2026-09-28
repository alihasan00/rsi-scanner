// Package fairvaluegaps describes three-candle wick gaps and subsequent OHLC
// interactions. It adapts the geometry and midpoint-retirement convention in
// lecture 102; it does not infer resting orders, future fills or trade returns.
package fairvaluegaps

import (
	"fmt"
	"sort"

	"github.com/alihasan00/crypto/internal/market"
)

const (
	WarmupBars         = 3
	RecentResolvedBars = 4
	MaxGaps            = 8
)

type Rules struct {
	RecentResolvedBars int `json:"recentResolvedBars"`
	MaxGaps            int `json:"maxGaps"`
}

func DefaultRules() Rules {
	return Rules{RecentResolvedBars: RecentResolvedBars, MaxGaps: MaxGaps}
}

// Gap keeps formation separate from later interaction. FormedAt is the third
// candle's close; StateAt is the first close observing the current State.
// Open timestamps identify all three source candles. AgeBars is since formation.
//
// active and touched remain live references. midpoint_mitigated is retired at
// the first midpoint overlap or passage; fully_traversed means the far boundary
// lies in a later candle's range, not proof that every price in the gap traded.
// price_beyond means the later range is wholly beyond the far boundary.
//
// FirstTouchedAt requires zone overlap, MidpointAt requires midpoint overlap,
// and TraversedAt requires far-boundary overlap. These timestamps are never
// manufactured by a price jump. PriceBeyondAt identifies the first midpoint or
// far-boundary passage without corresponding overlap. ResolvedAt stays frozen
// at the first retirement even if the latest state later reaches the far edge.
type Gap struct {
	ID                  string  `json:"id"`
	Direction           string  `json:"direction"`
	State               string  `json:"state"`
	Lower               float64 `json:"lower"`
	Upper               float64 `json:"upper"`
	Midpoint            float64 `json:"midpoint"`
	FirstOpenTime       int64   `json:"firstOpenTime"`
	MiddleOpenTime      int64   `json:"middleOpenTime"`
	ThirdOpenTime       int64   `json:"thirdOpenTime"`
	FormedAt            int64   `json:"formedAt"`
	StateAt             int64   `json:"stateAt"`
	AgeBars             int     `json:"ageBars"`
	FirstTouchedAt      *int64  `json:"firstTouchedAt"`
	MidpointAt          *int64  `json:"midpointAt"`
	TraversedAt         *int64  `json:"traversedAt"`
	PriceBeyondAt       *int64  `json:"priceBeyondAt"`
	ResolvedAt          *int64  `json:"resolvedAt"`
	BarsSinceResolution *int    `json:"barsSinceResolution"`
	ResolutionReason    string  `json:"resolutionReason"`
}

// GapTotal counts active and last-four-bar resolved references before MaxGaps
// is applied, not every gap ever observed in the supplied finite history.
// Status is ready after three valid, equal-duration, contiguous candles. Empty
// gaps in a ready snapshot means no retained observations, not missing data.
type Snapshot struct {
	Status     string   `json:"status"`
	AsOf       *int64   `json:"asOf"`
	ClosedBars int      `json:"closedBars"`
	WarmupBars int      `json:"warmupBars"`
	Rules      Rules    `json:"rules"`
	Gaps       []Gap    `json:"gaps"`
	GapTotal   int      `json:"gapTotal"`
	GapOmitted int      `json:"gapOmitted"`
	Warnings   []string `json:"warnings"`
}

type trackedGap struct {
	Gap
	formedIndex   int
	resolvedIndex int
}

// Analyze accepts only a completed prefix of ordinary OHLCV candles. The
// caller owns finality, symbol and interval selection: market.Candle carries
// no finality flag. There is no clock, hidden data fetch, ATR threshold, candle
// color condition or BOS hard filter. A strict wick gap is known only when
// candle i closes, and only candles j>i can change its interaction state.
func Analyze(candles []market.Candle) Snapshot {
	s := Snapshot{Status: "insufficient", ClosedBars: len(candles), WarmupBars: WarmupBars,
		Rules: DefaultRules(),
		Gaps:  []Gap{}, Warnings: []string{}}
	if len(candles) == 0 {
		return s
	}
	if warning := validateHistory(candles); warning != "" {
		s.Status, s.Warnings = "invalid", []string{warning}
		return s
	}
	s.AsOf = pointer(candles[len(candles)-1].CloseTime)
	if len(candles) < WarmupBars {
		return s
	}
	s.Status = "ready"
	var records []trackedGap
	for i, candle := range candles {
		for j := range records {
			update(&records[j], candle, i)
		}
		if i < WarmupBars-1 {
			continue
		}
		first := candles[i-2]
		var direction string
		var lower, upper float64
		if candle.Low > first.High {
			direction, lower, upper = "bullish", first.High, candle.Low
		} else if candle.High < first.Low {
			direction, lower, upper = "bearish", candle.High, first.Low
		} else {
			continue
		}
		records = append(records, trackedGap{Gap: Gap{
			ID:        fmt.Sprintf("fvg-%s-%d-%d", direction, first.OpenTime, candle.OpenTime),
			Direction: direction, State: "active", Lower: lower, Upper: upper,
			Midpoint:      lower + (upper-lower)/2,
			FirstOpenTime: first.OpenTime, MiddleOpenTime: candles[i-1].OpenTime,
			ThirdOpenTime: candle.OpenTime, FormedAt: candle.CloseTime, StateAt: candle.CloseTime,
		}, formedIndex: i, resolvedIndex: -1})
	}
	last := len(candles) - 1
	for _, record := range records {
		if record.resolvedIndex >= 0 && last-record.resolvedIndex >= RecentResolvedBars {
			continue
		}
		record.AgeBars = last - record.formedIndex
		if record.resolvedIndex >= 0 {
			record.BarsSinceResolution = pointer(last - record.resolvedIndex)
		}
		s.Gaps = append(s.Gaps, record.Gap)
	}
	price := candles[last].Close
	sort.Slice(s.Gaps, func(i, j int) bool {
		a, b := s.Gaps[i], s.Gaps[j]
		if (a.ResolvedAt == nil) != (b.ResolvedAt == nil) {
			return a.ResolvedAt == nil
		}
		if a.ResolvedAt == nil {
			if da, db := distance(a, price), distance(b, price); da != db {
				return da < db
			}
		} else if *a.ResolvedAt != *b.ResolvedAt {
			return *a.ResolvedAt > *b.ResolvedAt
		}
		if a.FormedAt != b.FormedAt {
			return a.FormedAt > b.FormedAt
		}
		return a.ID < b.ID
	})
	s.GapTotal = len(s.Gaps)
	if len(s.Gaps) > MaxGaps {
		s.GapOmitted = len(s.Gaps) - MaxGaps
		s.Gaps = s.Gaps[:MaxGaps]
	}
	return s
}

func update(record *trackedGap, candle market.Candle, index int) {
	// Terminal references never become new signals on a later revisit. An old
	// retirement also never reappears merely because its far edge is hit later.
	if record.State == "fully_traversed" || record.State == "price_beyond" ||
		record.resolvedIndex >= 0 && index-record.resolvedIndex >= RecentResolvedBars {
		return
	}
	at := candle.CloseTime
	overlaps := candle.High >= record.Lower && candle.Low <= record.Upper
	if overlaps && record.FirstTouchedAt == nil {
		record.FirstTouchedAt = pointer(at)
		if record.ResolvedAt == nil {
			record.State, record.StateAt = "touched", at
		}
	}
	midpointOverlap := candle.Low <= record.Midpoint && candle.High >= record.Midpoint
	if midpointOverlap && record.MidpointAt == nil {
		record.MidpointAt = pointer(at)
	}
	far := record.Lower
	passedMidpoint, passedFar := candle.Low <= record.Midpoint, candle.High < record.Lower
	if record.Direction == "bearish" {
		far = record.Upper
		passedMidpoint, passedFar = candle.High >= record.Midpoint, candle.Low > record.Upper
	}
	if passedFar {
		if record.PriceBeyondAt == nil {
			record.PriceBeyondAt = pointer(at)
		}
		record.State, record.StateAt = "price_beyond", at
		retire(record, index, at, "far_boundary_passed_without_overlap")
		return
	}
	if candle.Low <= far && candle.High >= far {
		record.TraversedAt = pointer(at)
		record.State, record.StateAt = "fully_traversed", at
		retire(record, index, at, "far_boundary_overlap")
		return
	}
	if passedMidpoint {
		reason := "midpoint_overlap"
		if !midpointOverlap {
			reason = "midpoint_passed_without_overlap"
			if record.PriceBeyondAt == nil {
				record.PriceBeyondAt = pointer(at)
			}
		}
		if record.ResolvedAt == nil {
			record.State, record.StateAt = "midpoint_mitigated", at
		}
		retire(record, index, at, reason)
	}
}

func retire(record *trackedGap, index int, at int64, reason string) {
	if record.ResolvedAt != nil {
		return
	}
	record.ResolvedAt, record.resolvedIndex, record.ResolutionReason = pointer(at), index, reason
}

func distance(gap Gap, price float64) float64 {
	if price < gap.Lower {
		return gap.Lower - price
	}
	if price > gap.Upper {
		return price - gap.Upper
	}
	return 0
}

func validateHistory(candles []market.Candle) string {
	for i, candle := range candles {
		if !candle.Valid() {
			return fmt.Sprintf("invalid candle at index %d; fair value gap evidence unavailable", i)
		}
		if !market.SameInterval(candles[0], candle) {
			return fmt.Sprintf("changed candle duration at index %d; fair value gap evidence unavailable", i)
		}
		if i > 0 && candle.OpenTime != candles[i-1].CloseTime+1 {
			return fmt.Sprintf("candle gap, overlap or ordering error at index %d; fair value gap evidence unavailable", i)
		}
	}
	return ""
}

func pointer[T any](v T) *T { return &v }

func clonePointer[T any](v *T) *T {
	if v == nil {
		return nil
	}
	return pointer(*v)
}

// CloneSnapshot grants independent ownership of all published pointers/slices.
func CloneSnapshot(s Snapshot) Snapshot {
	s.AsOf = clonePointer(s.AsOf)
	s.Warnings = append([]string{}, s.Warnings...)
	s.Gaps = append([]Gap{}, s.Gaps...)
	for i := range s.Gaps {
		gap := &s.Gaps[i]
		gap.FirstTouchedAt = clonePointer(gap.FirstTouchedAt)
		gap.MidpointAt = clonePointer(gap.MidpointAt)
		gap.TraversedAt = clonePointer(gap.TraversedAt)
		gap.PriceBeyondAt = clonePointer(gap.PriceBeyondAt)
		gap.ResolvedAt = clonePointer(gap.ResolvedAt)
		gap.BarsSinceResolution = clonePointer(gap.BarsSinceResolution)
	}
	return s
}

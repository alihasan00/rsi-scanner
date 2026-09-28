// Package calendarlevels derives calendar references and strict wick
// sweep/reclaims from completed candles. These are measured observations,
// never trade instructions, fills, or probabilities.
package calendarlevels

import (
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/alihasan00/crypto/internal/market"
)

const (
	dayMillis      = int64(24 * 60 * 60 * 1000)
	weekMillis     = 7 * dayMillis
	maxSafeInteger = int64(1<<53 - 1)
	// RecentBars bounds confirmed observations; it is not an entry-validity window.
	RecentBars = 3
)

// SourceStatus makes missing or inapplicable calendar history explicit. Period
// bounds are UTC, with an inclusive start and exclusive end. AvailableBars is
// the count actually present, never a partial OHLC substitute.
type SourceStatus struct {
	Source        string `json:"source"`
	Status        string `json:"status"`
	PeriodStart   int64  `json:"periodStart"`
	PeriodEnd     int64  `json:"periodEnd"`
	ExpectedBars  int    `json:"expectedBars"`
	AvailableBars int    `json:"availableBars"`
	Reason        string `json:"reason"`
}

// Level preserves each source label even when several labels have equal prices.
// Role and absolute DistancePct use only the latest completed reaction close;
// they are unavailable when that reference is missing, invalid, or stale.
type Level struct {
	ID            string   `json:"id"`
	Label         string   `json:"label"`
	Source        string   `json:"source"`
	Price         float64  `json:"price"`
	PeriodStart   int64    `json:"periodStart"`
	PeriodEnd     int64    `json:"periodEnd"`
	AvailableFrom int64    `json:"availableFrom"`
	ExpiresAt     int64    `json:"expiresAt"`
	Role          string   `json:"role"`
	DistancePct   *float64 `json:"distancePct"`
}

// Event records a completed wick breach and close back across a level, with
// the immediately preceding contiguous close on the same approach side.
// PenetrationPrice and CloseBackPrice are positive distances in price units.
// ConfirmedAt is the inclusive close time. Level was available throughout the
// event candle; a recent event can retain a level that has since rolled over.
type Event struct {
	Level            Level         `json:"level"`
	Direction        string        `json:"direction"`
	State            string        `json:"state"`
	ConfirmedAt      int64         `json:"confirmedAt"`
	BarsAgo          int           `json:"barsAgo"`
	Candle           market.Candle `json:"candle"`
	PreviousClose    float64       `json:"previousClose"`
	PenetrationPrice float64       `json:"penetrationPrice"`
	CloseBackPrice   float64       `json:"closeBackPrice"`
}

// Snapshot.Status summarizes calendar-source availability (ready, partial,
// insufficient, or invalid). ReactionStatus independently describes the latest
// reaction history. AsOf is the exclusive completion watermark supplied by the
// caller; only candles with CloseTime < AsOf are considered.
type Snapshot struct {
	Status            string         `json:"status"`
	AsOf              int64          `json:"asOf"`
	ReactionStatus    string         `json:"reactionStatus"`
	ReferenceClosedAt *int64         `json:"referenceClosedAt"`
	ReferenceClose    *float64       `json:"referenceClose"`
	Sources           []SourceStatus `json:"sources"`
	Levels            []Level        `json:"levels"`
	Events            []Event        `json:"events"`
}

// Analyze uses only supplied candles, without a live quote or any hidden fetch.
// It derives the actual previous UTC month/week and latest completed Monday
// body. A source period must contain every daily candle. Monday body levels
// apply only when the supplied reaction interval is intraday. Future candles
// are ignored, so historical calls remain frozen to asOf.
func Analyze(daily, reactions []market.Candle, asOf int64) Snapshot {
	s := Snapshot{Status: "insufficient", AsOf: asOf, ReactionStatus: "insufficient",
		Sources: []SourceStatus{}, Levels: []Level{}, Events: []Event{}}
	if asOf < 0 || asOf > maxSafeInteger {
		s.Status, s.ReactionStatus = "invalid", "invalid"
		return s
	}
	bars, duration, reactionsValid := reactionHistory(reactions, asOf)
	if !reactionsValid {
		s.ReactionStatus = "invalid"
	} else if len(bars) > 0 {
		last := bars[len(bars)-1]
		s.ReferenceClosedAt, s.ReferenceClose = pointer(last.CloseTime), pointer(last.Close)
		s.ReactionStatus = "ready"
		// A full missing interval makes these observations historical, not recent.
		nextEnd := last.CloseTime + 1 + duration
		if market.CalendarMonth(last) {
			nextEnd = time.UnixMilli(last.OpenTime).UTC().AddDate(0, 2, 0).UnixMilli()
		}
		if asOf >= nextEnd {
			s.ReactionStatus = "stale"
		}
	}

	days, dailyValid := dailyHistory(daily, asOf)
	intraday := reactionsValid && duration > 0 && duration < dayMillis
	s.Levels, s.Sources = levelsAt(days, asOf, intraday)
	if !dailyValid {
		s.Status, s.Levels = "invalid", []Level{}
		for i := range s.Sources {
			if s.Sources[i].Status != "not_applicable" {
				s.Sources[i].Status = "invalid"
				s.Sources[i].Reason = "Daily history must contain valid, ordered, completed UTC days."
			}
		}
		return s
	}
	ready, applicable := 0, 0
	for _, source := range s.Sources {
		if source.Status != "not_applicable" {
			applicable++
		}
		if source.Status == "ready" {
			ready++
		}
	}
	if ready == applicable {
		s.Status = "ready"
	} else if ready > 0 {
		s.Status = "partial"
	}
	if s.ReactionStatus != "ready" {
		return s
	}
	for i := range s.Levels {
		setReference(&s.Levels[i], *s.ReferenceClose)
	}
	for i := len(bars) - 1; i >= max(1, len(bars)-RecentBars); i-- {
		bar, previous := bars[i], bars[i-1]
		if previous.CloseTime+1 != bar.OpenTime {
			continue
		}
		ageMillis := bars[len(bars)-1].CloseTime - bar.CloseTime
		barsAgo := int(ageMillis / duration)
		alignedAge := ageMillis%duration == 0
		if market.CalendarMonth(bar) {
			lastOpen, barOpen := time.UnixMilli(bars[len(bars)-1].OpenTime).UTC(), time.UnixMilli(bar.OpenTime).UTC()
			barsAgo = (lastOpen.Year()-barOpen.Year())*12 + int(lastOpen.Month()-barOpen.Month())
			alignedAge = true
		}
		if !alignedAge || barsAgo >= RecentBars {
			// A gap must not compress an old event into the recent window merely
			// because only three newer candles happen to have been supplied.
			continue
		}
		// Reconstruct what was available at the candle's own opening. Using
		// today's levels here would project new levels onto earlier candles and
		// lose valid observations when the UTC week/month rolls over.
		levels, _ := levelsAt(days, bar.OpenTime, intraday)
		for _, level := range levels {
			if bar.OpenTime < level.AvailableFrom || bar.CloseTime >= level.ExpiresAt {
				continue
			}
			bullish := previous.Close > level.Price && bar.Low < level.Price && bar.Close > level.Price
			bearish := previous.Close < level.Price && bar.High > level.Price && bar.Close < level.Price
			if !bullish && !bearish {
				continue
			}
			setReference(&level, bar.Close)
			event := Event{Level: level, Direction: "bullish", State: "confirmed", ConfirmedAt: bar.CloseTime,
				BarsAgo: barsAgo, Candle: bar, PreviousClose: previous.Close,
				PenetrationPrice: level.Price - bar.Low, CloseBackPrice: bar.Close - level.Price}
			if bearish {
				event.Direction = "bearish"
				event.PenetrationPrice, event.CloseBackPrice = bar.High-level.Price, level.Price-bar.Close
			}
			s.Events = append(s.Events, event)
		}
	}
	sort.SliceStable(s.Events, func(i, j int) bool {
		if s.Events[i].ConfirmedAt != s.Events[j].ConfirmedAt {
			return s.Events[i].ConfirmedAt > s.Events[j].ConfirmedAt
		}
		if s.Events[i].Level.Price != s.Events[j].Level.Price {
			return s.Events[i].Level.Price < s.Events[j].Level.Price
		}
		return s.Events[i].Level.ID < s.Events[j].Level.ID
	})
	return s
}

func dailyHistory(candles []market.Candle, asOf int64) (map[int64]market.Candle, bool) {
	days := make(map[int64]market.Candle)
	previous := int64(-1)
	for _, candle := range candles {
		if candle.CloseTime >= asOf {
			continue
		}
		if !candle.Valid() || candle.OpenTime%dayMillis != 0 ||
			candle.CloseTime-candle.OpenTime+1 != dayMillis || candle.OpenTime <= previous {
			return nil, false
		}
		days[candle.OpenTime] = candle
		previous = candle.OpenTime
	}
	return days, true
}

func reactionHistory(candles []market.Candle, asOf int64) ([]market.Candle, int64, bool) {
	closed := make([]market.Candle, 0, len(candles))
	duration := int64(0)
	for _, candle := range candles {
		if candle.CloseTime >= asOf {
			continue
		}
		if !candle.Valid() {
			return nil, 0, false
		}
		if duration == 0 {
			duration = candle.CloseTime - candle.OpenTime + 1
		}
		if len(closed) > 0 && !market.SameInterval(closed[0], candle) ||
			len(closed) > 0 && candle.OpenTime <= closed[len(closed)-1].CloseTime {
			return nil, 0, false
		}
		closed = append(closed, candle)
	}
	return closed, duration, true
}

func levelsAt(days map[int64]market.Candle, asOf int64, intraday bool) ([]Level, []SourceStatus) {
	monthEnd := monthStart(asOf, 0)
	weekEnd := weekStart(asOf)
	mondayStart := weekEnd
	if mondayStart+dayMillis > asOf {
		mondayStart -= weekMillis
	}
	periods := []SourceStatus{
		{Source: "month", PeriodStart: monthStart(asOf, -1), PeriodEnd: monthEnd},
		{Source: "week", PeriodStart: weekEnd - weekMillis, PeriodEnd: weekEnd},
		{Source: "monday", PeriodStart: mondayStart, PeriodEnd: mondayStart + dayMillis},
	}
	levels := []Level{}
	for i := range periods {
		period := &periods[i]
		period.ExpectedBars = int((period.PeriodEnd - period.PeriodStart) / dayMillis)
		bars := make([]market.Candle, 0, period.ExpectedBars)
		for opening := period.PeriodStart; opening < period.PeriodEnd; opening += dayMillis {
			if candle, present := days[opening]; present {
				bars = append(bars, candle)
			}
		}
		period.AvailableBars = len(bars)
		if period.Source == "monday" && !intraday {
			period.Status = "not_applicable"
			period.Reason = "Monday body levels require a completed intraday reaction interval."
			continue
		}
		if period.AvailableBars != period.ExpectedBars {
			period.Status = "insufficient"
			period.Reason = "The required calendar period is incomplete in the supplied daily history."
			continue
		}
		period.Status = "ready"
		if period.Source == "monday" {
			low, high := math.Min(bars[0].Open, bars[0].Close), math.Max(bars[0].Open, bars[0].Close)
			levels = append(levels,
				makeLevel(*period, "low", low),
				makeLevel(*period, "midpoint", low+(high-low)/2),
				makeLevel(*period, "high", high))
			continue
		}
		high, low := bars[0].High, bars[0].Low
		for _, candle := range bars[1:] {
			high, low = math.Max(high, candle.High), math.Min(low, candle.Low)
		}
		levels = append(levels,
			makeLevel(*period, "open", bars[0].Open),
			makeLevel(*period, "high", high),
			makeLevel(*period, "low", low),
			makeLevel(*period, "close", bars[len(bars)-1].Close))
	}
	return levels, periods
}

func makeLevel(period SourceStatus, name string, price float64) Level {
	label, expiry := "Previous week ", period.PeriodEnd+weekMillis
	switch period.Source {
	case "month":
		label, expiry = "Previous month ", monthStart(period.PeriodEnd, 1)
	case "monday":
		label = "Monday body "
	}
	return Level{ID: fmt.Sprintf("%s-%d-%s", period.Source, period.PeriodStart, name),
		Label: label + name, Source: period.Source, Price: price,
		PeriodStart: period.PeriodStart, PeriodEnd: period.PeriodEnd,
		AvailableFrom: period.PeriodEnd, ExpiresAt: expiry, Role: "unavailable"}
}

func setReference(level *Level, close float64) {
	level.Role = "at"
	if level.Price < close {
		level.Role = "support"
	} else if level.Price > close {
		level.Role = "resistance"
	}
	distance := math.Abs(level.Price-close) / close * 100
	if !math.IsInf(distance, 0) && !math.IsNaN(distance) {
		level.DistancePct = pointer(distance)
	}
}

func monthStart(asOf int64, offset int) int64 {
	t := time.UnixMilli(asOf).UTC()
	return time.Date(t.Year(), t.Month()+time.Month(offset), 1, 0, 0, 0, 0, time.UTC).UnixMilli()
}

func weekStart(asOf int64) int64 {
	t := time.UnixMilli(asOf).UTC()
	day := asOf - asOf%dayMillis
	return day - int64((int(t.Weekday())+6)%7)*dayMillis
}

func pointer[T any](value T) *T { return &value }

func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return pointer(*value)
}

// CloneSnapshot gives a published snapshot ownership of every slice and
// nullable field; a later caller cannot mutate another snapshot's evidence.
func CloneSnapshot(s Snapshot) Snapshot {
	s.ReferenceClosedAt, s.ReferenceClose = clonePointer(s.ReferenceClosedAt), clonePointer(s.ReferenceClose)
	s.Sources = append([]SourceStatus{}, s.Sources...)
	s.Levels = append([]Level{}, s.Levels...)
	for i := range s.Levels {
		s.Levels[i].DistancePct = clonePointer(s.Levels[i].DistancePct)
	}
	s.Events = append([]Event{}, s.Events...)
	for i := range s.Events {
		s.Events[i].Level.DistancePct = clonePointer(s.Events[i].Level.DistancePct)
	}
	return s
}

// Package swingfailure describes wick rejections of previously confirmed
// three-candle swings. These observations do not establish resting orders,
// participant intent, an executable setup, or a probability of profit.
package swingfailure

import (
	"fmt"
	"sort"

	"github.com/alihasan00/crypto/internal/market"
)

// Rules separates the lecture's strict three-candle swing definition from our
// bounded observation window. ExpiryBars is not a lecture-derived trade expiry.
type Rules struct {
	LeftBars           int `json:"leftBars"`
	RightBars          int `json:"rightBars"`
	ExpiryBars         int `json:"expiryBars"`
	RecentResolvedBars int `json:"recentResolvedBars"`
	MaxEvents          int `json:"maxEvents"`
}

func DefaultRules() Rules {
	return Rules{LeftBars: 1, RightBars: 1, ExpiryBars: 4, RecentResolvedBars: 4, MaxEvents: 8}
}

// Pivot becomes available at the inclusive close of its right-hand neighbour.
// A reaction may use it only after that close, never on its confirmation bar.
type Pivot struct {
	OpenTime    int64   `json:"openTime"`
	CloseTime   int64   `json:"closeTime"`
	AvailableAt int64   `json:"availableAt"`
	Price       float64 `json:"price"`
}

// Event records a confirmed SFP, followed by at most one terminal observation:
// follow_through (a later close crossing the frozen opposite pivot), invalidated
// (the reclaimed swing level lost on a close), or expired (no such close-break
// in the next four bars). Follow-through is a measured break, not a trade win.
// AvailableAt is the first close at which State was knowable. ResolvedAt never
// implies a fill, realized outcome, or continuing validity of the observation.
type Event struct {
	ID                  string        `json:"id"`
	Direction           string        `json:"direction"`
	State               string        `json:"state"`
	Level               Pivot         `json:"level"`
	Trigger             *Pivot        `json:"trigger"`
	TriggerStatus       string        `json:"triggerStatus"`
	Candle              market.Candle `json:"candle"`
	PreviousClose       float64       `json:"previousClose"`
	PenetrationPrice    float64       `json:"penetrationPrice"`
	CloseBackPrice      float64       `json:"closeBackPrice"`
	ConfirmedAt         int64         `json:"confirmedAt"`
	AvailableAt         int64         `json:"availableAt"`
	AgeBars             int           `json:"ageBars"`
	BarsSinceSweep      int           `json:"barsSinceSweep"`
	FollowThroughAt     *int64        `json:"followThroughAt"`
	FollowThroughClose  *float64      `json:"followThroughClose"`
	ResolvedAt          *int64        `json:"resolvedAt"`
	BarsSinceResolution *int          `json:"barsSinceResolution"`
	ResolutionReason    string        `json:"resolutionReason"`
}

// Snapshot contains active and recently resolved events before the MaxEvents
// bound. Total and Omitted count only that current/recent set, not all history.
// LatestHigh/Low are the latest confirmed swings not yet broken on a close;
// wicks may have swept them. They are reference prices, not known order pools.
type Snapshot struct {
	Status     string   `json:"status"`
	AsOf       *int64   `json:"asOf"`
	ClosedBars int      `json:"closedBars"`
	WarmupBars int      `json:"warmupBars"`
	Rules      Rules    `json:"rules"`
	LatestHigh *Pivot   `json:"latestHigh"`
	LatestLow  *Pivot   `json:"latestLow"`
	Events     []Event  `json:"events"`
	Total      int      `json:"total"`
	Omitted    int      `json:"omitted"`
	Warnings   []string `json:"warnings"`
}

type pending struct {
	Event
	sweepIndex    int
	resolvedIndex int
}

type reference struct {
	Pivot
	crossed bool
}

// Analyze accepts an ascending, contiguous prefix of CLOSED candles. Candle has
// no finality bit, so the caller must exclude previews. Invalid OHLCV, gaps,
// changed durations and overlaps withhold all observations. The analyzer is
// pure, reads no wall clock, and neither mutates nor retains input slices.
func Analyze(candles []market.Candle) Snapshot {
	s := Snapshot{Status: "insufficient", ClosedBars: len(candles), WarmupBars: 4,
		Rules: DefaultRules(), Events: []Event{}, Warnings: []string{}}
	if len(candles) == 0 {
		return s
	}
	if warning := validate(candles); warning != "" {
		s.Status = "invalid"
		s.Warnings = append(s.Warnings, warning)
		return s
	}
	s.AsOf = pointer(candles[len(candles)-1].CloseTime)
	if len(candles) < s.WarmupBars {
		return s
	}
	s.Status = "ready"
	var high, low *reference
	active := make([]pending, 0, 2*s.Rules.ExpiryBars)
	recent := make([]pending, 0, 2*s.Rules.RecentResolvedBars)
	last := len(candles) - 1
	for i, bar := range candles {
		// The active set is bounded by two new observations per candle and the
		// four-bar timeout. No all-history prefix analysis is performed.
		remaining := active[:0]
		for _, observation := range active {
			observation.advance(candles[i-1], bar, i, s.Rules)
			if observation.State == "confirmed" {
				remaining = append(remaining, observation)
			} else if last-i < s.Rules.RecentResolvedBars {
				recent = append(recent, observation)
			}
		}
		active = remaining
		if i > 0 {
			previous := candles[i-1]
			if usable(high, bar) && previous.Close < high.Price && bar.Open <= high.Price &&
				bar.High > high.Price && bar.Close < high.Price {
				active = append(active, observe("bearish", high, low, previous, bar, i))
			}
			if usable(low, bar) && previous.Close > low.Price && bar.Open >= low.Price &&
				bar.Low < low.Price && bar.Close > low.Price {
				active = append(active, observe("bullish", low, high, previous, bar, i))
			}
		}
		if high != nil && bar.Close > high.Price {
			high.crossed = true
		}
		if low != nil && bar.Close < low.Price {
			low.crossed = true
		}
		// Discover after processing the reaction: these pivots become usable
		// only by the next candle, even when this candle swept another level.
		if i >= 2 {
			left, middle := candles[i-2], candles[i-1]
			if middle.High > left.High && middle.High > bar.High {
				high = &reference{Pivot: Pivot{OpenTime: middle.OpenTime, CloseTime: middle.CloseTime,
					AvailableAt: bar.CloseTime, Price: middle.High}}
			}
			if middle.Low < left.Low && middle.Low < bar.Low {
				low = &reference{Pivot: Pivot{OpenTime: middle.OpenTime, CloseTime: middle.CloseTime,
					AvailableAt: bar.CloseTime, Price: middle.Low}}
			}
		}
	}
	if high != nil && !high.crossed {
		s.LatestHigh = pointer(high.Pivot)
	}
	if low != nil && !low.crossed {
		s.LatestLow = pointer(low.Pivot)
	}
	for _, observation := range append(active, recent...) {
		e := observation.Event
		e.BarsSinceSweep = last - observation.sweepIndex
		e.AgeBars = e.BarsSinceSweep
		if e.ResolvedAt != nil {
			e.AgeBars = last - observation.resolvedIndex
			e.BarsSinceResolution = pointer(e.AgeBars)
		}
		s.Events = append(s.Events, e)
	}
	// Keep actionable chronology explicit without claiming that an active
	// observation is a trade. Stable time-based IDs survive prefix growth.
	sort.Slice(s.Events, func(i, j int) bool {
		a, b := s.Events[i], s.Events[j]
		if (a.State == "confirmed") != (b.State == "confirmed") {
			return a.State == "confirmed"
		}
		if a.AvailableAt != b.AvailableAt {
			return a.AvailableAt > b.AvailableAt
		}
		if a.ConfirmedAt != b.ConfirmedAt {
			return a.ConfirmedAt > b.ConfirmedAt
		}
		return a.ID < b.ID
	})
	s.Total = len(s.Events)
	if len(s.Events) > s.Rules.MaxEvents {
		s.Omitted = len(s.Events) - s.Rules.MaxEvents
		s.Events = s.Events[:s.Rules.MaxEvents]
	}
	return s
}

func usable(level *reference, bar market.Candle) bool {
	return level != nil && !level.crossed && level.AvailableAt < bar.OpenTime
}

func observe(direction string, level, opposite *reference, previous, bar market.Candle, i int) pending {
	e := Event{ID: fmt.Sprintf("%s-%d-%d", direction, level.OpenTime, bar.OpenTime),
		Direction: direction, State: "confirmed", Level: level.Pivot, TriggerStatus: "no_intervening_pivot",
		Candle: bar, PreviousClose: previous.Close, ConfirmedAt: bar.CloseTime, AvailableAt: bar.CloseTime}
	if direction == "bearish" {
		e.PenetrationPrice, e.CloseBackPrice = bar.High-level.Price, level.Price-bar.Close
	} else {
		e.PenetrationPrice, e.CloseBackPrice = level.Price-bar.Low, bar.Close-level.Price
	}
	if opposite != nil && opposite.OpenTime > level.OpenTime && opposite.AvailableAt < bar.OpenTime {
		e.TriggerStatus = "already_crossed"
		// A trigger already crossed before or on the sweep candle cannot be
		// represented later as a new, separately observed close-break.
		if !opposite.crossed && ((direction == "bearish" && bar.Close >= opposite.Price) ||
			(direction == "bullish" && bar.Close <= opposite.Price)) {
			e.Trigger, e.TriggerStatus = pointer(opposite.Pivot), "available"
		}
	}
	return pending{Event: e, sweepIndex: i, resolvedIndex: -1}
}

func (p *pending) advance(previous, bar market.Candle, i int, rules Rules) {
	lost := p.Direction == "bearish" && bar.Close > p.Level.Price ||
		p.Direction == "bullish" && bar.Close < p.Level.Price
	if lost {
		p.resolve("invalidated", "reclaimed_swing_level_lost_on_close", bar, i)
		return
	}
	if p.Trigger != nil {
		broken := p.Direction == "bearish" && previous.Close >= p.Trigger.Price && bar.Close < p.Trigger.Price ||
			p.Direction == "bullish" && previous.Close <= p.Trigger.Price && bar.Close > p.Trigger.Price
		if broken {
			p.FollowThroughAt, p.FollowThroughClose = pointer(bar.CloseTime), pointer(bar.Close)
			p.resolve("follow_through", "subsequent_close_broke_frozen_opposite_swing", bar, i)
			return
		}
	}
	if i-p.sweepIndex >= rules.ExpiryBars {
		p.resolve("expired", "no_subsequent_structure_close_break_within_window", bar, i)
	}
}

func (p *pending) resolve(state, reason string, bar market.Candle, i int) {
	p.State, p.ResolutionReason, p.AvailableAt = state, reason, bar.CloseTime
	p.ResolvedAt, p.resolvedIndex = pointer(bar.CloseTime), i
}

func validate(candles []market.Candle) string {
	for i, candle := range candles {
		if !candle.Valid() {
			return fmt.Sprintf("invalid candle at index %d; swing-failure evidence unavailable", i)
		}
		if !market.SameInterval(candles[0], candle) {
			return fmt.Sprintf("changed candle duration at index %d; swing-failure evidence unavailable", i)
		}
		if i > 0 && candle.OpenTime != candles[i-1].CloseTime+1 {
			return fmt.Sprintf("candle gap, overlap or ordering error at index %d; swing-failure evidence unavailable", i)
		}
	}
	return ""
}

func pointer[T any](value T) *T { return &value }

func clonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	return pointer(*value)
}

// CloneSnapshot gives the caller ownership of every mutable published value.
func CloneSnapshot(s Snapshot) Snapshot {
	s.AsOf, s.LatestHigh, s.LatestLow = clonePointer(s.AsOf), clonePointer(s.LatestHigh), clonePointer(s.LatestLow)
	s.Events = append([]Event{}, s.Events...)
	s.Warnings = append([]string{}, s.Warnings...)
	for i := range s.Events {
		e := &s.Events[i]
		e.Trigger = clonePointer(e.Trigger)
		e.FollowThroughAt, e.FollowThroughClose = clonePointer(e.FollowThroughAt), clonePointer(e.FollowThroughClose)
		e.ResolvedAt, e.BarsSinceResolution = clonePointer(e.ResolvedAt), clonePointer(e.BarsSinceResolution)
	}
	return s
}

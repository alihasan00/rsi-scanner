package market

import (
	"errors"
	"time"
)

// BoundaryGrace is the tolerated delivery delay/clock skew at a candle boundary.
const BoundaryGrace = 5 * time.Second

// IntervalDuration describes fixed intervals. Calendar months have no constant
// duration and return zero, true; unsupported intervals return zero, false.
func IntervalDuration(interval string) (time.Duration, bool) {
	switch interval {
	case "1M":
		return 0, true
	case "1w":
		return 7 * 24 * time.Hour, true
	case "3d":
		return 3 * 24 * time.Hour, true
	case "1d":
		return 24 * time.Hour, true
	default:
		if !supportedInterval(interval) {
			return 0, false
		}
		duration, err := time.ParseDuration(interval)
		return duration, err == nil
	}
}

func midnight(t time.Time) bool {
	return t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0
}

// CalendarMonth reports an exact UTC calendar-month candle, including leap years.
func CalendarMonth(c Candle) bool {
	open := time.UnixMilli(c.OpenTime).UTC()
	return c.Valid() && open.Day() == 1 && midnight(open) && open.AddDate(0, 1, 0).UnixMilli()-1 == c.CloseTime
}

// SameInterval accepts constant-duration analysis histories or calendar months.
// Continuity and OHLCV validity are checked separately by the caller. Recognizing
// months from exact boundaries avoids treating an arbitrary duration change as
// valid when a pure analyzer has no requested interval argument.
func SameInterval(reference, candle Candle) bool {
	if CalendarMonth(reference) {
		return CalendarMonth(candle)
	}
	return candle.CloseTime-candle.OpenTime == reference.CloseTime-reference.OpenTime
}

// ValidateInterval checks candle shape and the exchange's UTC boundaries.
// Three-day bars retain their exchange-provided phase instead of imposing a
// Unix-epoch phase that can reject otherwise valid Binance history.
func ValidateInterval(c Candle, interval string) error {
	if !c.Valid() {
		return errors.New("invalid OHLCV or timestamp")
	}
	if interval == "1M" {
		if !CalendarMonth(c) {
			return errors.New("not a UTC calendar-month candle")
		}
		return nil
	}
	duration, ok := IntervalDuration(interval)
	if !ok || c.CloseTime-c.OpenTime+1 != duration.Milliseconds() {
		return errors.New("candle duration does not match interval")
	}
	open := time.UnixMilli(c.OpenTime).UTC()
	if interval == "1w" {
		if open.Weekday() != time.Monday || !midnight(open) {
			return errors.New("weekly candle must open on Monday at 00:00 UTC")
		}
	} else if interval == "3d" {
		if !midnight(open) {
			return errors.New("three-day candle must open at 00:00 UTC")
		}
	} else if c.OpenTime%duration.Milliseconds() != 0 {
		return errors.New("candle open is not aligned to its UTC interval")
	}
	return nil
}

func validateResponse(closed []Candle, preview *Candle, interval string, now time.Time, latest bool) error {
	for _, candle := range closed {
		if err := ValidateInterval(candle, interval); err != nil {
			return err
		}
		if candle.CloseTime > now.Add(BoundaryGrace).UnixMilli() {
			return errors.New("closed candle ends in the future")
		}
	}
	if preview == nil {
		return errors.New("candle response has no provisional bar")
	}
	if err := ValidateInterval(*preview, interval); err != nil {
		return err
	}
	if preview.OpenTime > now.Add(BoundaryGrace).UnixMilli() {
		return errors.New("provisional candle opens in the future")
	}
	if latest {
		expected, _ := ExpectedClosedTime(now, interval, preview.OpenTime, BoundaryGrace)
		if preview.OpenTime < expected+1 || len(closed) > 0 && closed[len(closed)-1].CloseTime < expected {
			return errors.New("latest candle response is stale")
		}
	}
	return nil
}

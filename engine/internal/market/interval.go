package market

import "time"

// ExpectedClosedTime returns the inclusive close time of the latest bar that
// should be available after grace. Weeks start on Monday in UTC, months follow
// the UTC calendar, and latestOpening preserves Binance's three-day phase.
// Unsupported intervals and negative grace return false.
func ExpectedClosedTime(now time.Time, interval string, latestOpening int64, grace time.Duration) (int64, bool) {
	if grace < 0 || !supportedInterval(interval) {
		return 0, false
	}
	t := now.UTC().Add(-grace)
	var start time.Time
	switch interval {
	case "1M":
		start = time.Date(t.Year(), t.Month(), 1, 0, 0, 0, 0, time.UTC)
	case "1w":
		day := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
		start = day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
	case "3d":
		if latestOpening < 0 {
			return 0, false
		}
		const width = int64((72 * time.Hour) / time.Millisecond)
		delta := t.UnixMilli() - latestOpening
		steps := delta / width
		if delta < 0 && delta%width != 0 {
			steps--
		}
		start = time.UnixMilli(latestOpening + steps*width)
	case "1d":
		start = t.Truncate(24 * time.Hour)
	default:
		duration, err := time.ParseDuration(interval)
		if err != nil {
			return 0, false
		}
		start = t.Truncate(duration)
	}
	return start.UnixMilli() - 1, true
}

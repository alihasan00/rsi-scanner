package market

import (
	"testing"
	"time"
)

func intervalTime(value string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		panic(err)
	}
	return t
}

func TestExpectedClosedTimeBoundariesAndCalendars(t *testing.T) {
	for _, test := range []struct {
		name, interval, now, anchor, next string
	}{
		{"daily bar can be hours old", "1d", "2026-09-25T12:34:00Z", "", "2026-09-25T00:00:00Z"},
		{"four-hour boundary", "4h", "2026-09-25T12:00:05Z", "", "2026-09-25T12:00:00Z"},
		{"hourly grace before expiry", "1h", "2026-09-25T12:00:04.999Z", "", "2026-09-25T11:00:00Z"},
		{"hourly grace expires exactly", "1h", "2026-09-25T12:00:05Z", "", "2026-09-25T12:00:00Z"},
		{"quarter-hour boundary", "15m", "2026-09-25T12:30:05Z", "", "2026-09-25T12:30:00Z"},
		{"timezone uses UTC", "4h", "2026-09-25T17:00:05+05:00", "", "2026-09-25T12:00:00Z"},
		{"week before Monday boundary", "1w", "2026-09-28T00:00:04.999Z", "", "2026-09-21T00:00:00Z"},
		{"week after Monday boundary", "1w", "2026-09-28T00:00:05Z", "", "2026-09-28T00:00:00Z"},
		{"Sunday belongs to prior Monday", "1w", "2026-09-27T23:59:59Z", "", "2026-09-21T00:00:00Z"},
		{"month before grace expires", "1M", "2024-03-01T00:00:04.999Z", "", "2024-02-01T00:00:00Z"},
		{"leap February complete", "1M", "2024-03-01T00:00:05Z", "", "2024-03-01T00:00:00Z"},
		{"year rollover", "1M", "2027-01-01T00:00:05Z", "", "2027-01-01T00:00:00Z"},
		{"three-day phase", "3d", "2026-09-25T12:00:00Z", "2026-09-22T00:00:00Z", "2026-09-25T00:00:00Z"},
		{"three-day different phase", "3d", "2026-09-25T12:00:00Z", "2026-09-23T00:00:00Z", "2026-09-23T00:00:00Z"},
		{"three-day grace before anchor", "3d", "2026-09-25T00:00:04Z", "2026-09-25T00:00:00Z", "2026-09-22T00:00:00Z"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var anchor int64
			if test.anchor != "" {
				anchor = intervalTime(test.anchor).UnixMilli()
			}
			got, ok := ExpectedClosedTime(intervalTime(test.now), test.interval, anchor, 5*time.Second)
			want := intervalTime(test.next).UnixMilli() - 1
			if !ok || got != want {
				t.Fatalf("expected close=%s ok=%v, want=%s", time.UnixMilli(got).UTC(), ok, time.UnixMilli(want).UTC())
			}
		})
	}
}

func TestExpectedClosedTimeSupportsSpotIntervalsAndRejectsInvalidInputs(t *testing.T) {
	now := intervalTime("2026-09-25T12:34:56Z")
	for _, interval := range SupportedIntervals {
		if _, ok := ExpectedClosedTime(now, interval, now.Truncate(24*time.Hour).UnixMilli(), 0); !ok {
			t.Errorf("supported interval %q rejected", interval)
		}
	}
	for _, input := range []struct {
		interval string
		anchor   int64
		grace    time.Duration
	}{{"1H", 0, 0}, {"2d", 0, 0}, {"1h", 0, -time.Second}, {"3d", -1, 0}} {
		if _, ok := ExpectedClosedTime(now, input.interval, input.anchor, input.grace); ok {
			t.Errorf("accepted invalid interval input: %+v", input)
		}
	}
}

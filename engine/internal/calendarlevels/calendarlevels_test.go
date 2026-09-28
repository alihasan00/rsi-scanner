package calendarlevels

import (
	"encoding/json"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
)

const quarterHour = int64(15 * 60 * 1000)

func timestamp(value string) int64 {
	t, err := time.Parse(time.RFC3339, value)
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}

func candle(openTime, duration int64, open, high, low, close float64) market.Candle {
	return market.Candle{OpenTime: openTime, CloseTime: openTime + duration - 1,
		Open: open, High: high, Low: low, Close: close, Volume: 17}
}

func dailyBetween(start, end string) []market.Candle {
	var days []market.Candle
	for at, limit := timestamp(start), timestamp(end); at < limit; at += dayMillis {
		days = append(days, candle(at, dayMillis, 100, 110, 90, 102))
	}
	return days
}

func TestMonthlyReactionsUseCalendarDurations(t *testing.T) {
	jan, feb, march := timestamp("2024-01-01T00:00:00Z"), timestamp("2024-02-01T00:00:00Z"), timestamp("2024-03-01T00:00:00Z")
	months := []market.Candle{candle(jan, feb-jan, 100, 110, 90, 102), candle(feb, march-feb, 100, 110, 90, 102)}
	days := dailyBetween("2023-12-01T00:00:00Z", "2024-03-01T00:00:00Z")
	if got := Analyze(days, months, march); got.ReactionStatus != "ready" {
		t.Fatalf("valid leap-February month rejected: %s", got.ReactionStatus)
	}
	if got := Analyze(days, months[:1], march); got.ReactionStatus != "stale" {
		t.Fatalf("missing complete February not detected: %s", got.ReactionStatus)
	}
}

func source(t *testing.T, s Snapshot, name string) SourceStatus {
	t.Helper()
	for _, source := range s.Sources {
		if source.Source == name {
			return source
		}
	}
	t.Fatalf("missing %s source: %+v", name, s.Sources)
	return SourceStatus{}
}

func level(t *testing.T, s Snapshot, source, label string) Level {
	t.Helper()
	for _, level := range s.Levels {
		if level.Source == source && level.Label == label {
			return level
		}
	}
	t.Fatalf("missing %s %s level: %+v", source, label, s.Levels)
	return Level{}
}

func eventsFor(s Snapshot, source, label string) []Event {
	var events []Event
	for _, event := range s.Events {
		if event.Level.Source == source && event.Level.Label == label {
			events = append(events, event)
		}
	}
	return events
}

func TestCalendarPeriodsUseCompleteUTCMonthAndWeek(t *testing.T) {
	for _, tt := range []struct {
		name, start, asOf, monthStart, monthEnd, weekStart, weekEnd string
		monthDays                                                   int
	}{
		{"leap February", "2024-01-01T00:00:00Z", "2024-03-01T12:00:00Z", "2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z", "2024-02-19T00:00:00Z", "2024-02-26T00:00:00Z", 29},
		{"cross year", "2020-11-01T00:00:00Z", "2021-01-01T12:00:00Z", "2020-12-01T00:00:00Z", "2021-01-01T00:00:00Z", "2020-12-21T00:00:00Z", "2020-12-28T00:00:00Z", 31},
	} {
		t.Run(tt.name, func(t *testing.T) {
			asOf := timestamp(tt.asOf)
			daily := dailyBetween(tt.start, tt.monthEnd)
			for i := range daily {
				if daily[i].OpenTime == timestamp(tt.monthStart) {
					daily[i].Open = 99
				}
				if daily[i].OpenTime == timestamp(tt.monthStart)+10*dayMillis {
					daily[i].High, daily[i].Low = 125, 80
				}
				if daily[i].CloseTime == timestamp(tt.monthEnd)-1 {
					daily[i].Close = 107
				}
			}
			s := Analyze(daily, []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 104, 96, 100)}, asOf)
			if s.Status != "ready" || s.ReactionStatus != "ready" || len(s.Levels) != 11 {
				t.Fatalf("expected fully ready calendar evidence: %+v", s)
			}
			month := source(t, s, "month")
			if month.PeriodStart != timestamp(tt.monthStart) || month.PeriodEnd != timestamp(tt.monthEnd) || month.ExpectedBars != tt.monthDays || month.AvailableBars != tt.monthDays {
				t.Fatalf("wrong completed month: %+v", month)
			}
			week := source(t, s, "week")
			if week.PeriodStart != timestamp(tt.weekStart) || week.PeriodEnd != timestamp(tt.weekEnd) || week.ExpectedBars != 7 || week.AvailableBars != 7 {
				t.Fatalf("wrong completed week: %+v", week)
			}
			for name, want := range map[string]float64{"open": 99, "high": 125, "low": 80, "close": 107} {
				if got := level(t, s, "month", "Previous month "+name).Price; got != want {
					t.Fatalf("monthly %s got %v, want %v", name, got, want)
				}
			}
		})
	}
}

func TestMondayBodyReplacesOnlyAtTuesdayBoundary(t *testing.T) {
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-29T00:00:00Z")
	for i := range daily {
		if daily[i].OpenTime == timestamp("2026-09-28T00:00:00Z") {
			daily[i] = candle(daily[i].OpenTime, dayMillis, 120, 150, 95, 110)
		}
	}
	for _, tt := range []struct {
		name, asOf, monday string
		low, mid, high     float64
	}{
		{"new Monday still forming", "2026-09-28T12:00:00Z", "2026-09-21T00:00:00Z", 100, 101, 102},
		{"new Monday final", "2026-09-29T00:00:00Z", "2026-09-28T00:00:00Z", 110, 115, 120},
	} {
		t.Run(tt.name, func(t *testing.T) {
			asOf := timestamp(tt.asOf)
			s := Analyze(daily, []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 105, 95, 100)}, asOf)
			monday := source(t, s, "monday")
			if monday.PeriodStart != timestamp(tt.monday) || monday.PeriodEnd != timestamp(tt.monday)+dayMillis {
				t.Fatalf("wrong Monday: %+v", monday)
			}
			for name, want := range map[string]float64{"low": tt.low, "midpoint": tt.mid, "high": tt.high} {
				l := level(t, s, "monday", "Monday body "+name)
				if l.Price != want || l.AvailableFrom != monday.PeriodEnd || l.ExpiresAt != monday.PeriodEnd+weekMillis {
					t.Fatalf("incorrect Monday body %s: %+v", name, l)
				}
			}
		})
	}
	// Missing the latest Monday must not carry last week's completed body ahead.
	asOf := timestamp("2026-09-29T00:00:00Z")
	s := Analyze(daily[:len(daily)-1], []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 105, 95, 100)}, asOf)
	if got := source(t, s, "monday"); got.Status != "insufficient" || got.AvailableBars != 0 {
		t.Fatalf("missing Monday was substituted: %+v", got)
	}
	for _, level := range s.Levels {
		if level.Source == "monday" {
			t.Fatal("expired Monday survived its Tuesday replacement")
		}
	}
}

func TestMondayIsIntradayOnlyAndDojiKeepsAllLabels(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	for i := range daily {
		if daily[i].OpenTime == timestamp("2026-09-21T00:00:00Z") {
			daily[i].Close = daily[i].Open
		}
	}
	s := Analyze(daily, []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 105, 95, 100)}, asOf)
	ids := map[string]bool{}
	for _, label := range []string{"low", "midpoint", "high"} {
		l := level(t, s, "monday", "Monday body "+label)
		if l.Price != 100 || l.Role != "at" || l.DistancePct == nil || *l.DistancePct != 0 || ids[l.ID] {
			t.Fatalf("doji lost independent source label: %+v", l)
		}
		ids[l.ID] = true
	}
	s = Analyze(daily, daily, asOf)
	if source(t, s, "monday").Status != "not_applicable" || len(s.Levels) != 8 {
		t.Fatalf("Monday body leaked onto daily interval: %+v", s)
	}
}

func TestSourceCoverageNeverUsesPartialOHLC(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	filtered := make([]market.Candle, 0, len(daily))
	for _, bar := range daily {
		if bar.OpenTime != timestamp("2026-08-15T00:00:00Z") {
			filtered = append(filtered, bar)
		}
	}
	s := Analyze(filtered, []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 105, 95, 100)}, asOf)
	month := source(t, s, "month")
	if s.Status != "partial" || month.Status != "insufficient" || month.ExpectedBars != 31 || month.AvailableBars != 30 || month.Reason == "" {
		t.Fatalf("missing day did not stay explicit: %+v", s)
	}
	if source(t, s, "week").Status != "ready" || source(t, s, "monday").Status != "ready" || len(s.Levels) != 7 {
		t.Fatalf("independent complete sources were lost: %+v", s)
	}
	// Starting midway through the required week must not aggregate a short week.
	truncated := dailyBetween("2026-09-15T00:00:00Z", "2026-09-26T00:00:00Z")
	s = Analyze(truncated, []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 105, 95, 100)}, asOf)
	if week := source(t, s, "week"); week.Status != "insufficient" || week.AvailableBars != 6 {
		t.Fatalf("truncated week accepted: %+v", week)
	}
}

func TestMalformedDailyHistoryIsRejectedWithoutRepair(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	for name, mutate := range map[string]func([]market.Candle) []market.Candle{
		"duplicate": func(b []market.Candle) []market.Candle {
			return append(b[:1], append([]market.Candle{b[0]}, b[1:]...)...)
		},
		"out of order":    func(b []market.Candle) []market.Candle { b[0], b[1] = b[1], b[0]; return b },
		"wrong duration":  func(b []market.Candle) []market.Candle { b[0].CloseTime--; return b },
		"misaligned day":  func(b []market.Candle) []market.Candle { b[0].OpenTime++; b[0].CloseTime++; return b },
		"bad prices":      func(b []market.Candle) []market.Candle { b[0].High = b[0].Low; return b },
		"negative volume": func(b []market.Candle) []market.Candle { b[0].Volume = -1; return b },
		"nonfinite price": func(b []market.Candle) []market.Candle { b[0].Close = math.NaN(); return b },
	} {
		t.Run(name, func(t *testing.T) {
			daily := mutate(dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z"))
			s := Analyze(daily, []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 105, 95, 100)}, asOf)
			if s.Status != "invalid" || len(s.Levels) != 0 || len(s.Events) != 0 || source(t, s, "week").Status != "invalid" {
				t.Fatalf("malformed history silently repaired: %+v", s)
			}
		})
	}
}

func TestStrictSweepsAreMirroredAndMeasured(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	for _, tt := range []struct {
		direction, label string
		previous, bar    market.Candle
	}{
		{"bullish", "Previous week low", candle(asOf-2*quarterHour, quarterHour, 92, 94, 91, 92), candle(asOf-quarterHour, quarterHour, 92, 94, 88, 93)},
		{"bearish", "Previous week high", candle(asOf-2*quarterHour, quarterHour, 108, 109, 106, 108), candle(asOf-quarterHour, quarterHour, 108, 112, 106, 107)},
	} {
		t.Run(tt.direction, func(t *testing.T) {
			s := Analyze(daily, []market.Candle{tt.previous, tt.bar}, asOf)
			events := eventsFor(s, "week", tt.label)
			if len(events) != 1 {
				t.Fatalf("expected one mirrored sweep: %+v", events)
			}
			e := events[0]
			if e.State != "confirmed" || e.Direction != tt.direction || e.ConfirmedAt != tt.bar.CloseTime || e.BarsAgo != 0 ||
				e.Candle != tt.bar || e.PreviousClose != tt.previous.Close || e.PenetrationPrice != 2 || e.CloseBackPrice != 3 {
				t.Fatalf("incorrect measured event: %+v", e)
			}
		})
	}
}

func TestTouchesEqualityAndWrongApproachDoNotConfirm(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	for _, direction := range []string{"bullish", "bearish"} {
		for _, failure := range []string{"wick touch", "equal close", "equal approach", "wrong approach"} {
			t.Run(direction+"/"+failure, func(t *testing.T) {
				previous := candle(asOf-2*quarterHour, quarterHour, 92, 94, 88, 92)
				bar := candle(asOf-quarterHour, quarterHour, 92, 94, 88, 93)
				label := "Previous week low"
				if direction == "bullish" {
					switch failure {
					case "wick touch":
						bar.Low = 90
					case "equal close":
						bar.Close = 90
					case "equal approach":
						previous.Close = 90
					case "wrong approach":
						previous.Close = 89
					}
				} else {
					previous = candle(previous.OpenTime, quarterHour, 108, 112, 106, 108)
					bar = candle(bar.OpenTime, quarterHour, 108, 112, 106, 107)
					label = "Previous week high"
					switch failure {
					case "wick touch":
						bar.High = 110
					case "equal close":
						bar.Close = 110
					case "equal approach":
						previous.Close = 110
					case "wrong approach":
						previous.Close = 111
					}
				}
				if events := eventsFor(Analyze(daily, []market.Candle{previous, bar}, asOf), "week", label); len(events) != 0 {
					t.Fatalf("strict %s comparison admitted %s: %+v", direction, failure, events)
				}
			})
		}
	}
}

func TestReactionGapStalenessAndInvalidHistory(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	previous := candle(asOf-2*quarterHour, quarterHour, 92, 94, 91, 92)
	bar := candle(asOf-quarterHour, quarterHour, 92, 94, 88, 93)
	gapped := previous
	gapped.OpenTime -= quarterHour
	gapped.CloseTime -= quarterHour
	s := Analyze(daily, []market.Candle{gapped, bar}, asOf)
	if s.ReactionStatus != "ready" || len(s.Events) != 0 {
		t.Fatalf("gap was used as a contiguous approach: %+v", s)
	}
	// A gap earlier in history does not invalidate a later, complete approach pair.
	earlier := candle(asOf-4*quarterHour, quarterHour, 92, 94, 91, 92)
	s = Analyze(daily, []market.Candle{earlier, previous, bar}, asOf)
	if len(eventsFor(s, "week", "Previous week low")) != 1 {
		t.Fatal("unrelated older gap suppressed a contiguous recent observation")
	}
	oldPrevious := candle(asOf-6*quarterHour, quarterHour, 92, 94, 91, 92)
	oldSweep := candle(asOf-5*quarterHour, quarterHour, 92, 94, 88, 93)
	latest := candle(asOf-quarterHour, quarterHour, 92, 94, 91, 92)
	s = Analyze(daily, []market.Candle{oldPrevious, oldSweep, latest}, asOf)
	if len(s.Events) != 0 {
		t.Fatal("missing candles compressed an older sweep into the latest three intervals")
	}
	s = Analyze(daily, []market.Candle{previous, bar}, asOf+quarterHour)
	if s.ReactionStatus != "stale" || len(s.Events) != 0 || s.ReferenceClose == nil || *s.ReferenceClose != bar.Close {
		t.Fatalf("stale reference was presented as fresh: %+v", s)
	}
	for _, l := range s.Levels {
		if l.Role != "unavailable" || l.DistancePct != nil {
			t.Fatal("stale reference produced current level distances")
		}
	}
	if got := Analyze(daily, []market.Candle{previous, bar}, asOf+quarterHour-1); got.ReactionStatus != "ready" {
		t.Fatal("reference became stale before the next candle completed")
	}
	for name, bars := range map[string][]market.Candle{
		"duplicate":          {previous, previous, bar},
		"out of order":       {bar, previous},
		"different duration": {previous, candle(bar.OpenTime, quarterHour-1, 92, 94, 88, 93)},
		"overlap":            {previous, candle(bar.OpenTime-1, quarterHour, 92, 94, 88, 93)},
		"negative volume":    {previous, {OpenTime: bar.OpenTime, CloseTime: bar.CloseTime, Open: 92, High: 94, Low: 88, Close: 93, Volume: -1}},
	} {
		t.Run(name, func(t *testing.T) {
			s := Analyze(daily, bars, asOf)
			if s.ReactionStatus != "invalid" || len(s.Events) != 0 || s.ReferenceClose != nil {
				t.Fatalf("invalid reactions admitted: %+v", s)
			}
		})
	}
}

func TestOnlyLatestThreeCompletedReactionsAreReported(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	var bars []market.Candle
	for i := 5; i > 0; i-- {
		bars = append(bars, candle(asOf-int64(i)*quarterHour, quarterHour, 92, 94, 88, 92))
	}
	s := Analyze(daily, bars, asOf)
	events := eventsFor(s, "week", "Previous week low")
	if len(events) != 3 {
		t.Fatalf("wrong event recency window: %+v", events)
	}
	for i, event := range events {
		if event.BarsAgo != i || event.ConfirmedAt != bars[4-i].CloseTime {
			t.Fatalf("events not ordered by completed recency: %+v", events)
		}
	}
}

func TestFutureAndUnfinishedCandlesCannotChangeFrozenEvidence(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	bars := []market.Candle{candle(asOf-2*quarterHour, quarterHour, 92, 94, 91, 92), candle(asOf-quarterHour, quarterHour, 92, 94, 88, 93)}
	want := Analyze(daily, bars, asOf)
	futureDays := append(append([]market.Candle{}, daily...), dailyBetween("2026-09-26T00:00:00Z", "2026-10-02T00:00:00Z")...)
	// Even malformed future values are outside this watermark's evidence.
	futureDays[len(futureDays)-1].High = math.NaN()
	futureBars := append(append([]market.Candle{}, bars...), candle(asOf, quarterHour, 500, 1000, 1, 700))
	futureBars = append(futureBars, candle(asOf+quarterHour, quarterHour, 500, 1000, 1, 700))
	futureBars[len(futureBars)-1].Volume = math.NaN()
	if got := Analyze(futureDays, futureBars, asOf); !reflect.DeepEqual(got, want) {
		t.Fatalf("future candles changed frozen evidence:\ngot %+v\nwant %+v", got, want)
	}
	if got := Analyze(daily, bars, bars[1].CloseTime); got.ReferenceClosedAt == nil || *got.ReferenceClosedAt != bars[0].CloseTime {
		t.Fatal("candle closing exactly at asOf was treated as already completed")
	}
}

func TestRecentSweepKeepsItsHistoricalLevelAcrossWeeklyRollover(t *testing.T) {
	asOf := timestamp("2026-09-28T00:15:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-28T00:00:00Z")
	for i := range daily {
		if daily[i].OpenTime >= timestamp("2026-09-21T00:00:00Z") {
			daily[i].High = 130
		}
	}
	bars := []market.Candle{
		candle(asOf-4*quarterHour, quarterHour, 108, 109, 106, 108),
		candle(asOf-3*quarterHour, quarterHour, 108, 112, 106, 107),
		candle(asOf-2*quarterHour, quarterHour, 108, 109, 106, 108),
		candle(asOf-quarterHour, quarterHour, 108, 109, 106, 108),
	}
	s := Analyze(daily, bars, asOf)
	current := level(t, s, "week", "Previous week high")
	events := eventsFor(s, "week", "Previous week high")
	if current.Price != 130 || current.PeriodStart != timestamp("2026-09-21T00:00:00Z") || len(events) != 1 {
		t.Fatalf("wrong rolled calendar or recent events: current %+v events %+v", current, events)
	}
	e := events[0]
	if e.Level.Price != 110 || e.Level.PeriodStart != timestamp("2026-09-14T00:00:00Z") || e.Level.ExpiresAt != timestamp("2026-09-28T00:00:00Z") || e.BarsAgo != 2 || e.ConfirmedAt != bars[1].CloseTime {
		t.Fatalf("historical event was rewritten using new levels: %+v", e)
	}
	// Current calendar sources stay complete, but the old event's own source is
	// now missing a daily candle and therefore cannot be reconstructed.
	var missing []market.Candle
	for _, bar := range daily {
		if bar.OpenTime != timestamp("2026-09-16T00:00:00Z") {
			missing = append(missing, bar)
		}
	}
	s = Analyze(missing, bars, asOf)
	if s.Status != "ready" || len(eventsFor(s, "week", "Previous week high")) != 0 {
		t.Fatalf("historical event used an incomplete source period: %+v", s)
	}
}

func TestSweepsRequireLevelAvailableForEntireReactionCandle(t *testing.T) {
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-28T00:00:00Z")
	for i := range daily {
		if daily[i].OpenTime >= timestamp("2026-09-21T00:00:00Z") {
			daily[i].High = 130
		}
	}
	rollover := timestamp("2026-09-28T00:00:00Z")
	fourHours := int64(4 * 60 * 60 * 1000)
	bars := []market.Candle{
		candle(rollover-6*60*60*1000, fourHours, 108, 109, 106, 108),
		candle(rollover-2*60*60*1000, fourHours, 108, 132, 106, 107),
	}
	s := Analyze(daily, bars, rollover+2*60*60*1000)
	if len(eventsFor(s, "week", "Previous week high")) != 0 {
		t.Fatalf("straddling candle swept a level unavailable for the full candle: %+v", s.Events)
	}
	// A candle opening exactly at publication may use the new weekly reference.
	bars = []market.Candle{
		candle(rollover-quarterHour, quarterHour, 125, 128, 124, 125),
		candle(rollover, quarterHour, 125, 132, 124, 127),
	}
	s = Analyze(daily, bars, rollover+quarterHour)
	events := eventsFor(s, "week", "Previous week high")
	if len(events) != 1 || events[0].Level.Price != 130 || events[0].Level.AvailableFrom != rollover {
		t.Fatalf("newly published reference was not usable at its exact boundary: %+v", events)
	}
}

func TestLevelsUseClosedReferenceAndMissingValuesAreNull(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	s := Analyze(daily, []market.Candle{candle(asOf-quarterHour, quarterHour, 100, 105, 95, 100)}, asOf)
	for label, wantRole := range map[string]string{"low": "support", "high": "resistance", "open": "at"} {
		l := level(t, s, "week", "Previous week "+label)
		wantDistance := 10.0
		if label == "open" {
			wantDistance = 0
		}
		if l.Role != wantRole || l.DistancePct == nil || *l.DistancePct != wantDistance {
			t.Fatalf("wrong completed-close relationship: %+v", l)
		}
	}
	empty := Analyze(nil, nil, asOf)
	if empty.Status != "insufficient" || empty.ReactionStatus != "insufficient" || empty.ReferenceClose != nil || empty.ReferenceClosedAt != nil || len(empty.Levels) != 0 || len(empty.Events) != 0 {
		t.Fatalf("empty input invented evidence: %+v", empty)
	}
	encoded, err := json.Marshal(empty)
	if err != nil || !strings.Contains(string(encoded), `"referenceClose":null`) || !strings.Contains(string(encoded), `"levels":[]`) || !strings.Contains(string(encoded), `"events":[]`) {
		t.Fatalf("missing values were not explicit in JSON: %s, %v", encoded, err)
	}
	for _, invalid := range []int64{-1, maxSafeInteger + 1} {
		if got := Analyze(daily, nil, invalid); got.Status != "invalid" || got.ReactionStatus != "invalid" || len(got.Levels) != 0 {
			t.Fatalf("invalid clock accepted: %+v", got)
		}
	}
}

func TestInputsAndPublishedSnapshotsOwnTheirData(t *testing.T) {
	asOf := timestamp("2026-09-26T12:00:00Z")
	daily := dailyBetween("2026-08-01T00:00:00Z", "2026-09-26T00:00:00Z")
	bars := []market.Candle{candle(asOf-2*quarterHour, quarterHour, 92, 94, 91, 92), candle(asOf-quarterHour, quarterHour, 92, 94, 88, 93)}
	dailyBefore, barsBefore := append([]market.Candle{}, daily...), append([]market.Candle{}, bars...)
	s := Analyze(daily, bars, asOf)
	if !reflect.DeepEqual(daily, dailyBefore) || !reflect.DeepEqual(bars, barsBefore) {
		t.Fatal("analyzing calendar levels mutated supplied candles")
	}
	before, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	clone := CloneSnapshot(s)
	*clone.ReferenceClose, *clone.ReferenceClosedAt = 1, 1
	clone.Sources[0].Status = "changed"
	clone.Levels[0].Price, *clone.Levels[0].DistancePct = 1, 1
	clone.Events[0].Candle.Close = 1
	clone.Events[0].Level.Price, *clone.Events[0].Level.DistancePct = 1, 1
	after, err := json.Marshal(s)
	if err != nil || string(before) != string(after) {
		t.Fatalf("cloned snapshot leaked mutable ownership: %s -> %s (%v)", before, after, err)
	}
}

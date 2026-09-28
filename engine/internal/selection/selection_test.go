package selection

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/regime"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/structure"
)

func selectionFixture(now time.Time, direction string, symbols ...string) (scanner.Snapshot, map[string]scanner.History) {
	snapshot := scanner.Snapshot{}
	histories := make(map[string]scanner.History)
	for _, symbol := range symbols {
		frames := []scanner.TimeframeContext{}
		for _, tf := range intervals {
			closedAt, _ := market.ExpectedClosedTime(now, tf, 0, market.BoundaryGrace)
			frames = append(frames, scanner.TimeframeContext{Interval: tf, Availability: "ready", LastClosedAt: &closedAt, Trend: direction, InternalBias: direction})
			snapshot.Series = append(snapshot.Series, scanner.SeriesSummary{
				Symbol: symbol, Interval: tf, Price: 100, LastClosedAt: closedAt, ObservedAt: now.Add(-time.Second),
				Analysis: scanner.SeriesAnalysis{
					Regime:    regime.Snapshot{Ready: true, Direction: direction, ClosedAt: &closedAt},
					Structure: structure.Snapshot{Status: "ready", Internal: structure.State{Bias: direction}},
				},
			})
			if tf == "15m" {
				bars := []market.Candle{}
				for i := 7; i >= 0; i-- {
					close := closedAt - int64(i)*(15*time.Minute).Milliseconds()
					bars = append(bars, market.Candle{OpenTime: close - (15 * time.Minute).Milliseconds() + 1, CloseTime: close, Open: 100, Close: 100, High: 101, Low: 99})
				}
				histories[pair(symbol, tf)] = scanner.History{Candles: bars}
			}
		}
		closedAt, _ := market.ExpectedClosedTime(now, "1h", 0, market.BoundaryGrace)
		atr, sign := 10.0, directionSign(direction)
		snapshot.Rows = append(snapshot.Rows, scanner.Row{
			Symbol: symbol, Interval: "1h", Price: 100, LastClosedAt: closedAt, ObservedAt: now.Add(-time.Second),
			Pattern: harmonic.Pattern{
				ID: symbol + "-setup", Kind: "bat", Direction: direction, Stage: "confirmed", Status: "active", Score: 95,
				Entry: 100, Stop: 100 - sign*10, Target1: 100 + sign*20, Target2: 100 + sign*40,
				D:          &harmonic.Point{Time: closedAt - time.Hour.Milliseconds(), Price: 100},
				DetectedAt: closedAt - time.Hour.Milliseconds(), ConfirmedAt: closedAt, LevelsEstablishedAt: closedAt,
			},
			Rank: scanner.Rank{Order: 1, Tier: scanner.TierConfirmedWithTrendTightStop},
			Decision: scanner.Decision{Status: "aligned", ContextComplete: true, Timeframes: frames,
				Confirmation: scanner.Confirmation{Interval: "15m", Status: "waiting"},
				Risk:         scanner.RiskContext{ATR: &atr, ReferencePrice: 100, ReferenceClosedAt: closedAt}},
		})
	}
	return snapshot, histories
}

func selectionSeries(snapshot *scanner.Snapshot, symbol, interval string) *scanner.SeriesSummary {
	for i := range snapshot.Series {
		if snapshot.Series[i].Symbol == symbol && snapshot.Series[i].Interval == interval {
			return &snapshot.Series[i]
		}
	}
	panic("fixture series not found")
}

func selectionFrame(row *scanner.Row, interval string) *scanner.TimeframeContext {
	for i := range row.Decision.Timeframes {
		if row.Decision.Timeframes[i].Interval == interval {
			return &row.Decision.Timeframes[i]
		}
	}
	panic("fixture frame not found")
}

func selectionConfirm(row *scanner.Row) {
	closed := *selectionFrame(row, "15m").LastClosedAt
	age := 0
	row.Decision.Confirmation = scanner.Confirmation{
		Interval: "15m", Status: "confirmed", AfterSetup: true, BarsAgo: &age,
		Event: &structure.Break{Type: "BOS", Direction: string(row.Pattern.Direction), ConfirmedAt: closed, Level: 100},
	}
}

func TestAssessDirectionMirrorsAndNeverUsesDAlone(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		opposite := "bearish"
		if direction == "bearish" {
			opposite = "bullish"
		}
		for _, test := range []struct {
			name string
			edit func(*scanner.Row)
			mode string
		}{
			{"aligned watch without timing", func(*scanner.Row) {}, ModeTrendAligned},
			{"aligned potential", func(r *scanner.Row) { r.Pattern.Stage, r.Pattern.D, r.Pattern.ConfirmedAt = "potential", nil, 0 }, ModeTrendAligned},
			{"D cannot bypass local trend", func(r *scanner.Row) { selectionFrame(r, "1h").Trend = opposite }, ""},
			{"D cannot bypass local structure", func(r *scanner.Row) { selectionFrame(r, "1h").InternalBias = opposite }, ""},
			{"D cannot bypass 15m trend", func(r *scanner.Row) { selectionFrame(r, "15m").Trend = opposite }, ""},
			{"D cannot bypass 15m structure", func(r *scanner.Row) { selectionFrame(r, "15m").InternalBias = opposite }, ""},
			{"confirmed reversal", func(r *scanner.Row) { selectionFrame(r, "1h").Trend = opposite; selectionConfirm(r) }, ModeConfirmedReversal},
			{"recent event cannot bypass current 15m trend", func(r *scanner.Row) { selectionConfirm(r); selectionFrame(r, "15m").Trend = opposite }, ""},
			{"stale", func(r *scanner.Row) { r.Stale = true }, ""},
			{"context incomplete", func(r *scanner.Row) { r.Decision.ContextComplete = false }, ""},
			{"context frame not ready", func(r *scanner.Row) { selectionFrame(r, "4h").Availability = "warming_up" }, ""},
		} {
			t.Run(direction+"/"+test.name, func(t *testing.T) {
				snapshot, _ := selectionFixture(now, direction, "BTCUSDT")
				row := snapshot.Rows[0]
				test.edit(&row)
				mode, reason, eligible := AssessDirection(row)
				if mode != test.mode || eligible != (test.mode != "") || reason == "" {
					t.Fatalf("assessment = %q %q %v; want mode %q", mode, reason, eligible, test.mode)
				}
			})
		}
	}
}

func TestCountertrendConfirmationMustBeCausalAndComplete(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, test := range []struct {
			name string
			edit func(*scanner.Row)
			want bool
		}{
			{"valid", func(*scanner.Row) {}, true},
			{"potential has no confirmed D", func(r *scanner.Row) { r.Pattern.Stage, r.Pattern.D = "potential", nil }, false},
			{"D missing", func(r *scanner.Row) { r.Pattern.D = nil }, false},
			{"future D", func(r *scanner.Row) { r.Pattern.ConfirmedAt = r.LastClosedAt + 1 }, false},
			{"not after setup", func(r *scanner.Row) { r.Decision.Confirmation.AfterSetup = false }, false},
			{"missing event", func(r *scanner.Row) { r.Decision.Confirmation.Event = nil }, false},
			{"missing age", func(r *scanner.Row) { r.Decision.Confirmation.BarsAgo = nil }, false},
			{"negative age", func(r *scanner.Row) { *r.Decision.Confirmation.BarsAgo = -1 }, false},
			{"configured age already accepted by scanner", func(r *scanner.Row) { *r.Decision.Confirmation.BarsAgo = 8 }, true},
			{"old event marked waiting", func(r *scanner.Row) { r.Decision.Confirmation.Status = "waiting" }, false},
			{"event before D", func(r *scanner.Row) { r.Decision.Confirmation.Event.ConfirmedAt = r.Pattern.ConfirmedAt - 1 }, false},
			{"event before later detection", func(r *scanner.Row) { r.Pattern.DetectedAt = r.Decision.Confirmation.Event.ConfirmedAt + 1 }, false},
			{"future event", func(r *scanner.Row) { r.Decision.Confirmation.Event.ConfirmedAt++ }, false},
			{"wrong event direction", func(r *scanner.Row) { r.Decision.Confirmation.Event.Direction = "neutral" }, false},
			{"wrong interval", func(r *scanner.Row) { r.Decision.Confirmation.Interval = "1h" }, false},
			{"unknown 15m close", func(r *scanner.Row) { selectionFrame(r, "15m").LastClosedAt = nil }, false},
		} {
			t.Run(direction+"/"+test.name, func(t *testing.T) {
				snapshot, _ := selectionFixture(now, direction, "BTCUSDT")
				row := snapshot.Rows[0]
				selectionFrame(&row, "1h").Trend = "neutral"
				selectionConfirm(&row)
				test.edit(&row)
				mode, _, got := AssessDirection(row)
				if got != test.want || got && mode != ModeConfirmedReversal {
					t.Fatalf("reversal = %q %v, want eligible %v", mode, got, test.want)
				}
			})
		}
	}
}

func TestOwnTimeframeAndHourlyDirectionAreSeparateRequirements(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, interval := range []string{"1d", "4h", "15m"} {
			snapshot, _ := selectionFixture(now, direction, "BTCUSDT")
			row := snapshot.Rows[0]
			row.Interval = interval
			row.LastClosedAt = *selectionFrame(&row, interval).LastClosedAt
			row.Pattern.ConfirmedAt = row.LastClosedAt
			row.Pattern.DetectedAt = row.LastClosedAt - time.Hour.Milliseconds()
			if _, _, eligible := AssessDirection(row); !eligible {
				t.Fatalf("aligned %s %s row did not qualify", direction, interval)
			}
			selectionFrame(&row, "1h").Trend = "neutral"
			if _, _, eligible := AssessDirection(row); eligible {
				t.Fatalf("%s own timeframe bypassed 1h agreement", interval)
			}
			selectionConfirm(&row)
			if mode, _, eligible := AssessDirection(row); !eligible || mode != ModeConfirmedReversal {
				t.Fatalf("%s explicit reversal exception failed: %q %v", interval, mode, eligible)
			}
		}
	}
}

func TestPriceRiskBoundariesAndLifecycle(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		sign := directionSign(direction)
		for _, test := range []struct {
			name string
			edit func(*scanner.Row, *scanner.SeriesSummary)
			want bool
		}{
			{"valid", func(*scanner.Row, *scanner.SeriesSummary) {}, true},
			{"quote at stop", func(r *scanner.Row, s *scanner.SeriesSummary) { s.Price = r.Pattern.Stop }, false},
			{"quote at target", func(r *scanner.Row, s *scanner.SeriesSummary) { s.Price = r.Pattern.Target1 }, false},
			{"closed reference at stop", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Decision.Risk.ReferencePrice = r.Pattern.Stop }, false},
			{"closed reference at target", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Decision.Risk.ReferencePrice = r.Pattern.Target1 }, false},
			{"one to one RR", func(_ *scanner.Row, s *scanner.SeriesSummary) { s.Price = 100 + sign*5 }, true},
			{"less than one to one RR", func(_ *scanner.Row, s *scanner.SeriesSummary) { s.Price = 100 + sign*5.01 }, false},
			{"exactly one ATR from entry", func(r *scanner.Row, s *scanner.SeriesSummary) {
				r.Pattern.Stop = 100 - sign*20
				s.Price = 100 - sign*10
			}, true},
			{"beyond one ATR from entry", func(r *scanner.Row, s *scanner.SeriesSummary) {
				r.Pattern.Stop = 100 - sign*20
				s.Price = 100 - sign*10.01
			}, false},
			{"pending", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Status = "pending" }, true},
			{"potential", func(r *scanner.Row, _ *scanner.SeriesSummary) {
				r.Pattern.Stage, r.Pattern.D, r.Pattern.ConfirmedAt = "potential", nil, 0
			}, true},
			{"completed", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Status = "completed" }, false},
			{"invalidated", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Status = "invalidated" }, false},
			{"expired", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Status = "expired" }, false},
			{"target 1 reached", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Target1Reached = true }, false},
			{"target 2 reached", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Target2Reached = true }, false},
			{"wrong stop side", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Stop = 100 + sign*10 }, false},
			{"reversed targets", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Target2 = 100 + sign*10 }, false},
			{"missing ATR", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Decision.Risk.ATR = nil }, false},
			{"zero ATR", func(r *scanner.Row, _ *scanner.SeriesSummary) { *r.Decision.Risk.ATR = 0 }, false},
			{"NaN ATR", func(r *scanner.Row, _ *scanner.SeriesSummary) { *r.Decision.Risk.ATR = math.NaN() }, false},
			{"NaN quote", func(_ *scanner.Row, s *scanner.SeriesSummary) { s.Price = math.NaN() }, false},
			{"infinite target", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Target1 = math.Inf(1) }, false},
			{"nonfinite score", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.Score = math.NaN() }, false},
			{"unranked", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Rank.Order = 0 }, false},
			{"missing confirmed D", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.D = nil }, false},
			{"future confirmed D", func(r *scanner.Row, _ *scanner.SeriesSummary) { r.Pattern.ConfirmedAt = r.LastClosedAt + 1 }, false},
		} {
			t.Run(direction+"/"+test.name, func(t *testing.T) {
				snapshot, _ := selectionFixture(now, direction, "BTCUSDT")
				row, series := &snapshot.Rows[0], selectionSeries(&snapshot, "BTCUSDT", "1h")
				test.edit(row, series)
				candidate, got := priceCandidate(*row, *series)
				if got != test.want {
					t.Fatalf("eligibility = %v, want %v", got, test.want)
				}
				if got && (!finite(candidate.RewardRisk1) || candidate.RewardRisk1 < 1) {
					t.Fatal("invalid remaining risk")
				}
			})
		}
	}
}

func TestBuildFreshCompleteContextAndBoundaryGrace(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, test := range []struct {
		name string
		edit func(*scanner.Snapshot)
	}{
		{"running", func(s *scanner.Snapshot) { s.Running = true }},
		{"stale daily", func(s *scanner.Snapshot) { selectionSeries(s, "BTCUSDT", "1d").Stale = true }},
		{"old observation", func(s *scanner.Snapshot) { selectionSeries(s, "BTCUSDT", "4h").ObservedAt = now.Add(-2 * time.Minute) }},
		{"missing observation", func(s *scanner.Snapshot) { selectionSeries(s, "BTCUSDT", "4h").ObservedAt = time.Time{} }},
		{"unready regime", func(s *scanner.Snapshot) { selectionSeries(s, "BTCUSDT", "1h").Analysis.Regime.Ready = false }},
		{"unready structure", func(s *scanner.Snapshot) {
			selectionSeries(s, "BTCUSDT", "15m").Analysis.Structure.Status = "warming_up"
		}},
		{"missing expected bar", func(s *scanner.Snapshot) {
			selectionSeries(s, "BTCUSDT", "15m").LastClosedAt -= (15 * time.Minute).Milliseconds()
		}},
		{"missing timeframe", func(s *scanner.Snapshot) { s.Series = s.Series[1:] }},
		{"errored timeframe", func(s *scanner.Snapshot) { s.Errors = []scanner.ScanError{{Symbol: "BTCUSDT", Interval: "1d"}} }},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, histories := selectionFixture(now, "bullish", "BTCUSDT")
			test.edit(&snapshot)
			if result := Build(snapshot, histories, []string{"BTCUSDT"}, now, time.Minute); len(result.Items) != 0 {
				t.Fatalf("unavailable context qualified: %+v", result.Items)
			}
		})
	}
	boundary := time.Date(2026, 9, 25, 12, 59, 59, 0, time.UTC)
	snapshot, histories := selectionFixture(boundary, "bullish", "BTCUSDT")
	if len(Build(snapshot, histories, []string{"BTCUSDT"}, boundary.Add(5*time.Second), time.Hour).Items) != 1 {
		t.Fatal("boundary grace was lost")
	}
	if len(Build(snapshot, histories, []string{"BTCUSDT"}, boundary.Add(7*time.Second), time.Hour).Items) != 0 {
		t.Fatal("missing bar survived boundary grace")
	}
	if len(Build(snapshot, histories, []string{"BTCUSDT"}, boundary.Add(2*time.Minute), time.Minute).Items) != 0 {
		t.Fatal("reading a snapshot renewed its observation age")
	}
}

func TestFutureAndUnavailableEvidenceCannotBecomeReadyBreadthOrCandidates(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, test := range []struct {
		name   string
		edit   func(*scanner.SeriesSummary)
		maxAge time.Duration
		ready  bool
	}{
		{"current evidence", func(*scanner.SeriesSummary) {}, time.Minute, true},
		{"future last close despite matching indicator", func(s *scanner.SeriesSummary) {
			s.LastClosedAt = now.Add(time.Minute).UnixMilli()
			closed := s.LastClosedAt
			s.Analysis.Regime.ClosedAt = &closed
		}, time.Minute, false},
		{"missing indicator close", func(s *scanner.SeriesSummary) { s.Analysis.Regime.ClosedAt = nil }, time.Minute, false},
		{"mismatched indicator close", func(s *scanner.SeriesSummary) {
			closed := s.LastClosedAt - time.Hour.Milliseconds()
			s.Analysis.Regime.ClosedAt = &closed
		}, time.Minute, false},
		{"future observation beyond clock grace", func(s *scanner.SeriesSummary) {
			s.ObservedAt = now.Add(market.BoundaryGrace + time.Nanosecond)
		}, time.Minute, false},
		{"observation at clock grace", func(s *scanner.SeriesSummary) {
			s.ObservedAt = now.Add(market.BoundaryGrace)
		}, time.Minute, true},
		{"zero maximum age", func(*scanner.SeriesSummary) {}, 0, false},
		{"negative maximum age", func(*scanner.SeriesSummary) {}, -time.Minute, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, histories := selectionFixture(now, "bullish", "BTCUSDT")
			s := selectionSeries(&snapshot, "BTCUSDT", "1h")
			test.edit(s)
			if got := seriesReady(*s, now, test.maxAge); got != test.ready {
				t.Fatalf("series readiness = %v, want %v", got, test.ready)
			}
			result := Build(snapshot, histories, []string{"BTCUSDT"}, now, test.maxAge)
			if got := len(result.Items) == 1; got != test.ready {
				t.Fatalf("candidate readiness = %v, want %v", got, test.ready)
			}
			for _, breadth := range result.Breadth {
				if breadth.Interval != "1h" {
					continue
				}
				if test.ready && (breadth.Ready != 1 || breadth.Bullish != 1 || breadth.Unavailable != 0) {
					t.Fatalf("coherent evidence not counted: %+v", breadth)
				}
				if !test.ready && (breadth.Ready != 0 || breadth.Bullish != 0 || breadth.Unavailable != 1) {
					t.Fatalf("unavailable evidence became directional breadth: %+v", breadth)
				}
			}
		})
	}
}

func TestLowerTimeframeCoverageTouchesAndCausality(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, test := range []struct {
			name string
			edit func(*scanner.Row, *scanner.History)
			want bool
		}{
			{"untouched", func(*scanner.Row, *scanner.History) {}, true},
			{"stop wick", func(r *scanner.Row, h *scanner.History) {
				b := &h.Candles[len(h.Candles)-1]
				if direction == "bullish" {
					b.Low = r.Pattern.Stop
				} else {
					b.High = r.Pattern.Stop
				}
			}, false},
			{"target wick", func(r *scanner.Row, h *scanner.History) {
				b := &h.Candles[len(h.Candles)-1]
				if direction == "bullish" {
					b.High = r.Pattern.Target1
				} else {
					b.Low = r.Pattern.Target1
				}
			}, false},
			{"reference created inside bar", func(r *scanner.Row, h *scanner.History) {
				b := &h.Candles[len(h.Candles)-1]
				r.Pattern.LevelsEstablishedAt = b.OpenTime + time.Minute.Milliseconds()
				b.High, b.Low = 120, 80
			}, true},
			{"missing history", func(_ *scanner.Row, h *scanner.History) { h.Candles = nil }, false},
			{"missing latest bar", func(_ *scanner.Row, h *scanner.History) { h.Candles = h.Candles[:len(h.Candles)-1] }, false},
			{"missing intermediate bar", func(_ *scanner.Row, h *scanner.History) { h.Candles = h.Candles[len(h.Candles)-1:] }, false},
			{"invalid bar", func(_ *scanner.Row, h *scanner.History) { h.Candles[len(h.Candles)-1].Low = math.NaN() }, false},
			{"duplicate completed bar", func(_ *scanner.Row, h *scanner.History) { h.Candles = append(h.Candles, h.Candles[len(h.Candles)-1]) }, false},
			{"preview does not count", func(_ *scanner.Row, h *scanner.History) {
				b := h.Candles[len(h.Candles)-1]
				b.High, b.Low = 120, 80
				h.Preview = &b
			}, true},
			{"future candles do not count", func(_ *scanner.Row, h *scanner.History) {
				b := h.Candles[len(h.Candles)-1]
				b.OpenTime += (15 * time.Minute).Milliseconds()
				b.CloseTime += (15 * time.Minute).Milliseconds()
				b.High, b.Low = 120, 80
				h.Candles = append(h.Candles, b)
			}, true},
		} {
			t.Run(direction+"/"+test.name, func(t *testing.T) {
				snapshot, histories := selectionFixture(now, direction, "BTCUSDT")
				h := histories["BTCUSDT/15m"]
				test.edit(&snapshot.Rows[0], &h)
				histories["BTCUSDT/15m"] = h
				if got := len(Build(snapshot, histories, []string{"BTCUSDT"}, now, time.Minute).Items) == 1; got != test.want {
					t.Fatalf("eligible = %v, want %v", got, test.want)
				}
			})
		}
	}
	// At a shared closed-candle boundary there is no newer 15m evidence to
	// verify; higher-timeframe rows do not need an invented history gap.
	boundary := time.Date(2026, 9, 25, 12, 0, 6, 0, time.UTC)
	snapshot, _ := selectionFixture(boundary, "bullish", "BTCUSDT")
	if len(Build(snapshot, nil, []string{"BTCUSDT"}, boundary, time.Minute).Items) != 1 {
		t.Fatal("no-gap row requires unnecessary history")
	}
}

func TestBuildOrderingDeduplicationAndLimit(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	symbols := []string{"AREVERSAL", "BWAITRANK1", "CTRIGGERRANK6", "DNEAR", "EHIGH", "FLOW"}
	snapshot, histories := selectionFixture(now, "bullish", symbols...)
	for i := range snapshot.Rows {
		r := &snapshot.Rows[i]
		r.Rank.Order, r.Pattern.Entry = 3, 103
		switch r.Symbol {
		case "AREVERSAL":
			r.Rank.Order = 1
			selectionFrame(r, "1h").Trend = "bearish"
			selectionConfirm(r)
		case "BWAITRANK1":
			r.Rank.Order = 1
		case "CTRIGGERRANK6":
			r.Rank.Order = 6
			selectionConfirm(r)
		case "DNEAR":
			r.Pattern.Entry, r.Pattern.Score = 100, 90
		case "EHIGH":
			r.Pattern.Score = 99
		}
	}
	duplicate := snapshot.Rows[3]
	duplicate.Pattern.ID, duplicate.Pattern.Score = "alternative", 89
	snapshot.Rows = append(snapshot.Rows, duplicate)
	result := Build(snapshot, histories, symbols, now, time.Minute)
	got := []string{}
	for _, c := range result.Items {
		got = append(got, c.Setup.Symbol)
	}
	want := []string{"CTRIGGERRANK6", "BWAITRANK1", "DNEAR", "EHIGH", "FLOW", "AREVERSAL"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ordering = %v, want %v", got, want)
	}
	if result.Examined != 7 || result.Eligible != 6 || result.Items[2].Alternatives != 1 {
		t.Fatalf("incorrect counts: %+v", result)
	}
	if !strings.Contains(result.Items[5].Caution, "countertrend reversal") {
		t.Fatal("reversal opposition is hidden")
	}
	symbols = nil
	for i := 0; i < 15; i++ {
		symbols = append(symbols, fmt.Sprintf("COIN%02d", i))
	}
	snapshot, histories = selectionFixture(now, "bullish", symbols...)
	result = Build(snapshot, histories, symbols, now, time.Minute)
	if len(result.Items) != 12 || result.Limit != 12 || result.Eligible != 15 {
		t.Fatal("limit changed eligible pair counts")
	}
	for i := 1; i < len(snapshot.Rows); i++ {
		snapshot.Rows[i].Pattern.Target1Reached = true
	}
	if result := Build(snapshot, histories, symbols, now, time.Minute); len(result.Items) != 1 || result.Eligible != 1 {
		t.Fatal("ineligible rows filled the list")
	}
}

func TestBreadthUniquenessCoverageAndEmptyReadiness(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	snapshot, histories := selectionFixture(now, "bullish", "BTCUSDT", "ETHUSDT", "EXCLUDED")
	snapshot.Series = append(snapshot.Series, snapshot.Series[0])
	selectionSeries(&snapshot, "ETHUSDT", "1d").Analysis.Regime.Direction = "bearish"
	selectionSeries(&snapshot, "ETHUSDT", "4h").Analysis.Regime.Direction = "neutral"
	selectionSeries(&snapshot, "ETHUSDT", "1h").Stale = true
	selectionSeries(&snapshot, "ETHUSDT", "15m").Analysis.Regime.Direction = "unavailable"
	result := Build(snapshot, histories, []string{"BTCUSDT", "BTCUSDT", "ETHUSDT", "MISSING"}, now, time.Minute)
	want := []Breadth{
		{Interval: "1d", Requested: 3, Ready: 2, Bullish: 1, Bearish: 1, Unavailable: 1},
		{Interval: "4h", Requested: 3, Ready: 2, Bullish: 1, Neutral: 1, Unavailable: 1},
		{Interval: "1h", Requested: 3, Ready: 1, Bullish: 1, Unavailable: 2},
		{Interval: "15m", Requested: 3, Ready: 1, Bullish: 1, Unavailable: 2},
	}
	if !reflect.DeepEqual(result.Breadth, want) {
		t.Fatalf("breadth = %+v, want %+v", result.Breadth, want)
	}
	if len(result.Items) != 1 || result.Items[0].Setup.Symbol != "BTCUSDT" {
		t.Fatal("missing context or unrequested coin survived")
	}
	empty := Build(scanner.Snapshot{}, nil, []string{"BTCUSDT"}, now, time.Minute)
	if empty.Items == nil || len(empty.Items) != 0 || empty.Eligible != 0 || len(empty.Breadth) != 4 {
		t.Fatal("empty readiness fabricated candidates")
	}
	for _, b := range empty.Breadth {
		if b.Requested != 1 || b.Ready != 0 || b.Unavailable != 1 {
			t.Fatalf("missing breadth hidden: %+v", b)
		}
	}
}

func TestBuildPreservesEvidenceAndExplainsReadiness(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	snapshot, histories := selectionFixture(now, "bullish", "BTCUSDT")
	row := &snapshot.Rows[0]
	row.Decision.Status = "mixed"
	row.Decision.Risk.NearestOpposingLevel = &scanner.PriceLevel{Price: 110}
	before, _ := json.Marshal(snapshot)
	result := Build(snapshot, histories, []string{"BTCUSDT"}, now, time.Minute)
	after, _ := json.Marshal(snapshot)
	if string(before) != string(after) {
		t.Fatal("selection mutated the source scan")
	}
	c := result.Items[0]
	if c.Confirmation || !strings.Contains(c.Next, "Watch for a bullish closed 15m structure break") || c.RewardRisk1 != 2 || c.QuoteStopATR != 1 {
		t.Fatalf("waiting/risk explanation wrong: %+v", c)
	}
	if !strings.Contains(c.Caution, "conflicting directional evidence") || !strings.Contains(c.Caution, "opposing structure level") {
		t.Fatal("risk context omitted")
	}
	selectionConfirm(row)
	result = Build(snapshot, histories, []string{"BTCUSDT"}, now, time.Minute)
	if !result.Items[0].Confirmation || !strings.Contains(result.Items[0].Next, "D and recent 15m timing are confirmed") {
		t.Fatal("confirmed timing not distinguished")
	}
	row.Pattern.Stage, row.Pattern.D, row.Pattern.ConfirmedAt = "potential", nil, 0
	result = Build(snapshot, histories, []string{"BTCUSDT"}, now, time.Minute)
	if !strings.Contains(result.Items[0].Next, "D pivot to confirm") {
		t.Fatal("potential promoted as confirmed D")
	}
	selectionFrame(row, "15m").InternalBias = "bearish"
	result = Build(snapshot, histories, []string{"BTCUSDT"}, now, time.Minute)
	if len(result.Items) != 0 || result.DirectionFiltered != 1 {
		t.Fatalf("direction filtering count misleading: %+v", result)
	}
}

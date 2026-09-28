package selection

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/regime"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/structure"
)

func trendFixture(now time.Time, direction string, symbols ...string) (scanner.Snapshot, map[string]scanner.History) {
	snapshot := scanner.Snapshot{}
	histories := map[string]scanner.History{}
	for _, symbol := range symbols {
		for _, interval := range []string{"1d", "4h", "1h", "15m"} {
			closedAt, _ := market.ExpectedClosedTime(now, interval, 0, market.BoundaryGrace)
			atr := 10.0
			snapshot.Series = append(snapshot.Series, scanner.SeriesSummary{
				Symbol: symbol, Interval: interval, Price: 104, LastClosedAt: closedAt, ObservedAt: now.Add(-time.Second),
				Analysis: scanner.SeriesAnalysis{AsOf: closedAt,
					Regime: regime.Snapshot{Ready: true, Direction: direction, ClosedAt: &closedAt, Volatility: regime.Volatility{Ready: true, ATR: &atr}},
					Structure: structure.Snapshot{Status: "ready", AsOf: closedAt,
						Internal: structure.State{Ready: true, Bias: direction}, Swing: structure.State{Ready: true, Bias: direction}},
				},
			})
		}
		for interval, count := range map[string]int{"1h": 36, "15m": 144} {
			width, _ := time.ParseDuration(interval)
			last := trendFixtureSeries(&snapshot, symbol, interval).LastClosedAt
			candles := make([]market.Candle, count)
			for i := range candles {
				closedAt := last - int64(count-1-i)*width.Milliseconds()
				candles[i] = market.Candle{OpenTime: closedAt - width.Milliseconds() + 1, CloseTime: closedAt, Open: 104, High: 105, Low: 102, Close: 104, Volume: 10}
			}
			histories[symbol+"/"+interval] = scanner.History{Candles: candles}
		}
		hour := trendFixtureSeries(&snapshot, symbol, "1h")
		eventAt := hour.LastClosedAt - 3*time.Hour.Milliseconds()
		hour.Analysis.Structure.Internal.LastBreak = &structure.Break{Type: "BOS", Direction: direction, PreviousBias: direction, Level: 100, ConfirmedAt: eventAt, PivotConfirmedAt: eventAt - time.Hour.Milliseconds()}
		if direction == "bearish" {
			for i := range snapshot.Series {
				if snapshot.Series[i].Symbol == symbol {
					snapshot.Series[i].Price = 96
				}
			}
			for _, interval := range []string{"1h", "15m"} {
				for i := range histories[symbol+"/"+interval].Candles {
					c := &histories[symbol+"/"+interval].Candles[i]
					c.Open, c.Close, c.High, c.Low = 200-c.Open, 200-c.Close, 200-c.Low, 200-c.High
				}
			}
		}
	}
	return snapshot, histories
}

func trendFixtureSeries(snapshot *scanner.Snapshot, symbol, interval string) *scanner.SeriesSummary {
	for i := range snapshot.Series {
		if snapshot.Series[i].Symbol == symbol && snapshot.Series[i].Interval == interval {
			return &snapshot.Series[i]
		}
	}
	panic("missing fixture series")
}

func trendFixtureTouch(c *market.Candle, direction string) {
	if direction == "bullish" {
		c.Low = 99
	} else {
		c.High = 101
	}
}

func TestTrendWatchesIndependentAndSymmetric(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			snapshot, histories := trendFixture(now, direction, "TESTUSDT")
			if len(snapshot.Rows) != 0 {
				t.Fatal("fixture must contain no harmonics")
			}
			bars := histories["TESTUSDT/15m"].Candles
			trendFixtureTouch(&bars[len(bars)-1], direction)
			got := TrendWatches(snapshot, histories, []string{"TESTUSDT", "TESTUSDT"}, now, time.Minute)
			if len(got) != 1 || got[0].Status != "retest_seen" || got[0].Direction != direction || got[0].PullbackLevel != 100 || got[0].BreakAgeBars != 3 || got[0].DistanceATR != .4 {
				t.Fatalf("unexpected watch: %+v", got)
			}
			if got[0].RetestClosedAt == nil || *got[0].RetestClosedAt != bars[len(bars)-1].CloseTime {
				t.Fatalf("missing latest closed retest: %+v", got[0])
			}
			if !strings.Contains(got[0].Next, "Reassess") {
				t.Fatalf("must describe observation and reassessment: %+v", got[0])
			}
		})
	}
}

func TestTrendRetestsUseClosedPostBreakEvidenceAndRetainIt(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, test := range []struct {
		name   string
		edit   func(*scanner.Snapshot, map[string]scanner.History)
		want   string
		retest bool
	}{
		{"no touch", func(*scanner.Snapshot, map[string]scanner.History) {}, "near_retest", false},
		{"pre-break touch", func(s *scanner.Snapshot, h map[string]scanner.History) {
			event := trendFixtureSeries(s, "TESTUSDT", "1h").Analysis.Structure.Internal.LastBreak
			bars := h["TESTUSDT/15m"].Candles
			for i := range bars {
				if bars[i].CloseTime == event.ConfirmedAt {
					trendFixtureTouch(&bars[i], "bullish")
				}
			}
		}, "near_retest", false},
		{"preview touch", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			history := h["TESTUSDT/15m"]
			preview := history.Candles[len(history.Candles)-1]
			preview.OpenTime += (15 * time.Minute).Milliseconds()
			preview.CloseTime += (15 * time.Minute).Milliseconds()
			trendFixtureTouch(&preview, "bullish")
			history.Preview = &preview
			h["TESTUSDT/15m"] = history
		}, "near_retest", false},
		{"older retest", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			bars := h["TESTUSDT/15m"].Candles
			trendFixtureTouch(&bars[len(bars)-2], "bullish")
		}, "retest_seen", true},
		{"quote extended after retest", func(s *scanner.Snapshot, h map[string]scanner.History) {
			bars := h["TESTUSDT/15m"].Candles
			trendFixtureTouch(&bars[len(bars)-1], "bullish")
			trendFixtureSeries(s, "TESTUSDT", "1h").Price = 111
		}, "waiting_for_pullback", true},
		{"closed reference extended", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			bars := h["TESTUSDT/15m"].Candles
			bars[len(bars)-1].High, bars[len(bars)-1].Close = 111, 111
		}, "waiting_for_pullback", false},
		{"exact ATR boundary", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			trendFixtureSeries(s, "TESTUSDT", "1h").Price = 110
		}, "near_retest", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, histories := trendFixture(now, "bullish", "TESTUSDT")
			test.edit(&snapshot, histories)
			got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(got) != 1 || got[0].Status != test.want || (got[0].RetestClosedAt != nil) != test.retest {
				t.Fatalf("got %+v, want %s with retained retest=%t", got, test.want, test.retest)
			}
		})
	}
}

func TestTrendLaterCloseInvalidatesDespiteRecovery(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			snapshot, histories := trendFixture(now, direction, "TESTUSDT")
			bars := histories["TESTUSDT/15m"].Candles
			prior := &bars[len(bars)-2]
			if direction == "bullish" {
				prior.Low, prior.Close = 99, 99
			} else {
				prior.High, prior.Close = 101, 101
			}
			if got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute); len(got) != 0 {
				t.Fatalf("recovery must not resurrect invalidated break: %+v", got)
			}
		})
	}
}

func TestTrendBreakCandleCannotAlsoConfirmItsRetest(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 30, 0, time.UTC)
	snapshot, histories := trendFixture(now, "bullish", "TESTUSDT")
	hour := trendFixtureSeries(&snapshot, "TESTUSDT", "1h")
	hour.Analysis.Structure.Internal.LastBreak.ConfirmedAt = hour.LastClosedAt
	bars := histories["TESTUSDT/15m"].Candles
	trendFixtureTouch(&bars[len(bars)-1], "bullish")
	got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
	if len(got) != 1 || got[0].Status != "near_retest" || got[0].RetestClosedAt != nil {
		t.Fatalf("the 15m candle straddling break knowledge cannot prove a later retest: %+v", got)
	}
}

func TestTrendRetestRequiresStrictlyFavorableClose(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			snapshot, histories := trendFixture(now, direction, "TESTUSDT")
			bars := histories["TESTUSDT/15m"].Candles
			latest := &bars[len(bars)-1]
			trendFixtureTouch(latest, direction)
			latest.Close = 100
			got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(got) != 1 || got[0].Status != "near_retest" || got[0].RetestClosedAt != nil {
				t.Fatalf("an equal close can remain a watch but is not a reclaim: %+v", got)
			}
		})
	}
}

func TestTrendWatchesRequireCompleteFreshCausalEvidence(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, test := range []struct {
		name string
		edit func(*scanner.Snapshot, map[string]scanner.History)
	}{
		{"scan still running", func(s *scanner.Snapshot, _ map[string]scanner.History) { s.Running = true }},
		{"missing daily context", func(s *scanner.Snapshot, _ map[string]scanner.History) { s.Series = s.Series[1:] }},
		{"stale context", func(s *scanner.Snapshot, _ map[string]scanner.History) { s.Series[0].Stale = true }},
		{"old observation", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			s.Series[0].ObservedAt = now.Add(-2 * time.Minute)
		}},
		{"future observation beyond clock grace", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			s.Series[0].ObservedAt = now.Add(market.BoundaryGrace + time.Second)
		}},
		{"warming up", func(s *scanner.Snapshot, _ map[string]scanner.History) { s.Series[0].Analysis.Regime.Ready = false }},
		{"scan error", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			s.Errors = []scanner.ScanError{{Symbol: "TESTUSDT", Interval: "4h"}}
		}},
		{"opposing 4h trend", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			trendFixtureSeries(s, "TESTUSDT", "4h").Analysis.Regime.Direction = "bearish"
		}},
		{"opposing 1h internal structure", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			trendFixtureSeries(s, "TESTUSDT", "1h").Analysis.Structure.Internal.Bias = "bearish"
		}},
		{"latest opposing swing break", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			hour := trendFixtureSeries(s, "TESTUSDT", "1h")
			hour.Analysis.Structure.Swing.LastBreak = &structure.Break{Type: "CHoCH", Direction: "bearish", Level: 103, ConfirmedAt: hour.LastClosedAt}
		}},
		{"future break", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			hour := trendFixtureSeries(s, "TESTUSDT", "1h")
			hour.Analysis.Structure.Internal.LastBreak.ConfirmedAt = hour.LastClosedAt + time.Hour.Milliseconds()
		}},
		{"break over 24 bars old", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			hour := trendFixtureSeries(s, "TESTUSDT", "1h")
			event := hour.Analysis.Structure.Internal.LastBreak
			event.ConfirmedAt = hour.LastClosedAt - 25*time.Hour.Milliseconds()
			event.PivotConfirmedAt = event.ConfirmedAt - time.Hour.Milliseconds()
		}},
		{"missing 1h history", func(_ *scanner.Snapshot, h map[string]scanner.History) { delete(h, "TESTUSDT/1h") }},
		{"event absent from 1h history", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			history := h["TESTUSDT/1h"]
			history.Candles = history.Candles[len(history.Candles)-2:]
			h["TESTUSDT/1h"] = history
		}},
		{"15m begins after break", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			history := h["TESTUSDT/15m"]
			history.Candles = history.Candles[len(history.Candles)-2:]
			h["TESTUSDT/15m"] = history
		}},
		{"15m gap after break", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			history := h["TESTUSDT/15m"]
			i := len(history.Candles) - 2
			history.Candles = append(history.Candles[:i], history.Candles[i+1:]...)
			h["TESTUSDT/15m"] = history
		}},
		{"missing latest 15m bar", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			history := h["TESTUSDT/15m"]
			history.Candles = history.Candles[:len(history.Candles)-1]
			h["TESTUSDT/15m"] = history
		}},
		{"preview appended as closed", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			history := h["TESTUSDT/15m"]
			preview := history.Candles[len(history.Candles)-1]
			preview.OpenTime += (15 * time.Minute).Milliseconds()
			preview.CloseTime += (15 * time.Minute).Milliseconds()
			history.Candles = append(history.Candles, preview)
			h["TESTUSDT/15m"] = history
		}},
		{"nonfinite ATR", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			*trendFixtureSeries(s, "TESTUSDT", "1h").Analysis.Regime.Volatility.ATR = math.NaN()
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, histories := trendFixture(now, "bullish", "TESTUSDT")
			test.edit(&snapshot, histories)
			if got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute); len(got) != 0 {
				t.Fatalf("incomplete or conflicting evidence must not produce a watch: %+v", got)
			}
		})
	}
}

func TestTrendDailyConflictCautionsWithoutDirectionBias(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	snapshot, histories := trendFixture(now, "bullish", "TESTUSDT")
	trendFixtureSeries(&snapshot, "TESTUSDT", "1d").Analysis.Regime.Direction = "bearish"
	hour := trendFixtureSeries(&snapshot, "TESTUSDT", "1h")
	event := hour.Analysis.Structure.Internal.LastBreak
	event.ConfirmedAt = hour.LastClosedAt - 24*time.Hour.Milliseconds()
	event.PivotConfirmedAt = event.ConfirmedAt - time.Hour.Milliseconds()
	got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
	if len(got) != 1 || got[0].BreakAgeBars != 24 || !strings.Contains(got[0].Caution, "Daily direction") {
		t.Fatalf("daily conflict should be a caution; 24-bar boundary is eligible: %+v", got)
	}
}

func TestTrendWatchOrderingAndLimit(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	symbols := make([]string, 15)
	for i := range symbols {
		symbols[i] = fmt.Sprintf("COIN%02dUSDT", i)
	}
	snapshot, histories := trendFixture(now, "bullish", symbols...)
	for i, symbol := range symbols {
		trendFixtureSeries(&snapshot, symbol, "1h").Price = 111 + float64(i)
	}
	// Near and observed retests precede extended watches, regardless of name.
	trendFixtureSeries(&snapshot, symbols[14], "1h").Price = 104
	trendFixtureSeries(&snapshot, symbols[13], "1h").Price = 105
	bars := histories[symbols[13]+"/15m"].Candles
	trendFixtureTouch(&bars[len(bars)-1], "bullish")
	got := TrendWatches(snapshot, histories, symbols, now, time.Minute)
	if len(got) != 12 || got[0].Symbol != symbols[13] || got[1].Symbol != symbols[14] || got[2].Symbol != symbols[0] {
		t.Fatalf("unexpected watch ordering/limit: %+v", got)
	}
	all := TrendWatchesAll(snapshot, histories, symbols, now, time.Minute)
	if len(all) != len(symbols) || all[0].Symbol != got[0].Symbol || all[12].Symbol == "" {
		t.Fatalf("unlimited observation list lost watches or changed order: %+v", all)
	}
}

func TestTrendDevelopingPullbackKeepsHourlyThesis(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, conflict := range []string{"trend", "structure", "both"} {
			t.Run(direction+"/"+conflict, func(t *testing.T) {
				snapshot, histories := trendFixture(now, direction, "TESTUSDT")
				opposite := "bearish"
				if direction == "bearish" {
					opposite = "bullish"
				}
				lower := trendFixtureSeries(&snapshot, "TESTUSDT", "15m")
				if conflict != "structure" {
					lower.Analysis.Regime.Direction = opposite
				}
				if conflict != "trend" {
					lower.Analysis.Structure.Internal.Bias = opposite
				}
				lower.Analysis.Regime.Momentum.Direction = opposite
				adx := 58.7
				trendFixtureSeries(&snapshot, "TESTUSDT", "1h").Analysis.Regime.Momentum.ADX = &adx
				bars := histories["TESTUSDT/15m"].Candles
				trendFixtureTouch(&bars[len(bars)-2], direction)
				got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
				if len(got) != 1 || got[0].Status != "pullback_developing" || got[0].TriggerAligned || got[0].RetestClosedAt == nil || got[0].PullbackMomentum != opposite || got[0].TrendADX == nil || *got[0].TrendADX != adx {
					t.Fatalf("developing pullback lost hourly thesis/evidence: %+v", got)
				}
				*got[0].TrendADX = 0
				if adx != 58.7 {
					t.Fatal("published ADX aliases scanner evidence")
				}
			})
		}
	}
}

func TestTrendFollowThroughRequiresLaterStrictCloseAndCurrentAlignment(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, test := range []struct {
			name    string
			close   float64
			aligned bool
			want    string
			trigger bool
		}{
			{"wick beyond only", 104, true, "retest_seen", false},
			{"equal close", 105, true, "retest_seen", false},
			{"later close beyond", 106, true, "entry_confirmed", true},
			{"price follow-through without current alignment", 106, false, "pullback_developing", true},
		} {
			t.Run(direction+"/"+test.name, func(t *testing.T) {
				snapshot, histories := trendFixture(now, direction, "TESTUSDT")
				bars := histories["TESTUSDT/15m"].Candles
				retest, latest := &bars[len(bars)-2], &bars[len(bars)-1]
				trendFixtureTouch(retest, direction)
				if direction == "bullish" {
					latest.High, latest.Close = 107, test.close
				} else {
					latest.Low, latest.Close = 93, 200-test.close
				}
				lower := trendFixtureSeries(&snapshot, "TESTUSDT", "15m")
				lower.Analysis.Regime.Momentum.Direction = "bearish"
				if !test.aligned {
					lower.Analysis.Structure.Internal.Bias = "unknown"
				}
				got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
				if len(got) != 1 || got[0].Status != test.want || (got[0].TriggerClosedAt != nil) != test.trigger || got[0].TriggerAligned != test.aligned {
					t.Fatalf("unexpected follow-through: %+v", got)
				}
				w := got[0]
				if w.RetestClosedAt == nil || *w.RetestClosedAt != retest.CloseTime || w.RetestHigh == nil || *w.RetestHigh != retest.High || w.RetestLow == nil || *w.RetestLow != retest.Low {
					t.Fatalf("retained retest references mismatch: %+v", w)
				}
				if test.trigger && (w.TriggerAgeBars == nil || *w.TriggerAgeBars != 0 || w.TriggerPrice == nil || *w.TriggerPrice != latest.Close || *w.TriggerClosedAt != latest.CloseTime) {
					t.Fatalf("trigger references mismatch: %+v", w)
				}
			})
		}
	}
}

func TestTrendConfirmationAndEntryFreshnessWindows(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		for _, test := range []struct {
			name              string
			delay, triggerAge int
			want              string
			trigger           bool
		}{
			{"fourth subsequent close confirms", 4, 0, "entry_confirmed", true},
			{"fifth close cannot confirm old retest", 5, 0, "confirmation_expired", false},
			{"third later bar remains fresh", 1, 3, "entry_confirmed", true},
			{"fourth later bar expires entry", 1, 4, "confirmation_expired", true},
		} {
			t.Run(direction+"/"+test.name, func(t *testing.T) {
				snapshot, histories := trendFixture(now, direction, "TESTUSDT")
				bars := histories["TESTUSDT/15m"].Candles
				triggerIndex := len(bars) - 1 - test.triggerAge
				retestIndex := triggerIndex - test.delay
				trendFixtureTouch(&bars[retestIndex], direction)
				for i := triggerIndex; i < len(bars); i++ {
					if direction == "bullish" {
						bars[i].High, bars[i].Close = 107, 106
					} else {
						bars[i].Low, bars[i].Close = 93, 94
					}
				}
				got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
				if len(got) != 1 || got[0].Status != test.want || (got[0].TriggerClosedAt != nil) != test.trigger || got[0].RetestClosedAt == nil || *got[0].RetestClosedAt != bars[retestIndex].CloseTime {
					t.Fatalf("window mismatch: %+v", got)
				}
				if test.trigger && (*got[0].TriggerAgeBars != test.triggerAge || *got[0].TriggerClosedAt != bars[triggerIndex].CloseTime) {
					t.Fatalf("later favorable closes renewed old trigger: %+v", got[0])
				}
			})
		}
	}
}

func TestTrendExpiredRetestRemainsObservableAndNewRetestResetsCycle(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			snapshot, histories := trendFixture(now, direction, "TESTUSDT")
			bars := histories["TESTUSDT/15m"].Candles
			trendFixtureTouch(&bars[len(bars)-5], direction)
			got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(got) != 1 || got[0].Status != "confirmation_expired" || got[0].RetestClosedAt == nil || got[0].TriggerClosedAt != nil {
				t.Fatalf("unconfirmed retest did not expire observably: %+v", got)
			}
			trendFixtureTouch(&bars[len(bars)-1], direction)
			got = TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(got) != 1 || got[0].Status != "retest_seen" || *got[0].RetestClosedAt != bars[len(bars)-1].CloseTime || got[0].TriggerClosedAt != nil {
				t.Fatalf("new retest failed to reset expired observation: %+v", got)
			}
		})
	}
}

func TestTrendEntryConfirmationDoesNotBypassProximityOrClosedEvidence(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 30, 30, 0, time.UTC)
	for _, test := range []struct {
		name string
		edit func(*scanner.Snapshot, map[string]scanner.History)
		want string
	}{
		{"extended quote", func(s *scanner.Snapshot, _ map[string]scanner.History) {
			trendFixtureSeries(s, "TESTUSDT", "1h").Price = 111
		}, "waiting_for_pullback"},
		{"extended close", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			b := h["TESTUSDT/15m"].Candles
			b[len(b)-1].High, b[len(b)-1].Close = 111, 111
		}, "waiting_for_pullback"},
		{"new touch cannot confirm itself", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			b := h["TESTUSDT/15m"].Candles
			trendFixtureTouch(&b[len(b)-1], "bullish")
		}, "retest_seen"},
		{"preview cannot confirm", func(_ *scanner.Snapshot, h map[string]scanner.History) {
			history := h["TESTUSDT/15m"]
			preview := history.Candles[len(history.Candles)-1]
			preview.OpenTime += (15 * time.Minute).Milliseconds()
			preview.CloseTime += (15 * time.Minute).Milliseconds()
			history.Preview = &preview
			history.Candles[len(history.Candles)-1].Close = 104
			h["TESTUSDT/15m"] = history
		}, "retest_seen"},
	} {
		t.Run(test.name, func(t *testing.T) {
			snapshot, histories := trendFixture(now, "bullish", "TESTUSDT")
			bars := histories["TESTUSDT/15m"].Candles
			trendFixtureTouch(&bars[len(bars)-2], "bullish")
			bars[len(bars)-1].High, bars[len(bars)-1].Close = 107, 106
			test.edit(&snapshot, histories)
			got := TrendWatches(snapshot, histories, []string{"TESTUSDT"}, now, time.Minute)
			if len(got) != 1 || got[0].Status != test.want {
				t.Fatalf("unsafe promotion: %+v", got)
			}
		})
	}
}

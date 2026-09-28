package scanner

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/regime"
	"github.com/alihasan00/crypto/internal/structure"
)

func decisionFixture() (Row, map[string]SeriesSummary, map[string]History) {
	row := Row{Symbol: "BTCUSDT", Interval: "1h", Price: 999,
		Pattern: harmonic.Pattern{Direction: "bullish", Stage: "confirmed", Status: "pending", Entry: 100, Stop: 95, Target1: 110, Target2: 120, DetectedAt: 1, ConfirmedAt: 1}}
	series := map[string]SeriesSummary{}
	history := map[string]History{}
	for _, interval := range decisionIntervals {
		width := map[string]int64{"15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000}[interval]
		bars := make([]market.Candle, 60)
		end := int64(1000 * 86400000)
		for i := range bars {
			open := end - int64(len(bars)-i)*width
			bars[i] = market.Candle{OpenTime: open, CloseTime: open + width - 1, Open: 101, High: 103, Low: 100, Close: 102, Volume: 1}
		}
		closedAt, atr, adx := bars[len(bars)-1].CloseTime, 2.0, 35.0
		state := structure.State{Ready: true, Bias: "bullish", High: &structure.Pivot{Price: 108, OccurredAt: bars[50].OpenTime, ConfirmedAt: bars[55].CloseTime}}
		series[interval] = SeriesSummary{Symbol: row.Symbol, Interval: interval, LastClosedAt: closedAt,
			Analysis: SeriesAnalysis{AsOf: closedAt,
				Regime:    regime.Snapshot{ClosedAt: &closedAt, Ready: true, Direction: "bullish", Volatility: regime.Volatility{ATR: &atr, Ready: true}, Momentum: regime.Momentum{ADX: &adx, Direction: "bullish", Ready: true}},
				Structure: structure.Snapshot{Status: "ready", AsOf: closedAt, Internal: state, Swing: state}}}
		history[row.Symbol+"/"+interval] = History{Candles: bars}
	}
	return row, series, history
}

func TestDecisionSeparatesDirectionAgreementFromCoverage(t *testing.T) {
	for _, test := range []struct {
		name, want string
		complete   bool
		change     func(map[string]SeriesSummary)
	}{
		{"aligned", "aligned", true, func(map[string]SeriesSummary) {}},
		{"opposing macro trend", "mixed", true, func(s map[string]SeriesSummary) { v := s["1d"]; v.Analysis.Regime.Direction = "bearish"; s["1d"] = v }},
		{"all oppose", "conflicting", true, func(s map[string]SeriesSummary) {
			for k, v := range s {
				v.Analysis.Regime.Direction = "bearish"
				v.Analysis.Regime.Momentum.Direction = "bearish"
				v.Analysis.Structure.Internal.Bias = "bearish"
				v.Analysis.Structure.Swing.Bias = "bearish"
				s[k] = v
			}
		}},
		{"neutral", "neutral", true, func(s map[string]SeriesSummary) {
			for k, v := range s {
				v.Analysis.Regime.Direction = "neutral"
				v.Analysis.Regime.Momentum.Direction = "neutral"
				v.Analysis.Structure.Internal.Bias = "unknown"
				v.Analysis.Structure.Swing.Bias = "unknown"
				s[k] = v
			}
		}},
		{"missing", "insufficient_data", false, func(s map[string]SeriesSummary) { delete(s, "4h") }},
		{"warmup", "insufficient_data", false, func(s map[string]SeriesSummary) { v := s["1d"]; v.Analysis.Regime.Ready = false; s["1d"] = v }},
		{"invalid", "insufficient_data", false, func(s map[string]SeriesSummary) { v := s["1d"]; v.Analysis.Structure.Status = "invalid"; s["1d"] = v }},
		{"stale trigger", "stale_data", false, func(s map[string]SeriesSummary) { v := s["15m"]; v.Stale = true; s["15m"] = v }},
	} {
		t.Run(test.name, func(t *testing.T) {
			row, series, history := decisionFixture()
			test.change(series)
			d := assess(row, series, history, decisionIntervals, DefaultAnalysisSettings())
			if d.Status != test.want || d.ContextComplete != test.complete || len(d.Timeframes) != 4 {
				t.Fatalf("decision=%+v", d)
			}
			if d.Confirmation.Status == "confirmed" {
				t.Fatal("direction agreement invented an entry confirmation")
			}
			for _, reason := range d.Reasons {
				if reason.Interval == "15m" && test.name == "stale trigger" && reason.Kind == "support" {
					t.Fatal("stale evidence contributed supporting confirmation")
				}
			}
		})
	}
	row, series, history := decisionFixture()
	delete(series, "4h")
	d := assess(row, series, history, []string{"1d", "1h", "15m"}, DefaultAnalysisSettings())
	if d.Timeframes[1].Availability != "not_requested" {
		t.Fatal("unrequested context confused with a failed request")
	}
}

func TestConfirmationRequiresRecentEventAtOrAfterCurrentPattern(t *testing.T) {
	row, series, history := decisionFixture()
	closes := history[row.Symbol+"/15m"].Candles
	setEvent := func(index int, direction string) {
		v := series["15m"]
		v.Analysis.Structure.Internal.LastBreak = &structure.Break{Type: "CHoCH", Direction: direction, ConfirmedAt: closes[index].CloseTime}
		v.Analysis.Structure.Swing.LastBreak = nil
		series["15m"] = v
	}
	setEvent(59, "bullish")
	row.Pattern.ConfirmedAt = closes[59].CloseTime
	c := confirmationFor(row, series, history, 4)
	if c.Status != "confirmed" || c.BarsAgo == nil || *c.BarsAgo != 0 || !c.AfterSetup {
		t.Fatalf("same closed bar should make both observations available: %+v", c)
	}
	row.Pattern.ConfirmedAt++
	if c := confirmationFor(row, series, history, 4); c.Status != "waiting" || c.AfterSetup {
		t.Fatal("preexisting break confirmed newer harmonic geometry")
	}
	row.Pattern.ConfirmedAt = 1
	setEvent(55, "bullish")
	if c := confirmationFor(row, series, history, 4); c.Status != "waiting" || *c.BarsAgo != 4 {
		t.Fatal("expired confirmation was treated as recent")
	}
	setEvent(56, "bullish")
	if c := confirmationFor(row, series, history, 4); c.Status != "confirmed" {
		t.Fatal("age-three event should fit the latest four bars")
	}
	v := series["15m"]
	v.Analysis.Structure.Swing.LastBreak = &structure.Break{Type: "CHoCH", Direction: "bearish", ConfirmedAt: closes[59].CloseTime}
	series["15m"] = v
	if c := confirmationFor(row, series, history, 4); c.Status != "waiting" || c.Event.Direction != "bearish" {
		t.Fatal("older supporting break concealed a newer opposing event")
	}
	v.Stale = true
	series["15m"] = v
	if c := confirmationFor(row, series, history, 4); c.Status != "unavailable" || c.Event != nil {
		t.Fatal("stale series supplied a confirmation")
	}
}

func TestRiskBasesAndSuppressedInternalBreaks(t *testing.T) {
	row, series, history := decisionFixture()
	row.Interval = "1d"
	h := history[row.Symbol+"/15m"]
	last := h.Candles[len(h.Candles)-1]
	last.OpenTime += 900000
	last.CloseTime += 900000
	last.Open, last.High, last.Low, last.Close = 103, 105, 102, 104
	h.Candles = append(h.Candles, last)
	h.Preview = &market.Candle{Close: 9999}
	history[row.Symbol+"/15m"] = h
	r := riskFor(row, series, history)
	if r.ReferencePrice != 104 || r.ReferenceInterval != "15m" || r.ATRInterval != "1d" || r.RewardRiskBasis != "pattern_entry" || *r.RewardRisk1 != 2 || *r.RewardRisk2 != 4 || *r.EntryStopDistanceATR != 2.5 || *r.PriceStopDistanceATR != 4.5 {
		t.Fatalf("risk bases are ambiguous or include preview: %+v", r)
	}
	// Clear other levels to isolate an internal high that price crossed but the
	// source's duplicate-event suppression did not mark Crossed.
	for interval, v := range series {
		v.Analysis.Structure.Internal.High, v.Analysis.Structure.Swing.High = nil, nil
		series[interval] = v
	}
	v := series["15m"]
	v.Analysis.Structure.Internal.High = &structure.Pivot{Price: 108, ConfirmedAt: h.Candles[55].CloseTime}
	series["15m"] = v
	h.Candles[57].Close, h.Candles[57].High = 109, 110
	history[row.Symbol+"/15m"] = h
	if r := riskFor(row, series, history); r.NearestOpposingLevel != nil {
		t.Fatal("suppressed structure event resurrected a price-breached level")
	}
	zero := 0.0
	v = series["1d"]
	v.Analysis.Regime.Volatility.ATR = &zero
	series["1d"] = v
	r = riskFor(row, series, history)
	if r.EntryStopDistanceATR != nil || r.PriceStopDistanceATR != nil {
		t.Fatal("zero ATR created a ratio")
	}
	if _, err := json.Marshal(r); err != nil {
		t.Fatalf("risk output is not finite JSON: %v", err)
	}
}

func TestAnalysisAndDecisionsIgnorePreviewsAndKeepHarmonics(t *testing.T) {
	data, err := os.ReadFile("../harmonic/testdata/gartley.json")
	if err != nil {
		t.Fatal(err)
	}
	var candles []market.Candle
	if err := json.Unmarshal(data, &candles); err != nil {
		t.Fatal(err)
	}
	var first Snapshot
	for run, price := range []float64{1000, 100000} {
		calls := 0
		feed := feedFunc(func(context.Context, string, string, int) ([]market.Candle, *market.Candle, error) {
			calls++
			return candles, &market.Candle{Close: price}, nil
		})
		s := New(feed, []string{"BTCUSDT"}, "fixture", 1, harmonic.DefaultConfig())
		req := DefaultRequest()
		req.Timeframes = []string{"1m"}
		req.Kinds = []string{"gartley"}
		done, err := s.Start(context.Background(), req)
		if err != nil {
			t.Fatal(err)
		}
		waitScan(t, done)
		state := s.Snapshot()
		if calls != 1 || len(state.Rows) == 0 || len(state.Series) != 1 {
			t.Fatalf("analysis changed request coverage or lost fixture: calls=%d state=%+v", calls, state)
		}
		if state.Rows[0].Price != price || state.Rows[0].Decision.Status != "insufficient_data" {
			t.Fatal("quote display or missing timeframe evidence lost")
		}
		if run == 0 {
			first = state
		} else if !reflect.DeepEqual(first.Series[0].Analysis, state.Series[0].Analysis) || !reflect.DeepEqual(first.Rows[0].Decision, state.Rows[0].Decision) || !reflect.DeepEqual(first.Rows[0].Pattern, state.Rows[0].Pattern) {
			t.Fatal("provisional price altered closed-candle indicators, decisions, or harmonic geometry")
		}
		baseline := harmonic.Analyze(candles, func() harmonic.Config { cfg := harmonic.DefaultConfig(); cfg.Types = []string{"gartley"}; return cfg }())
		found := false
		for _, p := range baseline {
			if reflect.DeepEqual(p, state.Rows[0].Pattern) {
				found = true
			}
		}
		if !found {
			t.Fatal("new context changed original harmonic evidence")
		}
	}
}

func TestCurrentClosedPriceFlagsPassedTargetsWithoutRewritingDailyLifecycle(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		for _, test := range []struct {
			price float64
			code  string
		}{{109, ""}, {110, "closed_price_beyond_target1"}, {120, "closed_price_beyond_target2"}, {125, "closed_price_beyond_target2"}} {
			row, series, history := decisionFixture()
			row.Interval, row.Pattern.Status = "1d", "active"
			price := test.price
			if direction == "bearish" {
				row.Pattern.Direction = "bearish"
				row.Pattern.Stop, row.Pattern.Target1, row.Pattern.Target2 = 105, 90, 80
				price = 200 - price
			}
			h := history[row.Symbol+"/15m"]
			last := h.Candles[len(h.Candles)-1]
			last.OpenTime += 900000
			last.CloseTime += 900000
			last.Open, last.High, last.Low, last.Close = price, price, price, price
			h.Candles = append(h.Candles, last)
			history[row.Symbol+"/15m"] = h
			d := assess(row, series, history, decisionIntervals, DefaultAnalysisSettings())
			found := ""
			for _, reason := range d.Reasons {
				if reason.Code == "closed_price_beyond_target1" || reason.Code == "closed_price_beyond_target2" {
					found = reason.Code
					if reason.Interval != "15m" {
						t.Fatal("target flag lost its price timeframe")
					}
				}
			}
			if found != test.code {
				t.Fatalf("direction=%s price=%v got %q want %q", direction, price, found, test.code)
			}
			if row.Pattern.Status != "active" {
				t.Fatal("current risk context rewrote daily lifecycle")
			}
		}
	}
}

func TestSnapshotOwnsDecisionAndAnalysisPointers(t *testing.T) {
	row, series, history := decisionFixture()
	row.Decision = assess(row, series, history, decisionIntervals, DefaultAnalysisSettings())
	s := New(nil, []string{row.Symbol}, "fixture", 1, harmonic.DefaultConfig())
	s.state.Rows = []Row{row}
	s.state.Series = []SeriesSummary{series["1h"]}
	one := s.Snapshot()
	*one.Rows[0].Decision.Timeframes[0].ADX = 999
	*one.Rows[0].Decision.Risk.ATR = 999
	one.Rows[0].Decision.Reasons[0].Detail = "mutated"
	*one.Series[0].Analysis.Regime.Volatility.ATR = 999
	one.Series[0].Analysis.Structure.Internal.High.Price = 999
	two := s.Snapshot()
	if *two.Rows[0].Decision.Timeframes[0].ADX == 999 || *two.Rows[0].Decision.Risk.ATR == 999 || two.Rows[0].Decision.Reasons[0].Detail == "mutated" || *two.Series[0].Analysis.Regime.Volatility.ATR == 999 || two.Series[0].Analysis.Structure.Internal.High.Price == 999 {
		t.Fatal("snapshot caller mutated shared decision evidence")
	}
}

func TestAnalysisConfigurationIsValidatedAndStableDuringScan(t *testing.T) {
	s := New(feedFunc(func(context.Context, string, string, int) ([]market.Candle, *market.Candle, error) {
		time.Sleep(time.Millisecond)
		return flatCandles(), nil, nil
	}), []string{"BTCUSDT"}, "fixture", 1, harmonic.DefaultConfig())
	cfg := DefaultAnalysisSettings()
	cfg.TriggerMaxAgeBars = 0
	if err := s.ConfigureAnalysis(cfg); err == nil {
		t.Fatal("invalid trigger age accepted")
	}
	cfg = DefaultAnalysisSettings()
	cfg.Regime.ADXThreshold = 27
	if err := s.ConfigureAnalysis(cfg); err != nil {
		t.Fatal(err)
	}
	done, err := s.Start(context.Background(), DefaultRequest())
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureAnalysis(DefaultAnalysisSettings()); err != ErrRunning {
		t.Fatalf("running config mutation accepted: %v", err)
	}
	waitScan(t, done)
	if s.AnalysisSettings().Regime.ADXThreshold != 27 {
		t.Fatal("analysis settings changed during scan")
	}
}

package harmonic

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

var geometries = map[string][5]float64{
	"gartley":   {100, 200, 138.2, 176.3956, 121.4},
	"bat":       {100, 200, 155, 186.5, 111.4},
	"butterfly": {100, 200, 121.4, 176.42, 72.8},
	"crab":      {100, 200, 150, 194.3, 38.2},
	"shark":     {100, 200, 150, 220, 100},
	"cypher":    {100, 200, 150, 230, 127.82},
}

func fixture(kind, dir string) []market.Candle { return fixtureFrom(geometries[kind], dir) }

func fixtureFrom(g [5]float64, dir string) []market.Candle {
	knots := []struct {
		index int
		price float64
	}{{0, g[0] + 20}, {6, g[0]}, {16, g[1]}, {26, g[2]}, {36, g[3]}, {46, g[4]}, {47, g[4] + 1}}
	result := make([]market.Candle, 48)
	for k := 1; k < len(knots); k++ {
		a, b := knots[k-1], knots[k]
		for i := a.index; i <= b.index; i++ {
			price := 1000 + a.price + (b.price-a.price)*float64(i-a.index)/float64(b.index-a.index)
			if dir == "bearish" {
				price = 2400 - price
			}
			result[i] = bar(i, price)
		}
	}
	return result
}

func bar(index int, price float64) market.Candle {
	time := int64(1700000000000) + int64(index)*60000
	return market.Candle{OpenTime: time, CloseTime: time + 59999, Open: price, High: price, Low: price, Close: price, Volume: 10}
}

func config(kind string) Config {
	c := DefaultConfig()
	c.PivotMin = 3
	c.PivotMax = 3
	c.Types = []string{kind}
	c.MinScore = 0
	c.EntryAfterC = false
	return c
}

func findExpected(t *testing.T, patterns []Pattern, kind, dir string) Pattern {
	t.Helper()
	for _, p := range patterns {
		if p.Kind == kind && p.Direction == dir && p.X.Index == 6 && p.C.Index == 36 {
			return p
		}
	}
	data, _ := json.Marshal(patterns)
	t.Fatalf("missing %s %s X=6 C=36: %s", kind, dir, data)
	return Pattern{}
}

func near(t *testing.T, actual, want float64) {
	t.Helper()
	if math.Abs(actual-want) > 1e-7 {
		t.Fatalf("got %.10f, want %.10f", actual, want)
	}
}

func TestSixFamiliesBothDirections(t *testing.T) {
	for kind := range geometries {
		for _, dir := range []string{"bullish", "bearish"} {
			t.Run(kind+"/"+dir, func(t *testing.T) {
				candles := fixture(kind, dir)
				cfg := config(kind)
				p := findExpected(t, Analyze(candles, cfg), kind, dir)
				if p.D == nil || p.D.Index != 46 || p.Stage != "confirmed" {
					t.Fatalf("D was not confirmed: %+v", p)
				}
				if p.ConfirmedAt != candles[47].CloseTime {
					t.Fatalf("confirmation time %d", p.ConfirmedAt)
				}
				if p.EntryTouched || p.Status != "pending" {
					t.Fatalf("newly known D reference was observed retroactively: %+v", p)
				}
				if p.Score < 90 || p.Score > 100 {
					t.Fatalf("unexpected quality score %g", p.Score)
				}
				near(t, p.ScoreComponents.RatioAccuracy, 100)
				if p.LevelsBasedOn != "confirmed_d" {
					t.Fatalf("wrong level basis %s", p.LevelsBasedOn)
				}
				s := direction(p)
				d := p.D.Price
				ad := math.Abs(p.A.Price - d)
				cd := math.Abs(p.C.Price - d)
				xa := math.Abs(p.A.Price - p.X.Price)
				t1, t2 := d+s*.618*ad, d+s*1.272*ad
				switch kind {
				case "crab":
					t2 = d + s*1.618*ad
				case "shark":
					t1 = d + s*.382*ad
					t2 = p.C.Price
				case "cypher":
					t1 = d + s*.618*cd
					t2 = d + s*1.618*xa
					near(t, p.Ratios["cdXc"], .786)
					near(t, p.Ratios["xcXa"], 1.3)
				}
				near(t, p.Target1, t1)
				near(t, p.Target2, t2)
				near(t, p.Entry, d*(1+s*.01))
				near(t, p.Stop, p.Entry-s*.75*math.Abs(t1-p.Entry))
			})
		}
	}
}

func TestPotentialsNeverInventD(t *testing.T) {
	for kind := range geometries {
		for _, dir := range []string{"bullish", "bearish"} {
			t.Run(kind+"/"+dir, func(t *testing.T) {
				p := findExpected(t, Analyze(fixture(kind, dir)[:38], config(kind)), kind, dir)
				if p.D != nil || p.Stage != "potential" || p.ConfirmedAt != 0 || p.ScoreComponents.DConfluence != nil {
					t.Fatalf("fabricated completion: %+v", p)
				}
				for _, key := range []string{"cdBc", "adXa", "cdXc"} {
					if _, ok := p.Ratios[key]; ok {
						t.Fatalf("fabricated completed ratio %s", key)
					}
				}
				if p.LevelsBasedOn != "projected_prz" || p.EntryTouched {
					t.Fatalf("incorrect potential evidence: %+v", p)
				}
			})
		}
	}
}

func TestConfirmationRequiresTrailingClosedCandles(t *testing.T) {
	candles := fixture("gartley", "bullish")
	cfg := config("gartley")
	for end := 38; end <= len(candles); end++ {
		p := findExpected(t, Analyze(candles[:end], cfg), "gartley", "bullish")
		if end < 48 && p.D != nil {
			t.Fatalf("future D leaked at prefix %d: %+v", end, p)
		}
		if p.ConfirmedAt > candles[end-1].CloseTime || p.D != nil && p.D.Index+cfg.ConfirmationBars >= end {
			t.Fatalf("future confirmation leaked at prefix %d", end)
		}
	}
	cfg.ConfirmationBars = 2
	if p := findExpected(t, Analyze(candles, cfg), "gartley", "bullish"); p.D != nil {
		t.Fatal("D confirmed without its second trailing candle")
	}
	candles = append(candles, bar(48, candles[47].Close+1))
	p := findExpected(t, Analyze(candles, cfg), "gartley", "bullish")
	if p.D == nil || p.ConfirmedAt != candles[48].CloseTime {
		t.Fatalf("missing delayed confirmation: %+v", p)
	}
}

func TestBrokenPotentialIsNotResurrected(t *testing.T) {
	cfg := config("gartley")
	candles := fixture("gartley", "bullish")[:38]
	candles = append(candles, bar(38, candles[36].High+1))
	p := findExpected(t, Analyze(candles, cfg), "gartley", "bullish")
	if p.Status != "invalidated" || p.D != nil || p.EndedAt != candles[38].CloseTime {
		t.Fatalf("C breach not invalidated: %+v", p)
	}
	for i := 39; i <= 46; i++ {
		candles = append(candles, bar(i, 1170-float64(i-39)*7))
	}
	candles = append(candles, bar(47, candles[46].Close+1))
	p = findExpected(t, Analyze(candles, cfg), "gartley", "bullish")
	if p.Status != "invalidated" || p.D != nil {
		t.Fatalf("invalidated setup resurrected: %+v", p)
	}
}

func TestActiveProjectionReferencesStayFrozenAtDConfirmation(t *testing.T) {
	cfg := config("butterfly")
	cfg.EntryAfterC = true
	candles := fixture("butterfly", "bullish")
	before := findExpected(t, Analyze(candles[:47], cfg), "butterfly", "bullish")
	if before.D != nil || !before.EntryTouched || before.Status != "active" {
		t.Fatalf("expected observed C entry: %+v", before)
	}
	after := findExpected(t, Analyze(candles, cfg), "butterfly", "bullish")
	if after.D == nil || !after.EntryTouched {
		t.Fatalf("missing confirmed active setup: %+v", after)
	}
	near(t, after.Entry, before.Entry)
	near(t, after.Stop, before.Stop)
	near(t, after.Target1, before.Target1)
	near(t, after.Target2, before.Target2)
	if after.LevelsBasedOn != "projected_prz" || after.LevelsEstablishedAt != before.LevelsEstablishedAt || after.EntryTouchedAt != before.EntryTouchedAt {
		t.Fatal("entry reference history changed")
	}
	if before.EntryStage != "potential" || after.EntryStage != before.EntryStage || before.EntryScore == nil || after.EntryScore == nil {
		t.Fatalf("entry-time stage/score snapshot was not preserved: before=%+v after=%+v", before, after)
	}
	near(t, *after.EntryScore, *before.EntryScore)
}

func TestActivePotentialSurvivesMoveThroughC(t *testing.T) {
	cfg := config("gartley")
	cfg.EntryAfterC = true
	// A shallow .382 BC retracement places target 1 above C, so after the
	// projected entry a move through C is progress toward the target.
	candles := fixtureFrom([5]float64{100, 200, 138.2, 161.8, 121.4}, "bullish")[:47]
	p := findExpected(t, Analyze(candles, cfg), "gartley", "bullish")
	if p.D != nil || !p.EntryTouched || p.Status != "active" || p.Target1 <= p.C.Price {
		t.Fatalf("expected an active potential with target 1 beyond C: %+v", p)
	}
	// An outside bar closes above C without confirming D or reaching target 1.
	through := bar(47, 1160)
	through.Low, through.High = candles[46].Low-0.4, 1165
	withThrough := append(append([]market.Candle{}, candles...), through)
	p = findExpected(t, Analyze(withThrough, cfg), "gartley", "bullish")
	if p.Status != "active" || p.D != nil || p.Target1Reached {
		t.Fatalf("a move through C ended an active potential: %+v", p)
	}
	p = findExpected(t, Analyze(append(withThrough, bar(48, 1172)), cfg), "gartley", "bullish")
	if p.Status != "active" || p.D != nil || !p.Target1Reached || p.Target2Reached {
		t.Fatalf("target 1 after a move through C was not credited: %+v", p)
	}
	// After the entry observation only the stop, the targets and the time
	// window end the setup: the reversal zone's far edge no longer does.
	beyond := bar(47, p.Zone.Low+1)
	beyond.Low = p.Zone.Low - 1
	if beyond.Low <= p.Stop {
		t.Fatalf("fixture zone edge %g must lie before the stop %g", p.Zone.Low, p.Stop)
	}
	p = findExpected(t, Analyze(append(append([]market.Candle{}, candles...), beyond), cfg), "gartley", "bullish")
	if p.Status != "active" || p.Target1Reached {
		t.Fatalf("zone far edge ended an active potential before its stop: %+v", p)
	}
	stopped := bar(47, p.Stop+1)
	stopped.Low = p.Stop - 1
	p = findExpected(t, Analyze(append(append([]market.Candle{}, candles...), stopped), cfg), "gartley", "bullish")
	if p.Status != "invalidated" || p.Reason != "stop reference crossed" {
		t.Fatalf("stop did not end the active potential: %+v", p)
	}
}

func entryClockState(direction string) *tracked {
	p := Pattern{Direction: direction, Stage: "potential", Status: "pending", Score: 95,
		Entry: 110, Stop: 102.5, Target1: 120, Target2: 130, ReferenceD: 110,
		EntryAfterC: ptr(110), X: Point{Index: 0}, C: Point{Index: 3, Price: 140}, Zone: Zone{Low: 95, High: 145}}
	if direction == "bearish" {
		p.Entry, p.Stop, p.Target1, p.Target2, p.ReferenceD = 240-p.Entry, 240-p.Stop, 240-p.Target1, 240-p.Target2, 240-p.ReferenceD
		p.EntryAfterC = ptr(p.Entry)
		p.C.Price = 240 - p.C.Price
		p.Zone.Low, p.Zone.High = 240-p.Zone.High, 240-p.Zone.Low
	}
	return &tracked{p: p, entryAt: -1, referenceAt: 4, cEntryEligible: true}
}

func entryClockBar(index int, price float64, direction string) market.Candle {
	if direction == "bearish" {
		price = 240 - price
	}
	return bar(index, price)
}

func TestEnteredPotentialUsesEntryTargetClock(t *testing.T) {
	cfg := DefaultConfig()
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			state := entryClockState(direction)
			observe(state, entryClockBar(5, 110, direction), 5, cfg)
			if !state.p.EntryTouched || state.entryAt != 5 || state.p.EntryStage != "potential" || state.p.EntryScore == nil || *state.p.EntryScore != 95 {
				t.Fatalf("first entry evidence not captured: %+v", state)
			}
			// C=3 and X=0 give a completion deadline of 6, while entry=5
			// gives a target deadline of 5+(5-0)*3=20. Keep D unknown.
			observe(state, entryClockBar(7, 115, direction), 7, cfg)
			if state.p.Status != "active" || state.p.D != nil {
				t.Fatalf("entered potential expired on its old C clock: %+v", state.p)
			}
			observe(state, entryClockBar(20, 115, direction), 20, cfg)
			if state.p.Status != "active" {
				t.Fatalf("last target-window bar must remain observable: %+v", state.p)
			}
			observe(state, entryClockBar(21, 135, direction), 21, cfg)
			if state.p.Status != "expired" || state.p.Reason != "target observation window elapsed" || state.p.Target1Reached || state.p.Target2Reached {
				t.Fatalf("expired window credited late targets: %+v", state.p)
			}
		})
	}
}

func TestEnteredPotentialObservesTargetsAndStopsAfterCDeadline(t *testing.T) {
	cfg := DefaultConfig()
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			state := entryClockState(direction)
			observe(state, entryClockBar(5, 110, direction), 5, cfg)
			observe(state, entryClockBar(20, 135, direction), 20, cfg)
			if state.p.Status != "completed" || !state.p.Target1Reached || !state.p.Target2Reached || state.p.D != nil {
				t.Fatalf("target on final window bar was missed: %+v", state.p)
			}
			state = entryClockState(direction)
			observe(state, entryClockBar(5, 110, direction), 5, cfg)
			ambiguous := entryClockBar(7, 115, direction)
			ambiguous.Low, ambiguous.High = 100, 140
			observe(state, ambiguous, 7, cfg)
			if state.p.Status != "invalidated" || state.p.Reason != "stop reference crossed" || state.p.Target1Reached || state.p.Target2Reached {
				t.Fatalf("stop did not retain precedence after C deadline: %+v", state.p)
			}
		})
	}
}

func TestUnenteredPotentialRetainsCDeadlineAndNoEntrySnapshot(t *testing.T) {
	cfg := DefaultConfig()
	for _, direction := range []string{"bullish", "bearish"} {
		state := entryClockState(direction)
		observe(state, entryClockBar(7, 110, direction), 7, cfg)
		if state.p.Status != "expired" || state.p.Reason != "potential completion window elapsed" || state.p.EntryTouched || state.p.EntryStage != "" || state.p.EntryScore != nil {
			t.Fatalf("pending completion deadline or absent snapshot changed: %+v", state.p)
		}
	}
}

func TestLateDRemainsInvalidAfterEnteredPotentialClockExtension(t *testing.T) {
	cfg := DefaultConfig()
	state := entryClockState("bullish")
	state.d = definitions["gartley"]
	observe(state, entryClockBar(5, 110, "bullish"), 5, cfg)
	// D=7 lies after the original completion deadline=6. It must be rejected
	// even though the entered setup's observation window now lasts through 20.
	confirmD(state, nil, 8, Point{Index: 7, Price: 110}, cfg)
	if state.p.D != nil || state.p.Stage != "potential" || state.p.Status != "active" {
		t.Fatalf("extended observation window admitted a geometrically late D: %+v", state.p)
	}
}

func TestEntrySnapshotIsFrozenAtFirstObservation(t *testing.T) {
	cfg := DefaultConfig()
	state := entryClockState("bullish")
	state.p.Stage = "confirmed"
	state.p.D = &Point{Index: 4, Price: 109}
	observe(state, bar(5, 110), 5, cfg)
	if state.p.EntryStage != "confirmed" || state.p.EntryScore == nil || *state.p.EntryScore != 95 {
		t.Fatalf("confirmed entry snapshot missing: %+v", state.p)
	}
	state.p.Score = 99
	observe(state, bar(6, 115), 6, cfg)
	if *state.p.EntryScore != 95 {
		t.Fatalf("later evidence overwrote first entry score: %+v", state.p)
	}
}

func TestEnteredAdmissionUsesEntryScoreAfterDChangesGeometry(t *testing.T) {
	cfg := config("butterfly")
	cfg.EntryAfterC = true
	// D extends beyond its nominal 1.272 XA projection but remains within
	// tolerance and above the frozen stop, lowering the later geometry score.
	candles := fixtureFrom([5]float64{100, 200, 121.4, 176.42, 60}, "bullish")
	before := findExpected(t, Analyze(candles[:47], cfg), "butterfly", "bullish")
	after := findExpected(t, Analyze(candles, cfg), "butterfly", "bullish")
	if before.EntryScore == nil || !(after.Score < *before.EntryScore) {
		t.Fatalf("fixture must lower geometry after entry: before=%+v after=%+v", before, after)
	}
	cfg.MinScore = (*before.EntryScore + after.Score) / 2
	kept := findExpected(t, Analyze(candles, cfg), "butterfly", "bullish")
	if kept.EntryScore == nil || *kept.EntryScore < cfg.MinScore || kept.Score >= cfg.MinScore || !kept.EntryTouched {
		t.Fatalf("entry-time admission was not retained separately from current geometry: %+v", kept)
	}
}

func TestConservativeStopTargetObservation(t *testing.T) {
	cfg := config("gartley")
	cfg.PatternTimeout = 10
	p := Pattern{Direction: "bullish", Stage: "confirmed", Status: "active", Entry: 110, Stop: 100, Target1: 120, Target2: 130, EntryTouched: true, Score: 100, X: Point{Index: 0}, C: Point{Index: 3}, D: &Point{Index: 4}}
	state := &tracked{p: p, entryAt: 5, referenceAt: 4}
	b := bar(6, 115)
	b.Low = 99
	b.High = 135
	observe(state, b, 6, cfg)
	if state.p.Status != "invalidated" || state.p.Target1Reached || state.p.Target2Reached {
		t.Fatalf("ambiguous candle credited profit: %+v", state.p)
	}
	state = &tracked{p: p, entryAt: 5, referenceAt: 4}
	b = bar(6, 125)
	b.Low = 110
	b.High = 135
	observe(state, b, 6, cfg)
	if state.p.Status != "completed" || !state.p.Target1Reached || !state.p.Target2Reached {
		t.Fatalf("unambiguous target observation missed: %+v", state.p)
	}
}

func TestNoTargetCreditOnEntryCandleAndEntryExpiry(t *testing.T) {
	cfg := config("gartley")
	cfg.EntryWindow = 1
	p := Pattern{Direction: "bullish", Stage: "confirmed", Status: "pending", Entry: 110, Stop: 100, Target1: 120, Target2: 130, ReferenceD: 109, EntryAfterD: ptr(110), Score: 100, X: Point{Index: 0}, C: Point{Index: 3}, D: &Point{Index: 4}}
	state := &tracked{p: p, entryAt: -1, referenceAt: 4}
	b := bar(5, 115)
	b.Low = 109
	b.High = 135
	observe(state, b, 5, cfg)
	if state.p.Status != "active" || state.p.Target1Reached || state.p.Target2Reached {
		t.Fatalf("target credited on entry candle: %+v", state.p)
	}
	state = &tracked{p: p, entryAt: -1, referenceAt: 4}
	observe(state, bar(9, 115), 9, cfg)
	if state.p.Status != "expired" || state.p.EntryTouched {
		t.Fatalf("late entry accepted: %+v", state.p)
	}
}

func TestDistinctCypherAndSharkDefinitions(t *testing.T) {
	cfg := config("cypher")
	cfg.RatioTolerance = 0
	p := Pattern{Direction: "bullish", X: Point{Index: 0, Price: 1100}, A: Point{Index: 10, Price: 1200}, B: Point{Index: 20, Price: 1150}, C: Point{Index: 30, Price: 1215}}
	if validABC(p, definitions["cypher"], cfg) {
		t.Fatal("Cypher incorrectly accepted BC/AB=1.3 instead of requiring XC/XA=1.272..1.414")
	}
	p.B.Price = 1120
	p.C.Price = 1224 // AB/XA=.8, BC/AB=1.3; no independent Shark B constraint.
	if !validABC(p, definitions["shark"], cfg) {
		t.Fatal("Shark inherited a retracement-only B restriction")
	}
}

func TestInputValidationAndFlatCandles(t *testing.T) {
	cfg := DefaultConfig()
	flat := make([]market.Candle, 100)
	for i := range flat {
		flat[i] = bar(i, 100)
	}
	if len(Analyze(flat, cfg)) != 0 {
		t.Fatal("flat prices produced artificial swings")
	}
	cases := []func(*Config){func(c *Config) { c.PivotMin = 2 }, func(c *Config) { c.ConfirmationBars = 0 }, func(c *Config) { c.RatioTolerance = math.NaN() }, func(c *Config) { c.Types = []string{"unknown"} }, func(c *Config) { c.MinScore = 101 }, func(c *Config) { c.Types = []string{"Gartley", "gartley"} }, func(c *Config) { c.EntryOffsetMode = "unknown" }, func(c *Config) { c.EntryOffsetATR = math.NaN() }, func(c *Config) { c.EntryOffsetATR = 101 }}
	for _, mutate := range cases {
		bad := DefaultConfig()
		mutate(&bad)
		if bad.Validate() == nil {
			t.Fatalf("invalid config accepted: %+v", bad)
		}
	}
	candles := fixture("gartley", "bullish")
	candles[20].Close = math.NaN()
	if len(Analyze(candles, config("gartley"))) != 0 {
		t.Fatal("invalid OHLC accepted")
	}
	candles = fixture("gartley", "bullish")
	candles[20].OpenTime = candles[19].OpenTime
	if len(Analyze(candles, config("gartley"))) != 0 {
		t.Fatal("nonchronological candles accepted")
	}
}

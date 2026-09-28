package ichimoku

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func TestSeriesMatchesExistingCloudAndIndependentWindows(t *testing.T) {
	candles := extremeFixture()
	series := Series(candles)
	if len(series) != len(candles) {
		t.Fatal("series must preserve one point per candle")
	}
	for i, point := range series {
		if point.Time != candles[i].CloseTime || (point.Tenkan != nil) != (i >= 19) ||
			(point.Kijun != nil) != (i >= 59) || (point.SpanA != nil) != (i >= 149) ||
			(point.SpanB != nil) != (i >= 149) || (point.CalculatedAt != nil) != (i >= 149) {
			t.Fatalf("wrong per-line warmup at %d: %+v", i, point)
		}
		legacy := Analyze(candles[:i+1], nil)
		if !reflect.DeepEqual(point.Kijun, legacy.Kijun.Value) || !reflect.DeepEqual(point.SpanA, legacy.Cloud.SpanA) ||
			!reflect.DeepEqual(point.SpanB, legacy.Cloud.SpanB) || !reflect.DeepEqual(point.CalculatedAt, legacy.Cloud.CalculatedAt) {
			t.Fatalf("series does not match backward-compatible Analyze at %d", i)
		}
		if point.Tenkan != nil {
			assertFloat(t, point.Tenkan, midpoint(candles[i+1-20:i+1]))
		}
		prefix := Series(candles[:i+1])
		if !reflect.DeepEqual(point, prefix[i]) {
			t.Fatalf("later history changed earlier point at %d", i)
		}
	}
	assertFloat(t, series[149].SpanA, 107.5)
	assertFloat(t, series[149].SpanB, 505)
	series[149].SpanA = pointer(1.0)
	if *Analyze(candles, nil).Cloud.SpanA != 107.5 {
		t.Fatal("series must not own input or Analyze pointers")
	}
}

func TestLectureWarmupAndProjectionAreSeparate(t *testing.T) {
	for _, count := range []int{0, 1, 19, 20, 21, 59, 60, 119, 120, 149, 150, 151} {
		candles := candlesWithPrice(count, 100)
		s := AnalyzeLecture(candles, pointer(2.0))
		if (s.Tenkan.Value != nil) != (count >= 20) || (s.Tenkan.Change1Bar != nil) != (count >= 21) ||
			(s.Kijun.Value != nil) != (count >= 60) || (s.Cloud.Width != nil) != (count >= 150) {
			t.Fatalf("wrong lecture warmup at %d: %+v", count, s)
		}
		wantProjected := max(0, min(30, count-119))
		if len(s.Projection) != wantProjected {
			t.Fatalf("%d candles: want %d known projected points, got %d", count, wantProjected, len(s.Projection))
		}
		for i, p := range s.Projection {
			source := count - wantProjected + i
			if p.CalculatedAt != candles[source].CloseTime || p.DisplayedAt != candles[source].CloseTime+30*60_000 ||
				p.CalculatedAt > *s.AsOf || p.DisplayedAt <= *s.AsOf || p.SpanA != 100 || p.SpanB != 100 {
				t.Fatalf("wrong source/display projection at %d: %+v", count, p)
			}
		}
		if count >= 21 && (s.Tenkan.FlatBars == nil || *s.Tenkan.FlatBars != count-20 || !s.Tenkan.FlatHistoryBounded) {
			t.Fatal("flat Tenkan transitions must use independent twenty-bar history")
		}
	}
	// The displayed cloud stays historical while later source calculations are
	// separately exposed as projected geometry.
	candles := extremeFixture()
	s := AnalyzeLecture(candles, nil)
	assertFloat(t, s.Cloud.SpanA, 107.5)
	if s.Projection[0].CalculatedAt != candles[120].CloseTime || s.Projection[0].SpanA != 1002.5 ||
		s.Projection[0].DisplayedAt != candles[149].CloseTime+60_000 {
		t.Fatalf("projection/current-cloud boundary wrong: %+v", s.Projection[0])
	}
}

func TestLectureInvalidHistoryAndInvalidATR(t *testing.T) {
	for _, change := range []func([]market.Candle){
		func(c []market.Candle) { c[50].OpenTime++ },
		func(c []market.Candle) { c[50].OpenTime-- },
		func(c []market.Candle) { c[150].CloseTime++ },
		func(c []market.Candle) { c[150].High = math.NaN() },
		func(c []market.Candle) { c[150].Volume = -1 },
	} {
		candles := candlesWithPrice(151, 100)
		change(candles)
		s := AnalyzeLecture(candles, pointer(1.0))
		if s.Status != "invalid" || s.AsOf != nil || s.Tenkan.Value != nil || s.Kijun.Value != nil ||
			s.Cloud.Width != nil || s.TKCross != nil || s.PKCross != nil || len(s.Projection) != 0 ||
			s.EdgeToEdge.Status != "invalid" || s.Extension.Status != "invalid" {
			t.Fatalf("invalid history leaked evidence: %+v", s)
		}
		for i, p := range Series(candles) {
			if !reflect.DeepEqual(p, Point{Time: candles[i].CloseTime}) {
				t.Fatal("invalid series must contain only input timestamps")
			}
		}
	}
	for _, test := range []struct {
		atr    *float64
		status string
	}{{nil, "missing_atr"}, {pointer(0.0), "zero_atr"}, {pointer(-1.0), "invalid_atr"},
		{pointer(math.NaN()), "invalid_atr"}, {pointer(math.Inf(1)), "invalid_atr"},
		{pointer(math.SmallestNonzeroFloat64), "unrepresentable"}, {pointer(2.0), "ready"}} {
		s := AnalyzeLecture(extremeFixture(), test.atr)
		if s.Status != "ready" || s.Cloud.WidthATRStatus != test.status || s.Tenkan.DistanceATRStatus != test.status && test.status != "unrepresentable" {
			t.Fatalf("ATR status corrupted raw evidence: %+v", s)
		}
		if _, err := json.Marshal(s); err != nil {
			t.Fatalf("unserializable lecture snapshot: %v", err)
		}
	}
}

func flatGreenFixture() []market.Candle {
	c := candlesWithPrice(151, 100)
	for i := range c {
		c[i].High, c[i].Low = 110, 90
	}
	c[20].High = 1000
	return mirror(c, 10000)
}

func TestCloudMeasurementsFlatFibonacciAndColor(t *testing.T) {
	candles := flatGreenFixture()
	s := AnalyzeLecture(candles, pointer(5.0))
	if s.Cloud.Color != "green" || s.Cloud.WidthTrend != "flat" ||
		*s.Cloud.UpperFlatBars != 1 || *s.Cloud.LowerFlatBars != 1 || !s.Cloud.UpperFlatHistoryBounded ||
		!s.Cloud.LowerFlatHistoryBounded || s.Fibonacci.Status != "ready" || len(s.Fibonacci.Levels) != 5 {
		t.Fatalf("flat green context wrong: %+v", s)
	}
	assertFloat(t, s.Cloud.Lower, 9455)
	assertFloat(t, s.Cloud.Upper, 9900)
	assertFloat(t, s.Cloud.Width, 445)
	assertFloat(t, s.Cloud.WidthATR, 89)
	assertFloat(t, s.Cloud.WidthChange1Bar, 0)
	for i, ratio := range []float64{.236, .382, .5, .618, .786} {
		if s.Fibonacci.Levels[i].Ratio != ratio || s.Fibonacci.Levels[i].Price != 9455+445*ratio {
			t.Fatalf("wrong low-to-high Fibonacci reference: %+v", s.Fibonacci.Levels[i])
		}
	}
	red := AnalyzeLecture(mirror(candles, 10000), pointer(5.0))
	if red.Cloud.Color != "red" || red.Fibonacci.Status != "not_applicable" || len(red.Fibonacci.Levels) != 0 {
		t.Fatal("lecture's green-only Fibonacci example must not be silently mirrored to red")
	}
	firstCloud := AnalyzeLecture(candles[:150], nil)
	if firstCloud.Cloud.UpperFlatBars != nil || firstCloud.Fibonacci.Status == "ready" {
		t.Fatal("one displayed point cannot prove a flat edge")
	}
	zeroWidth := AnalyzeLecture(candlesWithPrice(151, 100), pointer(0.0))
	if zeroWidth.Cloud.Color != "flat" || *zeroWidth.Cloud.Width != 0 || zeroWidth.Cloud.Position != "inside" || zeroWidth.Fibonacci.Status == "ready" {
		t.Fatal("equal spans are a zero-width cloud, not a colored Fibonacci setup")
	}
}

func TestThinningCloudAndWideningGapAreMeasuredWithoutThreshold(t *testing.T) {
	candles := extremeFixture()
	candles = append(candles, market.Candle{OpenTime: 150 * 60_000, CloseTime: 151*60_000 - 1,
		Open: 100, High: 100, Low: 1, Close: 100, Volume: 1})
	s := AnalyzeLecture(candles, pointer(10.0))
	if !s.Extension.ThinningWithWideningGap || s.Cloud.WidthTrend != "narrowing" {
		t.Fatalf("expected measured narrowing+gap expansion: %+v %+v", s.Cloud, s.Extension)
	}
	assertFloat(t, s.Extension.GapChange1Bar, 42.5)
	assertFloat(t, s.Extension.CloudWidthChange1Bar, -397.5)
	assertFloat(t, s.Extension.TenkanKijunGap, 945)
	assertFloat(t, s.Extension.PriceKijunDistance, -900.5)
	if s.Extension.Direction != "below_kijun" {
		t.Fatal("extension direction must retain sign")
	}
	withoutATR := AnalyzeLecture(candles, nil)
	if !withoutATR.Extension.ThinningWithWideningGap || withoutATR.Extension.GapATRStatus != "missing_atr" || withoutATR.Extension.TenkanKijunGapATR != nil {
		t.Fatal("ATR absence must not suppress raw narrowing/gap observations")
	}
	mirrored := AnalyzeLecture(mirror(candles, 10000), pointer(10.0))
	if !mirrored.Extension.ThinningWithWideningGap || mirrored.Extension.Direction != "above_kijun" ||
		*mirrored.Extension.PriceKijunDistance != -*s.Extension.PriceKijunDistance {
		t.Fatal("symmetric extension distances must not become directional predictions")
	}
}

// Cross geometry tests construct already-seeded points, isolating cross rules
// from independently tested rolling-window arithmetic.
func crossFixture(n int) ([]market.Candle, []Point) {
	candles := candlesWithPrice(n, 120)
	points := make([]Point, n)
	for i := range points {
		points[i] = Point{Time: candles[i].CloseTime, Tenkan: pointer(109.0), Kijun: pointer(110.0)}
		if i >= CloudWarmupBars-1 {
			points[i].SpanA, points[i].SpanB = pointer(100.0), pointer(90.0)
		}
	}
	return candles, points
}

func TestLectureCrossValidityCloudConfluenceAndMildException(t *testing.T) {
	for _, test := range []struct {
		name     string
		mutate   func([]market.Candle, []Point)
		valid    bool
		eligible bool
		strength string
		kind     string
	}{
		{"stacked", func(c []market.Candle, p []Point) { p[150].Tenkan = pointer(111.0) }, true, true, "stacked", "tk"},
		{"flat_tenkan", func(c []market.Candle, p []Point) { p[150].Kijun = pointer(108.0) }, false, false, "invalid", "tk_kijun_driven"},
		{"opposite_tenkan", func(c []market.Candle, p []Point) { p[150].Tenkan, p[150].Kijun = pointer(108.0), pointer(107.0) }, false, false, "invalid", "tk_kijun_driven"},
		{"mild_exception", func(c []market.Candle, p []Point) { p[150].Tenkan, p[150].Kijun = pointer(111.0), pointer(109.5) }, true, true, "mild", "tk_exceptional_bullish"},
		{"wrong_color", func(c []market.Candle, p []Point) {
			p[150].Tenkan, p[150].SpanA, p[150].SpanB = pointer(111.0), pointer(90.0), pointer(100.0)
		}, true, true, "less_confluent", "tk"},
		{"in_cloud_cross", func(c []market.Candle, p []Point) { p[150].Tenkan, p[150].SpanA = pointer(111.0), pointer(115.0) }, true, false, "ignored_in_cloud", "tk"},
		{"on_cloud_boundary", func(c []market.Candle, p []Point) { p[150].Tenkan, p[150].SpanA = pointer(111.0), pointer(110.0) }, true, false, "ignored_in_cloud", "tk"},
		{"in_cloud_price", func(c []market.Candle, p []Point) { p[150].Tenkan, c[150].Close = pointer(111.0), 95 }, true, false, "ignored_in_cloud", "tk"},
		{"cloud_unavailable", func(c []market.Candle, p []Point) {
			p[150].Tenkan, p[150].SpanA, p[150].SpanB = pointer(111.0), nil, nil
		}, true, false, "less_confluent", "tk"},
	} {
		t.Run(test.name, func(t *testing.T) {
			candles, points := crossFixture(151)
			test.mutate(candles, points)
			e := latestCross(candles, points, false)
			if e == nil || e.Valid != test.valid || e.EntryEligible != test.eligible || e.Strength != test.strength || e.Kind != test.kind ||
				e.Time != candles[150].CloseTime || e.AgeBars != 0 || e.Direction != "bullish" {
				t.Fatalf("wrong cross classification: %+v", e)
			}
		})
	}
	// Bearish geometry mirrors the ordinary bullish case, including red cloud.
	candles, points := crossFixture(151)
	points[150].Tenkan = pointer(111.0)
	for i := range points {
		points[i].Tenkan, points[i].Kijun = pointer(1000-*points[i].Tenkan), pointer(1000-*points[i].Kijun)
		if points[i].SpanA != nil {
			points[i].SpanA, points[i].SpanB = pointer(1000-*points[i].SpanA), pointer(1000-*points[i].SpanB)
		}
	}
	e := latestCross(mirror(candles, 1000), points, false)
	if e == nil || e.Direction != "bearish" || e.Strength != "stacked" || !e.EntryEligible {
		t.Fatalf("mirrored bearish cross not recognized: %+v", e)
	}
}

func TestCrossEqualityPlateausAreNotDuplicateCrosses(t *testing.T) {
	candles, points := crossFixture(154)
	points[150].Tenkan, points[151].Tenkan, points[152].Tenkan, points[153].Tenkan = pointer(110.0), pointer(110.0), pointer(111.0), pointer(111.0)
	if latestCross(candles[:152], points[:152], false) != nil {
		t.Fatal("touching equality is not a cross")
	}
	e := latestCross(candles, points, false)
	if e == nil || e.Time != candles[152].CloseTime || e.AgeBars != 1 {
		t.Fatalf("equality plateau should preserve prior strict side until departure: %+v", e)
	}
	points[152].Tenkan, points[153].Tenkan = pointer(109.0), pointer(109.0)
	if latestCross(candles, points, false) != nil {
		t.Fatal("touch then return to same side must not manufacture a crossover")
	}
	for i := range points {
		points[i].Tenkan = pointer(110.0)
	}
	points[153].Tenkan = pointer(111.0)
	if latestCross(candles, points, false) != nil {
		t.Fatal("initial equality departure alone does not establish a side reversal")
	}
}

func TestPKUsesCompletedPriceMovementAndSameCloudRules(t *testing.T) {
	candles, points := crossFixture(151)
	for i := range candles {
		candles[i].Close = 109
	}
	candles[150].Close = 111
	e := latestCross(candles, points, true)
	if e == nil || e.Kind != "pk" || e.Strength != "stacked" || !e.Valid || e.MovingChange1Bar != 2 {
		t.Fatalf("completed price crossing Kijun missing: %+v", e)
	}
	candles[150].Close, points[150].Kijun = 109, pointer(108.0)
	e = latestCross(candles, points, true)
	if e == nil || e.Valid || e.Kind != "pk_kijun_driven" {
		t.Fatal("flat price must not become a PK entry when Kijun crosses it")
	}
}

func TestTwistsUseCalculationTimeAndSeparateFutureDisplay(t *testing.T) {
	candles := candlesWithPrice(180, 100)
	points := Series(candles)
	for i := 119; i < len(points); i++ {
		a := 90.0
		if i >= 130 && i < 160 {
			a = 110
		}
		points[i].Tenkan, points[i].Kijun = pointer(a), pointer(a)
	}
	s := LectureSnapshot{Projection: []CloudPoint{}}
	calculateTwistsAndProjection(&s, candles, points)
	if s.CurrentTwist == nil || s.ProjectedTwist == nil || s.CurrentTwist.CalculatedAt != candles[130].CloseTime ||
		s.CurrentTwist.DisplayedAt != candles[160].CloseTime || s.CurrentTwist.Direction != "bullish" || s.CurrentTwist.Scope != "displayed" ||
		s.ProjectedTwist.CalculatedAt != candles[160].CloseTime || s.ProjectedTwist.DisplayedAt != candles[160].CloseTime+30*60_000 ||
		s.ProjectedTwist.Scope != "projected" || s.ProjectedTwist.Direction != "bearish" || s.ProjectedTwist.AgeBars != 19 ||
		s.TwistsObserved != 2 || !s.AlternatingTwists || len(s.Projection) != 30 {
		t.Fatalf("twist source/display distinction failed: %+v", s)
	}
	before := LectureSnapshot{}
	calculateTwistsAndProjection(&before, candles[:160], points[:160])
	// At prefix159, bullish twist at130 displays160 and is still future.
	if before.CurrentTwist != nil || before.ProjectedTwist == nil || before.ProjectedTwist.CalculatedAt != candles[130].CloseTime || before.TwistsObserved != 1 {
		t.Fatalf("prefix exposed a future source event: %+v", before)
	}
}

func TestLectureFromCompletedHistoryKeepsEventsAndProjectionCausal(t *testing.T) {
	candles := candlesWithPrice(360, 100)
	for i := range candles {
		price := 100 + 20*math.Sin(float64(i)/15)
		candles[i].Open, candles[i].Close = price, price
		candles[i].Low, candles[i].High = price-1, price+1
	}
	original := append([]market.Candle{}, candles...)
	for end := 150; end <= len(candles); end += 10 {
		prefix := candles[:end]
		s := AnalyzeLecture(prefix, pointer(2.0))
		if s.Status != "ready" || !reflect.DeepEqual(s.Kijun, Analyze(prefix, pointer(2.0)).Kijun) {
			t.Fatal("extended analysis must preserve legacy Kijun observations")
		}
		for _, e := range []*CrossEvent{s.TKCross, s.PKCross} {
			if e != nil && (e.Time > *s.AsOf || e.AgeBars < 0 || *s.AsOf-e.Time != int64(e.AgeBars)*60_000) {
				t.Fatalf("future or mistimed crossover: %+v", e)
			}
		}
		for _, e := range []*TwistEvent{s.CurrentTwist, s.ProjectedTwist} {
			if e != nil && (e.CalculatedAt > *s.AsOf || *s.AsOf-e.CalculatedAt != int64(e.AgeBars)*60_000 ||
				e.DisplayedAt-e.CalculatedAt != 30*60_000 || e.Scope == "displayed" && e.DisplayedAt > *s.AsOf ||
				e.Scope == "projected" && e.DisplayedAt <= *s.AsOf) {
				t.Fatalf("future source or mistimed twist: %+v", e)
			}
		}
		lastProjected := s.Projection[len(s.Projection)-1]
		if lastProjected.CalculatedAt != candles[end-1].CloseTime || lastProjected.DisplayedAt != candles[end-1].CloseTime+30*60_000 ||
			lastProjected.SpanA != average(midpoint(prefix[end-20:]), midpoint(prefix[end-60:])) ||
			lastProjected.SpanB != midpoint(prefix[end-120:]) {
			t.Fatal("known projected geometry must use the current complete source windows")
		}
	}
	final := AnalyzeLecture(candles, nil)
	if final.TKCross == nil || final.PKCross == nil || final.CurrentTwist == nil || final.TwistsObserved < 2 {
		t.Fatal("oscillating price fixture should exercise real crossover and twist paths")
	}
	if !reflect.DeepEqual(original, candles) {
		t.Fatal("lecture analysis mutated supplied candles")
	}
}

func edgeFixture(n int) ([]market.Candle, []Point) {
	candles := candlesWithPrice(n, 80)
	points := Series(candles)
	for i := CloudWarmupBars - 1; i < len(points); i++ {
		points[i].SpanA, points[i].SpanB = pointer(110.0), pointer(90.0)
	}
	return candles, points
}

func TestEdgeToEdgeClosingEntryRetestAndNewlyFlatOpposite(t *testing.T) {
	candles, points := edgeFixture(154)
	for i := 150; i < len(candles); i++ {
		candles[i].Open, candles[i].Close, candles[i].Low, candles[i].High = 95, 96, 91, 100
	}
	points[149].SpanA = pointer(109.0)
	points[151].SpanA, points[152].SpanA, points[153].SpanA = pointer(112.0), pointer(112.0), pointer(112.0)
	candles[152].Low = 89
	first := edgeContext(candles[:151], points[:151], pointer(2.0))
	if first.Status != "active" || first.OppositeFlat || first.Direction != "bullish" || first.RetestStatus != "awaiting_retest" {
		t.Fatalf("first inside close context wrong: %+v", first)
	}
	later := edgeContext(candles, points, pointer(2.0))
	if later.Status != "active" || !later.OppositeFlat || *later.OppositeFlatBars != 2 || later.RetestStatus != "held" ||
		*later.EnteredAt != candles[150].CloseTime || *later.RetestedAt != candles[152].CloseTime || *later.AgeBars != 3 {
		t.Fatalf("held retest should retain newly flat current opposite edge: %+v", later)
	}
	assertFloat(t, later.EntryEdge, 90)
	assertFloat(t, later.OppositeEdge, 112)
	assertFloat(t, later.Width, 22)
	assertFloat(t, later.WidthATR, 11)
	// Cloud color does not gate E2E, and its bearish mirror follows the same
	// original near-edge and dynamic opposite-edge semantics.
	for i := 149; i < len(points); i++ {
		points[i].SpanA, points[i].SpanB = points[i].SpanB, points[i].SpanA
	}
	red := edgeContext(candles, points, nil)
	if red.Status != "active" || !red.OppositeFlat || red.WidthATRStatus != "missing_atr" {
		t.Fatal("edge-to-edge must not require green cloud")
	}
	candles[153].High = 113
	reached := edgeContext(candles, points, nil)
	if reached.Status != "opposite_edge_reached" {
		t.Fatalf("opposite-edge range touch was not observed: %+v", reached)
	}
	candles[153].Close = 85
	failed := edgeContext(candles, points, nil)
	if failed.Status != "entry_lost" || failed.RetestStatus != "failed" {
		t.Fatalf("original entry-edge close loss must override ambiguous candle target touch: %+v", failed)
	}
}

func TestEdgeRequiresObservedEntryAndDistinctWidth(t *testing.T) {
	candles, points := edgeFixture(151)
	candles[149].Close, candles[150].Close = 100, 100
	if c := edgeContext(candles, points, nil); c.Status != "inside_without_entry" || c.EnteredAt != nil {
		t.Fatalf("pre-existing inside price manufactured an entry: %+v", c)
	}
	candles[149].Close = 80
	points[150].SpanA, points[150].SpanB = pointer(100.0), pointer(100.0)
	if c := edgeContext(candles, points, nil); c.Status != "zero_width" || *c.Width != 0 {
		t.Fatalf("zero-width cloud should not invent opposite-edge opportunity: %+v", c)
	}
}

func TestProjectionWithholdsUnsafeFutureTimestamps(t *testing.T) {
	const maxSafe = int64(1<<53 - 1)
	duration := maxSafe / 120
	candles := candlesWithPrice(120, 100)
	for i := range candles {
		candles[i].OpenTime, candles[i].CloseTime = int64(i)*duration, int64(i+1)*duration-1
	}
	s := AnalyzeLecture(candles, nil)
	if s.Status == "invalid" || len(s.Projection) != 0 || s.Tenkan.Value == nil {
		t.Fatal("unsafe extrapolated display timestamp must be withheld without discarding valid input context")
	}
}

func TestLectureCloneOwnsPointersAndSlicesAndIsFinite(t *testing.T) {
	s := AnalyzeLecture(flatGreenFixture(), pointer(5.0))
	s.TKCross = &CrossEvent{Time: 10, Reason: "sample"}
	s.PKCross = &CrossEvent{Time: 11}
	s.CurrentTwist = &TwistEvent{CalculatedAt: 12}
	s.ProjectedTwist = &TwistEvent{CalculatedAt: 13}
	candles, points := edgeFixture(152)
	candles[150].Close, candles[151].Close = 95, 96
	candles[151].Low, candles[151].High = 90, 99
	s.EdgeToEdge = edgeContext(candles, points, pointer(2.0))
	before, _ := json.Marshal(s)
	cloned := CloneLectureSnapshot(s)
	assertOwnedAndMutate(t, reflect.ValueOf(s), reflect.ValueOf(&cloned).Elem())
	after, err := json.Marshal(s)
	if err != nil || string(before) != string(after) {
		t.Fatal("mutating clone changed source")
	}
	empty := AnalyzeLecture(nil, nil)
	if !reflect.DeepEqual(empty, CloneLectureSnapshot(empty)) {
		t.Fatal("empty clone changed nil/empty semantics")
	}
	for _, price := range []float64{math.SmallestNonzeroFloat64, math.MaxFloat64 / 2, math.MaxFloat64} {
		s := AnalyzeLecture(candlesWithPrice(151, price), pointer(1.0))
		if _, err := json.Marshal(s); err != nil {
			t.Fatalf("extreme finite price produced non-finite output: %v", err)
		}
	}
}

func assertOwnedAndMutate(t *testing.T, original, clone reflect.Value) {
	t.Helper()
	switch clone.Kind() {
	case reflect.Struct:
		for i := 0; i < clone.NumField(); i++ {
			assertOwnedAndMutate(t, original.Field(i), clone.Field(i))
		}
	case reflect.Pointer:
		if !clone.IsNil() {
			if clone.Pointer() == original.Pointer() {
				t.Fatalf("clone shares pointer of type %s", clone.Type())
			}
			assertOwnedAndMutate(t, original.Elem(), clone.Elem())
		}
	case reflect.Slice:
		if clone.Len() > 0 && clone.Pointer() == original.Pointer() {
			t.Fatalf("clone shares slice %s", clone.Type())
		}
		for i := 0; i < clone.Len(); i++ {
			assertOwnedAndMutate(t, original.Index(i), clone.Index(i))
		}
	default:
		if clone.CanSet() {
			clone.Set(reflect.Zero(clone.Type()))
		}
	}
}

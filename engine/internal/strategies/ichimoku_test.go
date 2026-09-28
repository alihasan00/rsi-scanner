package strategies

import (
	"reflect"
	"strings"
	"testing"

	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

func ichCrossFixture() []market.Candle {
	bars := pbTestBars(202)
	for i := range bars {
		pbTestSet(bars, i, 100, 102, 98, 100)
	}
	pbTestSet(bars, 80, 100, 102, 50, 100)
	pbTestSet(bars, 150, 100, 130, 98, 100)
	for i := 181; i < 200; i++ {
		pbTestSet(bars, i, 112, 116, 110, 112)
	}
	pbTestSet(bars, 200, 112, 122, 111, 119)
	pbTestSet(bars, 201, 119, 120, 113.5, 118)
	return bars
}

func ichMirrorPoints(points []ichimoku.Point) []ichimoku.Point {
	out := make([]ichimoku.Point, len(points))
	for i, point := range points {
		out[i] = point
		for _, pair := range []struct{ from, to **float64 }{
			{&point.Tenkan, &out[i].Tenkan}, {&point.Kijun, &out[i].Kijun},
			{&point.SpanA, &out[i].SpanA}, {&point.SpanB, &out[i].SpanB},
		} {
			if *pair.from != nil {
				*pair.to = pbPtr(200 - **pair.from)
			}
		}
	}
	return out
}

func TestLectureTKAndPKCrossesNeedLaterRetestAndFreezePlans(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		bars := ichCrossFixture()
		if direction == "bearish" {
			bars = pbTestMirror(bars)
		}
		for _, family := range []string{TKCross, PKCross} {
			before := IchimokuOpportunities(pbTestInput(bars[:200]))
			for _, op := range before {
				if op.Family == family && op.AvailableAt == bars[200].CloseTime {
					t.Fatal("cross observed before its completed candle")
				}
			}
			waiting := pbTestFind(t, IchimokuOpportunities(pbTestInput(bars[:201])), family, direction, bars[200].CloseTime)
			if waiting.State != "waiting_for_retest" || waiting.TriggerAt != nil || !strings.Contains(waiting.Caution, "Stacked") {
				t.Fatalf("%s/%s cross state: %+v", family, direction, waiting)
			}
			op := pbTestFind(t, IchimokuOpportunities(pbTestInput(bars)), family, direction, bars[200].CloseTime)
			if op.State != "entry_confirmed" || op.RetestAt == nil || *op.TriggerAt != bars[201].CloseTime || op.Target == nil {
				t.Fatalf("%s/%s retest missing: %+v", family, direction, op)
			}
			wantLevel, wantTarget := 114.0, 130.0
			if direction == "bearish" {
				wantLevel, wantTarget = 86, 70
			}
			if op.Level != wantLevel || *op.Target != wantTarget {
				t.Fatalf("wrong midpoint or causal structural target: %+v", op)
			}
			future := append(append([]market.Candle{}, bars...), bars[len(bars)-1])
			future[202].OpenTime += 3600000
			future[202].CloseTime += 3600000
			pbTestSet(future, 202, 118, 150, 70, 120)
			later := pbTestFind(t, IchimokuOpportunities(pbTestInput(future)), family, direction, bars[200].CloseTime)
			if later.State != "invalidated" || later.ID != op.ID || *later.Stop != *op.Stop || *later.Target != *op.Target || *later.EntryMin != *op.EntryMin {
				t.Fatalf("later candle changed frozen plan or stop precedence: %+v", later)
			}
		}
	}
}

func TestLectureCrossGeometryCloudExclusionAndMildException(t *testing.T) {
	// Keep exact causal prices, isolate line/cloud geometry at the event.
	// Production uses the same values directly from the tested Series API.
	for _, direction := range []string{"bullish", "bearish"} {
		for _, mode := range []string{"kt", "inside", "less_confluent", "mild", "touch_recede"} {
			bars := ichCrossFixture()[:201]
			points := ichimoku.Series(bars)
			want := mode == "less_confluent" || mode == "mild"
			switch mode {
			case "kt":
				points[199].Tenkan, points[199].Kijun = pbPtr(110.0), pbPtr(114.0)
				points[200].Tenkan, points[200].Kijun = pbPtr(110.0), pbPtr(108.0)
			case "inside":
				points[200].SpanA, points[200].SpanB = pbPtr(120.0), pbPtr(100.0)
			case "less_confluent":
				points[200].SpanA, points[200].SpanB = pbPtr(100.0), pbPtr(107.0)
			case "mild":
				points[199].Kijun = pbPtr(115.0)
			case "touch_recede":
				for i := 180; i < 199; i++ {
					points[i].Tenkan = pbPtr(116.0)
				}
				points[199].Tenkan = pbPtr(114.0)
			}
			if direction == "bearish" {
				bars, points = pbTestMirror(bars), ichMirrorPoints(points)
			}
			ops := ichCrossOpportunities(pbTestInput(bars), "1h", bars, points, TKCross)
			var found *Opportunity
			for i := range ops {
				if ops[i].AvailableAt == bars[200].CloseTime && ops[i].Direction == direction {
					found = &ops[i]
				}
			}
			if (found != nil) != want {
				t.Fatalf("%s/%s inclusion = %t; expected %t", direction, mode, found != nil, want)
			}
			if found != nil && (mode == "mild" && direction == "bullish" && !strings.Contains(found.Caution, "Mild") || mode == "less_confluent" && !strings.Contains(found.Caution, "Less-confluent")) {
				t.Fatalf("strength lost: %+v", found)
			}
			if found != nil && mode == "mild" && direction == "bearish" && strings.Contains(found.Caution, "Mild") {
				t.Fatalf("bullish-only lecture exception was assigned to a bearish cross: %+v", found)
			}
		}
	}
}

func ichEdgeFixture(color string, delayed bool) []market.Candle {
	bars := pbTestBars(153)
	for i := range bars {
		pbTestSet(bars, i, 100, 102, 98, 100)
	}
	if color == "red" {
		pbTestSet(bars, 15, 100, 130, 98, 100)
	} else {
		pbTestSet(bars, 15, 100, 102, 50, 100)
	}
	if delayed {
		pbTestSet(bars, 0, 100, 150, 98, 100)
		pbTestSet(bars, 1, 100, 140, 98, 100)
	}
	points := ichimoku.Series(bars)
	low, high, _ := ichCloud(points[150])
	entry := low + .2*(high-low)
	pbTestSet(bars, 149, low-1, low-.5, low-2, low-1)
	pbTestSet(bars, 150, low-1, entry+.5, low-1.5, entry)
	pbTestSet(bars, 151, entry, entry+1, entry-.5, entry+.5)
	pbTestSet(bars, 152, entry+.5, entry+1, low-.25, entry+.5)
	return bars
}

func TestLectureEdgeToEdgeIsColorIndependentAndFreezesOppositeEdge(t *testing.T) {
	for _, color := range []string{"green", "red"} {
		for _, direction := range []string{"bullish", "bearish"} {
			bars := ichEdgeFixture(color, false)[:151]
			if direction == "bearish" {
				bars = pbTestMirror(bars)
			}
			original := append([]market.Candle{}, bars...)
			op := pbTestFind(t, IchimokuOpportunities(pbTestInput(bars)), CloudEdgeToEdge, direction, bars[150].CloseTime)
			lo, hi, _ := ichCloud(ichimoku.Series(bars)[150])
			want := hi
			if direction == "bearish" {
				want = lo
			}
			if op.State != "entry_confirmed" || op.Target == nil || *op.Target != want || op.RetestAt != nil || *op.TriggerAt != bars[150].CloseTime {
				t.Fatalf("%s/%s flat-edge entry failed: %+v", color, direction, op)
			}
			if !reflect.DeepEqual(bars, original) {
				t.Fatal("detector mutated captured history")
			}
			future := append(append([]market.Candle{}, bars...), bars[150])
			future[151].OpenTime += 3600000
			future[151].CloseTime += 3600000
			if direction == "bullish" {
				future[151].High = want
			} else {
				future[151].Low = want
			}
			later := pbTestFind(t, IchimokuOpportunities(pbTestInput(future)), CloudEdgeToEdge, direction, bars[150].CloseTime)
			if later.State != "target_reached" || *later.Target != *op.Target || *later.Stop != *op.Stop || later.ID != op.ID {
				t.Fatalf("frozen opposite-edge lifecycle drifted: %+v", later)
			}
		}
	}
}

func TestLectureEdgeToEdgeMayWaitForNewlyFlatTargetAtHeldRetest(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		bars := ichEdgeFixture("red", true)
		if direction == "bearish" {
			bars = pbTestMirror(bars)
		}
		waiting := pbTestFind(t, IchimokuOpportunities(pbTestInput(bars[:151])), CloudEdgeToEdge, direction, bars[150].CloseTime)
		if waiting.State != "waiting_for_retest" || waiting.Target != nil || waiting.TriggerAt != nil {
			t.Fatalf("nonflat entry created a premature plan: %+v", waiting)
		}
		op := pbTestFind(t, IchimokuOpportunities(pbTestInput(bars)), CloudEdgeToEdge, direction, bars[150].CloseTime)
		want := 114.0
		if direction == "bearish" {
			want = 86
		}
		if op.State != "entry_confirmed" || op.RetestAt == nil || *op.TriggerAt != bars[152].CloseTime || *op.Target != want || op.Level != waiting.Level {
			t.Fatalf("held retest did not freeze its newly flat edge: %+v", op)
		}
		// The new lower far-edge value had already been touched at entry.
		// Later flattening must not present it as an unconsumed target.
		if direction == "bullish" {
			bars[150].High = 114.5
		} else {
			bars[150].Low = 85.5
		}
		consumed := pbTestFind(t, IchimokuOpportunities(pbTestInput(bars)), CloudEdgeToEdge, direction, bars[150].CloseTime)
		if consumed.State != "extended_before_entry" || consumed.Target != nil {
			t.Fatalf("consumed target was resurrected: %+v", consumed)
		}
	}
}

func TestLectureEdgeToEdgeRejectsEntryOrRetestWickAlreadyAtTarget(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		for _, delayed := range []bool{false, true} {
			bars := ichEdgeFixture("red", delayed)
			at := 150
			if delayed {
				at = 152
			}
			_, target, _ := ichCloud(ichimoku.Series(bars)[at])
			bars[at].High = target
			if direction == "bearish" {
				bars = pbTestMirror(bars)
			}
			op := pbTestFind(t, IchimokuOpportunities(pbTestInput(bars)), CloudEdgeToEdge, direction, bars[150].CloseTime)
			if op.State != "extended_before_entry" || op.Target != nil || op.TriggerAt != nil {
				t.Fatalf("%s/delayed%t created entry after same-candle target excursion: %+v", direction, delayed, op)
			}
		}
	}
}

func TestLectureCloudBreakoutDoesNotRequireCandleColorAndCanRetestInterior(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		bars := pbTestBars(162)
		for i := range bars {
			pbTestSet(bars, i, 100, 102, 98, 100)
		}
		pbTestSet(bars, 15, 100, 125, 98, 100)
		pbTestSet(bars, 159, 109, 110, 108, 109)
		// The bullish breakout closes above the cloud but below its own open.
		pbTestSet(bars, 160, 115, 116, 108, 114)
		// A held bounce entirely inside the cloud must be usable as a zone retest.
		pbTestSet(bars, 161, 107, 110, 105, 109)
		if direction == "bearish" {
			bars = pbTestMirror(bars)
		}
		op := pbTestFind(t, PullbackOpportunities(pbTestInput(bars)), CloudReclaim, direction, bars[160].CloseTime)
		if op.State != "entry_confirmed" || op.RetestAt == nil || *op.RetestAt != bars[161].CloseTime || op.Stop == nil {
			t.Fatalf("lecture cloud zone retest not admitted: %+v", op)
		}
		// Already-known candle 131 first appears in the DISPLAYED cloud at161.
		// Retesting yesterday's source cloud alone cannot confirm this setup.
		changed := append([]market.Candle{}, bars...)
		if direction == "bullish" {
			pbTestSet(changed, 131, 100, 150, 98, 100)
			pbTestSet(changed, 161, 114, 115, 111, 114)
		} else {
			pbTestSet(changed, 131, 100, 102, 50, 100)
			pbTestSet(changed, 161, 86, 89, 85, 86)
		}
		invalidated := pbTestFind(t, PullbackOpportunities(pbTestInput(changed)), CloudReclaim, direction, bars[160].CloseTime)
		if invalidated.State != "invalidated" || invalidated.TriggerAt != nil {
			t.Fatalf("old frozen boundary substituted for current displayed cloud: %+v", invalidated)
		}
	}
}

func TestLecturePKCrossRejectsKijunMovingThroughStationaryPrice(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		bars := ichCrossFixture()[:201]
		points := ichimoku.Series(bars)
		bars[200].Close = bars[199].Close
		points[200].Kijun = pbPtr(110.0)
		if direction == "bearish" {
			bars, points = pbTestMirror(bars), ichMirrorPoints(points)
		}
		for _, op := range ichCrossOpportunities(pbTestInput(bars), "1h", bars, points, PKCross) {
			if op.AvailableAt == bars[200].CloseTime {
				t.Fatalf("Kijun-only movement created PK entry: %+v", op)
			}
		}
	}
}

func TestLectureKijunReclaimRequiresCurrentLineAtBreakAndRetest(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		for _, at := range []int{20, 21} {
			bars := pbTestBars(82)
			for i := range bars {
				pbTestSet(bars, i, 102, 106, 98, 102)
			}
			pbTestSet(bars, 5, 102, 120, 98, 102)
			// Expiry of this old low moves Kijun from100 to102. At20 it
			// leaves at the breakout; at21 it leaves at the later retest.
			pbTestSet(bars, at, 102, 106, 94, 102)
			pbTestSet(bars, 79, 100, 103, 98, 99)
			pbTestSet(bars, 80, 99, 103, 98.9, 101)
			pbTestSet(bars, 81, 101, 103, 99.8, 101.5)
			if direction == "bearish" {
				bars = pbTestMirror(bars)
			}
			ops := PullbackOpportunities(pbTestInput(bars))
			var found *Opportunity
			for i := range ops {
				if ops[i].Family == KijunReclaim && ops[i].Direction == direction && ops[i].AvailableAt == bars[80].CloseTime {
					found = &ops[i]
				}
			}
			if at == 20 && found != nil {
				t.Fatalf("prior Kijun alone admitted a breakout below the actual Kijun: %+v", found)
			}
			if at == 21 && (found == nil || found.State != "invalidated" || found.TriggerAt != nil) {
				t.Fatalf("retest of the old line substituted for a current Kijun hold: %+v", found)
			}
		}
	}
}

func TestLectureIchimokuRejectsInvalidHistoryAndNeverUsesPreview(t *testing.T) {
	bars := ichCrossFixture()
	in := pbTestInput(bars[:200])
	in.Histories["1h"] = scanner.History{Candles: bars[:200], Preview: &bars[200]}
	got := IchimokuOpportunities(in)
	want := IchimokuOpportunities(pbTestInput(bars[:200]))
	if !reflect.DeepEqual(got, want) {
		t.Fatal("preview affected cross detection")
	}
	bars[195].OpenTime++
	if len(IchimokuOpportunities(pbTestInput(bars))) != 0 {
		t.Fatal("gapped history generated Ichimoku opportunities")
	}
}

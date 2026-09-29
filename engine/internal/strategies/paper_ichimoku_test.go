package strategies

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

func paperIchimokuTestBars(count int) []market.Candle {
	bars := make([]market.Candle, count)
	for i := range bars {
		bars[i] = market.Candle{OpenTime: int64(i) * paperDonchianDayMS,
			CloseTime: int64(i+1)*paperDonchianDayMS - 1,
			Open:      100, High: 102, Low: 98, Close: 100, Volume: 10}
	}
	return bars
}

func paperIchimokuTestSet(bars []market.Candle, at int, open, high, low, close float64) {
	bars[at].Open, bars[at].High, bars[at].Low, bars[at].Close = open, high, low, close
}

func paperIchimokuTestMirror(bars []market.Candle) {
	for i, bar := range bars {
		bars[i].Open, bars[i].High, bars[i].Low, bars[i].Close =
			200-bar.Open, 200-bar.Low, 200-bar.High, 200-bar.Close
	}
}

func paperIchimokuCloudFixture() []market.Candle {
	bars := paperIchimokuTestBars(162)
	paperIchimokuTestSet(bars, 15, 100, 125, 98, 100)
	for i := 110; i < 133; i++ {
		paperIchimokuTestSet(bars, i, 109, 110, 108, 109)
	}
	paperIchimokuTestSet(bars, 159, 109, 110, 108, 109)
	paperIchimokuTestSet(bars, 160, 109, 115, 108, 114)
	paperIchimokuTestSet(bars, 161, 114, 115, 111, 114)
	return bars
}

func paperIchimokuTKFixture() []market.Candle {
	bars := paperIchimokuTestBars(202)
	paperIchimokuTestSet(bars, 80, 100, 102, 50, 100)
	paperIchimokuTestSet(bars, 150, 100, 130, 98, 100)
	for i := 181; i < 200; i++ {
		paperIchimokuTestSet(bars, i, 112, 116, 110, 112)
	}
	paperIchimokuTestSet(bars, 200, 112, 122, 111, 119)
	paperIchimokuTestSet(bars, 201, 119, 120, 113.5, 118)
	return bars
}

func paperIchimokuTestInput(bars []market.Candle) Input {
	return Input{Symbol: "TESTUSDT", Histories: map[string]scanner.History{"1d": {Candles: bars}}}
}

func paperIchimokuFind(ops []Opportunity, family string, origin int64) (Opportunity, bool) {
	for _, op := range ops {
		if op.Family == family && op.AvailableAt == origin {
			return op, true
		}
	}
	return Opportunity{}, false
}

func TestPaperCloudMatchesSourceDailyReclaimAndFrozenPlan(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			bars := paperIchimokuCloudFixture()
			if direction == "bearish" {
				paperIchimokuTestMirror(bars)
			}
			origin := bars[160].CloseTime
			if op, found := paperIchimokuFind(PaperCloudTKOpportunities(paperIchimokuTestInput(bars[:161]), bars[160].CloseTime+1), PaperCloudVolume2R, origin); found {
				t.Fatalf("developing cloud breakout became an entry: %+v", op)
			}
			ops := PaperCloudTKOpportunities(paperIchimokuTestInput(bars), bars[161].CloseTime+1)
			op, found := paperIchimokuFind(ops, PaperCloudVolume2R, origin)
			if !found {
				t.Fatalf("source cloud fixture produced no curated daily base: %+v", ops)
			}
			wantTarget := 125.0
			if direction == "bearish" {
				wantTarget = 75
			}
			if op.ID != "curated-v1:ichimoku-v2:TESTUSDT:1d:cloud_reclaim:"+direction+":"+fmt.Sprintf("%d", origin)+":volume20-net2r" ||
				op.Direction != direction || op.Interval != "1d" || op.State != "entry_confirmed" ||
				op.LocationAvailableAt != bars[159].CloseTime || op.SourceEndAt != bars[159].CloseTime ||
				op.RetestAt == nil || *op.RetestAt != bars[161].CloseTime ||
				op.TriggerAt == nil || *op.TriggerAt != bars[161].CloseTime ||
				op.EntryReference == nil || *op.EntryReference != bars[161].Close ||
				op.Target == nil || *op.Target != wantTarget ||
				op.ExpiresAt == nil || *op.ExpiresAt != bars[161].CloseTime+4*paperDonchianDayMS {
				t.Fatalf("source cloud identity or frozen plan differs: %+v", op)
			}
			points := ichimoku.Series(bars)
			priorLow, priorHigh, _ := paperCloudBounds(points[159])
			atr, ready := paperSimpleATR(bars, 161)
			if !ready {
				t.Fatal("source fixture has no confirmation ATR")
			}
			wantStop := priorLow - 0.1*atr
			if direction == "bearish" {
				wantStop = priorHigh + 0.1*atr
			}
			if op.Stop == nil || *op.Stop != wantStop || op.ZoneLow == nil || *op.ZoneLow != priorLow ||
				op.ZoneHigh == nil || *op.ZoneHigh != priorHigh || op.EntryMin == nil || op.EntryMax == nil ||
				*op.EntryMin > *op.EntryReference || *op.EntryMax < *op.EntryReference ||
				!strings.Contains(op.Next, "net 2R after actual slipped entry") {
				t.Fatalf("cloud reference geometry or cap disclosure differs: %+v", op)
			}
		})
	}
}

func TestPaperCloudVolumeIsFrozenAtFirstEligibleCloseAndExcludesCurrent(t *testing.T) {
	bars := paperIchimokuCloudFixture()
	origin := bars[160].CloseTime
	points := ichimoku.Series(bars)
	pattern, found := paperCloudOriginAt(bars, points, 160, 1)
	if !found {
		t.Fatal("source fixture has no cloud origin")
	}
	plan, confirmed, first, ready := paperIchimokuPlan(pattern, bars, points, bars[161].CloseTime+1)
	_ = plan
	if !ready || confirmed != 161 || first != 161 {
		t.Fatalf("fixture must first qualify on held retest: confirmed=%d first=%d ready=%v", confirmed, first, ready)
	}
	lowVolume := append([]market.Candle(nil), bars...)
	lowVolume[161].Volume = 9
	if op, found := paperIchimokuFind(PaperCloudTKOpportunities(paperIchimokuTestInput(lowVolume), lowVolume[161].CloseTime+1), PaperCloudVolume2R, origin); found {
		t.Fatalf("volume below preceding 20-bar mean qualified: %+v", op)
	}
	later := append(lowVolume, market.Candle{OpenTime: 162 * paperDonchianDayMS,
		CloseTime: 163*paperDonchianDayMS - 1, Open: 114, High: 115, Low: 111, Close: 114, Volume: 100})
	if op, found := paperIchimokuFind(PaperCloudTKOpportunities(paperIchimokuTestInput(later), later[len(later)-1].CloseTime+1), PaperCloudVolume2R, origin); found {
		t.Fatalf("later volume revived the rejected cloud identity: %+v", op)
	}
	passing := append([]market.Candle(nil), later...)
	passing[161].Volume = 10
	passing[162].Volume = 0
	op, found := paperIchimokuFind(PaperCloudTKOpportunities(paperIchimokuTestInput(passing), passing[len(passing)-1].CloseTime+1), PaperCloudVolume2R, origin)
	if !found {
		t.Fatal("current zero volume replaced the eligible close's frozen volume")
	}
	previous, _ := paperIchimokuFind(PaperCloudTKOpportunities(paperIchimokuTestInput(bars), bars[161].CloseTime+1), PaperCloudVolume2R, origin)
	if op.ID != previous.ID || *op.Stop != *previous.Stop || *op.Target != *previous.Target ||
		*op.EntryMin != *previous.EntryMin || *op.EntryMax != *previous.EntryMax || *op.ExpiresAt != *previous.ExpiresAt {
		t.Fatalf("later source changed the frozen cloud plan: before=%+v after=%+v", previous, op)
	}
}

func TestPaperTKSourceDailyCrossAndRSIGate(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			bars := paperIchimokuTKFixture()
			if direction == "bearish" {
				paperIchimokuTestMirror(bars)
			}
			origin := bars[200].CloseTime
			if op, found := paperIchimokuFind(PaperCloudTKOpportunities(paperIchimokuTestInput(bars[:201]), bars[200].CloseTime+1), PaperTKCrossRSI, origin); found {
				t.Fatalf("TK cross before its held retest became an entry: %+v", op)
			}
			ops := PaperCloudTKOpportunities(paperIchimokuTestInput(bars), bars[201].CloseTime+1)
			op, found := paperIchimokuFind(ops, PaperTKCrossRSI, origin)
			if !found {
				t.Fatalf("source TK fixture produced no RSI profile: %+v", ops)
			}
			wantLevel, wantTarget := 114.0, 130.0
			if direction == "bearish" {
				wantLevel, wantTarget = 86, 70
			}
			if op.ID != "curated-v2:ichimoku-v2:TESTUSDT:1d:tk_cross:"+direction+":"+fmt.Sprintf("%d", origin)+":tk_cross_rsi" ||
				op.Direction != direction || op.Level != wantLevel || op.Target == nil || *op.Target != wantTarget ||
				op.RetestAt == nil || *op.RetestAt != bars[201].CloseTime ||
				op.TriggerAt == nil || *op.TriggerAt != bars[201].CloseTime ||
				op.EntryReference == nil || *op.EntryReference != bars[201].Close ||
				op.ExpiresAt == nil || *op.ExpiresAt != bars[201].CloseTime+4*paperDonchianDayMS {
				t.Fatalf("TK source geometry or identity differs: %+v", op)
			}
			atr, ready := paperSimpleATR(bars, 201)
			if !ready {
				t.Fatal("missing TK confirmation ATR")
			}
			wantStop := bars[201].Low - 0.1*atr
			if direction == "bearish" {
				wantStop = bars[201].High + 0.1*atr
			}
			if op.Stop == nil || *op.Stop != wantStop || op.EntryMin == nil || op.EntryMax == nil ||
				*op.EntryMin > *op.EntryReference || *op.EntryMax < *op.EntryReference {
				t.Fatalf("TK frozen stop/entry band differs: %+v", op)
			}
		})
	}
}

func TestPaperCloudAndTKFiltersUseFirstRawEligibility(t *testing.T) {
	base := Opportunity{ID: "curated-v1:raw:volume20-net2r", Family: PaperCloudVolume2R,
		Direction: "bullish", Reason: "volume passed", Stop: pbPtr(90.0), Target: pbPtr(120.0)}
	all := paperCloudProfiles(base, "raw", PaperFeatures{EMA: 1, SMA: 1, MACD: 1, Supertrend: 1, AO: 1})
	if len(all) != 6 {
		t.Fatalf("all aligned cloud profiles = %d, want 6", len(all))
	}
	seen := map[string]bool{}
	for _, op := range all {
		if seen[op.ID] || op.Stop == nil || *op.Stop != 90 || op.Target == nil || *op.Target != 120 {
			t.Fatalf("cloud variant lost independent ID or original plan: %+v", op)
		}
		seen[op.ID] = true
	}
	if got := paperCloudProfiles(base, "raw", PaperFeatures{EMA: -1, SMA: -1, MACD: -1, Supertrend: -1, AO: -1}); len(got) != 1 {
		t.Fatalf("opposed states admitted filtered long cloud profiles: %+v", got)
	}
	base.Direction = "bearish"
	if got := paperCloudProfiles(base, "raw", PaperFeatures{EMA: -1, SMA: -1, MACD: -1, Supertrend: -1, AO: -1}); len(got) != 6 {
		t.Fatalf("aligned short cloud states did not pass: %+v", got)
	}
	bars := paperIchimokuTestBars(58)
	plan, ready := paperFreezeFixed(bars, 55, "bullish", 95, 105)
	if !ready {
		t.Fatal("missing frozen first-eligibility fixture")
	}
	bars[56].Close, bars[57].Close = 99, 99
	if first := paperFirstFixedEligibility(plan, bars, 55, "bullish"); first != 56 {
		t.Fatalf("the first raw eligible close should be 56, got %d", first)
	}
	if paperAssessFixed(plan, bars[:56], 55, "bullish", bars[55].CloseTime+1) {
		t.Fatal("confirmation itself must not be raw eligible in this fixture")
	}
}

func TestPaperTKCrossGeometryPreservesEqualityAndMovingLine(t *testing.T) {
	bars := paperIchimokuTestBars(2)
	bars[1].Close = 102
	point := func(tenkan, kijun, spanA, spanB float64) ichimoku.Point {
		return ichimoku.Point{Tenkan: pbPtr(tenkan), Kijun: pbPtr(kijun), SpanA: pbPtr(spanA), SpanB: pbPtr(spanB)}
	}
	points := []ichimoku.Point{point(100, 100, 90, 80), point(101, 100, 90, 80)}
	if _, ok := paperTKOriginAt(bars, points, 1, -1); !ok {
		t.Fatal("prior bearish side did not survive a Tenkan/Kijun equality plateau")
	}
	if _, ok := paperTKOriginAt(bars, points, 1, 0); ok {
		t.Fatal("first departure from equality invented a cross")
	}
	points[0].Tenkan = pbPtr(101.0)
	points[1].Tenkan, points[1].Kijun = pbPtr(101.0), pbPtr(100.0)
	if _, ok := paperTKOriginAt(bars, points, 1, -1); ok {
		t.Fatal("moving Kijun past a flat Tenkan invented a cross")
	}
	points[1] = point(101, 100, 100, 80)
	if _, ok := paperTKOriginAt(bars, points, 1, -1); ok {
		t.Fatal("Kijun on the cloud boundary was treated as outside")
	}
}

func TestPaperIchimokuNoProvisionalOrUnrelatedFrameAndExpiry(t *testing.T) {
	bars := paperIchimokuCloudFixture()
	input := paperIchimokuTestInput(bars)
	input.Histories["4h"] = scanner.History{Candles: paperIchimokuTestBars(12)}
	origin := bars[160].CloseTime
	if op, found := paperIchimokuFind(PaperCloudTKOpportunities(input, bars[161].CloseTime), PaperCloudVolume2R, origin); found {
		t.Fatalf("unfinished latest daily bar produced a profile: %+v", op)
	}
	base, found := paperIchimokuFind(PaperCloudTKOpportunities(input, bars[161].CloseTime+1), PaperCloudVolume2R, origin)
	if !found {
		t.Fatal("unrelated 4h history gated a daily cloud profile")
	}
	if op, found := paperIchimokuFind(PaperCloudTKOpportunities(input, *base.ExpiresAt), PaperCloudVolume2R, origin); found {
		t.Fatalf("expired four-bar plan remained current: %+v", op)
	}
	if base.Target == nil || math.IsNaN(*base.Target) {
		t.Fatal("invalid source target")
	}
}

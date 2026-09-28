package strategies

import (
	"testing"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

func pbTestBars(n int) []market.Candle {
	b := make([]market.Candle, n)
	for i := range b {
		b[i] = market.Candle{OpenTime: int64(i) * 3600000, CloseTime: int64(i+1)*3600000 - 1, Open: 100, High: 103, Low: 97, Close: 100, Volume: 1}
	}
	return b
}
func pbTestSet(b []market.Candle, i int, o, h, l, c float64) {
	b[i].Open, b[i].High, b[i].Low, b[i].Close = o, h, l, c
}
func pbTestInput(b []market.Candle) Input {
	return Input{Symbol: "TESTUSDT", Histories: map[string]scanner.History{"1h": {Candles: b}}}
}
func pbTestMirror(b []market.Candle) []market.Candle {
	out := append([]market.Candle{}, b...)
	for i, c := range b {
		out[i].Open, out[i].High, out[i].Low, out[i].Close = 200-c.Open, 200-c.Low, 200-c.High, 200-c.Close
	}
	return out
}
func pbTestRange(b []market.Candle, start int) {
	closes := []float64{92, 96, 100, 104, 108, 104, 100, 96, 92, 96}
	for i := 0; i < 20; i++ {
		v := closes[i%len(closes)]
		pbTestSet(b, start+i, v, v+2, v-2, v)
	}
}
func pbTestFind(t *testing.T, ops []Opportunity, family, direction string, at int64) Opportunity {
	t.Helper()
	for _, op := range ops {
		if op.Family == family && op.Direction == direction && op.AvailableAt == at {
			return op
		}
	}
	t.Fatalf("missing%s %s at%d in%+v", family, direction, at, ops)
	return Opportunity{}
}

func TestRangeRejectionMirroredAndFrozenBeforeReaction(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			b := pbTestBars(22)
			pbTestRange(b, 0)
			pbTestSet(b, 20, 92, 96, 89, 94)
			pbTestSet(b, 21, 94, 98, 93, 97)
			if direction == "bearish" {
				b = pbTestMirror(b)
			}
			if got := RangeOpportunities(pbTestInput(b[:20])); len(got) != 0 {
				t.Fatalf("reaction leaked before candle: %+v", got)
			}
			waiting := pbTestFind(t, RangeOpportunities(pbTestInput(b[:21])), RangeRejection, direction, b[20].CloseTime)
			if waiting.State != "awaiting_confirmation" || waiting.TriggerAt != nil {
				t.Fatalf("not observing reaction: %+v", waiting)
			}
			op := pbTestFind(t, RangeOpportunities(pbTestInput(b)), RangeRejection, direction, b[20].CloseTime)
			if op.State != "entry_confirmed" || op.TriggerAt == nil || *op.TriggerAt != b[21].CloseTime || *op.ZoneLow != 90 || *op.ZoneHigh != 110 {
				t.Fatalf("incorrect frozen range: %+v", op)
			}
			future := pbTestBars(23)
			copy(future, b)
			pbTestSet(future, 22, 100, 112, 88, 100)
			later := pbTestFind(t, RangeOpportunities(pbTestInput(future)), RangeRejection, direction, b[20].CloseTime)
			if later.State != "invalidated" || later.ID != op.ID || *later.Stop != *op.Stop || *later.Target != *op.Target || *later.EntryMin != *op.EntryMin {
				t.Fatalf("plan drift or missing stop-first terminal: before%+v after%+v", op, later)
			}
		})
	}
}

func TestCompressionMustExistBeforeBreakAndNeedsKnownTarget(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			b := pbTestBars(42)
			pbTestSet(b, 8, 100, 130, 97, 100)
			pbTestSet(b, 10, 100, 103, 70, 100)
			pbTestSet(b, 18, 100, 120, 97, 100)
			pbTestSet(b, 19, 100, 103, 80, 100)
			pbTestRange(b, 20)
			pbTestSet(b, 40, 108, 114, 107, 113)
			pbTestSet(b, 41, 113, 114, 109, 112)
			if direction == "bearish" {
				b = pbTestMirror(b)
			}
			ops := RangeOpportunities(pbTestInput(b))
			op := pbTestFind(t, ops, CompressionBreakout, direction, b[40].CloseTime)
			if op.State != "entry_confirmed" || op.RetestAt == nil || *op.RetestAt != b[41].CloseTime {
				t.Fatalf("no held-retest confirmation: %+v", op)
			}
			want := 120.0
			if direction == "bearish" {
				want = 80
			}
			if op.Target == nil || *op.Target != want {
				t.Fatalf("target not pre-existing pivot: %+v", op)
			}
			seeds := rngSeeds("TESTUSDT", "1h", b[:40])
			found := false
			for _, seed := range seeds {
				if seed.compressed && seed.box.High == 110 && seed.box.Low == 90 {
					found = true
				}
			}
			if !found {
				t.Fatal("pre-break compressed range not observed")
			}
			// The same retest with no older outside pivot cannot manufacture
			// a measured-move target from the breakout itself.
			for i := 0; i < 20; i++ {
				pbTestSet(b, i, 100, 120, 80, 100)
			}
			rejected := pbTestFind(t, RangeOpportunities(pbTestInput(b)), CompressionBreakout, direction, b[40].CloseTime)
			if rejected.State != "rejected" || rejected.Target != nil {
				t.Fatalf("fabricated target: %+v", rejected)
			}
		})
	}
}

func TestRangeHistoryGapsAndObservationExpiry(t *testing.T) {
	b := pbTestBars(45)
	pbTestRange(b, 0)
	pbTestSet(b, 20, 92, 96, 89, 94)
	for i := 21; i < len(b); i++ {
		pbTestSet(b, i, 94, 95, 93, 94)
	}
	op := pbTestFind(t, RangeOpportunities(pbTestInput(b)), RangeRejection, "bullish", b[20].CloseTime)
	if op.State != "expired" || op.ResolvedAt == nil || *op.ResolvedAt != b[44].CloseTime {
		t.Fatalf("observation did not expire: %+v", op)
	}
	broken := append([]market.Candle{}, b...)
	broken[22].OpenTime++
	if got := RangeOpportunities(pbTestInput(broken)); len(got) != 0 {
		t.Fatalf("gap admitted: %+v", got)
	}
	in := pbTestInput(b)
	in.Histories["1h"] = scanner.History{Candles: b[:20], Preview: &b[20]}
	if got := RangeOpportunities(in); len(got) != 0 {
		t.Fatalf("unclosed preview influenced detection: %+v", got)
	}
}

func TestDescribeFrozenRangeAndSeparateVolatility(t *testing.T) {
	b := pbTestBars(20)
	pbTestRange(b, 0)
	ctx := Describe(pbTestInput(b))
	if ctx.Availability != "ready" || ctx.DirectionalState != "range" || ctx.Range == nil || ctx.Range.High != 110 || ctx.Range.Low != 90 {
		t.Fatalf("range context missing: %+v", ctx)
	}
	if ctx.VolatilityState != "unavailable" {
		t.Fatal("volatility rank claimed before warmup")
	}
	if ctx.AsOf == nil || *ctx.AsOf != b[19].CloseTime {
		t.Fatal("incorrect as-of")
	}
	b[19].High = 1e200
	if ctx.Range.High != 110 {
		t.Fatal("published range aliases input")
	}
}

func TestRangePlanStableAcrossRollingFiveHundredBars(t *testing.T) {
	b := pbTestBars(501)
	pbTestRange(b, 478)
	pbTestSet(b, 498, 92, 96, 89, 94)
	pbTestSet(b, 499, 94, 98, 93, 97)
	pbTestSet(b, 500, 97, 98, 94, 97)
	before := pbTestFind(t, RangeOpportunities(pbTestInput(b[:500])), RangeRejection, "bullish", b[498].CloseTime)
	after := pbTestFind(t, RangeOpportunities(pbTestInput(b[1:])), RangeRejection, "bullish", b[498].CloseTime)
	if before.State != "entry_confirmed" || after.State != "entry_confirmed" || before.ID != after.ID || before.SourceStartAt != after.SourceStartAt || before.SourceEndAt != after.SourceEndAt || before.LocationAvailableAt != after.LocationAvailableAt || *before.Stop != *after.Stop || *before.Target != *after.Target {
		t.Fatalf("rolling prefix changed range: before%+v after%+v", before, after)
	}
}

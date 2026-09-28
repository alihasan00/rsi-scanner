package strategies

import (
	"testing"

	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

func pbTestFVG() []market.Candle {
	b := pbTestBars(43)
	for i := 20; i < 38; i++ {
		pbTestSet(b, i, 105, 108, 102, 105)
	}
	pbTestSet(b, 5, 100, 140, 97, 100)
	pbTestSet(b, 38, 108, 110, 106, 109)
	pbTestSet(b, 39, 109, 116, 108, 115)
	pbTestSet(b, 40, 115, 117, 113, 116)
	pbTestSet(b, 41, 114, 116, 112, 115)
	pbTestSet(b, 42, 115, 118, 114, 117)
	return b
}
func TestFVGFirstRevisitMirroredAndNoMidpointResurrection(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			b := pbTestFVG()
			if direction == "bearish" {
				b = pbTestMirror(b)
			}
			waiting := pbTestFind(t, PullbackOpportunities(pbTestInput(b[:42])), FVGPullback, direction, b[40].CloseTime)
			if waiting.State != "awaiting_confirmation" || waiting.TriggerAt != nil {
				t.Fatalf("first revisit not distinct: %+v", waiting)
			}
			op := pbTestFind(t, PullbackOpportunities(pbTestInput(b)), FVGPullback, direction, b[40].CloseTime)
			if op.State != "entry_confirmed" || op.Target == nil {
				t.Fatalf("no FVG entry: %+v", op)
			}
			f := pbTestBars(44)
			copy(f, b)
			pbTestSet(f, 43, 115, 118, 111, 115)
			if direction == "bearish" {
				f[43] = pbTestMirror(f[43:44])[0]
			}
			later := pbTestFind(t, PullbackOpportunities(pbTestInput(f)), FVGPullback, direction, b[40].CloseTime)
			if later.State != "entry_confirmed" || *later.Stop != *op.Stop || *later.Target != *op.Target {
				t.Fatalf("post-trigger source retirement rewrote price plan: %+v", later)
			}
			invalid := pbTestFVG()
			pbTestSet(invalid, 41, 114, 116, 111, 115)
			if direction == "bearish" {
				invalid = pbTestMirror(invalid)
			}
			retired := pbTestFind(t, PullbackOpportunities(pbTestInput(invalid)), FVGPullback, direction, invalid[40].CloseTime)
			if retired.State != "invalidated" || retired.TriggerAt != nil || *retired.ResolvedAt != invalid[41].CloseTime {
				t.Fatalf("midpoint retirement resurrected: %+v", retired)
			}
		})
	}
}

func TestFVGRequiresPriorBreakAndFirstReaction(t *testing.T) {
	b := pbTestFVG()
	pbTestSet(b, 30, 105, 119, 102, 105)
	for _, op := range PullbackOpportunities(pbTestInput(b)) {
		if op.Family == FVGPullback && op.AvailableAt == b[40].CloseTime {
			t.Fatalf("no-break gap admitted: %+v", op)
		}
	}
	b = pbTestFVG()
	pbTestSet(b, 41, 114, 116, 112, 113.5)
	op := pbTestFind(t, PullbackOpportunities(pbTestInput(b)), FVGPullback, "bullish", b[40].CloseTime)
	if op.State != "rejected" || op.TriggerAt != nil {
		t.Fatalf("later candle rescued failed first reaction: %+v", op)
	}
}

func pbTestFib() []market.Candle {
	b := pbTestBars(37)
	values := [][4]float64{{86, 90, 80, 87}, {88, 94, 86, 92}, {92, 99, 90, 97}, {97, 105, 95, 103}, {103, 111, 101, 109}, {109, 116, 107, 114}, {114, 119, 112, 117}, {117, 120, 114, 118}, {118, 119, 111, 114}, {114, 116, 108, 110}, {94, 101, 94, 99}, {99, 105, 98, 103}}
	for i, v := range values {
		pbTestSet(b, 25+i, v[0], v[1], v[2], v[3])
	}
	return b
}
func TestFibonacciConfirmedImpulseMirroredFrozenAndCausal(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			b := pbTestFib()
			if direction == "bearish" {
				b = pbTestMirror(b)
			}
			for _, op := range PullbackOpportunities(pbTestInput(b[:34])) {
				if op.Family == FibonacciPullback && op.AvailableAt == b[34].CloseTime {
					t.Fatal("future endpoint confirmation leaked")
				}
			}
			wait := pbTestFind(t, PullbackOpportunities(pbTestInput(b[:35])), FibonacciPullback, direction, b[34].CloseTime)
			if wait.State != "waiting_for_retest" || wait.TriggerAt != nil {
				t.Fatalf("not waiting after known impulse: %+v", wait)
			}
			op := pbTestFind(t, PullbackOpportunities(pbTestInput(b)), FibonacciPullback, direction, b[34].CloseTime)
			if op.State != "entry_confirmed" || op.Target == nil {
				t.Fatalf("no Fibonacci trigger: %+v", op)
			}
			want := 120.0
			if direction == "bearish" {
				want = 80
			}
			if *op.Target != want {
				t.Fatalf("target was not frozen endpoint: %+v", op)
			}
			future := pbTestBars(38)
			copy(future, b)
			pbTestSet(future, 37, 103, 121, 102, 119)
			if direction == "bearish" {
				future[37] = pbTestMirror(future[37:38])[0]
			}
			later := pbTestFind(t, PullbackOpportunities(pbTestInput(future)), FibonacciPullback, direction, b[34].CloseTime)
			if later.State != "target_reached" || later.ID != op.ID || *later.ZoneLow != *op.ZoneLow || *later.ZoneHigh != *op.ZoneHigh || *later.Target != *op.Target {
				t.Fatalf("future impulse expansion moved evidence: %+v", later)
			}
		})
	}
}

func TestKijunReclaimRetestsFrozenPriorBoundary(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			b := pbTestBars(82)
			for i := range b {
				pbTestSet(b, i, 100, 102, 98, 100)
			}
			pbTestSet(b, 5, 100, 120, 98, 100)
			pbTestSet(b, 79, 100, 102, 98, 99)
			pbTestSet(b, 80, 99, 102, 98.9, 101)
			pbTestSet(b, 81, 101, 102, 99.8, 101.5)
			if direction == "bearish" {
				b = pbTestMirror(b)
			}
			op := pbTestFind(t, PullbackOpportunities(pbTestInput(b)), KijunReclaim, direction, b[80].CloseTime)
			if op.State != "entry_confirmed" || op.Level != 100 || op.RetestAt == nil || *op.TriggerAt != b[81].CloseTime {
				t.Fatalf("bad Kijun reclaim: %+v", op)
			}
			future := pbTestBars(83)
			copy(future, b)
			pbTestSet(future, 82, 102, 110, 101, 108)
			if direction == "bearish" {
				future[82] = pbTestMirror(future[82:83])[0]
			}
			later := pbTestFind(t, PullbackOpportunities(pbTestInput(future)), KijunReclaim, direction, b[80].CloseTime)
			if later.ID != op.ID || later.Level != 100 || *later.Target != *op.Target || *later.Stop != *op.Stop {
				t.Fatalf("moving Kijun moved frozen plan: %+v", later)
			}
		})
	}
}

func TestCloudUsesPreviouslyDisplayedDisplacedSpans(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		t.Run(direction, func(t *testing.T) {
			b := pbTestBars(162)
			for i := range b {
				pbTestSet(b, i, 100, 102, 98, 100)
			}
			pbTestSet(b, 15, 100, 125, 98, 100)
			pbTestSet(b, 159, 109, 110, 108, 109)
			pbTestSet(b, 160, 109, 115, 108, 114)
			pbTestSet(b, 161, 114, 115, 111, 114)
			if direction == "bearish" {
				b = pbTestMirror(b)
			}
			prior := ichimoku.Analyze(b[:160], nil)
			op := pbTestFind(t, PullbackOpportunities(pbTestInput(b)), CloudReclaim, direction, b[160].CloseTime)
			if op.State != "entry_confirmed" || *op.ZoneLow != *prior.Cloud.Lower || *op.ZoneHigh != *prior.Cloud.Upper || *op.TriggerAt != b[161].CloseTime {
				t.Fatalf("wrong displayed cloud: %+v vs %+v", op, prior.Cloud)
			}
			current := pbMidpoint(b[40:160])
			if op.Level == current {
				t.Fatalf("used newly calculated forward span instead of displayed cloud: %+v", op)
			}
		})
	}
}

func TestPullbackPostTriggerExpiryAndInvalidHistory(t *testing.T) {
	b := pbTestFVG()
	long := pbTestBars(47)
	copy(long, b)
	for i := 43; i < len(long); i++ {
		pbTestSet(long, i, 117, 118, 114, 117)
	}
	op := pbTestFind(t, PullbackOpportunities(pbTestInput(long)), FVGPullback, "bullish", b[40].CloseTime)
	if op.State != "expired" || *op.ResolvedAt != long[46].CloseTime {
		t.Fatalf("entry window failed to expire: %+v", op)
	}
	long[45].High = -1
	if got := PullbackOpportunities(pbTestInput(long)); len(got) != 0 {
		t.Fatalf("invalid candle admitted: %+v", got)
	}
}

func TestPullbackFourHourScaleAndCausalProvenance(t *testing.T) {
	b := pbTestFVG()
	for i := range b {
		b[i].OpenTime = int64(i) * 14400000
		b[i].CloseTime = int64(i+1)*14400000 - 1
	}
	in := pbTestInput(nil)
	in.Histories = map[string]scanner.History{"4h": {Candles: b}}
	op := pbTestFind(t, PullbackOpportunities(in), FVGPullback, "bullish", b[40].CloseTime)
	if op.State != "entry_confirmed" || op.Interval != "4h" || *op.ExpiresAt != b[42].CloseTime+4*14400000 {
		t.Fatalf("4h timing differs from source convention: %+v", op)
	}
	if op.SourceStartAt != b[38].OpenTime || op.SourceEndAt != b[40].CloseTime || op.LocationAvailableAt != b[40].CloseTime || op.SourceEndAt > op.LocationAvailableAt || op.LocationAvailableAt > op.AvailableAt || op.AvailableAt > *op.TriggerAt {
		t.Fatalf("noncausal source provenance: %+v", op)
	}
	// A frame identifying a later or earlier completed prefix must not admit
	// candidates from this different history.
	in.Frames = map[string]scanner.SeriesSummary{"4h": {LastClosedAt: b[41].CloseTime}}
	if got := PullbackOpportunities(in); len(got) != 0 {
		t.Fatalf("frame/history mismatch accepted: %+v", got)
	}
}

func TestPullbackTargetConsumedBeforeLocationIsUnavailable(t *testing.T) {
	b := pbTestFVG()
	// Equal later highs consume the old pivot without creating another strict
	// confirmed pivot. Neither revisit may revive the old target at140.
	pbTestSet(b, 14, 100, 140, 97, 100)
	pbTestSet(b, 15, 100, 140, 97, 100)
	op := pbTestFind(t, PullbackOpportunities(pbTestInput(b)), FVGPullback, "bullish", b[40].CloseTime)
	if op.State != "rejected" || op.Target != nil {
		t.Fatalf("already-consumed pivot revived as target: %+v", op)
	}
}

func TestPullbackPlansStableAcrossRollingFiveHundredBars(t *testing.T) {
	for _, tc := range []struct {
		family  string
		fixture []market.Candle
		known   int
	}{{FVGPullback, pbTestFVG(), 40}, {FibonacciPullback, pbTestFib(), 34}} {
		t.Run(tc.family, func(t *testing.T) {
			b := pbTestBars(501)
			offset := 500 - len(tc.fixture)
			for j, c := range tc.fixture {
				pbTestSet(b, offset+j, c.Open, c.High, c.Low, c.Close)
			}
			last := b[499]
			pbTestSet(b, 500, last.Close, last.Close+1, last.Close-1, last.Close)
			at := b[offset+tc.known].CloseTime
			before := pbTestFind(t, PullbackOpportunities(pbTestInput(b[:500])), tc.family, "bullish", at)
			after := pbTestFind(t, PullbackOpportunities(pbTestInput(b[1:])), tc.family, "bullish", at)
			if before.State != "entry_confirmed" || after.State != "entry_confirmed" || before.ID != after.ID || before.SourceStartAt != after.SourceStartAt || before.SourceEndAt != after.SourceEndAt || before.LocationAvailableAt != after.LocationAvailableAt || *before.Stop != *after.Stop || *before.Target != *after.Target || *before.EntryMin != *after.EntryMin || *before.EntryMax != *after.EntryMax {
				t.Fatalf("rolling history changed frozen plan: before%+v after%+v", before, after)
			}
		})
	}
}

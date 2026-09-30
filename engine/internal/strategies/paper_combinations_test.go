package strategies

import (
	"encoding/json"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"math"
	"os"
	"testing"
)

type comboFixture struct {
	Symbol, Frame, Method string
	Expected              bool
	Candles               []market.Candle
	Entry                 *struct {
		ID          string
		ManagedPlan struct {
			Entry, Stop, ATR           float64
			Target, EntryMin, EntryMax *float64
			ConfirmedAt, ExpiresAt     int64
		} `json:"managedPlan"`
	}
	Events map[string][]struct {
		Index, Side int
		Stop        *float64
	}
}

func loadComboFixtures(t *testing.T) []comboFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/combinations_rust.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []comboFixture
	if err = json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	return fixtures
}
func comboInput(f comboFixture) Input {
	return Input{Symbol: f.Symbol, Histories: map[string]scanner.History{f.Frame: {Candles: f.Candles}}}
}
func near(a, b float64) bool { return math.Abs(a-b) <= 1e-12*math.Max(1, math.Abs(b)) }
func TestCombinationsMatchRustSignalsAndHelpers(t *testing.T) {
	fixtures := loadComboFixtures(t)
	if len(fixtures) != 79 {
		t.Fatal("incomplete reference cases")
	}
	counts := map[string][2]int{}
	for k, f := range fixtures {
		t.Run(f.Method+":"+f.Symbol+":"+string(rune(k+65)), func(t *testing.T) {
			in := comboInput(f)
			ops := PaperLuxAlgoOpportunities(in, f.Frame)
			if f.Frame == "4h" {
				ops = PaperRangeWeeklyOpportunities(in)
			}
			var got *Opportunity
			for _, op := range ops {
				if op.Family == f.Method {
					copy := op
					got = &copy
				}
			}
			if (got != nil) != f.Expected {
				t.Fatalf("case %d expected %v got %+v", k, f.Expected, got)
			}
			count := counts[f.Method]
			if f.Expected {
				count[1]++
			} else {
				count[0]++
			}
			counts[f.Method] = count
			if got != nil {
				p := f.Entry.ManagedPlan
				if got.ID != f.Entry.ID || !near(*got.Stop, p.Stop) || !near(*got.ReferenceATR, p.ATR) || *got.EntryReference != p.Entry || *got.TriggerAt != p.ConfirmedAt || *got.ExpiresAt != p.ExpiresAt {
					t.Fatalf("frozen plan mismatch case %d: %+v vs %+v", k, got, p)
				}
				for key, pair := range map[string][2]*float64{"target": {got.Target, p.Target}, "minimum": {got.EntryMin, p.EntryMin}, "maximum": {got.EntryMax, p.EntryMax}} {
					if (pair[0] == nil) != (pair[1] == nil) || pair[0] != nil && !near(*pair[0], *pair[1]) {
						t.Fatalf("%s changed", key)
					}
				}
			}
			funcs := map[string]func([]market.Candle) []luxEvent{"trendlines": luxTrendlines, "cluster": luxCluster, "sfp": luxSFP, "ultimate": luxUltimate, "nwe": luxNWE}
			for name, want := range f.Events {
				actual := funcs[name](f.Candles)
				if len(actual) != len(want) {
					t.Fatalf("case %d %s event count %d != %d", k, name, len(actual), len(want))
				}
				for i, e := range actual {
					w := want[i]
					if e.index != w.Index || e.side != w.Side || w.Stop != nil && !near(e.stop, *w.Stop) {
						t.Fatalf("case %d %s[%d] %+v != %+v", k, name, i, e, w)
					}
				}
			}
		})
	}
	for _, family := range []string{PaperTrendADX, PaperTrendCluster, PaperTrendSFP, PaperRangeWeekly, PaperNWEMomentum} {
		c := counts[family]
		if c[0] == 0 || c[1] == 0 {
			t.Fatal("missing positive/negative", family)
		}
	}
}
func TestComboHelperCancellationAndAge(t *testing.T) {
	e := []luxEvent{{4, 1, math.NaN()}, {8, -1, math.NaN()}}
	if !luxAgrees(e, 6, 2) || luxAgrees(e, 7, 2) || !luxAgrees(e, 7, -1) || luxAgrees(e, 8, -1) {
		t.Fatal("helper age or opposite cancellation")
	}
	e = append(e, luxEvent{8, 1, 0})
	if luxAgrees(e, 8, -1) {
		t.Fatal("opposite events must neutralize")
	}
	if luxAgrees(nil, 10, -1) {
		t.Fatal("missing helper")
	}
}
func TestComboWarmupGapsAndPrefixCausality(t *testing.T) {
	for _, f := range loadComboFixtures(t) {
		if !f.Expected || f.Frame == "4h" {
			continue
		}
		in := comboInput(f)
		if f.Frame == "15m" {
			h := in.Histories[f.Frame]
			h.Candles = h.Candles[len(h.Candles)-998:]
			in.Histories[f.Frame] = h
			if len(PaperLuxAlgoOpportunities(in, f.Frame)) != 0 {
				t.Fatal("NWE emitted before crossing warmup")
			}
		}
		in = comboInput(f)
		h := in.Histories[f.Frame]
		h.Candles = append([]market.Candle{}, h.Candles...)
		h.Candles = append(h.Candles[:20:20], h.Candles[21:]...)
		in.Histories[f.Frame] = h
		if len(PaperLuxAlgoOpportunities(in, f.Frame)) != 0 {
			t.Fatal("gap carried helper state")
		}
		// Full-array pivot calculations must never introduce events before their right confirmation.
		for _, fn := range []func([]market.Candle) []luxEvent{luxTrendlines, luxSFP, luxCluster, luxUltimate, luxNWE} {
			n := len(f.Candles) - 3
			prefix := fn(f.Candles[:n])
			full := fn(f.Candles)
			i := 0
			for _, e := range full {
				if e.index < n {
					if i >= len(prefix) || e.index != prefix[i].index || e.side != prefix[i].side {
						t.Fatal("future candle changed a past event")
					}
					i++
				}
			}
			if i != len(prefix) {
				t.Fatal("prefix mismatch")
			}
		}
	}
}

package strategies

import (
	"encoding/json"
	"os"
	"slices"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func TestPaperPreciseSumMatchesResearchRounding(t *testing.T) {
	for _, test := range []struct {
		values []float64
		want   float64
	}{
		{[]float64{1e16, 1, -1e16}, 1},
		{[]float64{1e-16, 1, 1e16}, 1.0000000000000002e16},
	} {
		if got := paperPreciseSum(test.values); got != test.want {
			t.Fatalf("precise sum of %v = %.17g, want %.17g", test.values, got, test.want)
		}
	}
}

func TestPaperSourceFeaturesMatchAuditedFixtureAndCausalPrefixes(t *testing.T) {
	var fixture struct {
		Provenance string          `json:"provenance"`
		Candles    []market.Candle `json:"candles"`
		States     []struct {
			Directions [7]int8 `json:"directions"`
			ADXRange   bool    `json:"adxRange"`
		} `json:"states"`
	}
	data, err := os.ReadFile("testdata/signal_forge_states.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Candles) <= 300 || len(fixture.Candles) != len(fixture.States) || fixture.Provenance == "" {
		t.Fatalf("incomplete research fixture: %d candles, %d states", len(fixture.Candles), len(fixture.States))
	}
	got := paperSourceFeatures(fixture.Candles)
	if len(got) != len(fixture.Candles) {
		t.Fatalf("feature count = %d, want %d", len(got), len(fixture.Candles))
	}
	for i, state := range fixture.States {
		want := PaperFeatures{
			EMA: state.Directions[0], SMA: state.Directions[1],
			MACD: state.Directions[2], Stoch: state.Directions[3],
			RSI: state.Directions[4], Supertrend: state.Directions[5],
			AO: state.Directions[6], ADXRange: state.ADXRange,
		}
		if got[i] != want {
			t.Fatalf("feature at candle %d = %+v, want %+v", i, got[i], want)
		}
	}
	gap := -1
	for i := 1; i < len(fixture.Candles); i++ {
		if fixture.Candles[i-1].CloseTime+1 != fixture.Candles[i].OpenTime {
			gap = i
			break
		}
	}
	if gap < 0 {
		t.Fatal("fixture must contain a real quote gap")
	}
	if suffix := paperSourceFeatures(fixture.Candles[gap:]); !slices.Equal(suffix, got[gap:]) {
		t.Fatalf("features after gap at candle %d did not reset to a fresh source", gap)
	}
	for _, end := range []int{1, 14, 27, 80, gap, gap + 1, 300, len(fixture.Candles)} {
		if prefix := paperSourceFeatures(fixture.Candles[:end]); !slices.Equal(prefix, got[:end]) {
			t.Fatalf("later candles changed features in prefix ending at %d", end)
		}
	}
}

package strategies

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"github.com/alihasan00/crypto/internal/market"
)

func TestRangeIdentityNeverInheritsAnotherRetainedBox(t *testing.T) {
	raw, err := os.ReadFile("testdata/avnt-range-retention.json")
	if err != nil { t.Fatal(err) }
	var bars []market.Candle
	if err := json.Unmarshal(raw, &bars); err != nil { t.Fatal(err) }
	wanted := "v1:AVNTUSDT:1h:compression_breakout:bullish:1790265599999"
	var first *Opportunity
	terminal := false
	for n := 40; n <= len(bars); n++ {
		in := pbTestInput(bars[:n]); in.Symbol = "AVNTUSDT"
		for _, op := range RangeOpportunities(in) {
			if op.ID != wanted { continue }
			if first == nil { copy := op; first = &copy }
			if op.Level != first.Level || op.LocationAvailableAt != first.LocationAvailableAt || !reflect.DeepEqual(op.ZoneHigh, first.ZoneHigh) {
				t.Fatalf("frozen source changed at prefix %d: before=%+v after=%+v", n, first, op)
			}
			if terminal && op.ResolvedAt == nil { t.Fatalf("terminal ID resurrected at prefix %d: %+v", n, op) }
			terminal = terminal || op.ResolvedAt != nil
		}
	}
	if first == nil || !terminal { t.Fatal("regression did not cover the original terminal setup") }
}

func TestEntryIntervalStaysStrictlyInsideProtectiveLevels(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		b := pbTestBars(20)
		op := Opportunity{Direction: direction}
		stop, target := 99.99, 103.0
		if direction == "bearish" { stop, target = 100.01, 97 }
		pbTrigger(&op, b, 19, stop, &target)
		if op.EntryMin == nil || op.EntryMax == nil { t.Fatalf("missing interval: %+v", op) }
		for _, entry := range []float64{*op.EntryMin, *op.EntryMax} {
			if !pbBreak(direction, entry, stop) || !pbBreak(direction, target, entry) { t.Fatalf("advertised entry %.8f crosses protective levels: %+v", entry, op) }
		}
	}
}

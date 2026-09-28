package harmonic

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
)

func TestUnavailableATROmitsDEntryRoute(t *testing.T) {
	p := Pattern{Kind: "gartley", Direction: "bullish", X: Point{Price: 100}, A: Point{Price: 200}, B: Point{Price: 138.2}, C: Point{Price: 180}, D: &Point{Price: 121.4}, EntryTouched: true, Entry: 122, dEntryOffset: math.NaN()}
	cfg := DefaultConfig()
	cfg.EntryOffsetMode = "atr"
	setLevels(&p, definitions[p.Kind], cfg)
	if p.EntryAfterD != nil {
		t.Fatal("unavailable ATR published a D-entry reference")
	}
	if _, err := json.Marshal(p); err != nil {
		t.Fatalf("unavailable ATR broke pattern JSON: %v", err)
	}
}

func TestATROffsetUsesConfirmationHistory(t *testing.T) {
	candles := make([]market.Candle, 16)
	for i := range candles {
		candles[i] = market.Candle{High: 102, Low: 98, Close: 100}
	}
	cfg := DefaultConfig()
	cfg.EntryOffsetMode, cfg.EntryOffsetATR = "atr", .25
	if got := confirmedEntryOffset(candles, 13, cfg); got != 1 {
		t.Fatalf("offset=%v want1", got)
	}
	// A later extreme candle must not change an already-established offset.
	candles[15].High = 10000
	if got := confirmedEntryOffset(candles, 13, cfg); got != 1 {
		t.Fatalf("future data changed offset=%v", got)
	}
	candles[14].High = 116
	if got, want := confirmedEntryOffset(candles, 14, cfg), 1.25; math.Abs(got-want) > 1e-12 {
		t.Fatalf("Wilder offset=%v want%v", got, want)
	}
	if !math.IsNaN(confirmedEntryOffset(candles, 12, cfg)) {
		t.Fatal("unready ATR silently became a price offset")
	}
}

func TestEntryOffsetMirrorsDirectionAndScalesWithVolatility(t *testing.T) {
	for _, direction := range []string{"bullish", "bearish"} {
		p := Pattern{Kind: "gartley", Direction: direction, X: Point{Price: 100}, A: Point{Price: 200}, B: Point{Price: 138.2}, C: Point{Price: 180}, D: &Point{Price: 121.4}, dEntryOffset: 2}
		cfg := DefaultConfig()
		cfg.EntryOffsetMode = "atr"
		setLevels(&p, definitions[p.Kind], cfg)
		want := 123.4
		if direction == "bearish" {
			want = 119.4
		}
		if math.Abs(*p.EntryAfterD-want) > 1e-12 {
			t.Fatalf("%s ATR entry=%v want%v", direction, *p.EntryAfterD, want)
		}
		cfg.EntryOffsetMode = "percent"
		setLevels(&p, definitions[p.Kind], cfg)
		want = 121.4 * 1.01
		if direction == "bearish" {
			want = 121.4 * .99
		}
		if math.Abs(*p.EntryAfterD-want) > 1e-12 {
			t.Fatalf("%s percent entry=%v want%v", direction, *p.EntryAfterD, want)
		}
	}
}

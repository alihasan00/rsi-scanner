package strategies

import (
	"strings"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

func paperDonchianTestBars(count int) []market.Candle {
	bars := make([]market.Candle, count)
	for i := range bars {
		bars[i] = market.Candle{
			OpenTime: int64(i) * paperDonchianDayMS, CloseTime: int64(i+1)*paperDonchianDayMS - 1,
			Open: 100, High: 102, Low: 98, Close: 100, Volume: 10,
		}
	}
	return bars
}

func paperDonchianTestInput(bars []market.Candle) Input {
	return Input{Symbol: "TESTUSDT", Histories: map[string]scanner.History{"1d": {Candles: bars}}}
}

func paperDonchianTestBase(t *testing.T, found []Opportunity) Opportunity {
	t.Helper()
	for _, op := range found {
		if op.Family == PaperDonchianBase {
			return op
		}
	}
	t.Fatalf("missing base Donchian opportunity in %+v", found)
	return Opportunity{}
}

func TestPaperDonchianUsesExactly55PriorDailyHighsAndSourceATR(t *testing.T) {
	bars := paperDonchianTestBars(56)
	bars[55].Close, bars[55].High = 110, 112
	profiles := PaperDonchianOpportunities(paperDonchianTestInput(bars))
	base := paperDonchianTestBase(t, profiles)
	if len(profiles) != 4 || profiles[1].Family != PaperDonchianStoch ||
		profiles[2].Family != PaperDonchianMACD || profiles[3].Family != PaperDonchianADXRange {
		t.Fatalf("completed source breakout did not expose all qualifying profiles: %+v", profiles)
	}
	wantATR := (13*4.0 + 14.0) / 14.0
	if base.Level != 102 || base.EntryReference == nil || *base.EntryReference != 110 ||
		base.ReferenceATR == nil || *base.ReferenceATR != wantATR ||
		base.Stop == nil || *base.Stop != 110-2*wantATR {
		t.Fatalf("Donchian breakout and source ATR geometry drifted: %+v", base)
	}
	// The frozen research calculation divides once after summing the 14 true
	// ranges. The older per-step TR/14 convention differs on this fixture.
	perStep := 0.0
	for i := 0; i < 13; i++ {
		perStep += 4.0 / 14.0
	}
	perStep += 14.0 / 14.0
	if perStep == *base.ReferenceATR {
		t.Fatal("fixture does not distinguish source ATR order")
	}
	if base.ID != "native-v1:TESTUSDT:1d:donchian55_atr_trail:bullish:4838399999" ||
		base.Interval != "1d" || base.Direction != "bullish" || base.State != "entry_confirmed" ||
		base.TriggerAt == nil || *base.TriggerAt != bars[55].CloseTime ||
		base.ExpiresAt == nil || *base.ExpiresAt != 57*paperDonchianDayMS ||
		base.SourceStartAt != bars[0].OpenTime || base.SourceEndAt != bars[55].CloseTime ||
		base.Target != nil || base.EntryMin != nil || base.EntryMax != nil ||
		base.ZoneLow != nil || base.ZoneHigh != nil {
		t.Fatalf("Donchian identity, timing or target changed: %+v", base)
	}
	for _, fragment := range []string{"next whole one-minute opening", "3.5-ATR", "20 daily lows", "96 daily bars"} {
		if !strings.Contains(base.Next, fragment) {
			t.Fatalf("missing managed rule %q in next action: %s", fragment, base.Next)
		}
	}
	if !strings.Contains(base.Caution, "No fixed profit target") || !strings.Contains(base.Invalidation, "2-ATR") {
		t.Fatalf("managed-exit cautions are incomplete: %+v", base)
	}
}

func TestPaperDonchianRequiresFreshStrictLongBreakoutAndContiguousSourceWindow(t *testing.T) {
	bars := paperDonchianTestBars(56)
	bars[55].Close, bars[55].High = 110, 112
	if got := PaperDonchianOpportunities(paperDonchianTestInput(bars[:55])); len(got) != 0 {
		t.Fatalf("55 bars cannot establish 55 prior highs: %+v", got)
	}
	wrong := append([]market.Candle(nil), bars...)
	wrong[55].Close = 102
	if got := PaperDonchianOpportunities(paperDonchianTestInput(wrong)); len(got) != 0 {
		t.Fatalf("equal channel close passed a strict breakout: %+v", got)
	}
	wrong = append([]market.Candle(nil), bars...)
	for i := 31; i < len(wrong); i++ {
		wrong[i].OpenTime += paperDonchianDayMS
		wrong[i].CloseTime += paperDonchianDayMS
	}
	if got := PaperDonchianOpportunities(paperDonchianTestInput(wrong)); len(got) != 0 {
		t.Fatalf("gap within the 56-bar source window was ignored: %+v", got)
	}
	stale := paperDonchianTestInput(bars)
	stale.Frames = map[string]scanner.SeriesSummary{"1d": {
		Symbol: "TESTUSDT", Interval: "1d", LastClosedAt: bars[55].CloseTime, Stale: true,
	}}
	if got := PaperDonchianOpportunities(stale); len(got) != 0 {
		t.Fatalf("stale source frame produced a breakout: %+v", got)
	}
	// A completed high older than the 55-bar lookback is not in the channel.
	older := paperDonchianTestBars(57)
	older[0].High = 200
	older[56].Close, older[56].High = 110, 112
	base := paperDonchianTestBase(t, PaperDonchianOpportunities(paperDonchianTestInput(older)))
	if base.Level != 102 || base.SourceStartAt != older[1].OpenTime {
		t.Fatalf("old high leaked into the 55-bar channel: %+v", base)
	}
	// A wide signal bar cannot publish a nonpositive protective stop.
	wide := append([]market.Candle(nil), bars...)
	wide[55].High = 1000
	if got := PaperDonchianOpportunities(paperDonchianTestInput(wide)); len(got) != 0 {
		t.Fatalf("nonpositive initial stop admitted: %+v", got)
	}
}

func TestPaperDonchianVariantFiltersAndIdentitiesAreIndependent(t *testing.T) {
	base := Opportunity{ID: "native-v1:TESTUSDT:1d:donchian55_atr_trail:bullish:1", Family: PaperDonchianBase,
		Reason: "Completed 55-high breakout", Target: nil}
	all := paperDonchianProfiles(base, PaperFeatures{Stoch: 1, MACD: 1, ADXRange: true})
	want := []string{PaperDonchianBase, PaperDonchianStoch, PaperDonchianMACD, PaperDonchianADXRange}
	if len(all) != len(want) {
		t.Fatalf("all matching profiles = %d, want 4", len(all))
	}
	seen := map[string]bool{}
	for i, op := range all {
		if op.Family != want[i] || seen[op.ID] || op.Target != nil {
			t.Fatalf("duplicate, reordered or fixed-target profile: %+v", op)
		}
		seen[op.ID] = true
		if i > 0 && (op.ID != "curated-v2:"+base.ID+":"+op.Family || op.ParentID != base.ID || op.Reason == base.Reason) {
			t.Fatalf("filtered profile lost source identity or rule: %+v", op)
		}
	}
	if got := paperDonchianProfiles(base, PaperFeatures{Stoch: -1, MACD: 0}); len(got) != 1 {
		t.Fatalf("nonqualifying indicator states revived a variant: %+v", got)
	}
	if got := paperDonchianProfiles(base, PaperFeatures{Stoch: 1, MACD: -1}); len(got) != 2 || got[1].Family != PaperDonchianStoch {
		t.Fatalf("variant filters were not independent: %+v", got)
	}
}

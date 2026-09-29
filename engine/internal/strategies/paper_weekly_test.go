package strategies

import (
	"encoding/json"
	"math"
	"os"
	"sort"
	"testing"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

type paperWeeklyFixture struct {
	Candles  []market.Candle `json:"candles"`
	Original struct {
		Symbol        string  `json:"symbol"`
		TriggerAt     int64   `json:"triggerAt"`
		ReferenceAt   int64   `json:"referenceAt"`
		ReferenceLow  float64 `json:"referenceLow"`
		ReferenceHigh float64 `json:"referenceHigh"`
		Plan          struct {
			Entry       float64 `json:"entry"`
			Stop        float64 `json:"stop"`
			Target      float64 `json:"target"`
			ATR         float64 `json:"atr"`
			EntryMin    float64 `json:"entryMin"`
			EntryMax    float64 `json:"entryMax"`
			ConfirmedAt int64   `json:"confirmedAt"`
			ExpiresAt   int64   `json:"expiresAt"`
		} `json:"plan"`
	} `json:"original"`
	Trade struct {
		ID       string  `json:"id"`
		RawEntry float64 `json:"rawEntry"`
	} `json:"trade"`
}

func paperWeeklyLoadFixture(t *testing.T) paperWeeklyFixture {
	t.Helper()
	data, err := os.ReadFile("testdata/native_weekly_frozen_range.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture paperWeeklyFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Candles) < 100 || fixture.Original.Symbol == "" || fixture.Trade.ID == "" {
		t.Fatal("incomplete native weekly fixture")
	}
	return fixture
}

func paperWeeklyInput(symbol string, bars []market.Candle) Input {
	return Input{
		Symbol: symbol,
		Histories: map[string]scanner.History{
			"4h": {Candles: bars},
		},
	}
}

func paperWeeklyFind(ops []Opportunity, id string) (Opportunity, bool) {
	for _, op := range ops {
		if op.ID == id {
			return op, true
		}
	}
	return Opportunity{}, false
}

func TestPaperWeeklyMatchesFrozenNativeRangeFixture(t *testing.T) {
	fixture := paperWeeklyLoadFixture(t)
	op, found := paperWeeklyFind(PaperWeeklyOpportunities(paperWeeklyInput(fixture.Original.Symbol, fixture.Candles)), fixture.Trade.ID)
	if !found {
		t.Fatalf("native weekly setup %s was not reproduced", fixture.Trade.ID)
	}
	plan := fixture.Original.Plan
	if op.Family != PaperFreshWeeklyRangeLong || op.Interval != "4h" || op.Direction != "bullish" || op.State != "entry_confirmed" ||
		op.AvailableAt != fixture.Original.TriggerAt || op.LocationAvailableAt != fixture.Original.ReferenceAt ||
		op.SourceEndAt != fixture.Original.ReferenceAt || op.Level != fixture.Original.ReferenceLow ||
		op.ZoneLow == nil || *op.ZoneLow != fixture.Original.ReferenceLow ||
		op.ZoneHigh == nil || *op.ZoneHigh != fixture.Original.ReferenceHigh ||
		op.RetestAt == nil || *op.RetestAt != fixture.Original.TriggerAt ||
		op.TriggerAt == nil || *op.TriggerAt != plan.ConfirmedAt ||
		op.ExpiresAt == nil || *op.ExpiresAt != plan.ExpiresAt ||
		op.EntryReference == nil || *op.EntryReference != plan.Entry ||
		op.Stop == nil || *op.Stop != plan.Stop || op.Target == nil || *op.Target != plan.Target ||
		op.ReferenceATR == nil || *op.ReferenceATR != plan.ATR ||
		op.EntryMin == nil || *op.EntryMin != plan.EntryMin ||
		op.EntryMax == nil || *op.EntryMax != plan.EntryMax {
		t.Fatalf("weekly identity or frozen plan differs from native fixture: %+v", op)
	}
	if !PaperWeeklyOpeningPassesGuard(fixture.Trade.RawEntry, *op.Stop) ||
		PaperWeeklyMinOpeningStopWidth != .03 || PaperWeeklyMaxHoldingBars != 24 {
		t.Fatal("opening-width or holding policy differs from native fixture")
	}
}

func TestPaperWeeklyRequiresFirstTouchAndCompletePriorUTCWeek(t *testing.T) {
	fixture := paperWeeklyLoadFixture(t)
	bars := fixture.Candles
	source := sort.Search(len(bars), func(i int) bool { return bars[i].CloseTime >= fixture.Original.TriggerAt })
	if source >= len(bars) || bars[source].CloseTime != fixture.Original.TriggerAt {
		t.Fatal("missing fixture rejection")
	}
	level, ok := paperWeeklyLevel(bars, source, fixture.Original.ReferenceLow)
	if !ok {
		t.Fatal("native fixture did not satisfy weekly level")
	}
	weekStart := paperWeeklyWeekStart(bars[source].OpenTime)
	first := sort.Search(len(bars), func(i int) bool { return bars[i].OpenTime >= weekStart })
	if first >= source {
		t.Fatal("fixture needs an earlier current-week candle")
	}
	touched := append([]market.Candle(nil), bars...)
	touched[first].Low = level
	if _, ok := paperWeeklyLevel(touched, source, fixture.Original.ReferenceLow); ok {
		t.Fatal("prior touch of the weekly low was accepted")
	}
	priorStart := weekStart - paperWeeklyWeekMS
	priorFirst := sort.Search(len(bars), func(i int) bool { return bars[i].OpenTime >= priorStart })
	if priorFirst+1 >= source {
		t.Fatal("fixture lacks previous week")
	}
	if _, ok := paperWeeklyLevel(bars[priorFirst+1:], source-priorFirst-1, fixture.Original.ReferenceLow); ok {
		t.Fatal("an incomplete prior UTC week was accepted")
	}
	beforeATR, ok := paperWeeklyResearchATR(bars, source-1)
	if !ok {
		t.Fatal("missing pre-rejection ATR")
	}
	if _, ok := paperWeeklyLevel(bars, source, level+.25*beforeATR+1e-10); ok {
		t.Fatal("a frozen range edge outside the 0.25 ATR weekly tolerance was accepted")
	}
}

func TestPaperWeeklyUsesConfirmationLowAndFourBarEntryDeadline(t *testing.T) {
	fixture := paperWeeklyLoadFixture(t)
	bars := append([]market.Candle(nil), fixture.Candles...)
	source := sort.Search(len(bars), func(i int) bool { return bars[i].CloseTime >= fixture.Original.TriggerAt })
	confirmed := sort.Search(len(bars), func(i int) bool { return bars[i].CloseTime >= fixture.Original.Plan.ConfirmedAt })
	if source >= len(bars) || confirmed >= len(bars) {
		t.Fatal("missing fixture source or confirmation")
	}
	if _, found := paperWeeklyFind(PaperWeeklyOpportunities(paperWeeklyInput(fixture.Original.Symbol, bars[:confirmed])), fixture.Trade.ID); found {
		t.Fatal("future confirmation leaked into earlier candle prefix")
	}
	bars[confirmed].Low = bars[source].Low - .0001
	atr, ok := pbATR(bars, confirmed)
	if !ok {
		t.Fatal("missing confirmation ATR")
	}
	op, found := paperWeeklyFind(PaperWeeklyOpportunities(paperWeeklyInput(fixture.Original.Symbol, bars)), fixture.Trade.ID)
	if !found || op.Stop == nil || *op.Stop != bars[confirmed].Low-.1*atr {
		t.Fatalf("confirmation candle's lower low did not protect the frozen stop: %+v", op)
	}
	// Each later source candle stays inside the entry band and away from
	// protective levels, isolating the source plan's four-bar deadline.
	for i := 0; i < 4; i++ {
		last := bars[len(bars)-1]
		bars = append(bars, market.Candle{
			OpenTime:  last.CloseTime + 1,
			CloseTime: last.CloseTime + paperWeeklyStepMS,
			Open:      fixture.Original.Plan.Entry,
			High:      math.Min(fixture.Original.Plan.Target-.001, fixture.Original.Plan.Entry+.005),
			Low:       math.Max(*op.Stop+.001, fixture.Original.Plan.Entry-.005),
			Close:     fixture.Original.Plan.Entry,
			Volume:    1,
		})
		_, found = paperWeeklyFind(PaperWeeklyOpportunities(paperWeeklyInput(fixture.Original.Symbol, bars)), fixture.Trade.ID)
		if found != (i < 3) {
			t.Fatalf("weekly entry at %d later bars: found=%t", i+1, found)
		}
	}
	if !PaperWeeklyOpeningPassesGuard(100, 97) || PaperWeeklyOpeningPassesGuard(100, 97.01) ||
		PaperWeeklyOpeningPassesGuard(97, 100) {
		t.Fatal("raw opening-to-stop guard boundary is incorrect")
	}
}

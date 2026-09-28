package strategies

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/momentum"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/swingfailure"
)

func revTestInput(bars []market.Candle) Input {
	last := bars[len(bars)-1]
	return Input{Symbol: "TESTUSDT", Histories: map[string]scanner.History{"15m": {Candles: bars}},
		Frames: map[string]scanner.SeriesSummary{"15m": {Symbol: "TESTUSDT", Interval: "15m", LastClosedAt: last.CloseTime,
			ObservedAt: time.UnixMilli(last.CloseTime + 1), Price: last.Close}}}
}

func revTestAppend(bars []market.Candle, row [4]float64) []market.Candle {
	open := int64(len(bars)) * 900000
	return append(bars, market.Candle{OpenTime: open, CloseTime: open + 899999, Open: row[0], High: row[1], Low: row[2], Close: row[3], Volume: 100})
}

func revTestFixture(bullish bool) []market.Candle {
	bars := []market.Candle{}
	for i := 0; i < 20; i++ {
		row := [4]float64{9, 10, 8.5, 9}
		if i == 2 {
			row[2] = .5
		}
		bars = revTestAppend(bars, row)
	}
	for _, row := range [][4]float64{{9, 10, 8.5, 9}, {9, 12, 9, 11}, {10, 11, 8, 9}, {9, 10.5, 8.5, 10}, {10, 13, 9.2, 11},
		{11, 11.5, 7, 7.5}, {7.5, 8.2, 7.2, 7.6}, {7.6, 7.8, 6.8, 7}} {
		bars = revTestAppend(bars, row)
	}
	if bullish {
		for i, bar := range bars {
			bars[i].Open, bars[i].Close = 30-bar.Open, 30-bar.Close
			bars[i].High, bars[i].Low = 30-bar.Low, 30-bar.High
		}
	}
	return bars
}

func revTestFind(t *testing.T, out []Opportunity, family string, at int64) Opportunity {
	t.Helper()
	for _, op := range out {
		if op.Family == family && op.AvailableAt == at {
			return op
		}
	}
	t.Fatalf("missing %s at%d among%+v", family, at, out)
	return Opportunity{}
}

func TestReversalSweepRequiresSeparateBreakRetestFollowThrough(t *testing.T) {
	for _, bullish := range []bool{false, true} {
		bars := revTestFixture(bullish)
		at := bars[24].CloseTime
		for length, want := range map[int]string{25: "observing", 26: "waiting_for_retest", 27: "awaiting_confirmation", 28: "entry_confirmed"} {
			op := revTestFind(t, ReversalOpportunities(revTestInput(bars[:length])), SweepReversal, at)
			if op.State != want {
				t.Fatalf("length%d bullish%t: %+v", length, bullish, op)
			}
			if length < 28 && op.TriggerAt != nil {
				t.Fatal("trigger before independent follow-through")
			}
		}
		op := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
		if op.TriggerAt == nil || *op.TriggerAt != bars[27].CloseTime || op.RetestAt == nil || *op.RetestAt != bars[26].CloseTime ||
			op.EntryMin == nil || op.EntryMax == nil || *op.EntryMin >= *op.EntryReference || *op.EntryMax <= *op.EntryReference || op.Stop == nil || op.Target == nil {
			t.Fatalf("incomplete frozen plan: %+v", op)
		}
		if bullish && (*op.Stop >= *op.EntryMin || *op.Target <= *op.EntryMax) || !bullish && (*op.Target >= *op.EntryMin || *op.Stop <= *op.EntryMax) {
			t.Fatalf("unsafe entry bounds: %+v", op)
		}
	}
}

func TestReversalHistoricalSFPDoesNotResurrectAfterFailure(t *testing.T) {
	bars := revTestFixture(false)
	at := bars[24].CloseTime
	sourceBefore := swingfailure.Analyze(bars[:26]).Events
	bars = revTestAppend(bars, [4]float64{7, 13.5, 6.9, 12.5})
	op := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
	if op.State != "invalidated" || op.ResolvedAt == nil || *op.ResolvedAt != bars[28].CloseTime {
		t.Fatalf("failure lost: %+v", op)
	}
	bars = revTestAppend(bars, [4]float64{12.5, 12.6, 6.8, 7})
	again := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
	if again.State != "invalidated" || *again.ResolvedAt != *op.ResolvedAt || *again.Stop != *op.Stop || *again.Target != *op.Target {
		t.Fatalf("resurrected: %+v", again)
	}
	if !reflect.DeepEqual(sourceBefore, swingfailure.Analyze(bars[:26]).Events) {
		t.Fatal("source observations mutated")
	}
}

func TestReversalStopFirstTargetAndEntryExpiry(t *testing.T) {
	for _, mode := range []string{"both", "target", "expiry"} {
		bars := revTestFixture(false)
		at := bars[24].CloseTime
		op := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
		want := "expired"
		switch mode {
		case "both":
			bars = revTestAppend(bars, [4]float64{7, *op.Stop + .1, *op.Target - .1, 7})
			want = "invalidated"
		case "target":
			bars = revTestAppend(bars, [4]float64{7, 7.2, *op.Target, 1})
			want = "target_reached"
		case "expiry":
			for i := 0; i < 4; i++ {
				bars = revTestAppend(bars, [4]float64{7, 7.2, 6.8, 7})
			}
		}
		resolved := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
		if resolved.State != want || resolved.ResolvedAt == nil {
			t.Fatalf("%s: %+v", mode, resolved)
		}
		if *op.Stop != *resolved.Stop || *op.Target != *resolved.Target || *op.EntryMin != *resolved.EntryMin || *op.EntryMax != *resolved.EntryMax {
			t.Fatal("plan drift")
		}
	}
}

func TestReversalMissingTargetStaysRejectedWhenFuturePivotAppears(t *testing.T) {
	bars := revTestFixture(false)
	bars[2].Low = 8.5
	at := bars[24].CloseTime
	before := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
	if before.State != "rejected" || before.Target != nil {
		t.Fatalf("fabricated target: %+v", before)
	}
	bars = revTestAppend(bars, [4]float64{7, 8, 2, 7})
	bars = revTestAppend(bars, [4]float64{7, 8, 3, 7})
	after := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
	if after.State != "rejected" || after.Target != nil || *after.ResolvedAt != *before.ResolvedAt {
		t.Fatalf("future target changed rejection: %+v", after)
	}
}

func TestReversalRejectsMalformedOrFutureEvidence(t *testing.T) {
	for _, mode := range []string{"gap", "duration", "nonfinite", "future", "metadata", "unaligned", "stale"} {
		bars := revTestFixture(false)
		in := revTestInput(bars)
		frame := in.Frames["15m"]
		switch mode {
		case "gap":
			bars[5].OpenTime += 900000
			bars[5].CloseTime += 900000
		case "duration":
			bars[5].CloseTime++
		case "nonfinite":
			bars[5].High = math.Inf(1)
		case "future":
			frame.ObservedAt = time.UnixMilli(frame.LastClosedAt - 1)
		case "metadata":
			frame.LastClosedAt--
		case "unaligned":
			for i := range bars {
				bars[i].OpenTime++
				bars[i].CloseTime++
			}
			frame.LastClosedAt++
			frame.ObservedAt = frame.ObservedAt.Add(time.Millisecond)
		case "stale":
			frame.Stale = true
		}
		in.Frames["15m"] = frame
		if out := ReversalOpportunities(in); len(out) != 0 {
			t.Fatalf("%s accepted malformed evidence: %+v", mode, out)
		}
	}
}

func TestReversalRetentionIsIndependentOfSourceDisplayLimit(t *testing.T) {
	bars := revTestFixture(false)
	for i := 0; i < 20; i++ {
		bars = revTestAppend(bars, [4]float64{10, 14 + float64(i), 6 - float64(i)*.1, 10})
	}
	out := ReversalOpportunities(revTestInput(bars))
	count := 0
	for _, op := range out {
		if op.Family == SweepReversal {
			count++
		}
	}
	if count <= 8 {
		t.Fatalf("strategy retained only display-bound events: %d", count)
	}
	known := revTestFind(t, out, SweepReversal, bars[24].CloseTime)
	for i := 0; i < ReversalObservationBars; i++ {
		bars = revTestAppend(bars, [4]float64{10, 11, 9, 10})
	}
	for _, op := range ReversalOpportunities(revTestInput(bars)) {
		if op.ID == known.ID {
			t.Fatal("terminal escaped documented retention")
		}
	}
}

func TestReversalInputAndReturnedPointerOwnership(t *testing.T) {
	bars := revTestFixture(false)
	in := revTestInput(bars)
	before, _ := json.Marshal(in)
	one := ReversalOpportunities(in)
	after, _ := json.Marshal(in)
	if string(before) != string(after) {
		t.Fatal("input was mutated")
	}
	expected, _ := json.Marshal(one)
	two := ReversalOpportunities(in)
	for i := range two {
		if two[i].Stop != nil {
			*two[i].Stop = 999
		}
		two[i].State = "changed"
	}
	bars[0].High = 999
	actual, _ := json.Marshal(one)
	if string(expected) != string(actual) {
		t.Fatal("opportunity aliases input or another result")
	}
}

// Inject the separately validated causal RSI source event to isolate the new
// price lifecycle. End-to-end source discovery is also checked below.
func revTestDivergenceEvent(bars []market.Candle, hidden, bullish bool) momentum.Divergence {
	direction, kind := "bearish", "regular-bearish"
	start, end := 11.0, 13.0
	rsi := 70.0
	if bullish {
		direction, kind = "bullish", "regular-bullish"
		start, end, rsi = 19, 17, 30
	}
	if hidden {
		kind = "hidden-" + direction
	}
	return momentum.Divergence{ID: kind, Kind: kind, Direction: direction, DetectedAt: bars[24].CloseTime, InvalidationRSI: rsi,
		Start: momentum.Pivot{OpenTime: bars[21].OpenTime, AvailableAt: bars[23].CloseTime, Price: start, RSI: rsi},
		End:   momentum.Pivot{OpenTime: bars[24].OpenTime, AvailableAt: bars[24].CloseTime, Price: end, RSI: rsi}}
}

func TestDivergenceRegularAndHiddenStayDistinctAndNeedPriceTrigger(t *testing.T) {
	for _, bullish := range []bool{false, true} {
		bars := revTestFixture(bullish)
		event := revTestDivergenceEvent(bars, false, bullish)
		tracked := revNewDivergence(revTestInput(bars), event, bars, 24)
		if tracked.op.State != "observing" || tracked.op.Family != DivergenceReversal {
			t.Fatalf("bad divergence discovery: %+v", tracked.op)
		}
		rsi := 60.0
		if bullish {
			rsi = 40
		}
		revAdvanceDivergence(revTestInput(bars), &tracked, bars, 25, &rsi)
		if tracked.op.State != "entry_confirmed" || tracked.op.TriggerAt == nil {
			t.Fatalf("price trigger missing: %+v", tracked.op)
		}
		// Crossing RSI50 cannot itself complete a price opportunity.
		if bullish {
			rsi = 55
		} else {
			rsi = 45
		}
		revAdvanceDivergence(revTestInput(bars), &tracked, bars, 26, &rsi)
		if tracked.op.State != "entry_confirmed" {
			t.Fatalf("oscillator treated as profit: %+v", tracked.op)
		}
		event = revTestDivergenceEvent(bars, true, bullish)
		hidden := revNewDivergence(revTestInput(bars), event, bars, 24)
		if hidden.op.Family != DivergenceContinuation || hidden.op.State != "rejected" {
			t.Fatalf("hidden lacks independent trend admission: %+v", hidden.op)
		}
	}
}

func TestDivergenceWrongNextBodyAndAnchorBreachCannotRecover(t *testing.T) {
	for _, mode := range []string{"body", "price", "rsi"} {
		bars := revTestFixture(false)
		event := revTestDivergenceEvent(bars, false, false)
		tracked := revNewDivergence(revTestInput(bars), event, bars, 24)
		rsi := 60.0
		want := "invalidated"
		switch mode {
		case "body":
			bars[25].Open = 7
			bars[25].Close = 7.5
			want = "rejected"
		case "price":
			bars[25].High = 13.1
		case "rsi":
			rsi = 71
		}
		revAdvanceDivergence(revTestInput(bars), &tracked, bars, 25, &rsi)
		if tracked.op.State != want || tracked.op.TriggerAt != nil {
			t.Fatalf("%s: %+v", mode, tracked.op)
		}
		rsi = 60
		revAdvanceDivergence(revTestInput(bars), &tracked, bars, 26, &rsi)
		if tracked.op.State != want {
			t.Fatal("terminal divergence resurrected")
		}
	}
}

func TestReversalDiscoversRealRSIDivergenceWithoutHarmonics(t *testing.T) {
	for _, hidden := range []bool{false, true} {
		for _, bearish := range []bool{false, true} {
			values := []float64{40, 38, 35, 30, 25, 20, 30, 35, 32, 31, 28, 25, 30}
			if hidden {
				values = []float64{45, 44, 42, 40, 35, 30, 40, 42, 39, 38, 35, 20, 25}
			}
			up, down := values[0]/10, (100-values[0])/10
			closes := []float64{10000}
			for i := 1; i <= 14; i++ {
				change := up
				if i%2 == 0 {
					change = -down
				}
				closes = append(closes, closes[len(closes)-1]+change)
			}
			gain, loss := up/2, down/2
			// Hold the seeded oscillator unchanged so the second anchor lands
			// exactly at the end of the strategy's fixed160-candle source window.
			const offset = ReversalSourceBars - 26
			for i := 0; i < offset; i++ {
				closes = append(closes, closes[len(closes)-1])
				gain, loss = 13*gain/14, 13*loss/14
			}
			for _, rsi := range values[1:] {
				ratio := rsi / (100 - rsi)
				change := 13 * (ratio*loss - gain)
				if ratio < gain/loss {
					change = -13 * (gain/ratio - loss)
				}
				closes = append(closes, closes[len(closes)-1]+change)
				gain, loss = (13*gain+math.Max(0, change))/14, (13*loss+math.Max(0, -change))/14
			}
			bars := []market.Candle{}
			for _, close := range closes {
				bars = revTestAppend(bars, [4]float64{close, close + 1, close - 1, close})
			}
			first, second, confirmation := 19+offset, 25+offset, 26+offset
			bars[second].Open = math.Min(math.Min(bars[first].Close, bars[second].Close), bars[confirmation].Close) - 10
			if hidden {
				bars[second].Open = bars[second].Close
				bars[first].Open = math.Min(bars[first].Close, bars[second].Close) - 10
			}
			bars[confirmation].Open = bars[confirmation].Close - 1
			for i, bar := range bars {
				bars[i].High, bars[i].Low = math.Max(bar.Open, bar.Close)+1, math.Min(bar.Open, bar.Close)-1
				if bearish {
					bar = bars[i]
					bars[i].Open, bars[i].Close = 50000-bar.Open, 50000-bar.Close
					bars[i].High, bars[i].Low = 50000-bar.Low, 50000-bar.High
				}
			}
			family := DivergenceReversal
			if hidden {
				family = DivergenceContinuation
			}
			op := revTestFind(t, ReversalOpportunities(revTestInput(bars)), family, bars[second].CloseTime)
			wantDirection := "bullish"
			if bearish {
				wantDirection = "bearish"
			}
			if op.Direction != wantDirection || op.SourceStartAt != bars[first].OpenTime || op.SourceEndAt != bars[second].CloseTime {
				t.Fatalf("RSI discovery provenance: %+v", op)
			}
			for _, early := range ReversalOpportunities(revTestInput(bars[:second])) {
				if early.ID == op.ID {
					t.Fatal("RSI second anchor used before close")
				}
			}
			// Expand a500-bar cache by one, then drop its oldest bar. The same
			// event-time seed/anchors and resulting strategy state must survive.
			leading := 500 - len(bars)
			padded := []market.Candle{}
			for i := 0; i < leading; i++ {
				padded = revTestAppend(padded, [4]float64{bars[0].Close, bars[0].Close + 1, bars[0].Close - 1, bars[0].Close})
			}
			for _, bar := range bars {
				padded = revTestAppend(padded, [4]float64{bar.Open, bar.High, bar.Low, bar.Close})
			}
			last := padded[len(padded)-1].Close
			padded = revTestAppend(padded, [4]float64{last, last + 1, last - 1, last})
			at := padded[leading+second].CloseTime
			expanded := revTestFind(t, ReversalOpportunities(revTestInput(padded)), family, at)
			rolled := revTestFind(t, ReversalOpportunities(revTestInput(padded[1:])), family, at)
			if !reflect.DeepEqual(expanded, rolled) {
				t.Fatalf("rolling cache changed frozen divergence: expanded=%+v rolled=%+v", expanded, rolled)
			}
		}
	}
}

func TestReversalRollingCacheCannotReplaceFrozenTarget(t *testing.T) {
	seed := revTestFixture(false)
	bars := []market.Candle{}
	for i := 0; i < 500-len(seed); i++ {
		bars = revTestAppend(bars, [4]float64{9, 10, 8.5, 9})
	}
	// This nearer target disappears when its left neighbor rolls out. It is
	// outside the declared event-time160-bar target search in both histories.
	bars[1].Low = 3
	for _, bar := range seed {
		bars = revTestAppend(bars, [4]float64{bar.Open, bar.High, bar.Low, bar.Close})
	}
	at := bars[len(bars)-4].CloseTime
	before := revTestFind(t, ReversalOpportunities(revTestInput(bars)), SweepReversal, at)
	if before.Target == nil || *before.Target != .5 {
		t.Fatalf("used undeclared old target: %+v", before)
	}
	bars = revTestAppend(bars, [4]float64{7, 7.2, 6.8, 7})
	after := revTestFind(t, ReversalOpportunities(revTestInput(bars[1:])), SweepReversal, at)
	before.AsOf = after.AsOf
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("rolling target changed: before=%+v after=%+v", before, after)
	}
}

func TestHiddenDivergenceUsesOnlyAlreadyClosedHourlyTrend(t *testing.T) {
	for _, bullish := range []bool{false, true} {
		bars := revTestFixture(bullish)
		for i := range bars {
			bars[i].OpenTime += 120 * 3600000
			bars[i].CloseTime += 120 * 3600000
		}
		in := revTestInput(bars)
		hourly := []market.Candle{}
		prices := []float64{50}
		for i := 1; i <= 50; i++ {
			prices = append(prices, 100+float64(i))
		}
		prices = append(prices, 200)
		for i := 52; i <= 101; i++ {
			prices = append(prices, 100)
		}
		prices = append(prices, 90, 110, 110, 110, 110, 110, 130, 110, 110, 110, 110, 110, 140, 141)
		for i, price := range prices {
			if !bullish {
				price = 300 - price
			}
			open := int64(i) * 3600000
			hourly = append(hourly, market.Candle{OpenTime: open, CloseTime: open + 3599999, Open: price, High: price, Low: price, Close: price, Volume: 100})
		}
		last := hourly[len(hourly)-1]
		in.Histories["1h"] = scanner.History{Candles: hourly}
		in.Frames["1h"] = scanner.SeriesSummary{Symbol: in.Symbol, Interval: "1h", LastClosedAt: last.CloseTime, ObservedAt: time.UnixMilli(bars[len(bars)-1].CloseTime + 1)}
		event := revTestDivergenceEvent(bars, true, bullish)
		tracked := revNewDivergence(in, event, bars, 24)
		if tracked.op.State != "observing" {
			t.Fatalf("causal hourly agreement not admitted: %+v", tracked.op)
		}
		// Shift hourly agreement after divergence availability: it cannot leak back.
		for i := range hourly {
			hourly[i].OpenTime += 200 * 3600000
			hourly[i].CloseTime += 200 * 3600000
		}
		frame := in.Frames["1h"]
		frame.LastClosedAt = hourly[len(hourly)-1].CloseTime
		frame.ObservedAt = time.UnixMilli(frame.LastClosedAt + 1)
		in.Frames["1h"] = frame
		future := revNewDivergence(in, event, bars, 24)
		if future.op.State != "rejected" {
			t.Fatalf("future hourly agreement leaked into source: %+v", future.op)
		}
	}
}

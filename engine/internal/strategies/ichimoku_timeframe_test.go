package strategies

import (
	"reflect"
	"testing"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
)

var ichTestTimeframes = []string{"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "1d", "3d", "1w"}

func ichTimeframeInput(bars []market.Candle, timeframe string) Input {
	width, _ := market.IntervalDuration(timeframe)
	start := time.Date(2020, 1, 6, 0, 0, 0, 0, time.UTC).UnixMilli() // Monday for weekly bars.
	if timeframe == "3d" {
		start += 24 * time.Hour.Milliseconds() // Deliberately preserve a non-epoch three-day phase.
	}
	converted := append([]market.Candle{}, bars...)
	for i := range converted {
		converted[i].OpenTime = start + int64(i)*width.Milliseconds()
		converted[i].CloseTime = converted[i].OpenTime + width.Milliseconds() - 1
	}
	last := converted[len(converted)-1]
	return Input{Symbol: "TESTUSDT", Histories: map[string]scanner.History{timeframe: {Candles: converted}},
		Frames: map[string]scanner.SeriesSummary{timeframe: {Symbol: "TESTUSDT", Interval: timeframe,
			LastClosedAt: last.CloseTime, ObservedAt: time.UnixMilli(last.CloseTime + 1), Price: last.Close}}}
}

func TestIchimokuChosenTimeframePreservesCrossAndEdgeSemanticsOnEveryUIInterval(t *testing.T) {
	for _, timeframe := range ichTestTimeframes {
		t.Run(timeframe, func(t *testing.T) {
			in := ichTimeframeInput(ichCrossFixture(), timeframe)
			original := append([]market.Candle{}, in.Histories[timeframe].Candles...)
			out := IchimokuTimeframeOpportunities(in, timeframe)
			for _, family := range []string{TKCross, PKCross} {
				op := pbTestFind(t, out, family, "bullish", original[200].CloseTime)
				if op.Interval != timeframe || op.State != "entry_confirmed" || *op.TriggerAt != original[201].CloseTime ||
					op.Level != 114 || *op.Target != 130 || *op.ExpiresAt-*op.TriggerAt != 4*pbDuration(timeframe) {
					t.Fatalf("selected %s changed cross-time/price semantics: %+v", timeframe, op)
				}
			}
			for _, op := range out {
				if op.Interval != timeframe || op.Family != KijunReclaim && op.Family != CloudReclaim && op.Family != TKCross && op.Family != PKCross && op.Family != CloudEdgeToEdge {
					t.Fatalf("unselected method/frame discovered: %+v", op)
				}
			}
			if !reflect.DeepEqual(original, in.Histories[timeframe].Candles) {
				t.Fatal("selected discovery mutated supplied history")
			}
			edge := ichTimeframeInput(ichEdgeFixture("red", false)[:151], timeframe)
			entry := edge.Histories[timeframe].Candles[150].CloseTime
			op := pbTestFind(t, IchimokuTimeframeOpportunities(edge, timeframe), CloudEdgeToEdge, "bullish", entry)
			if op.State != "entry_confirmed" || op.TriggerAt == nil || *op.TriggerAt != entry || op.Target == nil {
				t.Fatalf("selected edge-to-edge lost its same-source completed entry: %+v", op)
			}
		})
	}
}

func TestIchimokuChosenSourceDoesNotBorrowOtherFramesOrPreview(t *testing.T) {
	in := ichTimeframeInput(ichCrossFixture(), "5m")
	want := IchimokuTimeframeOpportunities(in, "5m")
	other := ichTimeframeInput(ichEdgeFixture("green", false)[:151], "4h")
	in.Frames["4h"], in.Histories["4h"] = other.Frames["4h"], other.Histories["4h"]
	h := in.Histories["5m"]
	preview := h.Candles[len(h.Candles)-1]
	preview.OpenTime, preview.CloseTime = preview.OpenTime+pbDuration("5m"), preview.CloseTime+pbDuration("5m")
	preview.High, preview.Low = 1000, 1
	h.Preview = &preview
	in.Histories["5m"] = h
	if got := IchimokuTimeframeOpportunities(in, "5m"); !reflect.DeepEqual(got, want) {
		t.Fatal("other-frame opportunity or provisional candle changed the selected source")
	}
	delete(in.Frames, "5m")
	if len(IchimokuTimeframeOpportunities(in, "5m")) != 0 {
		t.Fatal("another frame substituted for missing selected source")
	}
	for _, unsupported := range []string{"", "6h", "12h", "1M", "unknown"} {
		if IchimokuTimeframeSupported(unsupported) || len(IchimokuTimeframeOpportunities(in, unsupported)) != 0 {
			t.Fatalf("unsupported chart period accepted: %s", unsupported)
		}
	}
}

func TestIchimokuChosenCalendarHistoryAndMalformedInputs(t *testing.T) {
	for _, timeframe := range []string{"5m", "3d", "1w"} {
		for _, mutation := range []string{"gap", "duration", "ohlc", "mismatch", "alignment"} {
			t.Run(timeframe+"/"+mutation, func(t *testing.T) {
				in := ichTimeframeInput(ichCrossFixture(), timeframe)
				bars := in.Histories[timeframe].Candles
				switch mutation {
				case "gap":
					bars[100].OpenTime++
				case "duration":
					bars[100].CloseTime++
				case "ohlc":
					bars[100].Low = 1000
				case "mismatch":
					frame := in.Frames[timeframe]
					frame.LastClosedAt--
					in.Frames[timeframe] = frame
				case "alignment":
					shift := int64(1)
					if timeframe == "1w" {
						shift = 24 * time.Hour.Milliseconds()
					}
					for i := range bars {
						bars[i].OpenTime += shift
						bars[i].CloseTime += shift
					}
					frame := in.Frames[timeframe]
					frame.LastClosedAt += shift
					frame.ObservedAt = frame.ObservedAt.Add(time.Duration(shift) * time.Millisecond)
					in.Frames[timeframe] = frame
				}
				if len(IchimokuTimeframeOpportunities(in, timeframe)) != 0 {
					t.Fatal("invalid selected source leaked an opportunity")
				}
			})
		}
	}
}

package strategies

import (
	"fmt"
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

const (
	PaperDonchianBase     = "donchian55_atr_trail"
	PaperDonchianStoch    = "donchian55_atr_trail_stoch"
	PaperDonchianMACD     = "donchian55_atr_trail_macd"
	PaperDonchianADXRange = "donchian55_atr_trail_adx_range"

	paperDonchianDayMS = int64(86_400_000)
)

// paperDonchianATR preserves the research engine's arithmetic order: add 14
// complete true ranges first, then divide once. Summing TR/14 on every step
// can move an exact-touch protective level by one floating-point unit.
func paperDonchianATR(bars []market.Candle, at int) (float64, bool) {
	if at < 14 || at >= len(bars) {
		return 0, false
	}
	total := 0.0
	for i := at - 13; i <= at; i++ {
		bar, before := bars[i], bars[i-1]
		total += math.Max(bar.High-bar.Low,
			math.Max(math.Abs(bar.High-before.Close), math.Abs(bar.Low-before.Close)))
	}
	atr := total / 14
	return atr, paperFinite(atr) && atr > 0
}

func paperDonchianProfiles(base Opportunity, feature PaperFeatures) []Opportunity {
	out := []Opportunity{base}
	for _, filtered := range []struct {
		family string
		passes bool
		rule   string
	}{
		{PaperDonchianStoch, feature.Stoch == 1, "Smoothed Stochastic K14/3 was above 50 at the breakout close."},
		{PaperDonchianMACD, feature.MACD == 1, "MACD12/26 was above its EMA9 signal at the breakout close."},
		{PaperDonchianADXRange, feature.ADXRange, "Defined ADX14 was at or below 20 at the breakout close."},
	} {
		if !filtered.passes {
			continue
		}
		variant := base
		variant.ID = fmt.Sprintf("curated-v2:%s:%s", base.ID, filtered.family)
		variant.ParentID = base.ID
		variant.Family = filtered.family
		variant.Reason = base.Reason + " " + filtered.rule
		out = append(out, variant)
	}
	return out
}

// PaperDonchianOpportunities translates the four active daily paper profiles.
// The most recent completed bar must close strictly above the preceding 55
// highs. The variants check their indicators on that same breakout close.
// Entry and later managed exits remain references: this detector never
// invents a fixed profit target or assumes an opening fill.
func PaperDonchianOpportunities(in Input) []Opportunity {
	history, present := in.Histories["1d"]
	if !present || len(history.Candles) < 56 || in.Symbol == "" {
		return nil
	}
	bars := history.Candles
	at := len(bars) - 1
	first := at - 55
	for i := first; i <= at; i++ {
		if market.ValidateInterval(bars[i], "1d") != nil ||
			i > first && bars[i-1].CloseTime+1 != bars[i].OpenTime {
			return nil
		}
	}
	last := bars[at]
	if frame, exists := in.Frames["1d"]; exists {
		if frame.Stale || frame.Symbol != "" && frame.Symbol != in.Symbol ||
			frame.Interval != "" && frame.Interval != "1d" ||
			frame.LastClosedAt != 0 && frame.LastClosedAt != last.CloseTime ||
			frame.Analysis.AsOf != 0 && frame.Analysis.AsOf != last.CloseTime ||
			!frame.ObservedAt.IsZero() && frame.ObservedAt.UnixMilli() < last.CloseTime {
			return nil
		}
	}
	priorHigh, priorLow := math.Inf(-1), math.Inf(1)
	for _, bar := range bars[first:at] {
		priorHigh = math.Max(priorHigh, bar.High)
		priorLow = math.Min(priorLow, bar.Low)
	}
	if last.Close <= priorHigh {
		return nil
	}
	atr, valid := paperDonchianATR(bars, at)
	if !valid {
		return nil
	}
	stop := last.Close - 2*atr
	if !paperFinite(stop) || stop <= 0 || last.CloseTime > int64(1<<53-1)-paperDonchianDayMS-1 {
		return nil
	}
	closedAt := last.CloseTime
	expiresAt := closedAt + paperDonchianDayMS + 1
	baseID := fmt.Sprintf("native-v1:%s:1d:%s:bullish:%d", in.Symbol, PaperDonchianBase, closedAt)
	base := Opportunity{
		Version: Version, ID: baseID,
		ParentID: fmt.Sprintf("price:%s:1d:bullish:%d", in.Symbol, closedAt),
		Family:   PaperDonchianBase, Symbol: in.Symbol, Interval: "1d", Direction: "bullish", State: "entry_confirmed",
		AvailableAt: closedAt, LocationAvailableAt: closedAt,
		SourceStartAt: bars[first].OpenTime, SourceEndAt: closedAt, AsOf: closedAt,
		TriggerAt: &closedAt, ExpiresAt: &expiresAt,
		Level: priorHigh, EntryReference: &last.Close, ReferenceATR: &atr, Stop: &stop,
		Reason:       fmt.Sprintf("A completed daily close exceeded the preceding 55 daily highs (channel high %.8g, low %.8g).", priorHigh, priorLow),
		Next:         "The paper trial checks the next whole one-minute opening after observation, once that minute candle closes, before this one-daily-bar entry window expires. Intervening minute candles must not touch protection, and the raw opening must exceed the initial 2-ATR stop. Ratchet a 3.5-ATR trailing stop only after completed daily closes; never widen it. A close below the preceding 20 daily lows schedules exit at the following one-minute opening. Maximum holding: 96 daily bars.",
		Invalidation: "The initial 2-ATR stop is protective. After entry, the non-widening 3.5-ATR trail and a completed close below the preceding 20 daily lows govern exits; the channel exit executes at the following one-minute opening.",
		Caution:      "No fixed profit target or assumed fill. This is a forward paper experiment; recent profitability is unproven.",
	}
	// The source exposes the 55-bar low as context, not as an entry zone. Keep
	// Level at the breakout threshold so a chart does not shade the whole range.
	features := paperSourceFeatures(bars)
	if len(features) != len(bars) {
		return nil
	}
	return paperDonchianProfiles(base, features[at])
}

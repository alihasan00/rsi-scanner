package strategies

import (
	"fmt"
	"github.com/alihasan00/crypto/internal/market"
	"math"
)

// Reconstruct raw range emissions before applying the weekly helper. The
// first eligible emission may be later than confirmation if costs improve.
func paperRawRanges(in Input, bars []market.Candle) []Opportunity {
	if len(bars) > 500 {
		bars = bars[len(bars)-500:]
	}
	out := []Opportunity{}
	seen := map[int]bool{}
	earliest := max(0, len(bars)-28)
	for _, seed := range rngSeeds(in.Symbol, "4h", bars) {
		if seed.known < max(0, earliest-24) {
			continue
		}
		source, confirmed, observed := paperWeeklyRangeRejection(bars, seed)
		if !observed || source < earliest || seen[source] {
			continue
		}
		seen[source] = true
		if confirmed < 0 {
			continue
		}
		atr, ok := paperSimpleATR(bars, confirmed)
		if !ok {
			continue
		}
		stop := math.Min(bars[source].Low, bars[confirmed].Low) - 0.1*atr
		plan, ok := paperFreezeFixed(bars, confirmed, "bullish", stop, seed.box.High)
		if !ok || !paperAssessFixed(plan, bars, confirmed, "bullish", bars[len(bars)-1].CloseTime+1) {
			continue
		}
		op := pbBase(in, "4h", RangeRejection, "bullish", bars, source, seed.box.Low, seed.box.Low, seed.box.High)
		op.ID = fmt.Sprintf("setups-v1:%s:4h:range_rejection:bullish:%d:%d:%016x:%016x", in.Symbol, bars[source].CloseTime, seed.box.EndAt, math.Float64bits(seed.box.Low), math.Float64bits(seed.box.High))
		op.LocationAvailableAt = seed.box.AvailableAt
		op.SourceStartAt = seed.box.StartAt
		op.SourceEndAt = seed.box.EndAt
		op.RetestAt = pbPtr(bars[source].CloseTime)
		op.TriggerAt = pbPtr(plan.ConfirmedAt)
		op.ExpiresAt = pbPtr(plan.ExpiresAt)
		op.EntryReference = pbPtr(plan.Entry)
		op.Stop = pbPtr(plan.Stop)
		op.Target = pbPtr(plan.Target)
		op.ReferenceATR = pbPtr(plan.ATR)
		op.EntryMin = pbPtr(plan.EntryMin)
		op.EntryMax = pbPtr(plan.EntryMax)
		op.State = "entry_confirmed"
		out = append(out, op)
	}
	return out
}
func paperFirstRangeOffer(in Input, bars []market.Candle, op Opportunity) (int, Opportunity, bool) {
	for at, c := range bars {
		if op.TriggerAt == nil || c.CloseTime < *op.TriggerAt {
			continue
		}
		for _, first := range paperRawRanges(in, bars[:at+1]) {
			if first.ID == op.ID {
				return at, first, true
			}
		}
	}
	return 0, Opportunity{}, false
}
func PaperRangeWeeklyOpportunities(in Input) []Opportunity {
	b, ok := pbCandles(in, "4h")
	if !ok || in.Symbol == "" {
		return nil
	}
	out := []Opportunity{}
	// Cache repeated short prefix scans for overlapping range candidates.
	helpers := map[int]bool{}
	checked := map[int]bool{}
	for _, raw := range paperRawRanges(in, b) {
		first, original, ok := paperFirstRangeOffer(in, b, raw)
		if !ok {
			continue
		}
		pass := false
		for at := max(0, first-2); at <= first; at++ {
			if !checked[at] {
				checked[at] = true
				prefix := b[:at+1]
				for _, e := range paperRawRanges(in, prefix) {
					observed, initial, ok := paperFirstRangeOffer(in, prefix, e)
					if !ok || observed != at {
						continue
					}
					source := -1
					for i, c := range prefix {
						if c.CloseTime == initial.AvailableAt {
							source = i
							break
						}
					}
					window := max(0, len(prefix)-500)
					if _, ok := paperWeeklyLevel(prefix[window:], source-window, initial.Level); ok {
						helpers[at] = true
						break
					}
				}
			}
			pass = pass || helpers[at]
		}
		if !pass {
			continue
		}
		// Current visibility comes from raw; every reference stays at first offer.
		original.AsOf = raw.AsOf
		original.ID = "combo-v1:" + raw.ID + ":weekly-event3"
		original.Family = PaperRangeWeekly
		original.Reason = "A fresh weekly-low event occurred at the range setup's first eligible close or preceding two four-hour bars. Later helper agreement cannot revive a rejected setup."
		original.Next = "Check the next whole one-minute opening after observation and intervening minute candles against the original entry band, stop and target. Maximum holding: 24 four-hour bars."
		original.Invalidation = "Stop or target touched, four-bar entry deadline reached, price outside the original band, or less than 1R after modeled costs."
		original.Caution = "Long-only paper research. The weekly helper adds no 3% opening-width guard. No assumed fill or profit."
		out = append(out, original)
	}
	return out
}

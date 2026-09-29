package strategies

// The fresh weekly rebound uses the existing frozen 20-bar range seed
// geometry, then applies the crypto watchlist's original range-rejection
// lifecycle and prior-week guard on completed four-hour candles.

import (
	"fmt"
	"math"
	"sort"

	"github.com/alihasan00/crypto/internal/market"
)

const (
	PaperFreshWeeklyRangeLong      = "fresh_weekly_range_long"
	PaperWeeklyMinOpeningStopWidth = 0.03
	PaperWeeklyMaxHoldingBars      = 24
	paperWeeklySourceBars          = 500
	paperWeeklyObservationBars     = 24
	paperWeeklyDayMS               = int64(86_400_000)
	paperWeeklyWeekMS              = 7 * paperWeeklyDayMS
	paperWeeklyStepMS              = 4 * 60 * 60 * 1000
)

// PaperWeeklyOpeningPassesGuard checks the raw opening price against the
// original frozen stop. The plan's entry band and net reward check are separate
// admission conditions, applied after adverse slippage and costs.
func PaperWeeklyOpeningPassesGuard(rawOpen, stop float64) bool {
	return paperFinite(rawOpen) && paperFinite(stop) && rawOpen > stop && stop > 0 &&
		(rawOpen-stop)/rawOpen >= PaperWeeklyMinOpeningStopWidth
}

// PaperWeeklyOpportunities returns currently eligible four-hour weekly
// rebounds. Each result owns the unchanged range-rejection entry, stop, target,
// and four-bar entry window. The 3% opening guard and 24-bar holding limit are
// execution policy, exposed above and in each result's explanation.
func PaperWeeklyOpportunities(in Input) []Opportunity {
	out := []Opportunity{}
	if in.Symbol == "" {
		return out
	}
	bars, ok := pbCandles(in, "4h")
	if !ok {
		return out
	}
	if len(bars) > paperWeeklySourceBars {
		bars = bars[len(bars)-paperWeeklySourceBars:]
	}
	firstSource := max(0, len(bars)-28)
	seen := make(map[int]bool)
	for _, seed := range rngSeeds(in.Symbol, "4h", bars) {
		source, confirmed, observed := paperWeeklyRangeRejection(bars, seed)
		if !observed || source < firstSource || seen[source] {
			continue
		}
		// The first frozen box owns this rejection even if its later price
		// lifecycle fails. A newer overlapping box cannot rescue the setup.
		seen[source] = true
		if confirmed < 0 {
			continue
		}
		weekLow, ok := paperWeeklyLevel(bars, source, seed.box.Low)
		if !ok {
			continue
		}
		atr, ok := pbATR(bars, confirmed)
		if !ok {
			continue
		}
		stop := math.Min(bars[source].Low, bars[confirmed].Low) - 0.1*atr
		plan, ok := paperFreezeFixed(bars, confirmed, "bullish", stop, seed.box.High)
		if !ok || !paperAssessFixed(plan, bars, confirmed, "bullish", bars[len(bars)-1].CloseTime+1) {
			continue
		}
		op := pbBase(in, "4h", PaperFreshWeeklyRangeLong, "bullish", bars, source, seed.box.Low, seed.box.Low, seed.box.High)
		op.ID = fmt.Sprintf("setups-v1:%s:4h:%s:bullish:%d:%d:%016x:%016x",
			in.Symbol, PaperFreshWeeklyRangeLong, bars[source].CloseTime, seed.box.EndAt,
			math.Float64bits(seed.box.Low), math.Float64bits(seed.box.High))
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
		op.Reason = fmt.Sprintf("A completed range rejection swept and reclaimed the previous complete UTC week's low (%.8g) on its first touch this week; a later close confirmed the unchanged range plan.", weekLow)
		op.Next = "The paper trial checks the next whole one-minute opening after observation, once that minute candle closes. Verify intervening minute candles, the frozen entry band and at least 3% raw opening-to-stop distance. Keep the original stop and target; exit after at most 24 four-hour bars."
		op.Invalidation = "A later protective stop or target touch, entry-band failure, net reward/risk below 1, or the four-bar entry-window deadline retires this plan."
		op.Caution = "Research paper strategy; minimum raw opening-to-stop width 3%; maximum holding 24 source bars. No fill or profit is inferred from this watchlist setup."
		out = append(out, op)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AvailableAt != out[j].AvailableAt {
			return out[i].AvailableAt > out[j].AvailableAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// paperWeeklyRangeRejection mirrors the source detector's first interaction
// with each frozen range. The rejection exists even when a later close fails;
// callers must consume that identity before trying any overlapping range.
func paperWeeklyRangeRejection(bars []market.Candle, seed rngSeed) (source, confirmed int, observed bool) {
	low, high := seed.box.Low, seed.box.High
	middle := low + (high-low)/2
	for j := seed.known + 1; j < len(bars) && j <= seed.known+paperWeeklyObservationBars; j++ {
		c := bars[j]
		if c.Close < low || c.Close > high {
			return -1, -1, false
		}
		if !(c.Low < low && c.Close > low && c.Close < middle && c.High < high) {
			continue
		}
		for k := j + 1; k < len(bars) && k <= j+paperWeeklyObservationBars; k++ {
			if bars[k].Close < low || bars[k].High >= high {
				return j, -1, true
			}
			if bars[k].Close > c.High {
				return j, k, true
			}
		}
		return j, -1, true
	}
	return -1, -1, false
}

// The native weekly screen uses sum(TR)/14 here. The frozen range plan uses
// its separate legacy sum(TR/14) arithmetic through paperFreezeFixed.
func paperWeeklyResearchATR(bars []market.Candle, at int) (float64, bool) {
	if at < 14 || at >= len(bars) {
		return 0, false
	}
	total := 0.0
	for i := at - 13; i <= at; i++ {
		tr := math.Max(bars[i].High-bars[i].Low, math.Abs(bars[i].High-bars[i-1].Close))
		tr = math.Max(tr, math.Abs(bars[i].Low-bars[i-1].Close))
		total += tr
	}
	atr := total / 14
	return atr, paperFinite(atr) && atr > 0
}

func paperWeeklyWeekStart(openTime int64) int64 {
	shifted := openTime - 4*paperWeeklyDayMS
	quotient := shifted / paperWeeklyWeekMS
	if shifted < 0 && shifted%paperWeeklyWeekMS != 0 {
		quotient--
	}
	return quotient*paperWeeklyWeekMS + 4*paperWeeklyDayMS
}

// paperWeeklyLevel requires every bar of the previous complete UTC week and
// no earlier touch of its low during the rejection's week.
func paperWeeklyLevel(bars []market.Candle, source int, frozenRangeLow float64) (float64, bool) {
	if source < 15 || source >= len(bars) {
		return 0, false
	}
	weekStart := paperWeeklyWeekStart(bars[source].OpenTime)
	priorStart := weekStart - paperWeeklyWeekMS
	a := sort.Search(len(bars), func(i int) bool { return bars[i].OpenTime >= priorStart })
	b := sort.Search(len(bars), func(i int) bool { return bars[i].OpenTime >= weekStart })
	if b <= a || b-a != int(paperWeeklyWeekMS/paperWeeklyStepMS) ||
		bars[a].OpenTime != priorStart || bars[b-1].CloseTime != weekStart-1 {
		return 0, false
	}
	for i := a + 1; i <= source; i++ {
		if bars[i-1].CloseTime+1 != bars[i].OpenTime {
			return 0, false
		}
	}
	level := math.Inf(1)
	for i := a; i < b; i++ {
		level = math.Min(level, bars[i].Low)
	}
	beforeATR, ok := paperWeeklyResearchATR(bars, source-1)
	if !ok || !(bars[source].Low < level && level < bars[source].Close) ||
		math.Abs(frozenRangeLow-level) > 0.25*beforeATR {
		return 0, false
	}
	count := (bars[source].OpenTime - weekStart) / paperWeeklyStepMS
	if source < b || source-b != int(count) || b < source && bars[b].OpenTime != weekStart {
		return 0, false
	}
	for i := b; i < source; i++ {
		if bars[i].Low <= level {
			return 0, false
		}
	}
	return level, true
}

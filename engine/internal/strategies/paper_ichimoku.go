package strategies

import (
	"fmt"
	"math"
	"sort"

	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
)

const (
	PaperCloudVolume2R            = "cloud_reclaim_volume_2r"
	PaperCloudVolume2REMA         = "cloud_reclaim_volume_2r_ema"
	PaperCloudVolume2RSMA         = "cloud_reclaim_volume_2r_sma"
	PaperCloudVolume2RSupertrend  = "cloud_reclaim_volume_2r_supertrend"
	PaperCloudVolume2RAO          = "cloud_reclaim_volume_2r_ao"
	PaperCloudVolume2RStack       = "cloud_reclaim_volume_2r_sma_ema_macd"
	PaperTKCrossRSI               = "tk_cross_rsi"
	paperIchimokuSourceBars       = 500
	paperIchimokuObservationBars  = 24
	paperIchimokuRecentRetestBars = 4
)

type paperIchimokuPattern struct {
	kind      string
	direction int8
	origin    int
	known     int
	low       float64
	high      float64
}

func paperCloudBounds(point ichimoku.Point) (float64, float64, bool) {
	if point.SpanA == nil || point.SpanB == nil {
		return 0, 0, false
	}
	return math.Min(*point.SpanA, *point.SpanB), math.Max(*point.SpanA, *point.SpanB), true
}

func paperFavorable(direction int8, price, level float64) bool {
	return float64(direction)*(price-level) > 0
}

func paperOverlaps(bar market.Candle, low, high float64) bool {
	return bar.Low <= high && bar.High >= low
}

// Both the previously displayed cloud and the current displayed cloud must
// be broken by the origin close. The earlier cloud is the frozen reference.
func paperCloudOriginAt(bars []market.Candle, points []ichimoku.Point, at int, direction int8) (paperIchimokuPattern, bool) {
	if at < ichimoku.CloudWarmupBars || at >= len(bars) || at >= len(points) || direction != 1 && direction != -1 {
		return paperIchimokuPattern{}, false
	}
	priorLow, priorHigh, priorReady := paperCloudBounds(points[at-1])
	currentLow, currentHigh, currentReady := paperCloudBounds(points[at])
	if !priorReady || !currentReady {
		return paperIchimokuPattern{}, false
	}
	priorEdge, currentEdge := priorHigh, currentHigh
	if direction < 0 {
		priorEdge, currentEdge = priorLow, currentLow
	}
	if paperFavorable(direction, bars[at-1].Close, priorEdge) ||
		!paperFavorable(direction, bars[at].Close, priorEdge) ||
		!paperFavorable(direction, bars[at].Close, currentEdge) {
		return paperIchimokuPattern{}, false
	}
	return paperIchimokuPattern{kind: "cloud_reclaim", direction: direction, origin: at,
		known: at - 1, low: priorLow, high: priorHigh}, true
}

// The previous nonzero Tenkan/Kijun side survives equality plateaus. A Kijun
// move past a flat Tenkan, or a line touching the displayed cloud, is excluded.
func paperTKOriginAt(bars []market.Candle, points []ichimoku.Point, at int, previousSide int8) (paperIchimokuPattern, bool) {
	if at < 1 || at >= len(bars) || at >= len(points) || previousSide == 0 ||
		points[at].Tenkan == nil || points[at].Kijun == nil || points[at-1].Tenkan == nil {
		return paperIchimokuPattern{}, false
	}
	point := points[at]
	direction := paperDirection(*point.Tenkan, *point.Kijun)
	if direction == 0 || direction == previousSide ||
		float64(direction)*(*point.Tenkan-*points[at-1].Tenkan) <= 0 {
		return paperIchimokuPattern{}, false
	}
	low, high, ready := paperCloudBounds(point)
	if !ready || *point.Kijun >= low && *point.Kijun <= high ||
		bars[at].Close >= low && bars[at].Close <= high {
		return paperIchimokuPattern{}, false
	}
	reference := *point.Kijun
	return paperIchimokuPattern{kind: "tk_cross", direction: direction, origin: at,
		known: at, low: reference, high: reference}, true
}

func paperIchimokuRetest(pattern paperIchimokuPattern, bar market.Candle, point ichimoku.Point) (holds, retest bool, currentLow, currentHigh float64) {
	if pattern.kind == "cloud_reclaim" {
		low, high, ready := paperCloudBounds(point)
		if !ready {
			return false, false, 0, 0
		}
		frozenAdverse, currentAdverse := pattern.low, low
		if pattern.direction < 0 {
			frozenAdverse, currentAdverse = pattern.high, high
		}
		if !paperFavorable(pattern.direction, bar.Close, frozenAdverse) ||
			!paperFavorable(pattern.direction, bar.Close, currentAdverse) {
			return false, false, low, high
		}
		outside := bar.Close > math.Max(pattern.high, high)
		if pattern.direction < 0 {
			outside = bar.Close < math.Min(pattern.low, low)
		}
		return true, paperOverlaps(bar, pattern.low, pattern.high) && paperOverlaps(bar, low, high) &&
			(outside || paperFavorable(pattern.direction, bar.Close, bar.Open)), low, high
	}
	if point.Kijun == nil || point.Tenkan == nil {
		return false, false, 0, 0
	}
	current := *point.Kijun
	if !paperFavorable(pattern.direction, bar.Close, pattern.low) ||
		!paperFavorable(pattern.direction, bar.Close, current) ||
		float64(pattern.direction)*(*point.Tenkan-current) < 0 {
		return false, false, current, current
	}
	return true, paperOverlaps(bar, pattern.low, pattern.high) && paperOverlaps(bar, current, current), current, current
}

// The first held retest owns the identity. If its causal plan cannot be
// established, a later retest cannot provide a better stop or target.
func paperIchimokuPlan(pattern paperIchimokuPattern, bars []market.Candle, points []ichimoku.Point,
	asOf int64) (PaperFixedPlan, int, int, bool) {
	latest := len(bars) - 1
	for at := pattern.origin + 1; at <= latest && at <= pattern.origin+paperIchimokuObservationBars; at++ {
		holds, retest, currentLow, currentHigh := paperIchimokuRetest(pattern, bars[at], points[at])
		if !holds {
			return PaperFixedPlan{}, 0, 0, false
		}
		if !retest {
			continue
		}
		atr, ready := paperSimpleATR(bars, at)
		if !ready {
			return PaperFixedPlan{}, 0, 0, false
		}
		stop := math.Min(math.Min(pattern.low, currentLow), bars[at].Low) - 0.1*atr
		if pattern.direction < 0 {
			stop = math.Max(math.Max(pattern.high, currentHigh), bars[at].High) + 0.1*atr
		}
		direction := "bullish"
		if pattern.direction < 0 {
			direction = "bearish"
		}
		target, ready := paperStructuralTarget(bars, pattern.known, at, direction, bars[at].Close)
		if !ready {
			return PaperFixedPlan{}, 0, 0, false
		}
		plan, ready := paperFreezeFixed(bars, at, direction, stop, target)
		if !ready || !paperAssessFixed(plan, bars, at, direction, asOf) {
			return PaperFixedPlan{}, 0, 0, false
		}
		firstEligible := paperFirstFixedEligibility(plan, bars, at, direction)
		if firstEligible < 0 {
			return PaperFixedPlan{}, 0, 0, false
		}
		return plan, at, firstEligible, true
	}
	return PaperFixedPlan{}, 0, 0, false
}

func paperFirstFixedEligibility(plan PaperFixedPlan, bars []market.Candle, confirmed int, direction string) int {
	for at := confirmed; at < len(bars); at++ {
		if paperAssessFixed(plan, bars[:at+1], confirmed, direction, bars[at].CloseTime+1) {
			return at
		}
	}
	return -1
}

func paperCloudVolumePass(bars []market.Candle, firstEligible int) bool {
	if firstEligible < 20 || firstEligible >= len(bars) {
		return false
	}
	priorVolume := 0.0
	for _, bar := range bars[firstEligible-20 : firstEligible] {
		priorVolume += bar.Volume
	}
	mean := priorVolume / 20
	return paperFinite(mean) && mean > 0 && bars[firstEligible].Volume >= mean
}

func paperFixedOpportunity(in Input, pattern paperIchimokuPattern, bars []market.Candle,
	plan PaperFixedPlan, confirmed int) (Opportunity, string) {
	direction := "bullish"
	if pattern.direction < 0 {
		direction = "bearish"
	}
	origin := bars[pattern.origin].CloseTime
	rawID := fmt.Sprintf("ichimoku-v2:%s:1d:%s:%s:%d", in.Symbol, pattern.kind, direction, origin)
	start := pattern.origin - (ichimoku.CloudWarmupBars - 1)
	knownAt := bars[pattern.known].CloseTime
	if pattern.kind == "cloud_reclaim" {
		start = pattern.origin - ichimoku.CloudWarmupBars
	}
	level := pattern.high
	if pattern.direction < 0 {
		level = pattern.low
	}
	op := Opportunity{
		Version: Version, ParentID: rawID, Symbol: in.Symbol, Interval: "1d", Direction: direction,
		State: "entry_confirmed", AvailableAt: origin, LocationAvailableAt: knownAt,
		SourceStartAt: bars[start].OpenTime, SourceEndAt: knownAt, AsOf: bars[len(bars)-1].CloseTime,
		RetestAt: pbPtr(bars[confirmed].CloseTime), TriggerAt: pbPtr(plan.ConfirmedAt), ExpiresAt: pbPtr(plan.ExpiresAt),
		Level: level, ZoneLow: pbPtr(pattern.low), ZoneHigh: pbPtr(pattern.high),
		EntryReference: pbPtr(plan.Entry), Stop: pbPtr(plan.Stop), Target: pbPtr(plan.Target),
		ReferenceATR: pbPtr(plan.ATR), EntryMin: pbPtr(plan.EntryMin), EntryMax: pbPtr(plan.EntryMax),
	}
	return op, rawID
}

func paperCloudProfiles(base Opportunity, rawID string, feature PaperFeatures) []Opportunity {
	out := []Opportunity{base}
	expected := int8(1)
	if base.Direction == "bearish" {
		expected = -1
	}
	for _, filtered := range []struct {
		family string
		passes bool
		rule   string
	}{
		{PaperCloudVolume2REMA, feature.EMA == expected, "EMA10/20 direction"},
		{PaperCloudVolume2RSMA, feature.SMA == expected, "SMA10/20 direction"},
		{PaperCloudVolume2RSupertrend, feature.Supertrend == expected, "Supertrend direction (factor 3, ATR10)"},
		{PaperCloudVolume2RAO, feature.AO == expected, "Awesome Oscillator direction (5/34)"},
		{PaperCloudVolume2RStack, feature.SMA == expected && feature.EMA == expected && feature.MACD == expected,
			"SMA10/20, EMA10/20 and MACD12/26/9 direction together"},
	} {
		if !filtered.passes {
			continue
		}
		variant := base
		variant.Family = filtered.family
		variant.ID = fmt.Sprintf("curated-v2:%s:%s", rawID, filtered.family)
		variant.Reason = base.Reason + " " + filtered.rule + " agreed at the first raw eligible completed close."
		out = append(out, variant)
	}
	return out
}

// PaperCloudTKOpportunities returns only currently source-eligible confirmed
// daily cloud reclaim and TK-cross paper profiles. The first raw eligible close
// freezes volume and indicator gates; a later change cannot revive a rejected
// identity. Detection uses no provisional candle or unrelated timeframe.
func PaperCloudTKOpportunities(in Input, asOf int64) []Opportunity {
	out := []Opportunity{}
	if in.Symbol == "" || asOf <= 0 {
		return out
	}
	all, ready := pbCandles(in, "1d")
	if !ready || all[len(all)-1].CloseTime >= asOf {
		return out
	}
	features := paperSourceFeatures(all)
	if len(features) != len(all) {
		return out
	}
	bars := all
	if len(bars) > paperIchimokuSourceBars {
		bars = bars[len(bars)-paperIchimokuSourceBars:]
	}
	featureOffset := len(all) - len(bars)
	points := ichimoku.Series(bars)
	latest := len(bars) - 1
	firstOrigin := max(0, len(bars)-(paperIchimokuObservationBars+paperIchimokuRecentRetestBars))
	for at := max(ichimoku.CloudWarmupBars, firstOrigin); at <= latest; at++ {
		for _, direction := range []int8{1, -1} {
			pattern, found := paperCloudOriginAt(bars, points, at, direction)
			if !found {
				continue
			}
			plan, confirmed, firstEligible, eligible := paperIchimokuPlan(pattern, bars, points, asOf)
			if !eligible || !paperCloudVolumePass(bars, firstEligible) {
				continue
			}
			op, rawID := paperFixedOpportunity(in, pattern, bars, plan, confirmed)
			op.Family = PaperCloudVolume2R
			op.ID = fmt.Sprintf("curated-v1:%s:volume20-net2r", rawID)
			op.Reason = "A completed daily close crossed both displayed clouds; a later held retest froze the original structural plan, and volume at first raw eligibility met the prior 20-bar mean."
			op.Next = "The paper trial checks the next whole one-minute opening after observation, once that minute candle closes, with intervening minute candles verified and the slipped entry inside the frozen band. Keep the original stop; cap only a farther target at net 2R after actual slipped entry and costs, without extending a nearer target. Exit after at most 24 daily bars."
			op.Invalidation = "A later stop or original target touch, entry-band failure, net reward/risk below 1, or the four-bar entry deadline retires the frozen plan."
			op.Caution = "Forward paper research candidate. The 2R target cap depends on actual slipped entry and costs; the watchlist target is an indicative reference, not a fill or proven profit."
			out = append(out, paperCloudProfiles(op, rawID, features[featureOffset+firstEligible])...)
		}
	}
	previousSide := int8(0)
	for at, point := range points {
		if point.Tenkan == nil || point.Kijun == nil {
			continue
		}
		direction := paperDirection(*point.Tenkan, *point.Kijun)
		if direction == 0 {
			continue
		}
		before := previousSide
		previousSide = direction
		if at < firstOrigin {
			continue
		}
		pattern, found := paperTKOriginAt(bars, points, at, before)
		if !found {
			continue
		}
		plan, confirmed, firstEligible, eligible := paperIchimokuPlan(pattern, bars, points, asOf)
		if !eligible || features[featureOffset+firstEligible].RSI != direction {
			continue
		}
		op, rawID := paperFixedOpportunity(in, pattern, bars, plan, confirmed)
		op.Family = PaperTKCrossRSI
		op.ID = fmt.Sprintf("curated-v2:%s:%s", rawID, PaperTKCrossRSI)
		op.Reason = "Tenkan crossed Kijun outside the displayed cloud; a later held Kijun retest froze the original structural plan, and RSI14 agreed at the first raw eligible completed close."
		op.Next = "The paper trial checks the next whole one-minute opening after observation, once that minute candle closes, with intervening minute candles verified and the slipped entry inside the frozen band. Keep the original stop and target; exit after at most 24 daily bars."
		op.Invalidation = "A later stop or target touch, entry-band failure, net reward/risk below 1, or the four-bar entry deadline retires the frozen plan."
		op.Caution = "Forward paper research candidate. RSI14 above 50 for longs or below 50 for shorts is frozen at first raw eligibility; no fill or profit is inferred."
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

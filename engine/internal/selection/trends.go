package selection

import (
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/structure"
)

// TrendWatch describes an observed structure break and a possible pullback to
// its level. It is independent of harmonic patterns and supplies neither a
// trade instruction nor hypothetical fills, targets or profitability.
type TrendWatch struct {
	Symbol              string                 `json:"symbol"`
	Interval            string                 `json:"interval"`
	Direction           string                 `json:"direction"`
	Status              string                 `json:"status"`
	Price               float64                `json:"price"`
	PullbackLevel       float64                `json:"pullbackLevel"`
	DistanceATR         float64                `json:"distanceATR"`
	BreakType           string                 `json:"breakType"`
	BreakConfirmedAt    int64                  `json:"breakConfirmedAt"`
	BreakAgeBars        int                    `json:"breakAgeBars"`
	RetestClosedAt      *int64                 `json:"retestClosedAt"`
	RetestHigh          *float64               `json:"retestHigh"`
	RetestLow           *float64               `json:"retestLow"`
	TriggerClosedAt     *int64                 `json:"triggerClosedAt"`
	TriggerPrice        *float64               `json:"triggerPrice"`
	TriggerAgeBars      *int                   `json:"triggerAgeBars"`
	PullbackMomentum    string                 `json:"pullbackMomentum"`
	TrendADX            *float64               `json:"trendADX"`
	TriggerAligned      bool                   `json:"triggerAligned"`
	QuoteAdverse        bool                   `json:"quoteAdverse"`
	Plan                TradePlan              `json:"plan"`
	Volume              participation.Snapshot `json:"volume"`
	AnchoredVWAP        participation.VWAP     `json:"anchoredVwap"`
	RelativeStrengthBTC *float64               `json:"relativeStrengthBTC"`
	Reason              string                 `json:"reason"`
	Next                string                 `json:"next"`
	Caution             string                 `json:"caution"`
}

// TrendWatches returns at most twelve current continuation watches. Use
// TrendWatchesAll when recording observations so the display limit cannot hide
// a lifecycle transition from the journal.
func TrendWatches(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, configs ...Config) []TrendWatch {
	watches := TrendWatchesAll(snapshot, histories, symbols, now, maxAge, configs...)
	if len(watches) > 12 {
		watches = watches[:12]
	}
	return watches
}

// TrendWatchesAll finds symmetric continuation watches from closed 1h structure
// and fresh multi-timeframe context, without consulting harmonic candidates or
// market-majority direction. Preview candles can affect a displayed quote but
// never establish a break, invalidate a level or confirm a retest.
func TrendWatchesAll(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, configs ...Config) []TrendWatch {
	watches := []TrendWatch{}
	if snapshot.Running {
		return watches
	}
	series := make(map[string]scanner.SeriesSummary, len(snapshot.Series))
	blocked := map[string]bool{}
	for _, s := range snapshot.Series {
		key := s.Symbol + "/" + s.Interval
		if _, duplicate := series[key]; duplicate {
			blocked[key] = true
		}
		series[key] = s
	}
	for _, e := range snapshot.Errors {
		blocked[e.Symbol+"/"+e.Interval] = true
	}
	seen := map[string]bool{}
	for _, symbol := range symbols {
		if seen[symbol] {
			continue
		}
		seen[symbol] = true
		frames := map[string]scanner.SeriesSummary{}
		for _, interval := range []string{"1d", "4h", "1h", "15m"} {
			key := symbol + "/" + interval
			s, ok := series[key]
			if !ok || blocked[key] || !trendSeriesReady(s, now, maxAge) {
				break
			}
			frames[interval] = s
		}
		if len(frames) != 4 {
			continue
		}
		if watch, ok := trendWatchFor(symbol, frames, histories); ok {
			enrichTrend(&watch, snapshot, histories, now, selectedConfig(configs), maxAge)
			watches = append(watches, watch)
		}
	}
	sort.Slice(watches, func(i, j int) bool {
		a, b := watches[i], watches[j]
		if trendStatusOrder(a.Status) != trendStatusOrder(b.Status) {
			return trendStatusOrder(a.Status) < trendStatusOrder(b.Status)
		}
		if a.DistanceATR != b.DistanceATR {
			return a.DistanceATR < b.DistanceATR
		}
		return a.Symbol < b.Symbol
	})
	return watches
}

func trendSeriesReady(s scanner.SeriesSummary, now time.Time, maxAge time.Duration) bool {
	return seriesReady(s, now, maxAge)
}

func trendWatchFor(symbol string, frames map[string]scanner.SeriesSummary, histories map[string]scanner.History) (TrendWatch, bool) {
	hour, lower := frames["1h"], frames["15m"]
	direction := hour.Analysis.Regime.Direction
	if direction != "bullish" && direction != "bearish" ||
		frames["4h"].Analysis.Regime.Direction != direction || hour.Analysis.Structure.Internal.Bias != direction {
		return TrendWatch{}, false
	}
	event, ok := trendLatestBreak(hour.Analysis.Structure.Internal.LastBreak, hour.Analysis.Structure.Swing.LastBreak)
	if !ok || event.Direction != direction || !trendPositive(event.Level) || event.ConfirmedAt <= 0 ||
		event.ConfirmedAt > hour.LastClosedAt || event.PivotConfirmedAt > event.ConfirmedAt ||
		(event.Type != "BOS" && event.Type != "CHoCH") {
		return TrendWatch{}, false
	}
	upperBars := histories[symbol+"/1h"].Candles
	lowerBars := histories[symbol+"/15m"].Candles
	if !trendHistoryValid(upperBars, time.Hour, hour.LastClosedAt) || !trendHistoryValid(lowerBars, 15*time.Minute, lower.LastClosedAt) {
		return TrendWatch{}, false
	}
	eventIndex := trendCandleIndex(upperBars, event.ConfirmedAt)
	// Requiring the 15m bar ending at the break ensures uninterrupted coverage
	// from when the level became known through the latest closed reference.
	lowerEventIndex := trendCandleIndex(lowerBars, event.ConfirmedAt)
	if eventIndex < 0 || lowerEventIndex < 0 {
		return TrendWatch{}, false
	}
	age := len(upperBars) - 1 - eventIndex
	if age > 24 {
		return TrendWatch{}, false
	}
	atr := hour.Analysis.Regime.Volatility.ATR
	if atr == nil || !trendPositive(*atr) || !trendPositive(hour.Price) {
		return TrendWatch{}, false
	}
	sign := 1.0
	if direction == "bearish" {
		sign = -1
	}
	latest := lowerBars[len(lowerBars)-1]
	if sign*(latest.Close-event.Level) < 0 {
		return TrendWatch{}, false
	}
	for _, candle := range lowerBars[lowerEventIndex+1:] {
		if candle.OpenTime <= event.ConfirmedAt {
			continue
		}
		if sign*(candle.Close-event.Level) < 0 {
			return TrendWatch{}, false
		}
	}
	distance := math.Abs(hour.Price-event.Level) / *atr
	closedDistance := math.Abs(latest.Close-event.Level) / *atr
	if !trendFinite(distance) || !trendFinite(closedDistance) {
		return TrendWatch{}, false
	}
	w := TrendWatch{
		Symbol: symbol, Interval: "1h", Direction: direction, Status: "waiting_for_pullback",
		Price: hour.Price, PullbackLevel: event.Level, DistanceATR: distance,
		BreakType: event.Type, BreakConfirmedAt: event.ConfirmedAt, BreakAgeBars: age,
		TriggerAligned:   lower.Analysis.Regime.Direction == direction && lower.Analysis.Structure.Internal.Bias == direction,
		PullbackMomentum: lower.Analysis.Regime.Momentum.Direction,
		Reason:           fmt.Sprintf("4h and 1h trends and 1h internal structure agree with the %s 1h %s.", direction, event.Type),
		Next:             "Wait for a pullback toward the broken 1h level, then reassess with a closed 15m candle.",
		QuoteAdverse:     sign*(hour.Price-event.Level) < 0,
	}
	if w.PullbackMomentum == "" {
		w.PullbackMomentum = "unavailable"
	}
	if value := hour.Analysis.Regime.Momentum.ADX; value != nil && trendFinite(*value) && *value >= 0 {
		adx := *value
		w.TrendADX = &adx
	}
	trendLifecycle(&w, lowerBars, lowerEventIndex, sign, distance <= 1 && closedDistance <= 1)
	if w.QuoteAdverse {
		w.Status = "quote_beyond_level"
		w.Next = "The quote is temporarily beyond the broken level. Wait for the next completed 15m candle; current entry is blocked."
		w.Caution = "The live quote is adverse to the hourly level, while completed candles have not invalidated it."
	}
	macro := frames["1d"].Analysis
	if trendOpposes(macro.Regime.Direction, direction) || trendOpposes(macro.Structure.Internal.Bias, direction) || trendOpposes(macro.Structure.Swing.Bias, direction) {
		if w.Caution != "" {
			w.Caution += " "
		}
		w.Caution += "Daily direction evidence contains a conflict."
	}
	return w, true
}

// trendLifecycle retains a retest and the first later price follow-through.
// A new level touch starts a new observation cycle, never a simultaneous entry
// confirmation. Confirmation must occur within four subsequent closed bars;
// its entry freshness then lasts for that bar and the next three closed bars.
// TriggerAligned is current closed-candle agreement, not a claim about the
// unavailable historical indicator state at TriggerClosedAt.
func trendLifecycle(w *TrendWatch, bars []market.Candle, breakIndex int, sign float64, nearby bool) {
	const maxTriggerBars = 4
	retestIndex, triggerIndex := -1, -1
	for i := breakIndex + 1; i < len(bars); i++ {
		bar := bars[i]
		if bar.OpenTime <= w.BreakConfirmedAt {
			continue
		}
		if bar.Low <= w.PullbackLevel && bar.High >= w.PullbackLevel && sign*(bar.Close-w.PullbackLevel) > 0 {
			retestIndex, triggerIndex = i, -1
			continue
		}
		if retestIndex < 0 || triggerIndex >= 0 || i-retestIndex > maxTriggerBars {
			continue
		}
		level := bars[retestIndex].High
		if sign < 0 {
			level = bars[retestIndex].Low
		}
		if sign*(bar.Close-level) > 0 {
			triggerIndex = i
		}
	}
	if retestIndex >= 0 {
		retest := bars[retestIndex]
		w.RetestClosedAt, w.RetestHigh, w.RetestLow = &retest.CloseTime, &retest.High, &retest.Low
		w.Reason += " A closed post-break 15m candle touched the level and held on the trend side; its retest evidence is retained."
	}
	if triggerIndex >= 0 {
		trigger, age := bars[triggerIndex], len(bars)-1-triggerIndex
		w.TriggerClosedAt, w.TriggerPrice, w.TriggerAgeBars = &trigger.CloseTime, &trigger.Close, &age
		w.Reason += " A later closed 15m candle followed through beyond the retest extreme."
	}
	expired := triggerIndex >= 0 && len(bars)-1-triggerIndex >= maxTriggerBars ||
		triggerIndex < 0 && retestIndex >= 0 && len(bars)-1-retestIndex >= maxTriggerBars
	switch {
	case expired:
		w.Status = "confirmation_expired"
		w.Next = "The four-bar confirmation or entry-freshness window has ended. Wait for a new closed retest before considering another entry."
	case !w.TriggerAligned:
		w.Status = "pullback_developing"
		w.Next = "The hourly thesis remains intact while 15m trend or structure disagrees. Watch the pullback; entry confirmation requires both to realign."
	case !nearby:
		// Preserve the evidence, but never promote an extended quote or closed
		// reference as an entry merely because a retest or trigger occurred.
		w.Status = "waiting_for_pullback"
	case triggerIndex >= 0:
		w.Status = "entry_confirmed"
		w.Next = "Recent closed 15m price follow-through and current 15m trend and structure agree. Reassess the current quote and trade plan before entry."
	case retestIndex >= 0:
		w.Status = "retest_seen"
		w.Next = "Reassess the retained retest: a later closed 15m candle must close beyond its high for a bullish setup or low for a bearish setup within four bars."
	default:
		w.Status = "near_retest"
		w.Next = "Watch for a closed 15m retest of the broken 1h level, then reassess the pullback."
	}
}

func trendLatestBreak(a, b *structure.Break) (*structure.Break, bool) {
	if a == nil {
		return b, b != nil
	}
	if b == nil {
		return a, true
	}
	if a.ConfirmedAt == b.ConfirmedAt && a.Direction != b.Direction {
		return nil, false
	}
	if b.ConfirmedAt > a.ConfirmedAt {
		return b, true
	}
	return a, true
}

func trendHistoryValid(candles []market.Candle, width time.Duration, lastClosedAt int64) bool {
	if len(candles) == 0 || candles[len(candles)-1].CloseTime != lastClosedAt {
		return false
	}
	for i, candle := range candles {
		if !candle.Valid() || candle.CloseTime-candle.OpenTime+1 != width.Milliseconds() ||
			(i > 0 && candle.OpenTime != candles[i-1].CloseTime+1) {
			return false
		}
	}
	return true
}

func trendCandleIndex(candles []market.Candle, closedAt int64) int {
	for i, candle := range candles {
		if candle.CloseTime == closedAt {
			return i
		}
	}
	return -1
}

func trendOpposes(value, direction string) bool {
	return (value == "bullish" || value == "bearish") && value != direction
}

func trendStatusOrder(status string) int {
	switch status {
	case "entry_confirmed":
		return 0
	case "retest_seen":
		return 1
	case "near_retest":
		return 2
	case "pullback_developing":
		return 3
	case "confirmation_expired":
		return 5
	default:
		return 4
	}
}

func trendPositive(value float64) bool { return value > 0 && trendFinite(value) }
func trendFinite(value float64) bool   { return !math.IsNaN(value) && !math.IsInf(value, 0) }

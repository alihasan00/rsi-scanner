// Package selection builds a current setup watchlist from the scanner's
// completed evidence. These are transparent selection rules, not calibrated
// probabilities or assumed trade fills. Raw harmonic ranks remain unchanged.
package selection

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/scanner"
)

const (
	ModeTrendAligned      = "trend_aligned"
	ModeConfirmedReversal = "confirmed_reversal"
	watchlistLimit        = 12
)

var intervals = [...]string{"1d", "4h", "1h", "15m"}

type Result struct {
	Strategies        StrategyResult `json:"strategies"`
	Config            Config         `json:"config"`
	Benchmarks        []Benchmark    `json:"benchmarks"`
	CostFiltered      int            `json:"costFiltered"`
	Items             []Candidate    `json:"items"`
	Trends            []TrendWatch   `json:"trends"`
	Breadth           []Breadth      `json:"breadth"`
	Examined          int            `json:"examined"`
	Eligible          int            `json:"eligible"`
	DirectionFiltered int            `json:"directionFiltered"`
	Limit             int            `json:"limit"`
}

type Candidate struct {
	Plan                TradePlan              `json:"plan"`
	Volume              participation.Snapshot `json:"volume"`
	RelativeStrengthBTC *float64               `json:"relativeStrengthBTC"`
	Setup               scanner.Row            `json:"setup"`
	Mode                string                 `json:"mode"`
	Confirmation        bool                   `json:"confirmation"`
	EntryDistanceATR    float64                `json:"entryDistanceATR"`
	RewardRisk1         float64                `json:"rewardRisk1"`
	QuoteStopATR        float64                `json:"quoteStopATR"`
	Reason              string                 `json:"reason"`
	Next                string                 `json:"next"`
	Caution             string                 `json:"caution"`
	Alternatives        int                    `json:"alternatives"`
}

type Breadth struct {
	Interval    string `json:"interval"`
	Requested   int    `json:"requested"`
	Ready       int    `json:"ready"`
	Bullish     int    `json:"bullish"`
	Bearish     int    `json:"bearish"`
	Neutral     int    `json:"neutral"`
	Unavailable int    `json:"unavailable"`
}

// Build uses the same immutable scan and matching histories for eligibility,
// quote-based risk and direction. Eligible counts unique coin/timeframe pairs
// before the display limit. DirectionFiltered counts rows that passed all
// other eligibility checks but failed the current directional requirements.
// Breadth counts each requested coin once per timeframe and never gates rows.
func Build(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, configs ...Config) Result {
	return build(snapshot, histories, symbols, now, maxAge, watchlistLimit, selectedConfig(configs))
}

// BuildAll retains one candidate per coin/timeframe without a display limit.
func BuildAll(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, configs ...Config) Result {
	return build(snapshot, histories, symbols, now, maxAge, 0, selectedConfig(configs))
}

// BuildIchimoku returns the uncapped active Ichimoku screener. It uses the same
// four-frame freshness and reference-plan checks as the mixed watchlist, while
// excluding harmonics, trend watches and other strategy families before caps.
func BuildIchimoku(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, configs ...Config) Result {
	return buildScoped(snapshot, histories, symbols, now, maxAge, 0, selectedConfig(configs), true)
}

func build(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, limit int, cfg Config, prepared ...*Prepared) Result {
	return buildScoped(snapshot, histories, symbols, now, maxAge, limit, cfg, false, prepared...)
}

func buildScoped(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, limit int, cfg Config, ichimokuOnly bool, prepared ...*Prepared) Result {
	result := Result{Config: cfg, Benchmarks: benchmarks(snapshot, now, maxAge), Items: []Candidate{}, Breadth: []Breadth{}, Examined: len(snapshot.Rows), Limit: limit}
	if ichimokuOnly {
		result.Trends = []TrendWatch{}
		result.Strategies = BuildIchimokuStrategies(snapshot, histories, symbols, now, maxAge, cfg, prepared...)
		result.Examined = 0
		for _, summary := range result.Strategies.Summary {
			result.Examined += summary.Observed
			result.Eligible += summary.Eligible
		}
		for _, candidate := range result.Strategies.Items {
			if candidate.Status == "cost_blocked" {
				result.CostFiltered++
			}
		}
	} else {
		result.Strategies = BuildStrategies(snapshot, histories, symbols, now, maxAge, limit, cfg, prepared...)
	}
	allowed := make(map[string]bool, len(symbols))
	for _, symbol := range symbols {
		allowed[symbol] = true
	}
	series := make(map[string]scanner.SeriesSummary, len(snapshot.Series))
	for _, s := range snapshot.Series {
		key := pair(s.Symbol, s.Interval)
		old, exists := series[key]
		if !exists || s.ObservedAt.After(old.ObservedAt) || s.ObservedAt.Equal(old.ObservedAt) && s.LastClosedAt > old.LastClosedAt {
			series[key] = s
		}
	}
	blocked := make(map[string]bool, len(snapshot.Errors))
	for _, e := range snapshot.Errors {
		blocked[pair(e.Symbol, e.Interval)] = true
	}
	complete := make(map[string]bool, len(allowed))
	for symbol := range allowed {
		complete[symbol] = true
	}
	for _, interval := range intervals {
		breadth := Breadth{Interval: interval, Requested: len(allowed)}
		for symbol := range allowed {
			key := pair(symbol, interval)
			s, exists := series[key]
			if !exists || blocked[key] || !seriesReady(s, now, maxAge) {
				breadth.Unavailable++
				complete[symbol] = false
				continue
			}
			breadth.Ready++
			switch s.Analysis.Regime.Direction {
			case "bullish":
				breadth.Bullish++
			case "bearish":
				breadth.Bearish++
			default:
				breadth.Neutral++
			}
		}
		result.Breadth = append(result.Breadth, breadth)
	}
	if ichimokuOnly {
		return result
	}
	if snapshot.Running {
		result.Trends = []TrendWatch{}
		return result
	}
	result.Trends = TrendWatchesAll(snapshot, histories, symbols, now, maxAge, cfg)
	if limit > 0 && len(result.Trends) > limit {
		result.Trends = result.Trends[:limit]
	}
	candidates := []Candidate{}
	for _, row := range snapshot.Rows {
		if !allowed[row.Symbol] || !complete[row.Symbol] {
			continue
		}
		assessment := AssessCandidate(snapshot, histories, row, now, maxAge, cfg)
		if !assessment.Eligible {
			if assessment.Code == "direction" {
				result.DirectionFiltered++
			}
			if assessment.Code == "cost_or_liquidity" {
				result.CostFiltered++
			}
			continue
		}
		candidate := *assessment.Candidate
		candidates = append(candidates, candidate)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.Mode != b.Mode {
			return a.Mode == ModeTrendAligned
		}
		if a.Confirmation != b.Confirmation {
			return a.Confirmation
		}
		if a.Setup.Rank.Order != b.Setup.Rank.Order {
			return a.Setup.Rank.Order < b.Setup.Rank.Order
		}
		if a.EntryDistanceATR != b.EntryDistanceATR {
			return a.EntryDistanceATR < b.EntryDistanceATR
		}
		if a.Setup.Pattern.Score != b.Setup.Pattern.Score {
			return a.Setup.Pattern.Score > b.Setup.Pattern.Score
		}
		if a.Setup.Symbol != b.Setup.Symbol {
			return a.Setup.Symbol < b.Setup.Symbol
		}
		if a.Setup.Interval != b.Setup.Interval {
			return a.Setup.Interval < b.Setup.Interval
		}
		return a.Setup.Pattern.ID < b.Setup.Pattern.ID
	})
	counts := make(map[string]int)
	directions := make(map[string]map[string]bool)
	for _, c := range candidates {
		key := pair(c.Setup.Symbol, c.Setup.Interval)
		counts[key]++
		if directions[key] == nil {
			directions[key] = make(map[string]bool)
		}
		directions[key][string(c.Setup.Pattern.Direction)] = true
	}
	result.Eligible = len(counts)
	seen := make(map[string]bool)
	for _, c := range candidates {
		key := pair(c.Setup.Symbol, c.Setup.Interval)
		if seen[key] {
			continue
		}
		seen[key] = true
		if limit > 0 && len(result.Items) >= limit {
			break
		}
		c.Alternatives = counts[key] - 1
		if len(directions[key]) > 1 {
			c.Caution = join(c.Caution, "An opposing pattern also qualifies on this timeframe.")
		}
		result.Items = append(result.Items, c)
	}
	return result
}

// AssessDirection classifies the current closed-candle evidence, independently
// of entry price and lifecycle eligibility. The result is symmetric for longs
// and shorts. Scanner confirmation status applies the configured age limit;
// the additional checks preserve the event's direction and causal timestamps.
func AssessDirection(row scanner.Row) (mode, reason string, eligible bool) {
	p, d := row.Pattern, row.Decision
	if !directional(string(p.Direction)) {
		return "", "The pattern direction is unavailable.", false
	}
	if row.Stale || !d.ContextComplete || oneOf(d.Status, "stale_data", "insufficient_data") {
		return "", "Fresh, complete closed-candle context is required.", false
	}
	for _, interval := range intervals {
		if _, ok := frame(row, interval); !ok {
			return "", "Fresh, complete closed-candle context is required.", false
		}
	}
	local, ok := frame(row, row.Interval)
	if !ok {
		return "", "The setup timeframe's closed-candle direction is unavailable.", false
	}
	hourly, _ := frame(row, "1h")
	trigger, _ := frame(row, "15m")
	direction := string(p.Direction)
	triggerAgrees := trigger.Trend == direction && trigger.InternalBias == direction
	trendAligned := local.Trend == direction && local.InternalBias == direction && hourly.Trend == direction && triggerAgrees
	if trendAligned {
		reasons := []string{row.Interval + " trend and structure agree", "1h and 15m trends agree", "15m internal structure agrees"}
		if confirmedD(row) {
			reasons = append(reasons, "D pivot is confirmed")
		}
		if confirmed15m(row) {
			reasons = append(reasons, "recent 15m structure confirmation")
		}
		return ModeTrendAligned, strings.Join(reasons, "; ") + ".", true
	}
	if triggerAgrees && confirmedD(row) && confirmed15m(row) {
		return ModeConfirmedReversal, "D pivot is confirmed; recent 15m structure confirmation; 15m trend and internal structure agree. The setup or 1h direction is not fully aligned.", true
	}
	if !triggerAgrees {
		return "", "The 15m trend and internal structure do not both agree with the pattern. A confirmed D pivot alone does not establish current directional support.", false
	}
	return "", "The setup or 1h direction is not fully aligned; a reversal requires a confirmed D pivot and a recent post-setup 15m structure confirmation.", false
}

func priceCandidate(row scanner.Row, s scanner.SeriesSummary) (Candidate, bool) {
	p, d := row.Pattern, row.Decision
	if s.Symbol != row.Symbol || s.Interval != row.Interval || row.Stale || !d.ContextComplete || oneOf(d.Status, "stale_data", "insufficient_data") || !oneOf(p.Status, "pending", "active") || p.Target1Reached || p.Target2Reached || row.Rank.Order < 1 || row.Rank.Order > 6 {
		return Candidate{}, false
	}
	if !directional(string(p.Direction)) || !oneOf(p.Stage, "confirmed", "potential") || !finite(p.Score) || d.Risk.ATR == nil {
		return Candidate{}, false
	}
	if p.Stage == "confirmed" && !confirmedD(row) {
		return Candidate{}, false
	}
	quote, atr := s.Price, *d.Risk.ATR
	for _, value := range []float64{quote, p.Entry, p.Stop, p.Target1, p.Target2, d.Risk.ReferencePrice, atr} {
		if !positive(value) {
			return Candidate{}, false
		}
	}
	sign := directionSign(string(p.Direction))
	if sign*(p.Entry-p.Stop) <= 0 || sign*(p.Target1-p.Entry) <= 0 || sign*(p.Target2-p.Target1) < 0 {
		return Candidate{}, false
	}
	for _, reference := range []float64{quote, d.Risk.ReferencePrice} {
		if sign*(reference-p.Stop) <= 0 || sign*(p.Target1-reference) <= 0 {
			return Candidate{}, false
		}
	}
	distance := math.Abs(quote-p.Entry) / atr
	risk := sign * (quote - p.Stop)
	rr := sign * (p.Target1 - quote) / risk
	stopATR := risk / atr
	if !finite(distance) || !finite(rr) || !finite(stopATR) || distance > 1 || rr < 1 {
		return Candidate{}, false
	}
	return Candidate{Setup: row, EntryDistanceATR: distance, RewardRisk1: rr, QuoteStopATR: stopATR}, true
}

func explanation(row scanner.Row, candidate Candidate, quote float64) (next, caution string) {
	if !confirmedD(row) {
		next = "Watch for the D pivot to confirm, then reassess near the entry reference."
	} else if !candidate.Confirmation {
		next = "Watch for a " + string(row.Pattern.Direction) + " closed 15m structure break, then reassess near the entry reference."
	} else {
		next = "D and recent 15m timing are confirmed; reassess near the entry reference and if the stop or first target is reached."
	}
	if candidate.Mode == ModeConfirmedReversal {
		caution = "This is a countertrend reversal: the setup or 1h directional context is not fully aligned. Wider opposition remains a risk despite the recent 15m confirmation."
	}
	if row.Decision.Status == "mixed" {
		caution = join(caution, "Timeframes contain conflicting directional evidence.")
	} else if row.Decision.Status == "conflicting" {
		caution = join(caution, "The wider directional context opposes this pattern.")
	}
	if local, ok := frame(row, row.Interval); !ok || local.Trend != string(row.Pattern.Direction) {
		caution = join(caution, "The setup timeframe's trend does not agree yet.")
	}
	if candidate.QuoteStopATR < .25 {
		caution = join(caution, "The current quote is less than 0.25 ATR from the stop.")
	}
	sign := directionSign(string(row.Pattern.Direction))
	if level := row.Decision.Risk.NearestOpposingLevel; level != nil && sign*(level.Price-quote) > 0 && sign*(row.Pattern.Target1-level.Price) >= 0 {
		caution = join(caution, "An opposing structure level lies before target 1.")
	}
	return next, caution
}

func confirmedD(row scanner.Row) bool {
	p := row.Pattern
	return p.Stage == "confirmed" && p.D != nil && p.ConfirmedAt > 0 && p.ConfirmedAt <= row.LastClosedAt
}

func confirmed15m(row scanner.Row) bool {
	c := row.Decision.Confirmation
	f, ok := frame(row, "15m")
	if !ok || f.LastClosedAt == nil || c.Interval != "15m" || c.Status != "confirmed" || !c.AfterSetup || c.Event == nil || c.BarsAgo == nil || *c.BarsAgo < 0 {
		return false
	}
	return c.Event.Direction == string(row.Pattern.Direction) && c.Event.ConfirmedAt > 0 && c.Event.ConfirmedAt >= max(row.Pattern.DetectedAt, row.Pattern.ConfirmedAt) && c.Event.ConfirmedAt <= *f.LastClosedAt
}

func frame(row scanner.Row, interval string) (scanner.TimeframeContext, bool) {
	for _, f := range row.Decision.Timeframes {
		if f.Interval == interval {
			return f, f.Availability == "ready"
		}
	}
	return scanner.TimeframeContext{}, false
}

// SeriesReady shares freshness/readiness checks with the opportunity journal.
func SeriesReady(s scanner.SeriesSummary, now time.Time, maxAge time.Duration) bool {
	return seriesReady(s, now, maxAge)
}

func seriesReady(s scanner.SeriesSummary, now time.Time, maxAge time.Duration) bool {
	if maxAge <= 0 || s.Stale || s.ObservedAt.IsZero() || s.ObservedAt.After(now.Add(market.BoundaryGrace)) || now.Sub(s.ObservedAt) > maxAge ||
		s.LastClosedAt > now.UnixMilli() || !s.Analysis.Regime.Ready || s.Analysis.Regime.ClosedAt == nil || *s.Analysis.Regime.ClosedAt != s.LastClosedAt ||
		!oneOf(s.Analysis.Regime.Direction, "bullish", "bearish", "neutral") || s.Analysis.Structure.Status != "ready" {
		return false
	}
	expected, ok := market.ExpectedClosedTime(now, s.Interval, s.FirstOpenTime, market.BoundaryGrace)
	return ok && s.LastClosedAt >= expected
}

// Only complete bars strictly after reference creation can establish a newer
// touch. Every such bar through the published 15m close must be available;
// missing history must not turn an unverified higher-timeframe row eligible.
// Preview candles and bars beyond this snapshot's closing time never contribute.
func lowerReferenceUnavailableOrReached(row scanner.Row, history scanner.History, latest15m int64) bool {
	if row.Interval == "15m" {
		return false
	}
	available := max(row.LastClosedAt, row.Pattern.LevelsEstablishedAt)
	return referencesUnavailableOrReached(row.Pattern.Direction, row.Pattern.Stop, row.Pattern.Target1, history, available, latest15m)
}

func referencesUnavailableOrReached(direction string, stop, target float64, history scanner.History, available, latest15m int64) bool {
	const barMillis = int64(15 * time.Minute / time.Millisecond)
	firstOpen := (available/barMillis + 1) * barMillis
	if firstOpen > latest15m {
		return false
	}
	bars := make(map[int64]market.Candle)
	for _, bar := range history.Candles {
		if bar.OpenTime < firstOpen || bar.CloseTime > latest15m {
			continue
		}
		if !bar.Valid() || bar.CloseTime != bar.OpenTime+barMillis-1 {
			return true
		}
		if _, duplicate := bars[bar.OpenTime]; duplicate {
			return true
		}
		bars[bar.OpenTime] = bar
	}
	for open := firstOpen; open <= latest15m; open += barMillis {
		bar, ok := bars[open]
		if !ok {
			return true
		}
		if direction == "bullish" && (bar.Low <= stop || bar.High >= target) || direction == "bearish" && (bar.High >= stop || bar.Low <= target) {
			return true
		}
	}
	return false
}

func pair(symbol, interval string) string { return symbol + "/" + interval }
func finite(v float64) bool               { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func positive(v float64) bool             { return finite(v) && v > 0 }
func directional(v string) bool           { return v == "bullish" || v == "bearish" }
func directionSign(v string) float64 {
	if v == "bearish" {
		return -1
	}
	return 1
}
func oneOf[T ~string](v T, values ...string) bool {
	for _, candidate := range values {
		if string(v) == candidate {
			return true
		}
	}
	return false
}
func join(a, b string) string {
	if a == "" {
		return b
	}
	return fmt.Sprintf("%s %s", a, b)
}

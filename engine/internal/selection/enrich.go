package selection

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/regime"
	"github.com/alihasan00/crypto/internal/scanner"
)

type Assessment struct {
	Eligible  bool       `json:"eligible"`
	Code      string     `json:"code"`
	Reason    string     `json:"reason"`
	Candidate *Candidate `json:"candidate"`
}

// AssessCandidate is shared by shortlist, detail, journal and replay. Selection
// limits never affect this eligibility decision.
func AssessCandidate(snapshot scanner.Snapshot, histories map[string]scanner.History, row scanner.Row, now time.Time, maxAge time.Duration, configs ...Config) Assessment {
	reject := func(code, reason string) Assessment { return Assessment{Code: code, Reason: reason} }
	if snapshot.Running {
		return reject("updating", "A completed scan is required.")
	}
	cfg := selectedConfig(configs)
	if err := cfg.Validate(); err != nil {
		return reject("configuration", err.Error())
	}
	frames := map[string]scanner.SeriesSummary{}
	for _, s := range snapshot.Series {
		if s.Symbol == row.Symbol {
			old, exists := frames[s.Interval]
			if !exists || s.ObservedAt.After(old.ObservedAt) || s.ObservedAt.Equal(old.ObservedAt) && s.LastClosedAt > old.LastClosedAt {
				frames[s.Interval] = s
			}
		}
	}
	for _, e := range snapshot.Errors {
		if e.Symbol == row.Symbol {
			return reject("data_unavailable", "A required market feed is unavailable.")
		}
	}
	for _, tf := range intervals {
		if s, ok := frames[tf]; !ok || !seriesReady(s, now, maxAge) {
			return reject("data_unavailable", "Fresh, complete context on all four timeframes is required.")
		}
	}
	s, exists := frames[row.Interval]
	if !exists || !seriesReady(s, now, maxAge) {
		return reject("data_unavailable", "The setup timeframe is unavailable or delayed.")
	}
	c, ok := priceCandidate(row, s)
	if !ok {
		return reject("price_or_lifecycle", "The setup no longer meets entry-distance, unreached-target, stop, gross reward/risk or lifecycle requirements.")
	}
	if lowerReferenceUnavailableOrReached(row, histories[pair(row.Symbol, "15m")], frames["15m"].LastClosedAt) {
		return reject("reference_unavailable_or_reached", "Subsequent completed candles reached a reference stop/target, or required history is unavailable.")
	}
	mode, reason, ok := AssessDirection(row)
	if !ok {
		return reject("direction", reason)
	}
	c.Mode, c.Reason = mode, reason
	c.Confirmation = confirmed15m(row)
	c.Next, c.Caution = explanation(row, c, s.Price)
	enrichCandidate(&c, snapshot, histories, now, cfg, maxAge)
	if planBlocked(c.Plan) {
		return Assessment{Code: "cost_or_liquidity", Reason: fmt.Sprintf("Trade plan is %s; inspect its cost, target and turnover reasons.", strings.ReplaceAll(c.Plan.Status, "_", " ")), Candidate: &c}
	}
	return Assessment{Eligible: true, Code: "eligible", Reason: c.Reason, Candidate: &c}
}

func planBlocked(p TradePlan) bool {
	return p.Status != "awaiting_trigger" && p.Status != "ready_for_review" && p.Status != "confirmation_expired"
}

func enrichCandidate(c *Candidate, snapshot scanner.Snapshot, histories map[string]scanner.History, now time.Time, cfg Config, maxAges ...time.Duration) {
	r := c.Setup
	direction := string(r.Pattern.Direction)
	entry := r.Price
	for _, s := range snapshot.Series {
		if s.Symbol == r.Symbol && s.Interval == r.Interval {
			entry = s.Price
			c.Volume = participation.CloneSnapshot(s.Analysis.Volume)
		}
	}
	target := r.Pattern.Target1
	available := r.Pattern.LevelsEstablishedAt
	// Anchor the target to closed evidence when the reference was established. A subsequent
	// crossing must retire that target, not remove it and reveal a farther one.
	obstacle, obstacleAt, targetContextComplete := nearestObstacleAt(r.Symbol, direction, r.Pattern.Entry, snapshot, histories, available)
	capped := obstacle != nil && directionSign(direction)*(*obstacle-target) < 0
	if capped {
		target = *obstacle
	}
	if !targetContextComplete {
		target = 0
	}
	c.Plan = referencePlan(direction, entry, r.Pattern.Stop, target, cfg)
	if !targetContextComplete {
		c.Plan.Status = "reference_unavailable_or_reached"
		c.Plan.Reasons = append(c.Plan.Reasons, "Complete historical structure at reference establishment is unavailable; the effective target cannot be verified.")
	} else if legacyAnalysisSettings(snapshot) {
		c.Plan.Reasons = append(c.Plan.Reasons, "Imported evidence lacks reconstruction settings. The target uses current structure; its historical target state is unverified.")
	}
	c.Plan.Trigger = "Confirmed D plus an eligible recent closed 15m structure break, with current directional agreement; reassess the current quote before entry."
	c.Plan.Invalidation = "Cancel if the stop/first target is touched, confirmation expires, required direction fails or remaining net reward/risk falls below the minimum."
	if c.Confirmation && confirmedD(r) && c.Plan.Status == "awaiting_trigger" {
		c.Plan.Status = "ready_for_review"
	}
	if c.Confirmation && r.Decision.Confirmation.Event != nil {
		expiry := r.Decision.Confirmation.Event.ConfirmedAt + 4*int64(time.Minute*15/time.Millisecond)
		if r.Decision.Confirmation.ExpiresAt != nil {
			expiry = *r.Decision.Confirmation.ExpiresAt
		}
		c.Plan.ExpiresAt = &expiry
		if now.UnixMilli() > expiry && c.Plan.Status == "ready_for_review" {
			c.Plan.Status = "confirmation_expired"
		}
	}
	if capped {
		available = max(available, obstacleAt)
		for _, frame := range snapshot.Series {
			if frame.Symbol == r.Symbol && frame.Interval == "15m" && referencesUnavailableOrReached(direction, r.Pattern.Stop, target, histories[pair(r.Symbol, "15m")], available, frame.LastClosedAt) {
				c.Plan.Status = "reference_unavailable_or_reached"
				c.Plan.Reasons = append(c.Plan.Reasons, "Completed candles after the effective target became available reached its stop/target, or required history is missing.")
			}
		}
	}
	applyTurnover(&c.Plan, c.Volume, cfg)
	applySizing(&c.Plan, r.Symbol, direction, cfg, now)
	c.RelativeStrengthBTC = relativeStrength(r.Symbol, snapshot, histories, now, maxAges...)
}

func enrichTrend(w *TrendWatch, snapshot scanner.Snapshot, histories map[string]scanner.History, now time.Time, cfg Config, maxAges ...time.Duration) {
	var atr float64
	lower, lowerFound := historicalFrame(snapshot, w.Symbol, "15m")
	if lowerFound {
		w.Volume = participation.CloneSnapshot(lower.Analysis.Volume)
		if lower.Analysis.Regime.Volatility.ATR != nil {
			atr = *lower.Analysis.Regime.Volatility.ATR
		}
	}
	w.AnchoredVWAP = participation.AnchoredVWAP(histories[pair(w.Symbol, "15m")].Candles, w.BreakConfirmedAt)
	w.RelativeStrengthBTC = relativeStrength(w.Symbol, snapshot, histories, now, maxAges...)
	stop, target := 0.0, 0.0
	available, targetEntry := int64(0), w.Price
	if w.RetestClosedAt != nil {
		available = *w.RetestClosedAt
	}
	if w.TriggerClosedAt != nil {
		available = *w.TriggerClosedAt
		if w.TriggerPrice != nil {
			targetEntry = *w.TriggerPrice
		}
	}
	complete := true
	if available > 0 {
		// Retest and trigger each establish an observation cycle. Geometry uses
		// that cycle's closed context, never a later quote or a later ATR.
		bars, prefixOK := historicalPrefix(lower, histories[pair(w.Symbol, "15m")], available)
		if prefixOK {
			targetEntry = bars[len(bars)-1].Close
		}
		if !legacyAnalysisSettings(snapshot) {
			atr = 0
			if lowerFound && prefixOK {
				v := regime.Analyze(bars, snapshot.AnalysisSettings.Regime).Volatility
				if v.Ready && v.ATR != nil {
					atr = *v.ATR
				}
			}
			complete = positive(atr)
		}
		level, _, targetComplete := nearestObstacleAt(w.Symbol, w.Direction, targetEntry, snapshot, histories, available)
		complete = complete && targetComplete
		if complete && level != nil {
			target = *level
		}
	}
	if w.RetestLow != nil && w.RetestHigh != nil && positive(atr) {
		if w.Direction == "bullish" {
			stop = math.Min(*w.RetestLow, w.PullbackLevel) - 0.1*atr
		} else {
			stop = math.Max(*w.RetestHigh, w.PullbackLevel) + 0.1*atr
		}
	}
	w.Plan = referencePlan(w.Direction, w.Price, stop, target, cfg)
	if w.RetestClosedAt == nil {
		w.Plan.Status = "awaiting_retest"
		w.Plan.Reasons = append(w.Plan.Reasons, "A closed retest is required before a structural stop and complete reference plan can be established.")
	} else if !complete {
		w.Plan.Status = "reference_unavailable_or_reached"
		w.Plan.Reasons = append(w.Plan.Reasons, "Complete historical structure and ATR at this retest/trigger are unavailable; its stop and target cannot be verified.")
	} else if legacyAnalysisSettings(snapshot) {
		w.Plan.Reasons = append(w.Plan.Reasons, "Imported evidence lacks reconstruction settings. The plan uses current structure and ATR; its historical stop/target state is unverified.")
	}
	w.Plan.Trigger = "A subsequent completed 15m close beyond the retest high (bullish) or low (bearish), within four bars, with current 15m trend and structure aligned."
	w.Plan.Invalidation = "Cancel after any post-break 15m close through the broken level, loss of the hourly thesis, subsequent stop/target touch, expired timing or insufficient net reward/risk. Geometry is established at the closed retest and reset at its trigger; the stop uses the retest extreme plus 0.1 of that cycle's completed 15m ATR."
	if w.TriggerClosedAt != nil {
		expiry := *w.TriggerClosedAt + 4*int64(15*time.Minute/time.Millisecond)
		w.Plan.ExpiresAt = &expiry
	}
	if w.Status == "entry_confirmed" && w.Plan.Status == "awaiting_trigger" {
		w.Plan.Status = "ready_for_review"
	}
	if w.Plan.ExpiresAt != nil && now.UnixMilli() > *w.Plan.ExpiresAt && w.Plan.Status == "ready_for_review" {
		w.Plan.Status = "confirmation_expired"
	}
	if w.Status == "confirmation_expired" && w.Plan.Status == "awaiting_trigger" {
		w.Plan.Status = "confirmation_expired"
	}
	if complete && available > 0 && positive(stop) && positive(target) && referencesUnavailableOrReached(w.Direction, stop, target, histories[pair(w.Symbol, "15m")], available, lower.LastClosedAt) {
		w.Plan.Status = "reference_unavailable_or_reached"
		w.Plan.Reasons = append(w.Plan.Reasons, "Completed candles after this retest/trigger reached its fixed stop/target, or required history is missing. A new closed retest starts a new observation cycle.")
	}
	if w.QuoteAdverse {
		w.Plan.Status = "quote_beyond_level"
		w.Plan.Reasons = append(w.Plan.Reasons, "The live quote is beyond the broken level. The closed-candle thesis is retained, but current entry is blocked.")
	}
	applyTurnover(&w.Plan, w.Volume, cfg)
	applySizing(&w.Plan, w.Symbol, w.Direction, cfg, now)
}

func applyTurnover(p *TradePlan, v participation.Snapshot, cfg Config) {
	if cfg.MinTurnover24h <= 0 {
		return
	}
	if v.QuoteTurnover24h.Status != "ready" || v.QuoteTurnover24h.EstimatedValue == nil {
		p.Status = "liquidity_unavailable"
		p.Reasons = append(p.Reasons, "The configured turnover floor requires a complete closed 24h volume history.")
		return
	}
	if *v.QuoteTurnover24h.EstimatedValue < cfg.MinTurnover24h {
		p.Status = "liquidity_blocked"
		p.Reasons = append(p.Reasons, "Estimated completed-24h turnover is below the configured floor; this estimate does not establish order-book depth.")
	}
}

type Benchmark struct {
	Symbol       string   `json:"symbol"`
	Interval     string   `json:"interval"`
	Availability string   `json:"availability"`
	Trend        string   `json:"trend"`
	Momentum     string   `json:"momentum"`
	ADX          *float64 `json:"adx"`
}

func benchmarks(snapshot scanner.Snapshot, now time.Time, maxAge time.Duration) []Benchmark {
	result := []Benchmark{}
	for _, sym := range []string{"BTCUSDT", "ETHUSDT"} {
		for _, tf := range intervals {
			b := Benchmark{Symbol: sym, Interval: tf, Availability: "unavailable", Trend: "unavailable", Momentum: "unavailable"}
			blocked := false
			for _, e := range snapshot.Errors {
				if e.Symbol == sym && e.Interval == tf {
					blocked = true
				}
			}
			for _, s := range snapshot.Series {
				if s.Symbol == sym && s.Interval == tf && !blocked && seriesReady(s, now, maxAge) {
					b.Availability = "ready"
					b.Trend = s.Analysis.Regime.Direction
					b.Momentum = s.Analysis.Regime.Momentum.Direction
					if s.Analysis.Regime.Momentum.ADX != nil {
						b.ADX = number(*s.Analysis.Regime.Momentum.ADX)
					}
				}
			}
			result = append(result, b)
		}
	}
	return result
}

// RelativeStrengthBTC exposes the same matched completed-24h calculation used
// by reference plans, without imposing candidate admission on AI evidence.
func RelativeStrengthBTC(symbol string, snapshot scanner.Snapshot, histories map[string]scanner.History, now time.Time) *float64 {
	return relativeStrength(symbol, snapshot, histories, now)
}

// Return differences are percentage points over the same completed 24 hours.
func relativeStrength(symbol string, snapshot scanner.Snapshot, histories map[string]scanner.History, now time.Time, maxAges ...time.Duration) *float64 {
	maxAge := 2 * time.Minute
	if len(maxAges) > 0 {
		maxAge = maxAges[0]
	}
	var closeAt int64
	for _, sym := range []string{symbol, "BTCUSDT"} {
		found := false
		for _, s := range snapshot.Series {
			if s.Symbol == sym && s.Interval == "1h" && seriesReady(s, now, maxAge) {
				if closeAt != 0 && closeAt != s.LastClosedAt {
					return nil
				}
				closeAt = s.LastClosedAt
				found = true
			}
		}
		if !found {
			return nil
		}
	}
	for _, e := range snapshot.Errors {
		if (e.Symbol == symbol || e.Symbol == "BTCUSDT") && e.Interval == "1h" {
			return nil
		}
	}
	returns := []float64{}
	for _, sym := range []string{symbol, "BTCUSDT"} {
		bars := histories[pair(sym, "1h")].Candles
		if len(bars) < 25 || !trendHistoryValid(bars, time.Hour, closeAt) {
			return nil
		}
		returns = append(returns, 100*(bars[len(bars)-1].Close/bars[len(bars)-25].Close-1))
	}
	return number(returns[0] - returns[1])
}

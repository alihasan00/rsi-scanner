package scanner

import (
	"time"
	"errors"
	"fmt"
	"math"

	"github.com/alihasan00/crypto/internal/calendarlevels"
	"github.com/alihasan00/crypto/internal/fairvaluegaps"
	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/momentum"
	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/regime"
	"github.com/alihasan00/crypto/internal/structure"
	"github.com/alihasan00/crypto/internal/swingfailure"
	"github.com/alihasan00/crypto/internal/technical"
	"github.com/alihasan00/crypto/internal/volumeresponse"
)

// AnalysisSettings describes evidence calculations, never trading instructions.
type AnalysisSettings struct {
	Regime            regime.Config    `json:"regime"`
	Structure         structure.Config `json:"structure"`
	TriggerMaxAgeBars int              `json:"triggerMaxAgeBars"`
}

func DefaultAnalysisSettings() AnalysisSettings {
	return AnalysisSettings{Regime: regime.DefaultConfig(), Structure: structure.DefaultConfig(), TriggerMaxAgeBars: 4}
}

func (c AnalysisSettings) Validate() error {
	if err := c.Regime.Validate(); err != nil {
		return fmt.Errorf("regime settings: %w", err)
	}
	if err := c.Structure.Validate(); err != nil {
		return fmt.Errorf("structure settings: %w", err)
	}
	if c.TriggerMaxAgeBars < 1 || c.TriggerMaxAgeBars > 100 {
		return errors.New("trigger-max-age must be between 1 and 100 closed bars")
	}
	return nil
}

func (s *Scanner) ConfigureAnalysis(cfg AnalysisSettings) error {
	if err := cfg.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.Running {
		return ErrRunning
	}
	s.analysis = cfg
	return nil
}

func (s *Scanner) AnalysisSettings() AnalysisSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.analysis
}

type SeriesAnalysis struct {
	AsOf           int64                   `json:"asOf"`
	Regime         regime.Snapshot         `json:"regime"`
	Structure      structure.Snapshot      `json:"structure"`
	Volume         participation.Snapshot  `json:"volume"`
	Oscillator     momentum.Snapshot       `json:"oscillator"`
	Technical      technical.Snapshot      `json:"technical"`
	Calendar       calendarlevels.Snapshot `json:"calendar"`
	SwingFailure   swingfailure.Snapshot   `json:"swingFailure"`
	VolumeResponse volumeresponse.Snapshot `json:"volumeResponse"`
	FairValueGaps  fairvaluegaps.Snapshot  `json:"fairValueGaps"`
	// Ichimoku is observation-only context on 4h/1h. Other requested frames
	// publish null; it never participates in selection or paid AI evidence.
	Ichimoku *ichimoku.Snapshot `json:"ichimoku"`
}

type TimeframeContext struct {
	Interval     string   `json:"interval"`
	Role         string   `json:"role"`
	Availability string   `json:"availability"`
	LastClosedAt *int64   `json:"lastClosedAt"`
	Trend        string   `json:"trend"`
	ADX          *float64 `json:"adx"`
	Momentum     string   `json:"momentum"`
	InternalBias string   `json:"internalBias"`
	SwingBias    string   `json:"swingBias"`
}

type DecisionReason struct {
	Code     string `json:"code"`
	Kind     string `json:"kind"`
	Interval string `json:"interval,omitempty"`
	Detail   string `json:"detail"`
}

type Confirmation struct {
	Interval   string           `json:"interval"`
	Status     string           `json:"status"`
	Event      *structure.Break `json:"event"`
	BarsAgo    *int             `json:"barsAgo"`
	AfterSetup bool             `json:"afterSetup"`
	ExpiresAt  *int64           `json:"expiresAt,omitempty"`
}

type PriceLevel struct {
	Interval    string  `json:"interval"`
	Kind        string  `json:"kind"`
	Price       float64 `json:"price"`
	ConfirmedAt int64   `json:"confirmedAt"`
	DistanceATR float64 `json:"distanceATR"`
}

type RiskContext struct {
	ReferencePrice       float64     `json:"referencePrice"`
	ReferenceInterval    string      `json:"referenceInterval"`
	ReferenceClosedAt    int64       `json:"referenceClosedAt"`
	ATR                  *float64    `json:"atr"`
	ATRInterval          string      `json:"atrInterval"`
	RewardRiskBasis      string      `json:"rewardRiskBasis"`
	EntryStopDistanceATR *float64    `json:"entryStopDistanceATR"`
	PriceStopDistanceATR *float64    `json:"priceStopDistanceATR"`
	RewardRisk1          *float64    `json:"rewardRisk1"`
	RewardRisk2          *float64    `json:"rewardRisk2"`
	NearestOpposingLevel *PriceLevel `json:"nearestOpposingLevel"`
}

// Decision explains current closed-candle context. Status describes agreement
// of direction evidence, not eligibility to trade or a probability of success.
type Decision struct {
	AsOf            int64              `json:"asOf"`
	Status          string             `json:"status"`
	ContextComplete bool               `json:"contextComplete"`
	Timeframes      []TimeframeContext `json:"timeframes"`
	Confirmation    Confirmation       `json:"confirmation"`
	Risk            RiskContext        `json:"risk"`
	Reasons         []DecisionReason   `json:"reasons"`
}

var decisionIntervals = []string{"1d", "4h", "1h", "15m"}

func timeframeRole(interval string) string {
	switch interval {
	case "1d":
		return "macro"
	case "4h":
		return "trend"
	case "1h":
		return "setup"
	case "15m":
		return "trigger"
	default:
		return "additional"
	}
}

// attachDecisions runs once after all workers finish. It reuses only this scan's
// series and histories; unrequested/missing timeframes never trigger fetches.
func (s *Scanner) attachDecisions(req Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bySymbol := make(map[string]map[string]SeriesSummary)
	for _, series := range s.state.Series {
		if bySymbol[series.Symbol] == nil {
			bySymbol[series.Symbol] = make(map[string]SeriesSummary)
		}
		bySymbol[series.Symbol][series.Interval] = series
	}
	for i := range s.state.Rows {
		row := &s.state.Rows[i]
		row.Decision = assess(*row, bySymbol[row.Symbol], s.history, req.Timeframes, s.analysis)
	}
}

func assess(row Row, series map[string]SeriesSummary, history map[string]History, requested []string, cfg AnalysisSettings) Decision {
	d := Decision{Status: "neutral", ContextComplete: true, Timeframes: []TimeframeContext{}, Reasons: []DecisionReason{},
		Confirmation: Confirmation{Interval: "15m", Status: "unavailable"}}
	intervals := append([]string{}, decisionIntervals...)
	if !contains(intervals, row.Interval) {
		intervals = append(intervals, row.Interval)
	}
	support, conflict, stale := false, false, row.Stale
	add := func(code, kind, interval, detail string) {
		d.Reasons = append(d.Reasons, DecisionReason{code, kind, interval, detail})
	}
	for _, interval := range intervals {
		frame := TimeframeContext{Interval: interval, Role: timeframeRole(interval), Availability: "not_requested", Trend: "unavailable", Momentum: "unavailable", InternalBias: "unknown", SwingBias: "unknown"}
		item, exists := series[interval]
		if !exists {
			if contains(requested, interval) {
				frame.Availability = "missing"
			}
			d.ContextComplete = false
			add("context_"+frame.Availability, "unavailable", interval, "Closed-candle context is unavailable for this timeframe.")
			d.Timeframes = append(d.Timeframes, frame)
			continue
		}
		closedAt := item.Analysis.AsOf
		frame.LastClosedAt = &closedAt
		d.AsOf = max(d.AsOf, closedAt)
		frame.Trend = item.Analysis.Regime.Direction
		frame.ADX = copyFloat(item.Analysis.Regime.Momentum.ADX)
		frame.Momentum = item.Analysis.Regime.Momentum.Direction
		frame.InternalBias = item.Analysis.Structure.Internal.Bias
		frame.SwingBias = item.Analysis.Structure.Swing.Bias
		frame.Availability = "ready"
		if item.Stale {
			frame.Availability = "stale"
			stale, d.ContextComplete = true, false
		} else if item.Analysis.Structure.Status == "invalid" || item.Analysis.Regime.ClosedAt == nil {
			frame.Availability = "invalid"
			d.ContextComplete = false
		} else if !item.Analysis.Regime.Ready || item.Analysis.Structure.Status != "ready" {
			frame.Availability = "warming_up"
			d.ContextComplete = false
		}
		d.Timeframes = append(d.Timeframes, frame)
		if frame.Availability != "ready" {
			add("context_"+frame.Availability, "unavailable", interval, "Direction evidence is not used while context is stale, invalid, or insufficiently warmed up.")
			continue
		}
		for _, evidence := range []struct{ code, direction string }{
			{"supertrend", frame.Trend}, {"directional_movement", frame.Momentum}, {"internal_structure", frame.InternalBias}, {"swing_structure", frame.SwingBias},
		} {
			if evidence.direction != "bullish" && evidence.direction != "bearish" {
				continue
			}
			kind, relation := "support", "agrees with"
			if evidence.direction != string(row.Pattern.Direction) {
				kind, relation, conflict = "conflict", "opposes", true
			} else {
				support = true
			}
			add(evidence.code+"_"+kind, kind, interval, evidence.direction+" "+evidence.code+" "+relation+" the harmonic direction.")
		}
		if frame.ADX != nil && *frame.ADX <= cfg.Regime.ADXThreshold {
			add("weak_trend", "info", interval, "ADX does not exceed the configured trend-strength threshold.")
		}
	}
	switch {
	case stale:
		d.Status = "stale_data"
	case !d.ContextComplete:
		d.Status = "insufficient_data"
	case support && conflict:
		d.Status = "mixed"
	case conflict:
		d.Status = "conflicting"
	case support:
		d.Status = "aligned"
	}
	if row.Pattern.Stage == "potential" {
		add("potential_pattern", "info", row.Interval, "The harmonic completion pivot is not confirmed.")
	}
	if row.Pattern.Status == "completed" || row.Pattern.Status == "invalidated" || row.Pattern.Status == "expired" {
		add("ended_pattern", "info", row.Interval, "This historical harmonic lifecycle has ended.")
	}
	d.Confirmation = confirmationFor(row, series, history, cfg.TriggerMaxAgeBars)
	if d.Confirmation.Status == "confirmed" {
		add("recent_structure_confirmation", "support", "15m", "A recent closed 15m structure break agrees with the pattern and became available at or after its detection/confirmation.")
	} else {
		add("structure_confirmation_"+d.Confirmation.Status, "info", "15m", "No eligible recent 15m structure confirmation is available.")
	}
	d.Risk = riskFor(row, series, history)
	if d.Risk.EntryStopDistanceATR != nil && *d.Risk.EntryStopDistanceATR < 1 {
		add("stop_within_one_atr", "info", row.Interval, "The harmonic entry-to-stop distance is less than one ATR.")
	}
	if level := d.Risk.NearestOpposingLevel; level != nil {
		beforeTarget := string(row.Pattern.Direction) == "bullish" && level.Price <= row.Pattern.Target1 || string(row.Pattern.Direction) == "bearish" && level.Price >= row.Pattern.Target1
		if beforeTarget {
			add("level_before_target1", "info", level.Interval, "An unbroken confirmed structure level lies before the first harmonic target from the closed reference price.")
		}
	}
	if d.Risk.PriceStopDistanceATR != nil && *d.Risk.PriceStopDistanceATR <= 0 {
		add("closed_price_beyond_stop", "conflict", d.Risk.ReferenceInterval, "The latest closed reference price is at or beyond the harmonic stop.")
	}
	// Higher-timeframe lifecycles update only when their own candle closes.
	// A newer closed lower-timeframe price can already be past the original
	// targets; flag that separately without rewriting the harmonic lifecycle.
	if finitePositive(d.Risk.ReferencePrice) {
		bullish := string(row.Pattern.Direction) == "bullish"
		beyond := func(target float64) bool {
			return finitePositive(target) && (bullish && d.Risk.ReferencePrice >= target || !bullish && d.Risk.ReferencePrice <= target)
		}
		if beyond(row.Pattern.Target2) {
			add("closed_price_beyond_target2", "conflict", d.Risk.ReferenceInterval, "The latest closed reference price is at or beyond the second harmonic target. Original entry-based reward/risk does not describe a new entry here.")
		} else if beyond(row.Pattern.Target1) {
			add("closed_price_beyond_target1", "info", d.Risk.ReferenceInterval, "The latest closed reference price is at or beyond the first harmonic target. Assess remaining target distance separately from original entry-based reward/risk.")
		}
	}
	return d
}

func confirmationFor(row Row, series map[string]SeriesSummary, history map[string]History, maxAge int) Confirmation {
	result := Confirmation{Interval: "15m", Status: "unavailable"}
	item, ok := series["15m"]
	if !ok || item.Stale || item.Analysis.Structure.Status != "ready" {
		return result
	}
	result.Status = "waiting"
	// Use the most recent event across both structures, including an opposing
	// event; an older agreeing event must not conceal a subsequent reversal.
	var latest *structure.Break
	for _, event := range []*structure.Break{item.Analysis.Structure.Internal.LastBreak, item.Analysis.Structure.Swing.LastBreak} {
		if event != nil && (latest == nil || event.ConfirmedAt > latest.ConfirmedAt || event.ConfirmedAt == latest.ConfirmedAt && event.Direction != string(row.Pattern.Direction)) {
			copy := *event
			latest = &copy
		}
	}
	if latest == nil {
		return result
	}
	result.Event = latest
	expires := latest.ConfirmedAt + int64(maxAge)*(15*time.Minute).Milliseconds()
	result.ExpiresAt = &expires
	barsAgo, found := 0, false
	for _, candle := range history[row.Symbol+"/15m"].Candles {
		if candle.CloseTime == latest.ConfirmedAt {
			found = true
		}
		if candle.CloseTime > latest.ConfirmedAt {
			barsAgo++
		}
	}
	if !found {
		return result
	}
	result.BarsAgo = &barsAgo
	knownAt := max(row.Pattern.DetectedAt, row.Pattern.ConfirmedAt)
	result.AfterSetup = latest.ConfirmedAt >= knownAt
	if latest.Direction == string(row.Pattern.Direction) && result.AfterSetup && barsAgo < maxAge {
		result.Status = "confirmed"
	}
	return result
}

func finitePositive(v float64) bool { return v > 0 && !math.IsNaN(v) && !math.IsInf(v, 0) }

func ratioValue(numerator, denominator float64) *float64 {
	if !finitePositive(denominator) || math.IsNaN(numerator) || math.IsInf(numerator, 0) {
		return nil
	}
	v := numerator / denominator
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}

func riskFor(row Row, series map[string]SeriesSummary, history map[string]History) RiskContext {
	risk := RiskContext{ATRInterval: row.Interval, RewardRiskBasis: "pattern_entry"}
	item, ok := series[row.Interval]
	candles := history[row.Symbol+"/"+row.Interval].Candles
	if !ok || len(candles) == 0 {
		return risk
	}
	last := candles[len(candles)-1]
	risk.ReferenceInterval = row.Interval
	// A daily setup can use the latest closed 15m reference price while retaining
	// daily ATR for scale. Provisional prices never enter these calculations.
	for _, interval := range decisionIntervals {
		candidate, exists := series[interval]
		h := history[row.Symbol+"/"+interval].Candles
		if !exists || candidate.Stale || len(h) == 0 {
			continue
		}
		if newer := h[len(h)-1]; newer.CloseTime > last.CloseTime {
			last = newer
			risk.ReferenceInterval = interval
		}
	}
	risk.ReferencePrice, risk.ReferenceClosedAt = last.Close, last.CloseTime
	if !item.Stale {
		risk.ATR = copyFloat(item.Analysis.Regime.Volatility.ATR)
	}
	p := row.Pattern
	stopDistance := math.Abs(p.Entry - p.Stop)
	bullish := string(p.Direction) == "bullish"
	validLevels := finitePositive(p.Entry) && finitePositive(p.Stop) && finitePositive(p.Target1) && finitePositive(p.Target2) &&
		(bullish && p.Stop < p.Entry && p.Target1 > p.Entry && p.Target2 >= p.Target1 || !bullish && p.Stop > p.Entry && p.Target1 < p.Entry && p.Target2 <= p.Target1)
	if validLevels {
		risk.RewardRisk1 = ratioValue(math.Abs(p.Target1-p.Entry), stopDistance)
		risk.RewardRisk2 = ratioValue(math.Abs(p.Target2-p.Entry), stopDistance)
		if risk.ATR != nil {
			risk.EntryStopDistanceATR = ratioValue(stopDistance, *risk.ATR)
		}
	}
	if risk.ATR == nil || !finitePositive(*risk.ATR) {
		return risk
	}
	// Signed distance becomes negative if the closed reference is past the stop.
	priceStop := last.Close - p.Stop
	if !bullish {
		priceStop = p.Stop - last.Close
	}
	risk.PriceStopDistanceATR = ratioValue(priceStop, *risk.ATR)
	// Deterministic tie order; include the setup timeframe and the four requested
	// context intervals, with every level's interval and knowledge time retained.
	intervals := append([]string{}, decisionIntervals...)
	if !contains(intervals, row.Interval) {
		intervals = append(intervals, row.Interval)
	}
	for _, interval := range intervals {
		context, exists := series[interval]
		if !exists || context.Stale || context.Analysis.Structure.Status != "ready" {
			continue
		}
		for _, candidate := range []struct {
			kind  string
			state structure.State
		}{{"internal", context.Analysis.Structure.Internal}, {"swing", context.Analysis.Structure.Swing}} {
			pivot, kind := candidate.state.High, candidate.kind+"_high"
			if !bullish {
				pivot, kind = candidate.state.Low, candidate.kind+"_low"
			}
			if pivot == nil || pivot.Crossed || !finitePositive(pivot.Price) || bullish && pivot.Price <= last.Close || !bullish && pivot.Price >= last.Close {
				continue
			}
			// Internal structure suppresses some duplicate breaks at swing levels.
			// A pivot's event flag alone therefore cannot prove price never broke it.
			breached := false
			for _, candle := range history[row.Symbol+"/"+interval].Candles {
				if candle.CloseTime >= pivot.ConfirmedAt && (bullish && candle.Close > pivot.Price || !bullish && candle.Close < pivot.Price) {
					breached = true
					break
				}
			}
			if breached {
				continue
			}
			distance := math.Abs(pivot.Price-last.Close) / *risk.ATR
			if math.IsInf(distance, 0) || math.IsNaN(distance) {
				continue
			}
			if risk.NearestOpposingLevel == nil || distance < risk.NearestOpposingLevel.DistanceATR {
				risk.NearestOpposingLevel = &PriceLevel{interval, kind, pivot.Price, pivot.ConfirmedAt, distance}
			}
		}
	}
	return risk
}

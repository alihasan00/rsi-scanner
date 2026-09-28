package selection

import (
	"fmt"
	"math"
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/structure"
)

// Config contains disclosed screening assumptions, not exchange quotes or a
// claim of optimal strategy parameters. Account is optional user-supplied data.
type Config struct {
	FeeBPS             float64  `json:"feeBps"`
	SlippageBPS        float64  `json:"slippageBps"`
	MinNetRR           float64  `json:"minNetRR"`
	MinTurnover24h     float64  `json:"minTurnover24h"`
	Account            *Account `json:"account"`
	AccountUnavailable string   `json:"accountUnavailable,omitempty"`
}

type Exposure struct {
	Symbol    string  `json:"symbol"`
	Direction string  `json:"direction"`
	RiskQuote float64 `json:"riskQuote"`
}

type Account struct {
	ExposureVerified    bool       `json:"exposureVerified"`
	AsOf                time.Time  `json:"asOf"`
	Equity              float64    `json:"equity"`
	RiskPercent         float64    `json:"riskPercent"`
	MaxOpenRiskPercent  float64    `json:"maxOpenRiskPercent"`
	MaxDailyLossPercent float64    `json:"maxDailyLossPercent"`
	DailyLossQuote      float64    `json:"dailyLossQuote"`
	MaxPositions        int        `json:"maxPositions"`
	MaxSameDirection    int        `json:"maxSameDirection"`
	Positions           []Exposure `json:"positions"`
}

func DefaultConfig() Config { return Config{FeeBPS: 20, SlippageBPS: 10, MinNetRR: 1} }

func (c Config) Validate() error {
	for name, v := range map[string]float64{"fee bps": c.FeeBPS, "slippage bps": c.SlippageBPS, "minimum net reward/risk": c.MinNetRR, "minimum turnover": c.MinTurnover24h} {
		if !finite(v) || v < 0 {
			return fmt.Errorf("%s must be finite and nonnegative", name)
		}
	}
	if c.FeeBPS+c.SlippageBPS >= 10000 || c.MinNetRR <= 0 {
		return fmt.Errorf("total costs must be below 10000 bps and minimum net reward/risk positive")
	}
	if a := c.Account; a != nil {
		if a.AsOf.IsZero() || !positive(a.Equity) || !positive(a.RiskPercent) || !positive(a.MaxOpenRiskPercent) || !positive(a.MaxDailyLossPercent) || a.RiskPercent > a.MaxOpenRiskPercent || a.MaxOpenRiskPercent > 100 || a.MaxDailyLossPercent > 100 || !finite(a.DailyLossQuote) || a.DailyLossQuote < 0 || a.MaxPositions < 1 || a.MaxSameDirection < 1 || a.MaxSameDirection > a.MaxPositions {
			return fmt.Errorf("account needs timestamp, positive equity and explicit valid risk/exposure limits")
		}
		seen := map[string]bool{}
		for _, p := range a.Positions {
			if p.Symbol == "" || !directional(p.Direction) || !finite(p.RiskQuote) || p.RiskQuote < 0 || seen[p.Symbol] {
				return fmt.Errorf("account positions need unique symbols, directions and nonnegative risk")
			}
			seen[p.Symbol] = true
		}
	}
	return nil
}

func selectedConfig(configs []Config) Config {
	if len(configs) > 0 {
		return configs[0]
	}
	return DefaultConfig()
}

// TradePlan is a proposed reference model at the current quote. A confirmed
// signal is not a fill, and executable liquidity is never inferred from OHLCV.
type TradePlan struct {
	Status            string   `json:"status"`
	Entry             *float64 `json:"entry"`
	Stop              *float64 `json:"stop"`
	Target            *float64 `json:"target"`
	GrossRR           *float64 `json:"grossRR"`
	NetRR             *float64 `json:"netRR"`
	CostRiskR         *float64 `json:"costRiskR"`
	FeeBPS            float64  `json:"feeBps"`
	SlippageBPS       float64  `json:"slippageBps"`
	MinNetRR          float64  `json:"minNetRR"`
	Trigger           string   `json:"trigger"`
	Invalidation      string   `json:"invalidation"`
	Management        string   `json:"management"`
	ExpiresAt         *int64   `json:"expiresAt"`
	Instrument        string   `json:"instrument"`
	ExecutionVerified bool     `json:"executionVerified"`
	SizingStatus      string   `json:"sizingStatus"`
	RiskBudgetQuote   *float64 `json:"riskBudgetQuote"`
	Quantity          *float64 `json:"quantity"`
	Reasons           []string `json:"reasons"`
}

func referencePlan(direction string, entry, stop, target float64, cfg Config) TradePlan {
	p := TradePlan{Status: "awaiting_trigger", FeeBPS: cfg.FeeBPS, SlippageBPS: cfg.SlippageBPS, MinNetRR: cfg.MinNetRR, Instrument: "spot_long_reference", SizingStatus: "unconfigured", Reasons: []string{}, Management: "Reference model: exit fully at the first target or initial stop; no automatic breakeven move or trailing stop. Never infer an order fill from a candle touch."}
	if direction == "bearish" {
		p.Instrument = "short_instrument_unverified"
		p.Reasons = append(p.Reasons, "Spot bearish context does not establish a shortable instrument; verify its own prices, borrow/funding and contract rules.")
	}
	if err := cfg.Validate(); err != nil {
		p.Status = "invalid_configuration"
		p.Reasons = append(p.Reasons, err.Error())
		return p
	}
	sign := directionSign(direction)
	if !directional(direction) || !positive(entry) || !positive(stop) || sign*(entry-stop) <= 0 {
		p.Status = "invalid_stop"
		p.Reasons = append(p.Reasons, "A structural stop on the adverse side of entry is required.")
		return p
	}
	p.Entry, p.Stop = number(entry), number(stop)
	if !positive(target) || sign*(target-entry) <= 0 {
		p.Status = "no_target"
		p.Reasons = append(p.Reasons, "No unbroken opposing structure target is available ahead of the quote.")
		return p
	}
	p.Target = number(target)
	risk, reward := sign*(entry-stop), sign*(target-entry)
	cost := entry * ((cfg.FeeBPS + cfg.SlippageBPS) / 10000)
	p.GrossRR, p.NetRR, p.CostRiskR = number(reward/risk), number((reward-cost)/(risk+cost)), number(cost/risk)
	if !positive(risk) || !positive(reward) || !finite(cost) || !positive(risk+cost) || p.GrossRR == nil || p.NetRR == nil || p.CostRiskR == nil {
		p.Status = "invalid_arithmetic"
		p.GrossRR, p.NetRR, p.CostRiskR = nil, nil, nil
		p.Reasons = append(p.Reasons, "Reference distances or cost ratios are outside the supported numeric range.")
		return p
	}
	if *p.NetRR < cfg.MinNetRR {
		p.Status = "cost_blocked"
		p.Reasons = append(p.Reasons, "Remaining reward/risk after the stated round-trip cost allowance is below the minimum.")
	}
	if cost >= risk {
		p.Reasons = append(p.Reasons, "The modeled round-trip costs equal or exceed the initial price risk; small fill differences materially affect this reference.")
	}
	p.Reasons = append(p.Reasons, "Costs are round-trip allowances on entry notional. Bid/ask spread, depth, tick size and actual fills are unverified.")
	return p
}

// ReferencePlan exposes numerical reference and local sizing checks without
// applying harmonic, trend or structure eligibility to an independent opinion.
func ReferencePlan(symbol, direction string, entry, stop, target float64, now time.Time, cfg Config) TradePlan {
	p := referencePlan(direction, entry, stop, target, cfg)
	applySizing(&p, symbol, direction, cfg, now)
	return p
}

func number(v float64) *float64 {
	if !finite(v) {
		return nil
	}
	return &v
}

func applySizing(p *TradePlan, symbol, direction string, cfg Config, now time.Time) {
	if cfg.AccountUnavailable != "" {
		p.SizingStatus = "blocked"
		p.Reasons = append(p.Reasons, "Account sizing is unavailable: "+cfg.AccountUnavailable)
		return
	}
	a := cfg.Account
	if a == nil || p.Entry == nil || p.Stop == nil || p.NetRR == nil {
		return
	}
	if !a.ExposureVerified {
		cost := *p.Entry * (cfg.FeeBPS + cfg.SlippageBPS) / 10000
		budget := a.Equity * a.RiskPercent / 100
		qty := math.Min(budget/(math.Abs(*p.Entry-*p.Stop)+cost), a.Equity / *p.Entry)
		p.RiskBudgetQuote = number(qty * (math.Abs(*p.Entry-*p.Stop) + cost))
		p.Quantity = number(qty)
		p.SizingStatus = "indicative_exposure_unverified"
		p.Reasons = append(p.Reasons, "Sizing is indicative: current holdings, daily losses and available cash have not been supplied. Verify remaining account limits before using any quantity.")
		return
	}
	p.SizingStatus = "blocked"
	if a.AsOf.After(now) || now.Sub(a.AsOf) > 15*time.Minute || a.AsOf.UTC().Format("2006-01-02") != now.UTC().Format("2006-01-02") {
		p.Reasons = append(p.Reasons, "Account state must be from today and no more than 15 minutes old before sizing.")
		return
	}
	if a.DailyLossQuote >= a.Equity*a.MaxDailyLossPercent/100 {
		p.Reasons = append(p.Reasons, "The supplied daily loss limit is reached.")
		return
	}
	if len(a.Positions) >= a.MaxPositions {
		p.Reasons = append(p.Reasons, "The supplied simultaneous-position limit is reached.")
		return
	}
	open, same := 0.0, 0
	for _, e := range a.Positions {
		open += e.RiskQuote
		if e.Symbol == symbol {
			p.Reasons = append(p.Reasons, "This coin already has exposure in the supplied account state.")
			return
		}
		if e.Direction == direction {
			same++
		}
	}
	if same >= a.MaxSameDirection {
		p.Reasons = append(p.Reasons, "The supplied same-direction exposure limit is reached.")
		return
	}
	budget := math.Min(a.Equity*a.RiskPercent/100, a.Equity*a.MaxOpenRiskPercent/100-open)
	budget = math.Min(budget, a.Equity*a.MaxDailyLossPercent/100-a.DailyLossQuote-open)
	if budget <= 0 {
		p.Reasons = append(p.Reasons, "The remaining aggregate or daily risk allowance is exhausted after existing open risk.")
		return
	}
	cost := *p.Entry * (cfg.FeeBPS + cfg.SlippageBPS) / 10000
	qty := budget / (math.Abs(*p.Entry-*p.Stop) + cost)
	// Spot long references are unlevered. Cash balance and exchange increments
	// are still unknown; this is an upper bound, not an order quantity.
	qty = math.Min(qty, a.Equity / *p.Entry)
	p.RiskBudgetQuote = number(qty * (math.Abs(*p.Entry-*p.Stop) + cost))
	p.Quantity = number(qty)
	p.SizingStatus = "individual_reference"
	p.Reasons = append(p.Reasons, "Sizing is for this candidate individually; simultaneous candidates share the same remaining risk budget. Available cash and exchange quantity filters still require verification.")
}

// NearestObstacle finds causal, unbroken structure in front of the proposed
// entry. Crossed flags alone are insufficient when internal events suppress
// duplicate swing breaks, so matching complete histories are checked too.
func NearestObstacle(symbol, direction string, entry float64, series []scanner.SeriesSummary, histories map[string]scanner.History) *float64 {
	price, _ := nearestObstacle(symbol, direction, entry, series, histories)
	return price
}

func legacyAnalysisSettings(snapshot scanner.Snapshot) bool {
	return snapshot.AnalysisSettings == (scanner.AnalysisSettings{})
}

// A nil obstacle with complete=true means no opposing level was found. Missing
// historical context must remain distinct: it cannot restore a farther target.
func nearestObstacleAt(symbol, direction string, entry float64, snapshot scanner.Snapshot, histories map[string]scanner.History, at int64) (price *float64, available int64, complete bool) {
	if legacyAnalysisSettings(snapshot) {
		// Compatibility for imported evidence without reconstruction settings is
		// explicitly disclosed by callers; its historical target is unverified.
		price, available = nearestObstacle(symbol, direction, entry, snapshot.Series, histories)
		return price, available, true
	}
	if at <= 0 || snapshot.AnalysisSettings.Structure.Validate() != nil {
		return nil, 0, false
	}
	frames := []scanner.SeriesSummary{}
	prefixes := map[string]scanner.History{}
	for _, interval := range intervals {
		frame, found := historicalFrame(snapshot, symbol, interval)
		if !found {
			return nil, 0, false
		}
		bars, ok := historicalPrefix(frame, histories[pair(symbol, interval)], at)
		if !ok {
			return nil, 0, false
		}
		frame.LastClosedAt = bars[len(bars)-1].CloseTime
		frame.Analysis.Structure = structure.Analyze(bars, snapshot.AnalysisSettings.Structure)
		if frame.Analysis.Structure.Status != "ready" {
			return nil, 0, false
		}
		frames = append(frames, frame)
		prefixes[pair(symbol, frame.Interval)] = scanner.History{Candles: bars}
	}
	price, available = nearestObstacle(symbol, direction, entry, frames, prefixes)
	return price, available, true
}

func historicalFrame(snapshot scanner.Snapshot, symbol, interval string) (scanner.SeriesSummary, bool) {
	var result scanner.SeriesSummary
	found := false
	for _, frame := range snapshot.Series {
		if frame.Symbol == symbol && frame.Interval == interval && (!found || frame.ObservedAt.After(result.ObservedAt) || frame.ObservedAt.Equal(result.ObservedAt) && frame.LastClosedAt > result.LastClosedAt) {
			result, found = frame, true
		}
	}
	return result, found
}

// Reconstruct from the same beginning as the published analysis and require
// every completed candle through the historical endpoint. Warmup is checked by
// the indicator caller; a short or missing prefix is never "no obstacle".
func historicalPrefix(frame scanner.SeriesSummary, history scanner.History, at int64) ([]market.Candle, bool) {
	if at <= 0 || frame.Stale || at > frame.LastClosedAt && frame.Interval == "15m" {
		return nil, false
	}
	expected, ok := market.ExpectedClosedTime(time.UnixMilli(at).Add(time.Millisecond), frame.Interval, frame.FirstOpenTime, 0)
	width, err := time.ParseDuration(frame.Interval)
	if frame.Interval == "1d" {
		width, err = 24*time.Hour, nil
	}
	if !ok || err != nil || expected > frame.LastClosedAt {
		return nil, false
	}
	bars := history.Candles
	end := 0
	for end < len(bars) && bars[end].CloseTime <= at {
		end++
	}
	if end == 0 {
		return nil, false
	}
	bars = bars[:end]
	if frame.FirstOpenTime > 0 && bars[0].OpenTime != frame.FirstOpenTime || !trendHistoryValid(bars, width, expected) {
		return nil, false
	}
	return bars, true
}

func nearestObstacle(symbol, direction string, entry float64, series []scanner.SeriesSummary, histories map[string]scanner.History) (*float64, int64) {
	var result *float64
	var available int64
	sign := directionSign(direction)
	for _, s := range series {
		if s.Symbol != symbol || s.Stale || s.Analysis.Structure.Status != "ready" {
			continue
		}
		h := histories[pair(symbol, s.Interval)].Candles
		width, err := time.ParseDuration(s.Interval)
		if s.Interval == "1d" {
			width = 24 * time.Hour
			err = nil
		}
		if err != nil || !trendHistoryValid(h, width, s.LastClosedAt) {
			continue
		}
		for _, st := range []struct {
			price     float64
			confirmed int64
			crossed   bool
		}{pivotInfo(s.Analysis.Structure.Internal, direction), pivotInfo(s.Analysis.Structure.Swing, direction)} {
			if st.crossed || st.confirmed <= 0 || st.confirmed > s.LastClosedAt || !positive(st.price) || sign*(st.price-entry) <= 0 || h[0].OpenTime > st.confirmed {
				continue
			}
			broken := false
			for _, c := range h {
				if c.CloseTime >= st.confirmed && sign*(c.Close-st.price) > 0 {
					broken = true
					break
				}
			}
			if !broken && (result == nil || sign*(st.price-entry) < sign*(*result-entry)) {
				result = number(st.price)
				available = st.confirmed
			}
		}
	}
	return result, available
}

func pivotInfo(state structure.State, direction string) (v struct {
	price     float64
	confirmed int64
	crossed   bool
}) {
	p := state.High
	if direction == "bearish" {
		p = state.Low
	}
	if p != nil {
		v.price, v.confirmed, v.crossed = p.Price, p.ConfirmedAt, p.Crossed
	}
	return
}

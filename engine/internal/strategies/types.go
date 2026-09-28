// Package strategies describes causal, experimental opportunities independently
// of harmonic discovery. It never places orders or asserts an execution.
package strategies

import (
	"github.com/alihasan00/crypto/internal/scanner"
)

const Version = 1

const (
	SweepReversal          = "sweep_reversal"
	DivergenceReversal     = "divergence_reversal"
	DivergenceContinuation = "divergence_continuation"
	RangeRejection         = "range_rejection"
	CompressionBreakout    = "compression_breakout"
	FVGPullback            = "fvg_pullback"
	FibonacciPullback      = "fibonacci_pullback"
	KijunReclaim           = "kijun_reclaim"
	CloudReclaim           = "cloud_reclaim"
	TKCross                = "tk_cross"
	PKCross                = "pk_cross"
	CloudEdgeToEdge        = "cloud_edge_to_edge"
)

var Families = []string{SweepReversal, DivergenceReversal, DivergenceContinuation,
	RangeRejection, CompressionBreakout, FVGPullback, FibonacciPullback, KijunReclaim, CloudReclaim,
	TKCross, PKCross, CloudEdgeToEdge}

// Input contains only the symbol's completed histories and measured context.
// Map keys are intervals (1d,4h,1h,15m), not symbol/interval keys. The selection
// adapter additionally validates freshness and all four context timeframes.
type Input struct {
	Symbol    string
	Frames    map[string]scanner.SeriesSummary
	Histories map[string]scanner.History
}

// Opportunity owns frozen signal evidence. Stop/Target and entry bounds are
// chosen using only evidence available at TriggerAt, and never drift afterward.
// A new setup must receive a new ID. State is the current closed-candle state;
// readiness at a live quote is assessed separately by internal/selection.
type Opportunity struct {
	Version             int      `json:"version"`
	ID                  string   `json:"id"`
	ParentID            string   `json:"parentId"`
	Family              string   `json:"family"`
	Symbol              string   `json:"symbol"`
	Interval            string   `json:"interval"`
	Direction           string   `json:"direction"`
	State               string   `json:"state"`
	AvailableAt         int64    `json:"availableAt"`
	LocationAvailableAt int64    `json:"locationAvailableAt"`
	SourceStartAt       int64    `json:"sourceStartAt"`
	SourceEndAt         int64    `json:"sourceEndAt"`
	AsOf                int64    `json:"asOf"`
	TriggerAt           *int64   `json:"triggerAt"`
	RetestAt            *int64   `json:"retestAt"`
	ResolvedAt          *int64   `json:"resolvedAt"`
	ExpiresAt           *int64   `json:"expiresAt"`
	Level               float64  `json:"level"`
	ZoneLow             *float64 `json:"zoneLow"`
	ZoneHigh            *float64 `json:"zoneHigh"`
	Stop                *float64 `json:"stop"`
	Target              *float64 `json:"target"`
	EntryReference      *float64 `json:"entryReference"`
	ReferenceATR        *float64 `json:"referenceAtr"`
	EntryMin            *float64 `json:"entryMin"`
	EntryMax            *float64 `json:"entryMax"`
	Reason              string   `json:"reason"`
	Next                string   `json:"next"`
	Invalidation        string   `json:"invalidation"`
	Caution             string   `json:"caution"`
}

type Range struct {
	ID          string  `json:"id"`
	Interval    string  `json:"interval"`
	AvailableAt int64   `json:"availableAt"`
	StartAt     int64   `json:"startAt"`
	EndAt       int64   `json:"endAt"`
	Low         float64 `json:"low"`
	High        float64 `json:"high"`
	Midpoint    float64 `json:"midpoint"`
	State       string  `json:"state"`
}

type RelativeStrength struct {
	Benchmark            string   `json:"benchmark"`
	Interval             string   `json:"interval"`
	Status               string   `json:"status"`
	AsOf                 *int64   `json:"asOf"`
	AbsoluteReturn24h    *float64 `json:"absoluteReturn24h"`
	AbsoluteReturn7d     *float64 `json:"absoluteReturn7d"`
	RatioReturn24h       *float64 `json:"ratioReturn24h"`
	RatioReturn7d        *float64 `json:"ratioReturn7d"`
	RSI14                *float64 `json:"rsi14"`
	RSIChange3           *float64 `json:"rsiChange3"`
	Last50CrossAt        *int64   `json:"last50CrossAt"`
	Last50CrossDirection string   `json:"last50CrossDirection"`
}

type Context struct {
	Symbol           string             `json:"symbol"`
	Availability     string             `json:"availability"`
	AsOf             *int64             `json:"asOf"`
	DirectionalState string             `json:"directionalState"`
	VolatilityState  string             `json:"volatilityState"`
	Range            *Range             `json:"range"`
	Relative         []RelativeStrength `json:"relative"`
}

// These functions are implemented in separate family files. Analyze enumerates
// current and recently terminal opportunities, independent of display limits.
// ReversalOpportunities(Input) []Opportunity
// RangeOpportunities(Input) []Opportunity
// PullbackOpportunities(Input) []Opportunity
// Describe(Input) Context

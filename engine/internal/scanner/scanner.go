// Package scanner coordinates bounded market requests and harmonic analysis.
package scanner

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/regime"
	"github.com/alihasan00/crypto/internal/structure"
)

var ErrRunning = errors.New("a scan is already running")

type Request struct {
	Timeframes       []string `json:"timeframes"`
	Limit            int      `json:"limit"`
	MinScore         float64  `json:"minScore"`
	IncludePotential bool     `json:"includePotential"`
	Direction        string   `json:"direction"`
	Kinds            []string `json:"kinds"`
	IncludeEnded     bool     `json:"includeEnded"`
}

func DefaultRequest() Request {
	return Request{Timeframes: []string{"1d", "4h", "1h", "15m"}, Limit: 500, MinScore: 90, IncludePotential: true, Direction: "both", Kinds: []string{}}
}

func (r Request) Validate() error {
	if len(r.Timeframes) == 0 || len(r.Timeframes) > 6 {
		return errors.New("choose between one and six timeframes")
	}
	seen := map[string]bool{}
	for _, tf := range r.Timeframes {
		valid := false
		for _, allowed := range market.SupportedIntervals {
			valid = valid || tf == allowed
		}
		if !valid || seen[tf] {
			return fmt.Errorf("unsupported or duplicate timeframe: %s", tf)
		}
		seen[tf] = true
	}
	if r.Limit < 100 || r.Limit > 1000 {
		return errors.New("candle limit must be between 100 and 1000")
	}
	if math.IsNaN(r.MinScore) || math.IsInf(r.MinScore, 0) || r.MinScore < 0 || r.MinScore > 100 {
		return errors.New("minimum score must be between 0 and 100")
	}
	if r.Direction != "both" && r.Direction != "bullish" && r.Direction != "bearish" {
		return errors.New("direction must be both, bullish, or bearish")
	}
	seenKinds := map[string]bool{}
	for _, k := range r.Kinds {
		if seenKinds[k] {
			return fmt.Errorf("duplicate pattern family: %s", k)
		}
		seenKinds[k] = true
		switch k {
		case "gartley", "bat", "butterfly", "crab", "shark", "cypher":
		default:
			return fmt.Errorf("unknown pattern family: %s", k)
		}
	}
	return nil
}

type Row struct {
	Symbol         string           `json:"symbol"`
	Interval       string           `json:"interval"`
	Price          float64          `json:"price"`
	LastClosedAt   int64            `json:"lastClosedAt"`
	Pattern        harmonic.Pattern `json:"pattern"`
	DistancePct    float64          `json:"distancePct"`
	PriceSource    string           `json:"priceSource"`
	ObservedAt     time.Time        `json:"observedAt"`
	DataAgeSeconds float64          `json:"dataAgeSeconds"`
	Stale          bool             `json:"stale"`
	Warnings       []string         `json:"warnings"`
	Decision       Decision         `json:"decision"`
	Rank           Rank             `json:"rank"`
}

type SeriesSummary struct {
	Symbol         string         `json:"symbol"`
	Interval       string         `json:"interval"`
	ClosedCandles  int            `json:"closedCandles"`
	FirstOpenTime  int64          `json:"firstOpenTime"`
	LastClosedAt   int64          `json:"lastClosedAt"`
	Price          float64        `json:"price"`
	PriceSource    string         `json:"priceSource"`
	ObservedAt     time.Time      `json:"observedAt"`
	DataAgeSeconds float64        `json:"dataAgeSeconds"`
	Stale          bool           `json:"stale"`
	Warnings       []string       `json:"warnings"`
	Analysis       SeriesAnalysis `json:"analysis"`
}

// Evidence preserves provider observation time when candles come from storage.
// A cache read must never make an old quote appear freshly collected.
type Evidence struct {
	ObservedAt     time.Time
	DataAgeSeconds float64
	Stale          bool
	Warnings       []string
}

type EvidenceFeed interface {
	CandlesWithEvidence(context.Context, string, string, int) ([]market.Candle, *market.Candle, Evidence, error)
}

type ScanError struct {
	Symbol   string `json:"symbol"`
	Interval string `json:"interval"`
	Error    string `json:"error"`
}

type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

type Snapshot struct {
	// Internal policy provenance used to reconstruct causal target context.
	// The CLI exports the same settings in its analysisSettings envelope.
	AnalysisSettings AnalysisSettings `json:"-"`
	Running     bool            `json:"running"`
	StartedAt   *time.Time      `json:"startedAt"`
	FinishedAt  *time.Time      `json:"finishedAt"`
	Progress    Progress        `json:"progress"`
	SymbolCount int             `json:"symbolCount"`
	Rows        []Row           `json:"rows"`
	Errors      []ScanError     `json:"errors"`
	Config      Request         `json:"config"`
	Source      string          `json:"source"`
	Series      []SeriesSummary `json:"series"`
}

type History struct {
	Candles []market.Candle `json:"candles"`
	Preview *market.Candle  `json:"preview"`
}

type Feed interface {
	Candles(context.Context, string, string, int) ([]market.Candle, *market.Candle, error)
}

type Scanner struct {
	mu       sync.RWMutex
	feed     Feed
	symbols  []string
	source   string
	workers  int
	settings harmonic.Config
	analysis AnalysisSettings
	state    Snapshot
	history  map[string]History
}

func New(feed Feed, symbols []string, source string, workers int, cfg harmonic.Config) *Scanner {
	if workers < 1 {
		workers = 1
	}
	if workers > 12 {
		workers = 12
	}
	cfg.Types = append([]string{}, cfg.Types...)
	return &Scanner{feed: feed, symbols: append([]string(nil), symbols...), source: source, workers: workers, settings: cfg, analysis: DefaultAnalysisSettings(),
		history: make(map[string]History), state: Snapshot{SymbolCount: len(symbols), Rows: []Row{}, Errors: []ScanError{}, Series: []SeriesSummary{}, Config: DefaultRequest(), Source: source}}
}

func (s *Scanner) Symbols() []string { return append([]string(nil), s.symbols...) }
func (s *Scanner) Settings() harmonic.Config {
	cfg := s.settings
	cfg.Types = append([]string{}, cfg.Types...)
	return cfg
}

func copyFloat(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func clonePattern(p harmonic.Pattern) harmonic.Pattern {
	if p.D != nil {
		copy := *p.D
		p.D = &copy
	}
	if p.Ratios != nil {
		ratios := make(map[string]float64, len(p.Ratios))
		for key, value := range p.Ratios {
			ratios[key] = value
		}
		p.Ratios = ratios
	}
	p.EntryAfterC = copyFloat(p.EntryAfterC)
	p.EntryAfterD = copyFloat(p.EntryAfterD)
	p.EntryScore = copyFloat(p.EntryScore)
	p.ScoreComponents.DConfluence = copyFloat(p.ScoreComponents.DConfluence)
	return p
}

func cloneRequest(r Request) Request {
	r.Timeframes = append([]string{}, r.Timeframes...)
	r.Kinds = append([]string{}, r.Kinds...)
	return r
}

func (s *Scanner) Snapshot() Snapshot {
	s.mu.RLock()
	state := s.state
	if state.StartedAt != nil {
		value := *state.StartedAt
		state.StartedAt = &value
	}
	if state.FinishedAt != nil {
		value := *state.FinishedAt
		state.FinishedAt = &value
	}
	state.Rows = append([]Row{}, state.Rows...)
	for i := range state.Rows {
		state.Rows[i].Pattern = clonePattern(state.Rows[i].Pattern)
		state.Rows[i].Warnings = append([]string{}, state.Rows[i].Warnings...)
		state.Rows[i].Decision = cloneDecision(state.Rows[i].Decision)
		state.Rows[i].Rank.Evidence = append([]string{}, state.Rows[i].Rank.Evidence...)
	}
	state.Errors = append([]ScanError{}, state.Errors...)
	state.Config = cloneRequest(state.Config)
	state.Series = append([]SeriesSummary{}, state.Series...)
	for i := range state.Series {
		state.Series[i].Warnings = append([]string{}, state.Series[i].Warnings...)
		state.Series[i].Analysis = cloneAnalysis(state.Series[i].Analysis)
	}
	s.mu.RUnlock()
	sort.Slice(state.Rows, func(i, j int) bool { return rowLess(state.Rows[i], state.Rows[j]) })
	sort.Slice(state.Series, func(i, j int) bool {
		if state.Series[i].Symbol != state.Series[j].Symbol {
			return state.Series[i].Symbol < state.Series[j].Symbol
		}
		return state.Series[i].Interval < state.Series[j].Interval
	})
	sort.Slice(state.Errors, func(i, j int) bool {
		if state.Errors[i].Symbol != state.Errors[j].Symbol {
			return state.Errors[i].Symbol < state.Errors[j].Symbol
		}
		return state.Errors[i].Interval < state.Errors[j].Interval
	})
	return state
}

// Start allows only one scan at a time. Its context belongs to the application,
// rather than the POST request which ends before this background work does.
func (s *Scanner) Start(ctx context.Context, req Request) (<-chan struct{}, error) {
	if err := req.Validate(); err != nil {
		return nil, err
	}
	if err := s.settings.Validate(); err != nil {
		return nil, err
	}
	if err := s.AnalysisSettings().Validate(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	req = cloneRequest(req)
	s.mu.Lock()
	if s.state.Running {
		s.mu.Unlock()
		return nil, ErrRunning
	}
	now := time.Now().UTC()
	s.state = Snapshot{AnalysisSettings: s.analysis, Running: true, StartedAt: &now, Progress: Progress{Total: len(s.symbols) * len(req.Timeframes)},
		SymbolCount: len(s.symbols), Rows: []Row{}, Errors: []ScanError{}, Series: []SeriesSummary{}, Config: req, Source: s.source}
	// Keep only this run's histories, so rows can never chart an older scan.
	s.history = make(map[string]History)
	s.mu.Unlock()
	done := make(chan struct{})
	go func() { defer close(done); s.run(ctx, req) }()
	return done, nil
}

func (s *Scanner) run(ctx context.Context, req Request) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	defer func() {
		s.mu.Lock()
		s.state.Running = false
		now := time.Now().UTC()
		s.state.FinishedAt = &now
		s.mu.Unlock()
	}()
	type job struct{ symbol, interval string }
	jobs := make(chan job)
	var workers sync.WaitGroup
	cfg := s.settings
	cfg.MinScore = req.MinScore
	cfg.IncludePotential = req.IncludePotential
	cfg.Bullish = req.Direction != "bearish"
	cfg.Bearish = req.Direction != "bullish"
	if len(req.Kinds) > 0 {
		cfg.Types = append([]string(nil), req.Kinds...)
	}
	for i := 0; i < s.workers; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := range jobs {
				var closed []market.Candle
				var preview *market.Candle
				var err error
				evidence := Evidence{Warnings: []string{}}
				if provider, ok := s.feed.(EvidenceFeed); ok {
					closed, preview, evidence, err = provider.CandlesWithEvidence(ctx, j.symbol, j.interval, req.Limit)
				} else {
					closed, preview, err = s.feed.Candles(ctx, j.symbol, j.interval, req.Limit)
					evidence.ObservedAt = time.Now().UTC()
				}
				var rows []Row
				var summary SeriesSummary
				if err == nil && len(closed) == 0 {
					err = errors.New("no closed candles returned")
				}
				if err == nil {
					price := closed[len(closed)-1].Close
					priceSource := "closed_candle"
					if preview != nil {
						price = preview.Close
						priceSource = "provisional_candle"
					}
					observedAt := evidence.ObservedAt
					summary = SeriesSummary{Symbol: j.symbol, Interval: j.interval, ClosedCandles: len(closed), FirstOpenTime: closed[0].OpenTime, LastClosedAt: closed[len(closed)-1].CloseTime, Price: price, PriceSource: priceSource, ObservedAt: observedAt, DataAgeSeconds: evidence.DataAgeSeconds, Stale: evidence.Stale, Warnings: append([]string{}, evidence.Warnings...)}
					summary.Analysis = SeriesAnalysis{AsOf: closed[len(closed)-1].CloseTime, Regime: regime.Analyze(closed, s.analysis.Regime), Structure: structure.Analyze(closed, s.analysis.Structure), Volume: participation.Analyze(closed)}
					for _, p := range harmonic.Analyze(closed, cfg) {
						// Analyze applies score admission causally and retains its
						// frozen entry score even if later D geometry scores lower.
						if !req.IncludePotential && p.D == nil {
							continue
						}
						if !req.IncludeEnded && (p.Status == "completed" || p.Status == "invalidated" || p.Status == "expired") {
							continue
						}
						if req.Direction != "both" && string(p.Direction) != req.Direction {
							continue
						}
						if len(req.Kinds) > 0 && !contains(req.Kinds, string(p.Kind)) {
							continue
						}
						distance := math.Max(p.Zone.Low-price, math.Max(price-p.Zone.High, 0)) / price * 100
						rows = append(rows, Row{Symbol: j.symbol, Interval: j.interval, Price: price,
							LastClosedAt: closed[len(closed)-1].CloseTime, Pattern: p, DistancePct: distance, PriceSource: priceSource, ObservedAt: observedAt, DataAgeSeconds: evidence.DataAgeSeconds, Stale: evidence.Stale, Warnings: append([]string{}, evidence.Warnings...)})
					}
				}
				s.mu.Lock()
				s.state.Progress.Done++
				if err != nil {
					s.state.Errors = append(s.state.Errors, ScanError{j.symbol, j.interval, err.Error()})
				} else {
					s.state.Rows = append(s.state.Rows, rows...)
					s.state.Series = append(s.state.Series, summary)
					history := History{Candles: append([]market.Candle{}, closed...)}
					if preview != nil {
						copy := *preview
						history.Preview = &copy
					}
					s.history[j.symbol+"/"+j.interval] = history
				}
				s.mu.Unlock()
			}
		}()
	}
	// Canceled requests still produce explicit per-pair errors, never an apparently
	// successful empty result. The feed returns promptly on a canceled context.
	for _, symbol := range s.symbols {
		for _, interval := range req.Timeframes {
			jobs <- job{symbol, interval}
		}
	}
	close(jobs)
	workers.Wait()
	s.attachIndicatorEvidence()
	s.attachDecisions(req)
	s.attachRanks()
}

func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}

// History uses the exact scan evidence for charting. Unknown pairs do not cause
// extra Binance traffic and cannot be used to turn the server into an API proxy.
func (s *Scanner) History(symbol, interval string) (History, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	h, ok := s.history[strings.ToUpper(symbol)+"/"+interval]
	h.Candles = append([]market.Candle{}, h.Candles...)
	if h.Preview != nil {
		copy := *h.Preview
		h.Preview = &copy
	}
	return h, ok
}

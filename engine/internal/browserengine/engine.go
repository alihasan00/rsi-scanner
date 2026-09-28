// Package browserengine supplies validated browser candle snapshots to the
// Go scanner and selector, including the local Ichimoku lecture extension.
// It does not implement indicator or strategy
// rules, fetch data, persist account state, or execute trades.
package browserengine

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/alihasan00/crypto/internal/harmonic"
	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/selection"
)

const (
	Version = "0.13.1-26e07587190d+ichimoku.2"
	// SourceHash identifies the upstream archive; local source hashes and the
	// extension revision are recorded separately in provenance.json.
	SourceHash = "26e07587190d24c66d62602e968ef24dafafb281b9b1a0140afa7f6c6d0a0d00"
	// This is the deployed CLI's --max-age default, not a new screen.
	MaxAge         = 2 * time.Minute
	maxSafeInteger = int64(1<<53 - 1)
)

type InputHistory struct {
	Symbol     string          `json:"symbol"`
	Timeframe  string          `json:"timeframe"`
	Candles    []market.Candle `json:"candles"`
	Preview    *market.Candle  `json:"preview"`
	ReceivedAt int64           `json:"receivedAt"`
	Status     string          `json:"status"`
	Error      *string         `json:"error"`
}

type Request struct {
	Now       int64          `json:"now"`
	Scope     string         `json:"scope"`
	Symbols   []string       `json:"symbols"`
	Histories []InputHistory `json:"histories"`
}

// Series is deliberately compact. Exact selected-candidate evidence and plans
// are retained in Result; unrelated full indicator inventories are not copied
// out of the WebAssembly heap on each publication.
type Series struct {
	Symbol         string                    `json:"symbol"`
	Interval       string                    `json:"interval"`
	Price          float64                   `json:"price"`
	PriceSource    string                    `json:"priceSource"`
	ObservedAt     int64                     `json:"observedAt"`
	LastClosedAt   int64                     `json:"lastClosedAt"`
	ClosedCandles  int                       `json:"closedCandles"`
	Ready          bool                      `json:"ready"`
	Trend          string                    `json:"trend"`
	Momentum       string                    `json:"momentum"`
	InternalBias   string                    `json:"internalBias"`
	Warnings       []string                  `json:"warnings"`
	Ichimoku       *ichimoku.LectureSnapshot `json:"ichimoku,omitempty"`
	IchimokuSeries []ichimoku.Point          `json:"ichimokuSeries,omitempty"`
}

type Scan struct {
	Series   []Series            `json:"series"`
	Errors   []scanner.ScanError `json:"errors"`
	Progress scanner.Progress    `json:"progress"`
}

type Response struct {
	Version    string            `json:"version"`
	Scope      string            `json:"scope"`
	SourceHash string            `json:"sourceHash"`
	Now        int64             `json:"now"`
	MaxAgeMS   int64             `json:"maxAgeMs"`
	Result     *selection.Result `json:"result,omitempty"`
	Scan       Scan              `json:"scan"`
	Error      string            `json:"error,omitempty"`
}

type memoryFeed struct {
	now       time.Time
	histories map[string]InputHistory
}

func (f memoryFeed) Candles(ctx context.Context, symbol, timeframe string, limit int) ([]market.Candle, *market.Candle, error) {
	closed, preview, _, err := f.CandlesWithEvidence(ctx, symbol, timeframe, limit)
	return closed, preview, err
}

// EvidenceFeed is essential: Scanner's plain Feed fallback timestamps a read
// as now. Browser history retains the actual successful provider receipt.
func (f memoryFeed) CandlesWithEvidence(ctx context.Context, symbol, timeframe string, limit int) ([]market.Candle, *market.Candle, scanner.Evidence, error) {
	evidence := scanner.Evidence{Warnings: []string{}}
	if err := ctx.Err(); err != nil {
		return nil, nil, evidence, err
	}
	history, ok := f.histories[symbol+"/"+timeframe]
	if !ok {
		return nil, nil, evidence, errors.New("Required timeframe history is unavailable.")
	}
	if history.Status != "ready" {
		message := "Market history request failed."
		if history.Error != nil && *history.Error != "" {
			message = *history.Error
		}
		return nil, nil, evidence, errors.New(message)
	}
	if history.Error != nil && *history.Error != "" {
		return nil, nil, evidence, errors.New(*history.Error)
	}
	if history.ReceivedAt <= 0 || history.ReceivedAt > maxSafeInteger {
		return nil, nil, evidence, errors.New("Market history has no valid receipt time.")
	}
	evidence.ObservedAt = time.UnixMilli(history.ReceivedAt).UTC()
	if evidence.ObservedAt.After(f.now.Add(market.BoundaryGrace)) {
		return nil, nil, evidence, errors.New("Market history receipt is in the future.")
	}
	if len(history.Candles) == 0 || len(history.Candles) > limit {
		return nil, nil, evidence, fmt.Errorf("Expected between 1 and %d completed candles.", limit)
	}
	for i, candle := range history.Candles {
		if err := market.ValidateInterval(candle, timeframe); err != nil {
			return nil, nil, evidence, fmt.Errorf("Completed candle %d: %w", i, err)
		}
		// A falsely finalized bar cannot enter the completed-candle analyzers.
		if candle.CloseTime > f.now.UnixMilli() {
			return nil, nil, evidence, fmt.Errorf("Completed candle %d ends in the future.", i)
		}
		if i > 0 && candle.OpenTime != history.Candles[i-1].CloseTime+1 {
			return nil, nil, evidence, fmt.Errorf("Completed candle %d has a gap, overlap or duplicate.", i)
		}
	}
	last := history.Candles[len(history.Candles)-1]
	if history.Preview != nil {
		if err := market.ValidateInterval(*history.Preview, timeframe); err != nil {
			return nil, nil, evidence, fmt.Errorf("Provisional candle: %w", err)
		}
		if history.Preview.OpenTime != last.CloseTime+1 || history.Preview.OpenTime > f.now.Add(market.BoundaryGrace).UnixMilli() {
			return nil, nil, evidence, errors.New("Provisional candle must immediately follow completed history and have started.")
		}
	}
	age := f.now.Sub(evidence.ObservedAt)
	if age < 0 {
		age = 0
	}
	evidence.DataAgeSeconds = age.Seconds()
	if age > MaxAge {
		return nil, nil, evidence, errors.New("Market history receipt is older than the two-minute freshness limit.")
	}
	expected, valid := market.ExpectedClosedTime(f.now, timeframe, last.OpenTime, market.BoundaryGrace)
	if !valid || last.CloseTime < expected {
		return nil, nil, evidence, errors.New("The latest completed candle is missing; a recent receipt cannot repair a gap.")
	}
	return append([]market.Candle(nil), history.Candles...), history.Preview, evidence, nil
}

func validateRequest(input Request) (memoryFeed, error) {
	feed := memoryFeed{now: time.UnixMilli(input.Now).UTC(), histories: map[string]InputHistory{}}
	if _, valid := requestScope(input.Scope); !valid {
		return feed, errors.New("Scope must be all or ichimoku.")
	}
	if input.Now <= 0 || input.Now > maxSafeInteger {
		return feed, errors.New("A valid current timestamp is required.")
	}
	if len(input.Symbols) == 0 || len(input.Symbols) > 1000 {
		return feed, errors.New("Supply between 1 and 1000 instruments.")
	}
	symbols := map[string]bool{}
	for _, symbol := range input.Symbols {
		if symbol == "" || symbol != strings.TrimSpace(symbol) || strings.Contains(symbol, "/") || symbols[symbol] {
			return feed, errors.New("Instrument symbols must be nonempty, unambiguous and unique.")
		}
		symbols[symbol] = true
	}
	if len(input.Histories) > len(input.Symbols)*4 {
		return feed, errors.New("A maximum of four histories per instrument is supported.")
	}
	for _, history := range input.Histories {
		if !symbols[history.Symbol] {
			return feed, errors.New("History does not belong to a requested instrument.")
		}
		switch history.Timeframe {
		case "1d", "4h", "1h", "15m":
		default:
			return feed, errors.New("The shared engine requires 1d, 4h, 1h and 15m histories.")
		}
		key := history.Symbol + "/" + history.Timeframe
		if _, found := feed.histories[key]; found {
			return feed, errors.New("Duplicate instrument/timeframe history.")
		}
		feed.histories[key] = history
	}
	return feed, nil
}

// Empty scope preserves callers of the original mixed-watchlist contract.
// Error responses retain a supported scope even for an unknown requested value.
func requestScope(scope string) (string, bool) {
	switch scope {
	case "", "all":
		return "all", true
	case "ichimoku":
		return "ichimoku", true
	default:
		return "all", false
	}
}

func Run(input Request) Response {
	scope, _ := requestScope(input.Scope)
	response := Response{Version: Version, Scope: scope, SourceHash: SourceHash, Now: input.Now, MaxAgeMS: MaxAge.Milliseconds(), Scan: Scan{Series: []Series{}, Errors: []scanner.ScanError{}}}
	feed, err := validateRequest(input)
	if err != nil {
		response.Error = err.Error()
		return response
	}
	engine := scanner.New(feed, input.Symbols, "Browser supplied Binance OHLCV", 1, harmonic.DefaultConfig())
	done, err := engine.Start(context.Background(), scanner.DefaultRequest())
	if err != nil {
		response.Error = err.Error()
		return response
	}
	<-done
	snapshot := engine.Snapshot()
	histories := map[string]scanner.History{}
	for _, symbol := range input.Symbols {
		for _, timeframe := range scanner.DefaultRequest().Timeframes {
			if history, ok := engine.History(symbol, timeframe); ok {
				histories[symbol+"/"+timeframe] = history
			}
		}
	}
	var result selection.Result
	if scope == "ichimoku" {
		result = selection.BuildIchimoku(snapshot, histories, input.Symbols, feed.now, MaxAge, selection.DefaultConfig())
	} else {
		result = selection.Build(snapshot, histories, input.Symbols, feed.now, MaxAge, selection.DefaultConfig())
	}
	response.Result = &result
	response.Scan.Errors = snapshot.Errors
	response.Scan.Progress = snapshot.Progress
	// Full chart paths only leave the worker for selected assets. The compact
	// readings remain available on all valid frames; neither can promote a
	// rejected observation into the selector's result.
	selected := make(map[string]bool)
	for _, candidate := range result.Items {
		selected[candidate.Setup.Symbol] = true
	}
	for _, candidate := range result.Trends {
		selected[candidate.Symbol] = true
	}
	for _, candidate := range result.Strategies.Items {
		selected[candidate.Opportunity.Symbol] = true
	}
	for _, frame := range snapshot.Series {
		series := Series{
			Symbol: frame.Symbol, Interval: frame.Interval, Price: frame.Price, PriceSource: frame.PriceSource,
			ObservedAt: frame.ObservedAt.UnixMilli(), LastClosedAt: frame.LastClosedAt, ClosedCandles: frame.ClosedCandles,
			Ready: selection.SeriesReady(frame, feed.now, MaxAge), Trend: frame.Analysis.Regime.Direction,
			Momentum: frame.Analysis.Regime.Momentum.Direction, InternalBias: frame.Analysis.Structure.Internal.Bias, Warnings: frame.Warnings,
		}
		if history, ok := histories[frame.Symbol+"/"+frame.Interval]; ok && series.Ready {
			// History is scanner-owned completed input. Preview is deliberately
			// excluded, including when it provides the evaluated live quote.
			context := ichimoku.AnalyzeLecture(history.Candles, frame.Analysis.Regime.Volatility.ATR)
			series.Ichimoku = &context
			if selected[frame.Symbol] {
				series.IchimokuSeries = ichimoku.Series(history.Candles)
			}
		}
		response.Scan.Series = append(response.Scan.Series, series)
	}
	return response
}

func RunJSON(raw string) (encoded string) {
	scope := "all"
	defer func() {
		if recovered := recover(); recovered != nil {
			body, _ := json.Marshal(Response{Version: Version, Scope: scope, SourceHash: SourceHash, MaxAgeMS: MaxAge.Milliseconds(), Error: "The shared engine could not process this snapshot."})
			encoded = string(body)
		}
	}()
	var input Request
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		body, _ := json.Marshal(Response{Version: Version, Scope: scope, SourceHash: SourceHash, MaxAgeMS: MaxAge.Milliseconds(), Error: "Invalid shared-engine request: " + err.Error()})
		return string(body)
	}
	scope, _ = requestScope(input.Scope)
	body, err := json.Marshal(Run(input))
	if err != nil {
		body, _ = json.Marshal(Response{Version: Version, Scope: scope, SourceHash: SourceHash, MaxAgeMS: MaxAge.Milliseconds(), Error: "The shared engine could not serialize this snapshot."})
	}
	return string(body)
}

package selection

import (
	"time"

	"github.com/alihasan00/crypto/internal/market"
	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

// IchimokuSeriesReady validates a published source against its exact
// completed history. Unrelated regime or structure warmup never withholds a
// valid Ichimoku source; each method has its own minimum lookback.
func IchimokuSeriesReady(s scanner.SeriesSummary, h scanner.History, now time.Time, maxAge time.Duration) bool {
	if !strategies.IchimokuTimeframeSupported(s.Interval) || maxAge <= 0 || s.Stale || s.Symbol == "" ||
		s.ObservedAt.IsZero() || s.ObservedAt.After(now.Add(market.BoundaryGrace)) || now.Sub(s.ObservedAt) > maxAge ||
		!positive(s.Price) || len(h.Candles) == 0 || s.LastClosedAt > now.UnixMilli() ||
		s.ObservedAt.UnixMilli() < s.LastClosedAt || h.Candles[len(h.Candles)-1].CloseTime != s.LastClosedAt {
		return false
	}
	if s.Analysis.AsOf != 0 && s.Analysis.AsOf != s.LastClosedAt ||
		s.ClosedCandles != 0 && s.ClosedCandles != len(h.Candles) ||
		s.FirstOpenTime != 0 && s.FirstOpenTime != h.Candles[0].OpenTime {
		return false
	}
	for i, candle := range h.Candles {
		if market.ValidateInterval(candle, s.Interval) != nil || i > 0 && candle.OpenTime != h.Candles[i-1].CloseTime+1 {
			return false
		}
	}
	expected, valid := market.ExpectedClosedTime(now, s.Interval, h.Candles[0].OpenTime, market.BoundaryGrace)
	return valid && s.LastClosedAt >= expected
}

// BuildIchimokuTimeframe publishes every active observation on one selected
// chart timeframe. Discovery, entry validation and subsequent stop/target
// lifecycle use only that source's own completed candles. Other periods never
// gate the dedicated view. Build and BuildIchimoku retain their original
// mixed/four-frame behavior.
func BuildIchimokuTimeframe(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, timeframe string, configs ...Config) Result {
	cfg := selectedConfig(configs)
	methods := buildIchimokuTimeframeStrategies(snapshot, histories, symbols, now, maxAge, timeframe, cfg, nil)
	out := Result{Config: cfg, Strategies: methods, Items: []Candidate{}, Trends: []TrendWatch{},
		Benchmarks: []Benchmark{}, Breadth: []Breadth{}, Limit: 0}
	for _, summary := range methods.Summary {
		out.Examined += summary.Observed
		out.Eligible += summary.Eligible
	}
	for _, item := range methods.Items {
		if item.Status == "cost_blocked" {
			out.CostFiltered++
		}
	}
	return out
}

func ichimokuTimeframeInput(snapshot scanner.Snapshot, histories map[string]scanner.History, symbol, timeframe string, now time.Time, maxAge time.Duration) (strategies.Input, bool) {
	in := strategies.Input{Symbol: symbol, Frames: map[string]scanner.SeriesSummary{}, Histories: map[string]scanner.History{}}
	if !strategies.IchimokuTimeframeSupported(timeframe) {
		return in, false
	}
	blocked := false
	for _, frame := range snapshot.Series {
		if frame.Symbol != symbol || frame.Interval != timeframe {
			continue
		}
		if _, duplicate := in.Frames[frame.Interval]; duplicate {
			blocked = true
		}
		in.Frames[frame.Interval] = frame
	}
	for _, err := range snapshot.Errors {
		if err.Symbol == symbol && err.Interval == timeframe {
			blocked = true
		}
	}
	history := histories[pair(symbol, timeframe)]
	in.Histories[timeframe] = history
	frame, present := in.Frames[timeframe]
	return in, !snapshot.Running && !blocked && present && IchimokuSeriesReady(frame, history, now, maxAge)
}

func buildIchimokuTimeframeStrategies(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, timeframe string, cfg Config, prepared *Prepared) StrategyResult {
	out := StrategyResult{Version: strategies.Version, Experimental: true, Items: []StrategyCandidate{},
		Summary: []StrategySummary{}, Contexts: []strategies.Context{}, Coverage: []StrategyCoverage{}, Unavailable: []string{}, Limit: 0}
	index := map[string]int{}
	for _, family := range ichimokuFamilies {
		index[family] = len(out.Summary)
		out.Summary = append(out.Summary, StrategySummary{Family: family})
	}
	seen := map[string]bool{}
	for _, symbol := range symbols {
		if seen[symbol] {
			continue
		}
		seen[symbol] = true
		in, sourceReady := ichimokuTimeframeInput(snapshot, histories, symbol, timeframe, now, maxAge)
		context := strategies.Context{Symbol: symbol, Availability: "unavailable", DirectionalState: "unavailable", VolatilityState: "unavailable", Relative: []strategies.RelativeStrength{}}
		if sourceReady {
			at := in.Frames[timeframe].LastClosedAt
			context.Availability, context.AsOf = "ready", &at
		} else {
			out.Unavailable = append(out.Unavailable, symbol)
		}
		out.Contexts = append(out.Contexts, context)
		for _, family := range ichimokuFamilies {
			_, warmup := strategyRequirements(family)
			coverage := StrategyCoverage{Symbol: symbol, Family: family, Interval: timeframe, Status: "data_unavailable", HistoryBars: len(in.Histories[timeframe].Candles)}
			if sourceReady {
				at := in.Frames[timeframe].LastClosedAt
				coverage.AsOf, coverage.Status = &at, "ready"
				if coverage.HistoryBars < warmup {
					coverage.Status = "insufficient"
				}
			}
			if coverage.Status != "ready" {
				out.Summary[index[family]].Unavailable++
			}
			out.Coverage = append(out.Coverage, coverage)
		}
		if !sourceReady {
			continue
		}
		var opportunities []strategies.Opportunity
		var found bool
		if prepared != nil {
			opportunities, found = prepared.opportunities[symbol]
		}
		if !found {
			opportunities = strategies.IchimokuTimeframeOpportunities(in, timeframe)
		}
		for _, opportunity := range opportunities {
			familyIndex, allowed := index[opportunity.Family]
			if !allowed || opportunity.Interval != timeframe || opportunity.Symbol != symbol {
				continue
			}
			candidate := assessStrategyOnFrame(opportunity, in, now, cfg, timeframe, true)
			summary := &out.Summary[familyIndex]
			summary.Observed++
			if candidate.Opportunity.State == "entry_confirmed" {
				summary.Confirmed++
			}
			if candidate.Eligible {
				summary.Eligible++
			}
			out.Items = append(out.Items, candidate)
		}
	}
	return finishStrategySelection(out, ichimokuFamilies, true, 0)
}

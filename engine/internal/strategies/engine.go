package strategies

import "sort"

// Analyze enumerates family observations before any display bound. All four
// completed histories must agree with their published frame timestamps. Empty
// results do not imply complete coverage; the selection adapter publishes the
// accompanying availability and observation-window metadata.
func Analyze(in Input) []Opportunity {
	for _, interval := range []string{"1d", "4h", "1h", "15m"} {
		if _, ok := strategyCandles(in, interval); !ok {
			return []Opportunity{}
		}
		if in.Frames[interval].LastClosedAt > in.Frames["15m"].LastClosedAt {
			return []Opportunity{}
		}
	}
	out := ReversalOpportunities(in)
	out = append(out, RangeOpportunities(in)...)
	out = append(out, PullbackOpportunities(in)...)
	out = append(out, IchimokuOpportunities(in)...)
	sort.Slice(out, func(i, j int) bool {
		if out[i].AvailableAt != out[j].AvailableAt {
			return out[i].AvailableAt > out[j].AvailableAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

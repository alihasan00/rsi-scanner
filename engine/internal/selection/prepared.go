package selection

import (
	"time"

	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

// Prepared owns discovery for one immutable publication. It must never be
// reused with different histories: corrected candles create a new publication
// even when the latest close timestamp is unchanged. Current eligibility is
// deliberately re-evaluated on every Build call.
type Prepared struct {
	snapshot      scanner.Snapshot
	histories     map[string]scanner.History
	opportunities map[string][]strategies.Opportunity
	contexts      map[string]strategies.Context
}

func Prepare(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration) *Prepared {
	p := &Prepared{snapshot: snapshot, histories: histories, opportunities: map[string][]strategies.Opportunity{}, contexts: map[string]strategies.Context{}}
	for _, symbol := range symbols {
		if _, found := p.opportunities[symbol]; found {
			continue
		}
		if in, ready := strategyInput(snapshot, histories, symbol, now, maxAge); ready {
			p.opportunities[symbol] = strategies.Analyze(in)
			p.contexts[symbol] = strategies.Describe(in)
		}
	}
	return p
}

// Build uses 0 for unlimited evidence and a positive limit for displayed rows.
// Freshness, expiry, current quote and supplied account/cost settings are never
// cached in a discovery result.
func (p *Prepared) Build(symbols []string, now time.Time, maxAge time.Duration, limit int, cfg Config) Result {
	return build(p.snapshot, p.histories, symbols, now, maxAge, limit, cfg, p)
}

func clonePointer[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneOpportunity(o strategies.Opportunity) strategies.Opportunity {
	o.TriggerAt = clonePointer(o.TriggerAt)
	o.RetestAt = clonePointer(o.RetestAt)
	o.ResolvedAt = clonePointer(o.ResolvedAt)
	o.ExpiresAt = clonePointer(o.ExpiresAt)
	o.ZoneLow = clonePointer(o.ZoneLow)
	o.ZoneHigh = clonePointer(o.ZoneHigh)
	o.Stop = clonePointer(o.Stop)
	o.Target = clonePointer(o.Target)
	o.EntryReference = clonePointer(o.EntryReference)
	o.ReferenceATR = clonePointer(o.ReferenceATR)
	o.EntryMin = clonePointer(o.EntryMin)
	o.EntryMax = clonePointer(o.EntryMax)
	return o
}

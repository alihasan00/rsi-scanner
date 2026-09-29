package selection

import (
	"time"

	"github.com/alihasan00/crypto/internal/scanner"
	"github.com/alihasan00/crypto/internal/strategies"
)

// BuildWatchlist limits setup origins to 1h, 4h and 1d before the existing
// source caps. Discovery and eligibility still use all four histories, including
// 15m confirmation, current-price and stop/target evidence.
func BuildWatchlist(snapshot scanner.Snapshot, histories map[string]scanner.History, symbols []string, now time.Time, maxAge time.Duration, configs ...Config) Result {
	prepared := watchlistPrepared(Prepare(snapshot, histories, symbols, now, maxAge))
	return prepared.Build(symbols, now, maxAge, watchlistLimit, selectedConfig(configs))
}

func watchlistSetupTimeframe(interval string) bool {
	return interval == "1h" || interval == "4h" || interval == "1d"
}

// Copy only candidate inventories. The immutable publication, its full series
// and histories remain available to the original scanner and selector checks.
func watchlistPrepared(source *Prepared) *Prepared {
	prepared := *source
	prepared.snapshot.Rows = make([]scanner.Row, 0, len(source.snapshot.Rows))
	for _, row := range source.snapshot.Rows {
		if watchlistSetupTimeframe(row.Interval) {
			prepared.snapshot.Rows = append(prepared.snapshot.Rows, row)
		}
	}
	prepared.opportunities = make(map[string][]strategies.Opportunity, len(source.opportunities))
	for symbol, opportunities := range source.opportunities {
		selected := make([]strategies.Opportunity, 0, len(opportunities))
		for _, opportunity := range opportunities {
			if watchlistSetupTimeframe(opportunity.Interval) {
				selected = append(selected, opportunity)
			}
		}
		prepared.opportunities[symbol] = selected
	}
	return &prepared
}

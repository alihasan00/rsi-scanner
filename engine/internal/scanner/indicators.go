package scanner

import (
	"github.com/alihasan00/crypto/internal/calendarlevels"
	"github.com/alihasan00/crypto/internal/fairvaluegaps"
	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/momentum"
	"github.com/alihasan00/crypto/internal/swingfailure"
	"github.com/alihasan00/crypto/internal/technical"
	"github.com/alihasan00/crypto/internal/volumeresponse"
)

// Supplemental evidence never changes admission, direction or trade-plan gates.
// All computations use the exact histories already collected for this scan.
func (s *Scanner) attachIndicatorEvidence() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Series {
		series := &s.state.Series[i]
		bars := s.history[series.Symbol+"/"+series.Interval].Candles
		series.Analysis.Oscillator = momentum.Analyze(bars)
		series.Analysis.Technical = technical.Analyze(bars)
		series.Analysis.Calendar = calendarlevels.Analyze(s.history[series.Symbol+"/1d"].Candles, bars, series.LastClosedAt+1)
		series.Analysis.SwingFailure = swingfailure.Analyze(bars)
		series.Analysis.VolumeResponse = volumeresponse.Analyze(bars)
		series.Analysis.FairValueGaps = fairvaluegaps.Analyze(bars)
		series.Analysis.Ichimoku = nil
		if series.Interval == "4h" || series.Interval == "1h" {
			context := ichimoku.Analyze(bars, series.Analysis.Regime.Volatility.ATR)
			series.Analysis.Ichimoku = &context
		}
	}
}

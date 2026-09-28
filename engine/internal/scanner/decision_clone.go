package scanner

import (
	"github.com/alihasan00/crypto/internal/calendarlevels"
	"github.com/alihasan00/crypto/internal/fairvaluegaps"
	"github.com/alihasan00/crypto/internal/ichimoku"
	"github.com/alihasan00/crypto/internal/momentum"
	"github.com/alihasan00/crypto/internal/participation"
	"github.com/alihasan00/crypto/internal/structure"
	"github.com/alihasan00/crypto/internal/swingfailure"
	"github.com/alihasan00/crypto/internal/technical"
	"github.com/alihasan00/crypto/internal/volumeresponse"
)

func clonePointer[T any](p *T) *T {
	if p == nil {
		return nil
	}
	v := *p
	return &v
}

func cloneStructureState(s structure.State) structure.State {
	s.High = clonePointer(s.High)
	s.Low = clonePointer(s.Low)
	s.LastBreak = clonePointer(s.LastBreak)
	return s
}

func cloneAnalysis(a SeriesAnalysis) SeriesAnalysis {
	r := &a.Regime
	r.ClosedAt = clonePointer(r.ClosedAt)
	r.Warnings = append([]string{}, r.Warnings...)
	r.Supertrend.ATR = copyFloat(r.Supertrend.ATR)
	r.Supertrend.Stop = copyFloat(r.Supertrend.Stop)
	r.Supertrend.Factor = copyFloat(r.Supertrend.Factor)
	r.Supertrend.PerformanceIndex = copyFloat(r.Supertrend.PerformanceIndex)
	r.Supertrend.LastFlipAt = clonePointer(r.Supertrend.LastFlipAt)
	r.Supertrend.BarsSinceFlip = clonePointer(r.Supertrend.BarsSinceFlip)
	r.Volatility.ATR = copyFloat(r.Volatility.ATR)
	r.Volatility.ATRPercent = copyFloat(r.Volatility.ATRPercent)
	r.Momentum.ADX = copyFloat(r.Momentum.ADX)
	r.Momentum.DIPlus = copyFloat(r.Momentum.DIPlus)
	r.Momentum.DIMinus = copyFloat(r.Momentum.DIMinus)
	a.Structure.Internal = cloneStructureState(a.Structure.Internal)
	a.Structure.Swing = cloneStructureState(a.Structure.Swing)
	a.Volume = participation.CloneSnapshot(a.Volume)
	a.Oscillator = momentum.CloneSnapshot(a.Oscillator)
	a.Technical = technical.CloneSnapshot(a.Technical)
	a.Calendar = calendarlevels.CloneSnapshot(a.Calendar)
	a.SwingFailure = swingfailure.CloneSnapshot(a.SwingFailure)
	a.VolumeResponse = volumeresponse.CloneSnapshot(a.VolumeResponse)
	a.FairValueGaps = fairvaluegaps.CloneSnapshot(a.FairValueGaps)
	if a.Ichimoku != nil {
		context := ichimoku.CloneSnapshot(*a.Ichimoku)
		a.Ichimoku = &context
	}
	return a
}

// CloneSeriesAnalysis gives downstream publishers independent ownership of all
// analysis fields, including nullable supplemental indicator observations.
// Unlike the scanner's output normalizer, it preserves an input's nil slices.
func CloneSeriesAnalysis(a SeriesAnalysis) SeriesAnalysis {
	cloned := cloneAnalysis(a)
	cloned.Regime.Warnings = preserveNil(a.Regime.Warnings, cloned.Regime.Warnings)
	cloned.Oscillator.Warnings = preserveNil(a.Oscillator.Warnings, cloned.Oscillator.Warnings)
	cloned.Oscillator.Divergences = preserveNil(a.Oscillator.Divergences, cloned.Oscillator.Divergences)
	cloned.Calendar.Sources = preserveNil(a.Calendar.Sources, cloned.Calendar.Sources)
	cloned.Calendar.Levels = preserveNil(a.Calendar.Levels, cloned.Calendar.Levels)
	cloned.Calendar.Events = preserveNil(a.Calendar.Events, cloned.Calendar.Events)
	cloned.SwingFailure.Warnings = preserveNil(a.SwingFailure.Warnings, cloned.SwingFailure.Warnings)
	cloned.SwingFailure.Events = preserveNil(a.SwingFailure.Events, cloned.SwingFailure.Events)
	cloned.FairValueGaps.Warnings = preserveNil(a.FairValueGaps.Warnings, cloned.FairValueGaps.Warnings)
	cloned.FairValueGaps.Gaps = preserveNil(a.FairValueGaps.Gaps, cloned.FairValueGaps.Gaps)
	return cloned
}

func preserveNil[T any](source, cloned []T) []T {
	if source == nil {
		return nil
	}
	return cloned
}

func cloneDecision(d Decision) Decision {
	d.Timeframes = append([]TimeframeContext{}, d.Timeframes...)
	for i := range d.Timeframes {
		d.Timeframes[i].LastClosedAt = clonePointer(d.Timeframes[i].LastClosedAt)
		d.Timeframes[i].ADX = copyFloat(d.Timeframes[i].ADX)
	}
	d.Reasons = append([]DecisionReason{}, d.Reasons...)
	d.Confirmation.Event = clonePointer(d.Confirmation.Event)
	d.Confirmation.BarsAgo = clonePointer(d.Confirmation.BarsAgo)
	d.Confirmation.ExpiresAt = clonePointer(d.Confirmation.ExpiresAt)
	d.Risk.ATR = copyFloat(d.Risk.ATR)
	d.Risk.EntryStopDistanceATR = copyFloat(d.Risk.EntryStopDistanceATR)
	d.Risk.PriceStopDistanceATR = copyFloat(d.Risk.PriceStopDistanceATR)
	d.Risk.RewardRisk1 = copyFloat(d.Risk.RewardRisk1)
	d.Risk.RewardRisk2 = copyFloat(d.Risk.RewardRisk2)
	d.Risk.NearestOpposingLevel = clonePointer(d.Risk.NearestOpposingLevel)
	return d
}

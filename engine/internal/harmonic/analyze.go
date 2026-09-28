// Inspired by harmonic.pine, © reees, licensed under MPL-2.0.
// This file is distributed under the Mozilla Public License 2.0.
package harmonic

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/alihasan00/crypto/internal/market"
)

type swing struct {
	point Point
	high  bool
}

type tracked struct {
	p              Pattern
	d              definition
	created        int
	referenceAt    int
	entryAt        int
	cEntryEligible bool
}

// Analyze returns a deterministic snapshot, including ended setups. Callers
// may exclude completed/invalidated/expired states for an actionable screen.
// It requires ascending, valid, CLOSED OHLC candles; the market adapter removes
// the live candle. Invalid input or config returns an empty result. It never
// mutates candles/config and never consults wall-clock time or external data.
//
// Each strength maintains an alternating pivot sequence, replacing consecutive
// same-side pivots only with a more extreme point. Patterns sharing XABC/type/
// direction are deduplicated. A more extreme confirmed D may revise a live
// pattern if its score improves; ended patterns are never resurrected. Prices
// on a detection or reference-revision bar cannot trigger a newly known level.
func Analyze(candles []market.Candle, cfg Config) []Pattern {
	result := make([]Pattern, 0)
	if cfg.Validate() != nil || !validCandles(candles) {
		return result
	}
	types := make([]string, len(cfg.Types))
	for i, kind := range cfg.Types {
		types[i] = strings.ToLower(strings.TrimSpace(kind))
	}
	sequences := make(map[int][]swing)
	seen := make(map[string]bool)
	states := make([]*tracked, 0)
	for i := range candles {
		j := i - cfg.ConfirmationBars
		for strength := cfg.PivotMin; strength <= cfg.PivotMax; strength++ {
			low, high := pivot(candles, j, strength, cfg.ConfirmationBars)
			// An outside/flat bar may be both: its intrabar swing order is unknown.
			if low == high {
				continue
			}
			price := candles[j].Low
			if high {
				price = candles[j].High
			}
			next := swing{point: Point{Index: j, Time: candles[j].OpenTime, Price: price}, high: high}
			seq := sequences[strength]
			if len(seq) > 0 && seq[len(seq)-1].high == high {
				last := seq[len(seq)-1].point.Price
				if (high && price <= last) || (!high && price >= last) {
					continue
				}
				seq[len(seq)-1] = next
			} else {
				seq = append(seq, next)
			}
			if len(seq) > 4 {
				seq = append([]swing(nil), seq[len(seq)-4:]...)
			}
			sequences[strength] = seq
			if len(seq) < 4 {
				continue
			}
			bull := !seq[0].high
			if (bull && !cfg.Bullish) || (!bull && !cfg.Bearish) {
				continue
			}
			for _, kind := range types {
				state := newCandidate(candles, i, seq, definitions[kind], cfg)
				if state == nil || seen[state.p.ID] {
					continue
				}
				seen[state.p.ID] = true
				for _, old := range states {
					if old.p.Status == "pending" && old.p.D == nil && sameXAB(old.p, state.p) && old.p.C.Index != state.p.C.Index {
						finish(old, "invalidated", "superseded by a later C pivot", candles[i].CloseTime)
					}
				}
				states = append(states, state)
			}
		}
		low, high := pivot(candles, j, 3, cfg.ConfirmationBars)
		for _, state := range states {
			if ended(state.p.Status) {
				continue
			}
			if low != high && ((low && state.p.Direction == "bullish") || (high && state.p.Direction == "bearish")) {
				price := candles[j].Low
				if high {
					price = candles[j].High
				}
				confirmD(state, candles, i, Point{Index: j, Time: candles[j].OpenTime, Price: price}, cfg)
			}
			observe(state, candles[i], i, cfg)
		}
	}
	for _, state := range states {
		p := state.p
		anchor := p.C.Index
		if p.D != nil {
			anchor = p.D.Index
		}
		p.AgeBars = len(candles) - 1 - anchor
		admissionScore := p.Score
		if p.EntryTouched && p.EntryScore != nil {
			// An entry admitted with the information available then must not
			// disappear because a later D changes its geometry score.
			admissionScore = *p.EntryScore
		}
		if admissionScore+1e-9 < cfg.MinScore || (p.D == nil && !cfg.IncludePotential) {
			continue
		}
		result = append(result, p)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].LastUpdatedAt != result[j].LastUpdatedAt {
			return result[i].LastUpdatedAt > result[j].LastUpdatedAt
		}
		if result[i].Score != result[j].Score {
			return result[i].Score > result[j].Score
		}
		return result[i].ID < result[j].ID
	})
	return result
}

func validCandles(c []market.Candle) bool {
	for i, b := range c {
		if !b.Valid() || (i > 0 && (b.OpenTime <= c[i-1].OpenTime || b.OpenTime <= c[i-1].CloseTime)) {
			return false
		}
	}
	return true
}

func pivot(c []market.Candle, j, left, right int) (low, high bool) {
	if j < left || j < 0 || j+right >= len(c) {
		return false, false
	}
	low, high = true, true
	for k := j - left; k <= j+right; k++ {
		if c[k].Low < c[j].Low {
			low = false
		}
		if c[k].High > c[j].High {
			high = false
		}
	}
	return low, high
}

func newCandidate(c []market.Candle, i int, seq []swing, d definition, cfg Config) *tracked {
	p := Pattern{Kind: d.name, Direction: "bullish", Stage: "potential", Status: "pending",
		X: seq[0].point, A: seq[1].point, B: seq[2].point, C: seq[3].point,
		DetectedAt: c[i].CloseTime, LastUpdatedAt: c[i].CloseTime}
	if seq[0].high {
		p.Direction = "bearish"
	}
	if !validABC(p, d, cfg) || !cleanLeg(c, p.X, p.A) || !cleanLeg(c, p.A, p.B) || !cleanLeg(c, p.B, p.C) {
		return nil
	}
	setLevels(&p, d, cfg)
	if !usableLevels(p) || p.Zone.High <= 0 || direction(p)*(p.C.Price-p.Entry) <= 0 {
		return nil
	}
	p.ID = fmt.Sprintf("%s:%s:%d:%d:%d:%d", p.Kind, p.Direction, p.X.Time, p.A.Time, p.B.Time, p.C.Time)
	p.LevelsEstablishedAt = c[i].CloseTime
	state := &tracked{p: p, d: d, created: i, referenceAt: i, entryAt: -1, cEntryEligible: true}
	// Do not infer a historical C entry while waiting for C's right-hand bars.
	for k := p.C.Index + 1; k <= i; k++ {
		if structureBroken(p, c[k]) {
			return nil
		}
		if touchesEntry(p, p.Entry, c[k]) {
			state.cEntryEligible = false
		}
	}
	return state
}

func sameXAB(a, b Pattern) bool {
	return a.Kind == b.Kind && a.Direction == b.Direction && a.X.Index == b.X.Index && a.A.Index == b.A.Index && a.B.Index == b.B.Index
}

func cleanLeg(c []market.Candle, a, b Point) bool {
	if b.Index <= a.Index {
		return false
	}
	low, high := math.Min(a.Price, b.Price), math.Max(a.Price, b.Price)
	eps := math.Max(1, high) * 1e-10
	for i := a.Index; i <= b.Index; i++ {
		if c[i].Low < low-eps || c[i].High > high+eps {
			return false
		}
	}
	return true
}

func potentialDeadline(p Pattern, cfg Config) int {
	return p.C.Index + int(float64(p.C.Index-p.X.Index)/3*(1+cfg.MaxLegAsymmetry/100))
}

func confirmD(t *tracked, c []market.Candle, i int, d Point, cfg Config) {
	p := t.p
	if d.Index <= p.C.Index || d.Index > potentialDeadline(p, cfg) || !cleanLeg(c, p.C, d) {
		return
	}
	if p.D != nil && (d.Index <= p.D.Index || direction(p)*(d.Price-p.D.Price) >= 0) {
		return
	}
	p.D = &d
	if !validRatiosD(p, t.d, cfg) {
		return
	}
	if cfg.EntryOffsetMode == "atr" {
		p.dEntryOffset = confirmedEntryOffset(c, i, cfg)
	}
	setLevels(&p, t.d, cfg)
	if t.p.D != nil && p.Score+1e-9 < t.p.Score {
		return
	}
	if t.p.EntryTouched {
		// Geometry can improve after an observed C entry, but earlier risk and
		// target observations must keep the references that were known then.
		p.Entry, p.Stop, p.Target1, p.Target2 = t.p.Entry, t.p.Stop, t.p.Target1, t.p.Target2
		p.ReferenceD, p.LevelsBasedOn, p.LevelsEstablishedAt = t.p.ReferenceD, t.p.LevelsBasedOn, t.p.LevelsEstablishedAt
		p.ReferenceStatus = t.p.ReferenceStatus
	} else {
		p.LevelsEstablishedAt = c[i].CloseTime
	}
	p.Stage = "confirmed"
	p.ConfirmedAt = c[i].CloseTime
	p.LastUpdatedAt = c[i].CloseTime
	// Geometry and entry eligibility are separate facts. A price-relative
	// offset can overtake T1 on a small but valid pattern; keep its confirmed
	// D and explicitly withhold reference observations until usable levels
	// exist. Previously observed entry references remain frozen above.
	if !p.EntryTouched {
		p.Reason = ""
		if !usableLevels(p) {
			p.Reason = "D geometry is confirmed, but the configured entry and target references are unusable."
		}
	}
	t.p = p
	if !p.EntryTouched {
		t.referenceAt = i
	}
}

// structureBroken ends a pending potential: price moved back through C, so the
// XABC leg cannot complete, or beyond the far edge of the reversal zone.
func structureBroken(p Pattern, b market.Candle) bool {
	if p.Direction == "bullish" {
		return b.High > p.C.Price || b.Low < p.Zone.Low
	}
	return b.Low < p.C.Price || b.High > p.Zone.High
}

func touchesEntry(p Pattern, level float64, b market.Candle) bool {
	if p.Direction == "bullish" {
		return b.Low <= level
	}
	return b.High >= level
}

func touchesStop(p Pattern, b market.Candle) bool {
	if p.Direction == "bullish" {
		return b.Low <= p.Stop
	}
	return b.High >= p.Stop
}

func touchesTarget(p Pattern, target float64, b market.Candle) bool {
	if p.Direction == "bullish" {
		return b.High >= target
	}
	return b.Low <= target
}

func observe(t *tracked, b market.Candle, i int, cfg Config) {
	p := &t.p
	p.LastUpdatedAt = b.CloseTime
	if p.D == nil {
		deadline, reason := potentialDeadline(*p, cfg), "potential completion window elapsed"
		if p.EntryTouched {
			// Pine moves an entered incomplete pattern to its pending-target
			// collection with entry as its provisional D. Keep D unconfirmed
			// here, but use the same known entry-to-X length and time anchor.
			deadline = t.entryAt + int(float64(t.entryAt-p.X.Index)*cfg.PatternTimeout)
			reason = "target observation window elapsed"
		}
		if i > deadline {
			finish(t, "expired", reason, b.CloseTime)
			return
		}
	} else {
		length := p.D.Index - p.X.Index
		if !p.EntryTouched && i > p.D.Index+int(float64(length)*cfg.EntryWindow) {
			finish(t, "expired", "entry observation window elapsed", b.CloseTime)
			return
		}
		if i > p.D.Index+int(float64(length)*cfg.PatternTimeout) {
			finish(t, "expired", "target observation window elapsed", b.CloseTime)
			return
		}
	}
	if i <= t.referenceAt {
		return
	}
	if p.ReferenceStatus == "unusable" && !p.EntryTouched {
		// The normal time window can still expire, and later D geometry may
		// establish usable references. Invalid prices cannot trigger outcomes.
		return
	}
	if p.EntryTouched {
		if touchesStop(*p, b) {
			finish(t, "invalidated", "stop reference crossed", b.CloseTime)
			return
		}
		// No target credit on the entry-touch bar: OHLC gives no intrabar order.
		if i > t.entryAt {
			if touchesTarget(*p, p.Target1, b) {
				p.Target1Reached = true
			}
			if touchesTarget(*p, p.Target2, b) {
				p.Target1Reached = true
				p.Target2Reached = true
				finish(t, "completed", "both target references reached after entry observation", b.CloseTime)
				return
			}
		}
		// After an entry observation only the stop, the targets and the time
		// window end a setup at either stage, as in harmonic.pine. A potential's
		// move back through C is progress toward target 1, not a failure of the
		// frozen reference levels, so the pending-only structure rule stops here.
		return
	}
	if p.D == nil && structureBroken(*p, b) {
		finish(t, "invalidated", "potential pattern structure breached", b.CloseTime)
		return
	}
	if p.D != nil && touchesStop(*p, b) {
		finish(t, "invalidated", "stop reference crossed before entry observation", b.CloseTime)
		return
	}
	if p.Score+1e-9 < cfg.MinScore {
		return
	}
	level := 0.0
	hit := false
	if cfg.EntryAfterC && t.cEntryEligible && p.EntryAfterC != nil && touchesEntry(*p, *p.EntryAfterC, b) {
		level = *p.EntryAfterC
		hit = true
	}
	if cfg.EntryAfterD && p.D != nil && p.EntryAfterD != nil && touchesEntry(*p, *p.EntryAfterD, b) {
		// If both levels are first reached on the same candle, retain the less
		// favorable reference. No exact execution price is asserted.
		if !hit || direction(*p)*(*p.EntryAfterD-level) > 0 {
			level = *p.EntryAfterD
		}
		hit = true
	}
	if !hit || direction(*p)*(p.Target1-level) <= 0 {
		return
	}
	p.Entry = level
	p.EntryStage = p.Stage
	p.EntryScore = ptr(p.Score)
	p.EntryTouched = true
	p.EntryTouchedAt = b.CloseTime
	p.Status = "active"
	t.entryAt = i
	p.Stop = p.Entry - direction(*p)*math.Abs(p.Target1-p.Entry)*cfg.StopPercent/100
	if !usableLevels(*p) {
		finish(t, "invalidated", "entry observation produced unusable price references", b.CloseTime)
		return
	}
	if touchesStop(*p, b) {
		finish(t, "invalidated", "entry and stop references crossed on the same candle; stop takes precedence", b.CloseTime)
	}
}

func ended(status string) bool {
	return status == "completed" || status == "invalidated" || status == "expired"
}

func finish(t *tracked, status, reason string, at int64) {
	t.p.Status = status
	t.p.Reason = reason
	t.p.EndedAt = at
	t.p.LastUpdatedAt = at
}

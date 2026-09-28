// Inspired by harmonic.pine, © reees, licensed under MPL-2.0.
// This file is distributed under the Mozilla Public License 2.0.
package harmonic

import "math"

type ratioRange struct{ low, high float64 }

type definition struct {
	name               string
	b, c, cd, terminal ratioRange
	cKey, terminalKey  string
	extendedC          bool
	ignoreB            bool
}

// These are the independent standard family definitions used by this package.
// Butterfly uses the 1.272 XA completion, not the alternative 1.618 variant.
// Cypher C is measured as XC/XA (not BC/AB); D is CD/XC. Shark places no
// AB/XA retracement restriction, matching the Pine tooltip's "NA" B error.
var definitions = map[string]definition{
	"gartley":   {"gartley", ratioRange{.618, .618}, ratioRange{.382, .886}, ratioRange{1.13, 1.618}, ratioRange{.786, .786}, "bcAb", "adXa", false, false},
	"bat":       {"bat", ratioRange{.382, .5}, ratioRange{.382, .886}, ratioRange{1.618, 2.618}, ratioRange{.886, .886}, "bcAb", "adXa", false, false},
	"butterfly": {"butterfly", ratioRange{.786, .786}, ratioRange{.382, .886}, ratioRange{1.618, 2.24}, ratioRange{1.272, 1.272}, "bcAb", "adXa", false, false},
	"crab":      {"crab", ratioRange{.382, .618}, ratioRange{.382, .886}, ratioRange{2.24, 3.618}, ratioRange{1.618, 1.618}, "bcAb", "adXa", false, false},
	"shark":     {"shark", ratioRange{}, ratioRange{1.13, 1.618}, ratioRange{1.618, 2.24}, ratioRange{.886, 1.13}, "bcAb", "adXa", true, true},
	"cypher":    {"cypher", ratioRange{.382, .618}, ratioRange{1.272, 1.414}, ratioRange{}, ratioRange{.786, .786}, "xcXa", "cdXc", true, false},
}

func (r ratioRange) error(v float64) float64 {
	if v < r.low {
		return (r.low - v) / r.low
	}
	if v > r.high {
		return (v - r.high) / r.high
	}
	return 0
}

func (r ratioRange) matches(v, tolerance float64) bool {
	return finite(v) && v > 0 && r.error(v) <= tolerance/100+1e-10
}

func lengths(p Pattern) (xa, ab, bc, xc float64) {
	return math.Abs(p.A.Price - p.X.Price), math.Abs(p.B.Price - p.A.Price),
		math.Abs(p.C.Price - p.B.Price), math.Abs(p.C.Price - p.X.Price)
}

func direction(p Pattern) float64 {
	if p.Direction == "bullish" {
		return 1
	}
	return -1
}

func ratiosFor(p Pattern) map[string]float64 {
	xa, ab, bc, xc := lengths(p)
	r := map[string]float64{"abXa": ab / xa, "bcAb": bc / ab, "xcXa": xc / xa}
	if p.D != nil {
		r["cdBc"] = math.Abs(p.C.Price-p.D.Price) / bc
		r["adXa"] = math.Abs(p.A.Price-p.D.Price) / xa
		if xc > 0 {
			r["cdXc"] = math.Abs(p.C.Price-p.D.Price) / xc
		}
	}
	return r
}

func validABC(p Pattern, d definition, cfg Config) bool {
	xa, ab, bc, xc := lengths(p)
	if xa <= 0 || ab <= 0 || bc <= 0 || (d.name == "cypher" && xc <= 0) {
		return false
	}
	s := direction(p)
	if s*(p.A.Price-p.X.Price) <= 0 || s*(p.A.Price-p.B.Price) <= 0 || s*(p.C.Price-p.B.Price) <= 0 {
		return false
	}
	if d.extendedC {
		if s*(p.C.Price-p.A.Price) <= 0 {
			return false
		}
	} else if s*(p.A.Price-p.C.Price) <= 0 {
		return false
	}
	r := ratiosFor(p)
	return (d.ignoreB || d.b.matches(r["abXa"], cfg.RatioTolerance)) &&
		d.c.matches(r[d.cKey], cfg.RatioTolerance) &&
		symmetric([]int{p.A.Index - p.X.Index, p.B.Index - p.A.Index, p.C.Index - p.B.Index}, cfg.MaxLegAsymmetry)
}

func validRatiosD(p Pattern, d definition, cfg Config) bool {
	if p.D == nil || direction(p)*(p.C.Price-p.D.Price) <= 0 {
		return false
	}
	// Standard retracement patterns terminate before X; extension patterns beyond X.
	dx := direction(p) * (p.D.Price - p.X.Price)
	if (d.name == "gartley" || d.name == "bat" || d.name == "cypher") && dx <= 0 {
		return false
	}
	if (d.name == "butterfly" || d.name == "crab") && dx >= 0 {
		return false
	}
	r := ratiosFor(p)
	return (d.name == "cypher" || d.cd.matches(r["cdBc"], cfg.RatioTolerance)) &&
		d.terminal.matches(r[d.terminalKey], cfg.RatioTolerance) &&
		symmetric([]int{p.A.Index - p.X.Index, p.B.Index - p.A.Index, p.C.Index - p.B.Index, p.D.Index - p.C.Index}, cfg.MaxLegAsymmetry)
}

func symmetric(legs []int, allowed float64) bool {
	total := 0
	for _, n := range legs {
		if n <= 0 {
			return false
		}
		total += n
	}
	for _, n := range legs {
		avg := float64(total-n) / float64(len(legs)-1)
		if math.Abs(float64(n)-avg)/avg > allowed/100+1e-10 {
			return false
		}
	}
	return true
}

// projections returns the two closest nominal, independently derived fib
// levels and the tolerance-expanded envelope of all projections. Range
// endpoints are explicit levels; no undocumented library formula is assumed.
func projections(p Pattern, d definition, cfg Config) (Zone, float64, float64) {
	xa, _, bc, xc := lengths(p)
	s := direction(p)
	base, length := p.A.Price, xa
	if d.name == "cypher" {
		base, length = p.C.Price, xc
	}
	xlevels := []float64{base - s*length*d.terminal.low, base - s*length*d.terminal.high}
	xbounds := []float64{base - s*length*d.terminal.low*(1-cfg.RatioTolerance/100), base - s*length*d.terminal.high*(1+cfg.RatioTolerance/100)}
	all := append([]float64{}, xbounds...)
	first, second := xlevels[0], xlevels[0]
	if d.name != "cypher" {
		blevels := []float64{p.C.Price - s*bc*d.cd.low, p.C.Price - s*bc*d.cd.high}
		all = append(all, p.C.Price-s*bc*d.cd.low*(1-cfg.RatioTolerance/100), p.C.Price-s*bc*d.cd.high*(1+cfg.RatioTolerance/100))
		gap := math.Inf(1)
		for _, x := range xlevels {
			for _, b := range blevels {
				if math.Abs(x-b) < gap {
					gap = math.Abs(x - b)
					first, second = x, b
				}
			}
		}
	}
	low, high := all[0], all[0]
	for _, level := range all {
		low = math.Min(low, level)
		high = math.Max(high, level)
	}
	return Zone{Low: math.Max(0, low), High: high}, first, second
}

func score(p Pattern, d definition, first, second float64) (float64, ScoreComponents) {
	r := ratiosFor(p)
	errors := []float64{d.c.error(r[d.cKey])}
	if !d.ignoreB {
		errors = append(errors, d.b.error(r["abXa"]))
	}
	if p.D != nil {
		errors = append(errors, d.terminal.error(r[d.terminalKey]))
		if d.name != "cypher" {
			errors = append(errors, d.cd.error(r["cdBc"]))
		}
	}
	avg := 0.0
	for _, e := range errors {
		avg += e / float64(len(errors))
	}
	xa, _, _, _ := lengths(p)
	c := ScoreComponents{RatioAccuracy: clamp(100 * (1 - avg)), PRZConfluence: clamp(100 * (1 - math.Abs(first-second)/xa)), RatioWeight: 4, PRZWeight: 2}
	if d.name == "cypher" {
		c.PRZWeight = 0
	}
	if p.D != nil {
		c.DConfluence = ptr(clamp(100 * (1 - math.Min(math.Abs(p.D.Price-first), math.Abs(p.D.Price-second))/xa)))
		c.DWeight = 3
	}
	total := c.RatioAccuracy*c.RatioWeight + c.PRZConfluence*c.PRZWeight
	if c.DConfluence != nil {
		total += *c.DConfluence * c.DWeight
	}
	return clamp(total / (c.RatioWeight + c.PRZWeight + c.DWeight)), c
}

func setLevels(p *Pattern, d definition, cfg Config) {
	zone, first, second := projections(*p, d, cfg)
	p.Zone = zone
	p.Ratios = ratiosFor(*p)
	p.Score, p.ScoreComponents = score(*p, d, first, second)
	s := direction(*p)
	entryC := math.Max(first, second)
	if s < 0 {
		entryC = math.Min(first, second)
	}
	p.EntryAfterC = nil
	p.EntryAfterD = nil
	if cfg.EntryAfterC {
		p.EntryAfterC = ptr(entryC)
	}
	completion := entryC
	p.LevelsBasedOn = "projected_prz"
	if p.D != nil {
		completion = p.D.Price
		p.LevelsBasedOn = "confirmed_d"
		if cfg.EntryAfterD {
			offset := completion * cfg.EntryLimitPercent / 100
			if cfg.EntryOffsetMode == "atr" {
				offset = p.dEntryOffset
			}
			if finite(offset) {
				p.EntryAfterD = ptr(completion + s*offset)
			}
		}
	}
	p.ReferenceD = completion
	if !p.EntryTouched {
		p.Entry = entryC
		if p.EntryAfterD != nil {
			p.Entry = *p.EntryAfterD
		}
	}
	xa, _, _, _ := lengths(*p)
	ad, cd := math.Abs(p.A.Price-completion), math.Abs(p.C.Price-completion)
	switch d.name {
	case "crab":
		p.Target1 = completion + s*.618*ad
		p.Target2 = completion + s*1.618*ad
	case "shark":
		p.Target1 = completion + s*.382*ad
		p.Target2 = p.C.Price
	case "cypher":
		p.Target1 = completion + s*.618*cd
		p.Target2 = completion + s*1.618*xa
	default:
		p.Target1 = completion + s*.618*ad
		p.Target2 = completion + s*1.272*ad
	}
	p.Stop = p.Entry - s*math.Abs(p.Target1-p.Entry)*cfg.StopPercent/100
	p.ReferenceStatus = "usable"
	if !usableLevels(*p) {
		p.ReferenceStatus = "unusable"
	}
}

func usableLevels(p Pattern) bool {
	for _, level := range []float64{p.Entry, p.Stop, p.Target1, p.Target2, p.ReferenceD} {
		if !finite(level) || level <= 0 {
			return false
		}
	}
	s := direction(p)
	return s*(p.Target1-p.Entry) > 0 && s*(p.Target2-p.Target1) > 0 && s*(p.Entry-p.Stop) >= 0
}

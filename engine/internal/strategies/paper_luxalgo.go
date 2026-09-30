package strategies

// Causal ports of the frozen LuxAlgo research recipes (© LuxAlgo,
// CC BY-NC-SA 4.0). See THIRD_PARTY_NOTICES.md for sources and adaptations.
// These calculations emit screening evidence, never an order or fill.
import (
	"fmt"
	"github.com/alihasan00/crypto/internal/market"
	"math"
	"sort"
)

const (
	PaperTrendADX     = "combo_trendlines_adx_daily"
	PaperTrendCluster = "combo_trendlines_cluster_daily"
	PaperTrendSFP     = "combo_trendlines_sfp_daily"
	PaperRangeWeekly  = "combo_range_weekly_4h"
	PaperNWEMomentum  = "combo_nwe_rsi_ultimate_15m"
)

type luxEvent struct {
	index, side int
	stop        float64
}

func luxStop(price, stop float64, side int) bool {
	return paperFinite(stop) && stop > 0 && float64(side)*(price-stop) > 0
}

// Explicit float64 product conversions prevent native FMA from changing
// rounded cluster-performance ties relative to Rust and WebAssembly.
// Source LuxAlgo RMA seeds with an ordered sum, distinct from Signal Forge's fsum.
func luxRMA(values []float64, length int) []float64 {
	out := make([]float64, len(values))
	sum, count, prev := 0.0, 0, math.NaN()
	a := 1 / float64(length)
	for i, v := range values {
		if paperFinite(v) {
			if paperFinite(prev) {
				prev = float64(a*v) + float64((1-a)*prev)
			} else {
				sum += v
				count++
				if count == length {
					prev = sum / float64(length)
				}
			}
		}
		out[i] = prev
	}
	return out
}
func luxATR(b []market.Candle, length int) []float64 {
	tr := make([]float64, len(b))
	for i, c := range b {
		tr[i] = c.High - c.Low
		if i > 0 {
			tr[i] = math.Max(tr[i], math.Max(math.Abs(c.High-b[i-1].Close), math.Abs(c.Low-b[i-1].Close)))
		}
	}
	return luxRMA(tr, length)
}
func luxPivot(values []float64, at, left, right int, high bool) bool {
	if at < left || at+right >= len(values) {
		return false
	}
	v := values[at]
	for j := at - left; j <= at+right; j++ {
		if j == at {
			continue
		}
		if high && (values[j] > v || j > at && values[j] == v) || !high && (values[j] < v || j > at && values[j] == v) {
			return false
		}
	}
	return true
}
func luxExtremes(b []market.Candle) ([]float64, []float64) {
	h, l := make([]float64, len(b)), make([]float64, len(b))
	for i, c := range b {
		h[i], l[i] = c.High, c.Low
	}
	return h, l
}
func luxTrendlines(b []market.Candle) []luxEvent {
	a := luxATR(b, 14)
	h, l := luxExtremes(b)
	upper, lower := math.NaN(), math.NaN()
	hs, ls := 0.0, 0.0
	up, down := false, false
	out := []luxEvent{}
	for i, c := range b {
		pu, pd := up, down
		if luxPivot(h, i-14, 14, 14, true) {
			upper = h[i-14]
			hs = a[i] / 14
			up = false
		} else if paperFinite(upper) {
			upper -= hs
			if c.Close > upper-hs*14 {
				up = true
			}
		}
		if luxPivot(l, i-14, 14, 14, false) {
			lower = l[i-14]
			ls = a[i] / 14
			down = false
		} else if paperFinite(lower) {
			lower += ls
			if c.Close < lower+ls*14 {
				down = true
			}
		}
		if up && !pu {
			out = append(out, luxEvent{i, 1, c.Close - 2*a[i]})
		}
		if down && !pd {
			out = append(out, luxEvent{i, -1, c.Close + 2*a[i]})
		}
	}
	return out
}
func luxAgrees(events []luxEvent, at, maxAge int) bool {
	latest := -1
	long, short := false, false
	for _, e := range events {
		if e.index > at || e.index < latest {
			continue
		}
		if e.index > latest {
			latest = e.index
			long = false
			short = false
		}
		long = long || e.side == 1
		short = short || e.side == -1
	}
	return latest >= 0 && (maxAge < 0 || at-latest <= maxAge) && long && !short
}
func luxSFP(b []market.Candle) []luxEvent {
	type swing struct {
		index           int
		price, opposite float64
	}
	type pending struct {
		swing
		stop              float64
		active, confirmed bool
	}
	var swings [2]*swing
	var patterns [2]*pending
	a := luxATR(b, 14)
	h, l := luxExtremes(b)
	out := []luxEvent{}
	for i, c := range b {
		for slot, side := range []int{-1, 1} {
			v, opp := h, l
			if side == 1 {
				v, opp = l, h
			}
			d := float64(side)
			if luxPivot(v, i-1, 5, 1, side == -1) {
				swings[slot] = &swing{i - 1, v[i-1], v[i-1]}
			} else if s := swings[slot]; s != nil {
				if side == -1 {
					s.opposite = math.Min(s.opposite, opp[i-1])
				} else {
					s.opposite = math.Max(s.opposite, opp[i-1])
				}
			}
			if s := swings[slot]; s != nil && d*(v[i]-s.price) < 0 && d*(c.Open-s.price) > 0 && d*(c.Close-s.price) > 0 {
				patterns[slot] = &pending{*s, v[i] - d*0.1*a[i], true, false}
			}
			if p := patterns[slot]; p != nil {
				if p.active && !p.confirmed && d*(c.Close-p.opposite) > 0 {
					p.confirmed = true
					if luxStop(c.Close, p.stop, side) {
						out = append(out, luxEvent{i, side, p.stop})
					}
				}
				if i-p.index > 500 || d*(c.Close-p.price) < 0 {
					p.active = false
				}
			}
		}
	}
	return out
}
func luxUltimate(b []market.Candle) []luxEvent {
	changes, abs := make([]float64, len(b)), make([]float64, len(b))
	prevHi, prevLo := math.NaN(), math.NaN()
	for i, c := range b {
		hi, lo := c.Close, c.Close
		for j := max(0, i-13); j < i; j++ {
			hi = math.Max(hi, b[j].Close)
			lo = math.Min(lo, b[j].Close)
		}
		changes[i] = math.NaN()
		if i > 0 {
			if hi > prevHi {
				changes[i] = hi - lo
			} else if lo < prevLo {
				changes[i] = lo - hi
			} else {
				changes[i] = c.Close - b[i-1].Close
			}
		}
		abs[i] = math.Abs(changes[i])
		prevHi, prevLo = hi, lo
	}
	num, den := luxRMA(changes, 14), luxRMA(abs, 14)
	a := luxATR(b, 14)
	previous := math.NaN()
	out := []luxEvent{}
	for i := range b {
		current := math.NaN()
		if den[i] > 0 {
			current = 50 + 50*num[i]/den[i]
		}
		side := 0
		if current > 50 && previous <= 50 {
			side = 1
		} else if current < 50 && previous >= 50 {
			side = -1
		}
		if side != 0 && a[i] > 0 {
			out = append(out, luxEvent{i, side, b[i].Close - float64(side)*2*a[i]})
		}
		previous = current
	}
	return out
}
func luxNWE(b []market.Candle) []luxEvent {
	weights := make([]float64, 500)
	den := 0.0
	for j := range weights {
		weights[j] = math.Exp(-float64(j*j) / 128)
		den += weights[j]
	}
	errors := make([]float64, len(b))
	prevLow, prevHigh := math.NaN(), math.NaN()
	a := luxATR(b, 14)
	out := []luxEvent{}
	for i := 499; i < len(b); i++ {
		center := 0.0
		for j, w := range weights {
			if w == 0 {
				break
			}
			center += b[i-j].Close * w
		}
		center /= den
		errors[i] = math.Abs(b[i].Close - center)
		if i < 997 {
			continue
		}
		width := 0.0
		for j := i - 498; j <= i; j++ {
			width += errors[j]
		}
		width = 3 * (width / 499)
		low, high := center-width, center+width
		side := 0
		if b[i].Close < low && b[i-1].Close >= prevLow {
			side = 1
		} else if b[i].Close > high && b[i-1].Close <= prevHigh {
			side = -1
		}
		if side != 0 {
			out = append(out, luxEvent{i, side, b[i].Close - float64(side)*2*a[i]})
		}
		prevLow, prevHigh = low, high
	}
	return out
}
func luxBestFactor(perfs [9]float64) float64 {
	sorted := append([]float64{}, perfs[:]...)
	sort.Float64s(sorted)
	centers := [3]float64{sorted[2], sorted[4], sorted[6]}
	members := [9]int{}
	for iteration := 0; iteration <= 1000; iteration++ {
		sums := [3]float64{}
		counts := [3]int{}
		for j, p := range perfs {
			k := 0
			for n := 1; n < 3; n++ {
				if math.Abs(p-centers[n]) < math.Abs(p-centers[k]) {
					k = n
				}
			}
			members[j] = k
			sums[k] += p
			counts[k]++
		}
		next := centers
		for k := range next {
			if counts[k] > 0 {
				next[k] = sums[k] / float64(counts[k])
			}
		}
		if next == centers {
			break
		}
		centers = next
	}
	sum, n := 0.0, 0
	for i, k := range members {
		if k == 2 {
			sum += 1 + float64(i)*0.5
			n++
		}
	}
	if n == 0 {
		return math.NaN()
	}
	return sum / float64(n)
}
func luxCluster(b []market.Candle) []luxEvent {
	if len(b) == 0 {
		return nil
	}
	type state struct {
		upper, lower, output, perf float64
		trend                      int
	}
	a := luxATR(b, 10)
	mid := (b[0].High + b[0].Low) / 2
	states := [9]state{}
	for j := range states {
		states[j] = state{mid, mid, math.NaN(), 0, 0}
	}
	upper, lower, trend, factor := mid, mid, 0, math.NaN()
	out := []luxEvent{}
	for i, c := range b {
		prev := math.NaN()
		if i > 0 {
			prev = b[i-1].Close
		}
		mid = (c.High + c.Low) / 2
		perfs := [9]float64{}
		for j := range states {
			s := &states[j]
			f := 1 + float64(j)*0.5
			up, dn := mid+float64(a[i]*f), mid-float64(a[i]*f)
			if c.Close > s.upper {
				s.trend = 1
			} else if c.Close < s.lower {
				s.trend = 0
			}
			if prev < s.upper {
				s.upper = math.Min(up, s.upper)
			} else {
				s.upper = up
			}
			if prev > s.lower {
				s.lower = math.Max(dn, s.lower)
			} else {
				s.lower = dn
			}
			diff := 0.0
			if prev > s.output {
				diff = 1
			} else if prev < s.output {
				diff = -1
			}
			change := 0.0
			if i > 0 {
				change = c.Close - prev
			}
			s.perf += float64((2.0 / 11) * (float64(change*diff) - s.perf))
			if s.trend == 1 {
				s.output = s.lower
			} else {
				s.output = s.upper
			}
			perfs[j] = s.perf
		}
		if selected := luxBestFactor(perfs); paperFinite(selected) {
			factor = selected
		}
		up, dn := mid+float64(a[i]*factor), mid-float64(a[i]*factor)
		if prev < upper {
			upper = math.Min(up, upper)
		} else {
			upper = up
		}
		if prev > lower {
			lower = math.Max(dn, lower)
		} else {
			lower = dn
		}
		old := trend
		if c.Close > upper {
			trend = 1
		} else if c.Close < lower {
			trend = 0
		}
		if old != trend {
			side, stop := -1, upper
			if trend == 1 {
				side, stop = 1, lower
			}
			out = append(out, luxEvent{i, side, stop})
		}
	}
	return out
}

// Only a new event on the latest completed candle can open a fresh window.
// pbCandles rejects gaps rather than carrying helper state through missing data.
func PaperLuxAlgoOpportunities(in Input, timeframe string) []Opportunity {
	if timeframe != "1d" && timeframe != "15m" || in.Symbol == "" {
		return nil
	}
	b, ok := pbCandles(in, timeframe)
	if !ok {
		return nil
	}
	at := len(b) - 1
	a := luxATR(b, 14)
	if !(a[at] > 0) {
		return nil
	}
	features := paperSourceFeatures(b)
	primary := luxTrendlines(b)
	families := []string{PaperTrendADX, PaperTrendCluster, PaperTrendSFP}
	helpers := map[string][]luxEvent{}
	if timeframe == "15m" {
		primary = luxNWE(b)
		families = []string{PaperNWEMomentum}
		helpers[PaperNWEMomentum] = luxUltimate(b)
	} else {
		helpers[PaperTrendCluster] = luxCluster(b)
		helpers[PaperTrendSFP] = luxSFP(b)
	}
	var signal *luxEvent
	for _, e := range primary {
		if e.index == at && e.side == 1 {
			copy := e
			signal = &copy
			break
		}
	}
	if signal == nil || !luxStop(b[at].Close, signal.stop, 1) {
		return nil
	}
	out := []Opportunity{}
	for _, family := range families {
		pass := false
		reason := ""
		switch family {
		case PaperTrendADX:
			pass = features[at].ADXRange
			reason = "Trendlines breakout with defined Signal Forge ADX14 at or below 20."
		case PaperTrendCluster:
			pass = luxAgrees(helpers[family], at, 2)
			reason = "Trendlines breakout with a bullish clustered-Supertrend event aged zero to two source bars."
		case PaperTrendSFP:
			pass = luxAgrees(helpers[family], at, 2)
			reason = "Trendlines breakout with a bullish Swing Failure Pattern event aged zero to two source bars."
		case PaperNWEMomentum:
			pass = features[at].RSI == 1 && luxAgrees(helpers[family], at, -1)
			reason = "Causal endpoint envelope lower-band fade with Signal Forge RSI14 above 50 and persistent bullish Ultimate RSI event state."
		}
		if !pass {
			continue
		}
		last := b[at]
		expires := last.CloseTime + pbDuration(timeframe) + 1
		op := Opportunity{Version: Version, ID: fmt.Sprintf("luxalgo-v1:%s:%s:%s:bullish:%d", in.Symbol, timeframe, family, last.CloseTime), ParentID: fmt.Sprintf("price:%s:%s:bullish:%d", in.Symbol, timeframe, last.CloseTime), Family: family, Symbol: in.Symbol, Interval: timeframe, Direction: "bullish", State: "entry_confirmed", AvailableAt: last.CloseTime, LocationAvailableAt: last.CloseTime, SourceStartAt: b[0].OpenTime, SourceEndAt: last.CloseTime, AsOf: last.CloseTime, TriggerAt: pbPtr(last.CloseTime), ExpiresAt: &expires, Level: signal.stop, EntryReference: pbPtr(last.Close), ReferenceATR: pbPtr(a[at]), Stop: pbPtr(signal.stop), Reason: reason,
			Next:         "Check the next whole one-minute opening after observation and intervening minute candles, above the fixed initial 2×Wilder ATR14 stop. The entry window ends at the next source boundary.",
			Invalidation: "Initial 2×Wilder ATR14 stop; never-widening 3.5×Wilder ATR14 trail after daily closes. Ungated opposite raw Trendlines events schedule exit at the next opening. Maximum holding: 96 daily bars.",
			Caution:      "Research reference using bounded browser history. No assumed fill, position or proven profitability."}
		if family == PaperNWEMomentum {
			op.Invalidation = "Keep the initial 2×Wilder ATR14 stop fixed. At execution, target = raw opening + 2 × (raw opening − stop). No trail or opposite-event exit. Maximum holding: 24 fifteen-minute bars."
		}
		out = append(out, op)
	}
	return out
}

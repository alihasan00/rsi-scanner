// Derived source distributed under CC BY-NC-SA 4.0; see types.go and README.md.
package regime

// wilder seeds with an arithmetic mean of the first length observations and
// then updates with alpha=1/length. Callers exclude undefined observations.
type wilder struct {
	length int
	count  int
	value  float64
}

func (w *wilder) add(v float64) {
	if w.count < w.length {
		w.count++
		w.value += (v - w.value) / float64(w.count)
		return
	}
	w.value += (v - w.value) / float64(w.length)
}

func (w wilder) ready() bool { return w.count >= w.length }

// ema uses the first defined source observation as its seed, matching Pine's
// ta.ema. This is deliberately distinct from Wilder's arithmetic seed.
type ema struct {
	alpha float64
	value float64
	ready bool
}

func (e *ema) add(v float64) {
	if !e.ready {
		e.value, e.ready = v, true
		return
	}
	e.value = (1-e.alpha)*e.value + e.alpha*v
}

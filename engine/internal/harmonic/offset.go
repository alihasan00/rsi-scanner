package harmonic

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

// confirmedEntryOffset uses ATR(14) through the D-confirmation close. These
// references are only eligible on a later bar, so no future candle contributes.
// The first true range is high-low; Wilder's average seeds over 14 bars.
func confirmedEntryOffset(candles []market.Candle, i int, cfg Config) float64 {
	const length = 14
	if i < length-1 || i >= len(candles) {
		return math.NaN() // unavailable volatility cannot silently become zero
	}
	atr := 0.0
	for j := 0; j <= i; j++ {
		c := candles[j]
		tr := c.High - c.Low
		if j > 0 {
			tr = math.Max(tr, math.Max(math.Abs(c.High-candles[j-1].Close), math.Abs(c.Low-candles[j-1].Close)))
		}
		denominator := float64(length)
		if j < length {
			denominator = float64(j + 1)
		}
		atr += (tr - atr) / denominator
	}
	return atr * cfg.EntryOffsetATR
}

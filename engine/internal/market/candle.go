// Package market reads the same Binance Spot candles and coin universe as the
// sibling rsi-scanner project.
package market

import "math"

// Candle is an OHLCV bar. Timestamps are Unix milliseconds, and CloseTime is
// inclusive, as returned by Binance.
type Candle struct {
	OpenTime  int64   `json:"openTime"`
	CloseTime int64   `json:"closeTime"`
	Open      float64 `json:"open"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Close     float64 `json:"close"`
	Volume    float64 `json:"volume"`
}

// Valid rejects malformed bars before they can affect indicator calculations.
func (c Candle) Valid() bool {
	const maxSafeInteger = int64(1<<53 - 1)
	if c.OpenTime < 0 || c.CloseTime < c.OpenTime || c.CloseTime > maxSafeInteger {
		return false
	}
	for _, price := range [...]float64{c.Open, c.High, c.Low, c.Close} {
		if math.IsNaN(price) || math.IsInf(price, 0) || price <= 0 {
			return false
		}
	}
	return !math.IsNaN(c.Volume) && !math.IsInf(c.Volume, 0) && c.Volume >= 0 &&
		c.High >= math.Max(c.Open, math.Max(c.Close, c.Low)) &&
		c.Low <= math.Min(c.Open, math.Min(c.Close, c.High))
}

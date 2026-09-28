// Derived source distributed under CC BY-NC-SA 4.0; see types.go and README.md.
package regime

import (
	"math"
	"testing"
)

func TestConfigValidation(t *testing.T) {
	if err := DefaultConfig().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Config){
		"zero trend ATR":           func(c *Config) { c.SupertrendATRLength = 0 },
		"zero ATR":                 func(c *Config) { c.ATRLength = 0 },
		"negative DI":              func(c *Config) { c.DILength = -1 },
		"excess ADX smoothing":     func(c *Config) { c.ADXSmoothing = 1001 },
		"zero iterations":          func(c *Config) { c.MaxClusterIterations = 0 },
		"negative factor":          func(c *Config) { c.MinFactor = -1 },
		"inverted factors":         func(c *Config) { c.MinFactor = c.MaxFactor + 1 },
		"infinite factor":          func(c *Config) { c.MaxFactor = math.Inf(1) },
		"nan factor":               func(c *Config) { c.MinFactor = math.NaN() },
		"zero step":                func(c *Config) { c.FactorStep = 0 },
		"nan step":                 func(c *Config) { c.FactorStep = math.NaN() },
		"too many factors":         func(c *Config) { c.FactorStep = .00001 },
		"overflow candidate count": func(c *Config) { c.FactorStep = math.SmallestNonzeroFloat64 },
		"short performance memory": func(c *Config) { c.PerformanceMemory = 1 },
		"infinite memory":          func(c *Config) { c.PerformanceMemory = math.Inf(1) },
		"low ADX threshold":        func(c *Config) { c.ADXThreshold = -1 },
		"high ADX threshold":       func(c *Config) { c.ADXThreshold = 101 },
		"nan ADX threshold":        func(c *Config) { c.ADXThreshold = math.NaN() },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := DefaultConfig()
			mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("invalid configuration was accepted")
			}
		})
	}
}

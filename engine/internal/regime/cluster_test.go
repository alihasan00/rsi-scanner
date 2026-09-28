// Derived source distributed under CC BY-NC-SA 4.0; see types.go and README.md.
package regime

import (
	"math"
	"testing"
)

func TestClusteringUsesHighestPerformanceGroup(t *testing.T) {
	var candidates []trendCandidate
	for i, value := range []float64{-3, -2, -1, 0, .1, .2, 3, 4, 5} {
		candidates = append(candidates, trendCandidate{factor: float64(i + 1), performance: value})
	}
	got := clusterBest(candidates, 100)
	near(t, "cluster factor", &got.factor, 8)
	near(t, "cluster performance", &got.performance, 4)
	if got.iterationLimit || got.bestWasEmpty {
		t.Fatalf("well-separated groups did not converge normally: %+v", got)
	}
}

func TestEmptyClustersAndSingleFactorHaveFiniteFallbacks(t *testing.T) {
	for _, candidates := range [][]trendCandidate{
		{{factor: 2.5, performance: 0}},
		{{factor: 1, performance: 4}, {factor: 4, performance: 4}},
	} {
		got := clusterBest(candidates, 100)
		near(t, "tied/single factor", &got.factor, 2.5)
		if !finite(got.performance) || got.iterationLimit || !got.bestWasEmpty {
			t.Fatalf("degenerate cluster failed: %+v", got)
		}
	}
}

func TestClusterDistanceScalingHandlesExtremeScores(t *testing.T) {
	got := clusterBest([]trendCandidate{
		{factor: 1, performance: -math.MaxFloat64},
		{factor: 2, performance: 0},
		{factor: 3, performance: math.MaxFloat64},
	}, 100)
	near(t, "extreme-score factor", &got.factor, 3)
	if !finite(got.performance) || got.performance <= 0 {
		t.Fatalf("non-finite clustering result: %+v", got)
	}
}

// Adapted from SuperTrend AI (Clustering), © LuxAlgo, CC BY-NC-SA 4.0.
// https://creativecommons.org/licenses/by-nc-sa/4.0/
package regime

import (
	"math"
	"sort"
)

type clusterResult struct {
	factor         float64
	performance    float64
	bestWasEmpty   bool
	iterationLimit bool
}

// clusterBest uses quartile-initialized, one-dimensional three-means. Ties go
// to the lower cluster index, as in Pine. Empty centroids retain their prior
// positions instead of becoming NaN, and the best non-empty cluster is chosen.
// Scaling all scores by a common positive magnitude keeps distances finite
// without changing the intended distance ordering.
func clusterBest(candidates []trendCandidate, maxIterations int) clusterResult {
	data := make([]float64, len(candidates))
	scale := 0.0
	for _, c := range candidates {
		scale = math.Max(scale, math.Abs(c.performance))
	}
	for i, c := range candidates {
		if scale != 0 {
			data[i] = c.performance / scale
		}
	}
	ordered := append([]float64(nil), data...)
	sort.Float64s(ordered)
	centroids := [3]float64{percentile(ordered, .25), percentile(ordered, .5), percentile(ordered, .75)}
	assignments := make([]int, len(data))
	for i := range assignments {
		assignments[i] = -1
	}
	var counts [3]int
	var means [3]float64
	converged := false
	for iteration := 0; iteration < maxIterations; iteration++ {
		counts, means = [3]int{}, [3]float64{}
		changed := false
		for i, value := range data {
			best, distance := 0, math.Abs(value-centroids[0])
			for j := 1; j < len(centroids); j++ {
				if d := math.Abs(value - centroids[j]); d < distance {
					best, distance = j, d
				}
			}
			changed = changed || assignments[i] != best
			assignments[i] = best
			counts[best]++
			means[best] += (value - means[best]) / float64(counts[best])
		}
		unchangedCentroids := true
		for j := range centroids {
			if counts[j] != 0 {
				unchangedCentroids = unchangedCentroids && centroids[j] == means[j]
				centroids[j] = means[j]
			}
		}
		if !changed || unchangedCentroids {
			converged = true
			break
		}
	}
	best := -1
	for j := range counts {
		if counts[j] > 0 && (best == -1 || means[j] > means[best]) {
			best = j
		}
	}
	result := clusterResult{bestWasEmpty: counts[2] == 0, iterationLimit: !converged}
	count := 0
	for i, c := range candidates {
		if assignments[i] == best {
			count++
			result.factor += (c.factor - result.factor) / float64(count)
			// A convex sum avoids overflow for mixed-sign finite scores.
			ratio := 1 / float64(count)
			result.performance = (1-ratio)*result.performance + ratio*c.performance
		}
	}
	return result
}

func percentile(sorted []float64, fraction float64) float64 {
	position := float64(len(sorted)-1) * fraction
	index := int(position)
	if index == len(sorted)-1 {
		return sorted[index]
	}
	return sorted[index] + (position-float64(index))*(sorted[index+1]-sorted[index])
}

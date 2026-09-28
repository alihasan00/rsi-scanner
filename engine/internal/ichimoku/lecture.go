package ichimoku

import (
	"math"

	"github.com/alihasan00/crypto/internal/market"
)

// Point contains the observations displayed at Time, an inclusive completed
// candle close. Span A/B use the existing actual +30-bar offset. CalculatedAt
// identifies the source close of those displayed spans, never a future candle.
// Partial windows stay nil. Invalid history produces time-only points.
type Point struct {
	Time         int64    `json:"time"`
	Tenkan       *float64 `json:"tenkan"`
	Kijun        *float64 `json:"kijun"`
	SpanA        *float64 `json:"spanA"`
	SpanB        *float64 `json:"spanB"`
	CalculatedAt *int64   `json:"calculatedAt"`
}

// CloudPoint is already calculated from completed prices; only its display
// position is in the future. DisplayedAt is extrapolated using the validated
// fixed candle duration. It is not a prediction of future prices.
type CloudPoint struct {
	CalculatedAt int64   `json:"calculatedAt"`
	DisplayedAt  int64   `json:"displayedAt"`
	SpanA        float64 `json:"spanA"`
	SpanB        float64 `json:"spanB"`
}

type LectureSnapshot struct {
	Status            string         `json:"status"`
	AsOf              *int64         `json:"asOf"`
	Bars              int            `json:"bars"`
	Tenkan            KijunContext   `json:"tenkan"`
	Kijun             KijunContext   `json:"kijun"`
	Cloud             LectureCloud   `json:"cloud"`
	TKCross           *CrossEvent    `json:"tkCross"`
	PKCross           *CrossEvent    `json:"pkCross"`
	CurrentTwist      *TwistEvent    `json:"currentTwist"`
	ProjectedTwist    *TwistEvent    `json:"projectedTwist"`
	TwistsObserved    int            `json:"twistsObserved"`
	AlternatingTwists bool           `json:"alternatingTwists"`
	EdgeToEdge        EdgeToEdge     `json:"edgeToEdge"`
	Fibonacci         CloudFibonacci `json:"fibonacci"`
	Extension         Extension      `json:"extension"`
	Projection        []CloudPoint   `json:"projection"`
	Conventions       []string       `json:"conventions"`
}

type LectureCloud struct {
	CloudContext
	Color                   string   `json:"color"`
	Width                   *float64 `json:"width"`
	WidthATRStatus          string   `json:"widthATRStatus"`
	WidthATR                *float64 `json:"widthATR"`
	WidthChange1Bar         *float64 `json:"widthChange1Bar"`
	WidthTrend              string   `json:"widthTrend"`
	UpperFlatBars           *int     `json:"upperFlatBars"`
	LowerFlatBars           *int     `json:"lowerFlatBars"`
	UpperFlatHistoryBounded bool     `json:"upperFlatHistoryBounded"`
	LowerFlatHistoryBounded bool     `json:"lowerFlatHistoryBounded"`
	SupportResistance       string   `json:"supportResistance"`
	TrendContext            string   `json:"trendContext"`
}

// CrossEvent is the most recent observed crossover, not necessarily a current
// entry. Valid is geometric TK/PK validity; EntryEligible also requires known
// outside-cloud context. Strength describes lecture confluence, never a score.
type CrossEvent struct {
	Time             int64   `json:"time"`
	Direction        string  `json:"direction"`
	Valid            bool    `json:"valid"`
	EntryEligible    bool    `json:"entryEligible"`
	Kind             string  `json:"kind"`
	Strength         string  `json:"strength"`
	Reason           string  `json:"reason"`
	CloudPosition    string  `json:"cloudPosition"`
	CloudColor       string  `json:"cloudColor"`
	MovingChange1Bar float64 `json:"movingChange1Bar"`
	KijunChange1Bar  float64 `json:"kijunChange1Bar"`
	AgeBars          int     `json:"ageBars"`
}

type TwistEvent struct {
	CalculatedAt int64  `json:"calculatedAt"`
	DisplayedAt  int64  `json:"displayedAt"`
	Direction    string `json:"direction"`
	Scope        string `json:"scope"`
	AgeBars      int    `json:"ageBars"`
}

// EdgeToEdge retains the latest outside-to-inside close and follows that
// observation until the other edge is reached or the entry side is lost.
// Width is measured without inventing a cutoff for the lecture's "significant".
type EdgeToEdge struct {
	Status           string   `json:"status"`
	Direction        string   `json:"direction"`
	EnteredAt        *int64   `json:"enteredAt"`
	AgeBars          *int     `json:"ageBars"`
	EntryEdge        *float64 `json:"entryEdge"`
	OppositeEdge     *float64 `json:"oppositeEdge"`
	OppositeFlatBars *int     `json:"oppositeFlatBars"`
	OppositeFlat     bool     `json:"oppositeFlat"`
	Width            *float64 `json:"width"`
	WidthATRStatus   string   `json:"widthATRStatus"`
	WidthATR         *float64 `json:"widthATR"`
	RetestStatus     string   `json:"retestStatus"`
	RetestedAt       *int64   `json:"retestedAt"`
	Reason           string   `json:"reason"`
}

type FibonacciLevel struct {
	Ratio float64 `json:"ratio"`
	Price float64 `json:"price"`
}

type CloudFibonacci struct {
	Status string           `json:"status"`
	Lower  *float64         `json:"lower"`
	Upper  *float64         `json:"upper"`
	Levels []FibonacciLevel `json:"levels"`
	Reason string           `json:"reason"`
}

type Extension struct {
	Status                  string   `json:"status"`
	PriceKijunDistance      *float64 `json:"priceKijunDistance"`
	PriceKijunDistanceATR   *float64 `json:"priceKijunDistanceATR"`
	PriceKijunATRStatus     string   `json:"priceKijunATRStatus"`
	TenkanKijunGap          *float64 `json:"tenkanKijunGap"`
	TenkanKijunGapATR       *float64 `json:"tenkanKijunGapATR"`
	GapATRStatus            string   `json:"gapATRStatus"`
	GapChange1Bar           *float64 `json:"gapChange1Bar"`
	CloudWidthChange1Bar    *float64 `json:"cloudWidthChange1Bar"`
	ThinningWithWideningGap bool     `json:"thinningWithWideningGap"`
	Direction               string   `json:"direction"`
	Reason                  string   `json:"reason"`
}

// Series publishes independent pointers and does not mutate its input. A gap,
// duration change, or malformed candle withholds the entire history's values.
func Series(candles []market.Candle) []Point {
	result := make([]Point, len(candles))
	for i, c := range candles {
		result[i].Time = c.CloseTime
	}
	if len(candles) == 0 || !validHistory(candles) {
		return result
	}
	for i := range candles {
		if i+1 >= TenkanLength {
			result[i].Tenkan = pointer(midpoint(candles[i+1-TenkanLength : i+1]))
		}
		if i+1 >= KijunLength {
			result[i].Kijun = pointer(midpoint(candles[i+1-KijunLength : i+1]))
		}
		if i+1 >= CloudWarmupBars {
			calculated := i - DisplacementBars
			result[i].SpanA = pointer(average(*result[calculated].Tenkan, *result[calculated].Kijun))
			result[i].SpanB = pointer(midpoint(candles[calculated+1-SpanBLength : calculated+1]))
			result[i].CalculatedAt = pointer(candles[calculated].CloseTime)
		}
	}
	return result
}

// AnalyzeLecture adds the lecture's descriptive observations without changing
// Analyze or interpreting any Ichimoku observation as independent confirmation.
// Callers supply completed contiguous candles, as for Analyze.
func AnalyzeLecture(candles []market.Candle, atr *float64) LectureSnapshot {
	base := Analyze(candles, atr)
	s := LectureSnapshot{
		Status: base.Status, AsOf: clonePointer(base.AsOf), Bars: base.Bars,
		Kijun: CloneSnapshot(base).Kijun,
		Tenkan: KijunContext{Status: base.Status, WarmupBars: TenkanLength,
			DistanceATRStatus: base.Status, SlopeStatus: base.Status, Slope: "unavailable"},
		Cloud: LectureCloud{CloudContext: CloneSnapshot(base).Cloud, Color: "unavailable",
			WidthATRStatus: base.Cloud.Status, WidthTrend: "unavailable",
			SupportResistance: "unavailable", TrendContext: "unavailable"},
		EdgeToEdge: EdgeToEdge{Status: base.Cloud.Status, Direction: "unavailable",
			WidthATRStatus: base.Cloud.Status, RetestStatus: "unavailable",
			Reason: "A completed outside-to-inside close and displayed cloud are required."},
		Fibonacci: CloudFibonacci{Status: base.Cloud.Status, Levels: []FibonacciLevel{},
			Reason: "Requires a green cloud with a flat lower and upper edge."},
		Extension: Extension{Status: base.Kijun.Status, PriceKijunATRStatus: base.Kijun.Status,
			GapATRStatus: base.Kijun.Status, Direction: "unavailable",
			Reason: "Distances are measurements; the lecture supplies no extension or thin-cloud cutoff."},
		Projection: []CloudPoint{},
		Conventions: []string{
			"20/60/120 lookbacks; actual +30-bar display offset, preserving the existing engine convention. This is not a claim of exact chart-input parity.",
			"All timestamps are inclusive completed-candle closes in Unix milliseconds. Future display positions use already calculated spans and the validated candle duration.",
			"Flat means exact equality; flat bars count unchanged one-bar transitions. Width, gap and extension have no invented thin, thick, significant or extreme threshold.",
			"Crosses require a strict side change, carrying the previous nonzero side across equality plateaus. Initial departure from equality alone is not a proven cross.",
			"Cross cloud location uses the current Kijun reference. Both that reference and the closing price must be outside the cloud for entry eligibility; strong confluence additionally requires the favorable side and color.",
			"The latest crossover is historical: ageBars measures completed bars since that event. Rising Tenkan crossing falling Kijun remains a mild bullish exception.",
			"Twists are timed when their source calculations become known; displayed and projected twists are separate. Alternating twists means at least two opposite color reversals in all supplied history, without a recency or profitability claim.",
			"Edge-to-edge tracks the original entry edge and the current opposite edge; later held retests may acquire a flat opposite edge. Cloud color does not gate this context.",
			"Green-cloud Fibonacci references use the current flat low as 0 and flat high as 1. Lagging/Chikou span is intentionally unused in the lecture.",
		},
	}
	if len(candles) == 0 || base.Status == "invalid" {
		return s
	}
	points := Series(candles)
	last := len(candles) - 1
	s.Tenkan = lineContext(points, candles[last].Close, TenkanLength, atr)
	if base.Cloud.Status == "ready" {
		s.Cloud.Color = cloudColor(*base.Cloud.SpanA, *base.Cloud.SpanB)
		width := *base.Cloud.Upper - *base.Cloud.Lower
		s.Cloud.Width = pointer(width)
		s.Cloud.WidthATRStatus, s.Cloud.WidthATR = normalizedDistance(width, atr)
		s.Cloud.SupportResistance = map[string]string{"above": "support", "below": "resistance", "inside": "inside_cloud"}[base.Cloud.Position]
		s.Cloud.TrendContext = "mixed"
		if base.Cloud.Position == "above" && s.Cloud.Color == "green" {
			s.Cloud.TrendContext = "bullish_alignment"
		} else if base.Cloud.Position == "below" && s.Cloud.Color == "red" {
			s.Cloud.TrendContext = "bearish_alignment"
		}
		if last > CloudWarmupBars-1 {
			prevLower, prevUpper := bounds(points[last-1])
			change := width - (prevUpper - prevLower)
			s.Cloud.WidthChange1Bar = pointer(change)
			s.Cloud.WidthTrend = movement(change, "widening", "narrowing")
			if change > 0 && s.Cloud.TrendContext == "bearish_alignment" {
				s.Cloud.TrendContext = "bearish_alignment_widening_cloud"
			}
		}
		s.Cloud.UpperFlatBars, s.Cloud.UpperFlatHistoryBounded = edgeFlat(points, last, true)
		s.Cloud.LowerFlatBars, s.Cloud.LowerFlatHistoryBounded = edgeFlat(points, last, false)
		s.EdgeToEdge = edgeContext(candles, points, atr)
		s.Fibonacci = fibonacciContext(s.Cloud)
	}
	s.TKCross = latestCross(candles, points, false)
	s.PKCross = latestCross(candles, points, true)
	s.Extension = extensionContext(candles, points, s.Cloud, atr)
	calculateTwistsAndProjection(&s, candles, points)
	return s
}

func lineContext(points []Point, close float64, length int, atr *float64) KijunContext {
	c := KijunContext{Status: "insufficient", WarmupBars: length,
		DistanceATRStatus: "insufficient", SlopeStatus: "insufficient", Slope: "unavailable"}
	last := len(points) - 1
	if len(points) < length {
		return c
	}
	valueAt := func(i int) float64 {
		if length == TenkanLength {
			return *points[i].Tenkan
		}
		return *points[i].Kijun
	}
	value := valueAt(last)
	c.Status, c.Value = "ready", pointer(value)
	c.DistanceATRStatus, c.DistanceATR = normalizedDistance(close-value, atr)
	if len(points) == length {
		return c
	}
	change := value - valueAt(last-1)
	c.SlopeStatus, c.Slope, c.Change1Bar = "ready", movement(change, "rising", "falling"), pointer(change)
	flatBars := 0
	for i := last - 1; i >= length-1 && valueAt(i) == value; i-- {
		flatBars++
	}
	c.FlatBars, c.FlatHistoryBounded = pointer(flatBars), flatBars == len(points)-length
	return c
}

func movement(change float64, positive, negative string) string {
	if change > 0 {
		return positive
	}
	if change < 0 {
		return negative
	}
	return "flat"
}

func cloudColor(a, b float64) string {
	return movement(a-b, "green", "red")
}

func bounds(p Point) (float64, float64) {
	return math.Min(*p.SpanA, *p.SpanB), math.Max(*p.SpanA, *p.SpanB)
}

func position(value, lower, upper float64) string {
	if value > upper {
		return "above"
	}
	if value < lower {
		return "below"
	}
	return "inside"
}

func edgeFlat(points []Point, at int, upper bool) (*int, bool) {
	if at < CloudWarmupBars {
		return nil, false
	}
	valueAt := func(i int) float64 {
		lo, hi := bounds(points[i])
		if upper {
			return hi
		}
		return lo
	}
	value, flatBars := valueAt(at), 0
	for i := at - 1; i >= CloudWarmupBars-1 && valueAt(i) == value; i-- {
		flatBars++
	}
	return pointer(flatBars), flatBars == at-(CloudWarmupBars-1)
}

func sign(value float64) int {
	if value > 0 {
		return 1
	}
	if value < 0 {
		return -1
	}
	return 0
}

func latestCross(candles []market.Candle, points []Point, priceCross bool) *CrossEvent {
	var latest *CrossEvent
	previousSide := 0
	for i := KijunLength - 1; i < len(points); i++ {
		moving := *points[i].Tenkan
		if priceCross {
			moving = candles[i].Close
		}
		side := sign(moving - *points[i].Kijun)
		if side == 0 {
			continue
		}
		if previousSide != 0 && side != previousSide {
			previousMoving := *points[i-1].Tenkan
			kind := "tk"
			if priceCross {
				previousMoving, kind = candles[i-1].Close, "pk"
			}
			e := CrossEvent{Time: candles[i].CloseTime, Direction: movement(float64(side), "bullish", "bearish"),
				Kind: kind, Strength: "invalid", CloudPosition: "unavailable", CloudColor: "unavailable",
				MovingChange1Bar: moving - previousMoving, KijunChange1Bar: *points[i].Kijun - *points[i-1].Kijun,
				AgeBars: len(points) - 1 - i}
			if points[i].SpanA != nil {
				lower, upper := bounds(points[i])
				e.CloudPosition = position(*points[i].Kijun, lower, upper)
				e.CloudColor = cloudColor(*points[i].SpanA, *points[i].SpanB)
			}
			e.Valid = sign(e.MovingChange1Bar) == side
			if !e.Valid {
				e.Kind += "_kijun_driven"
				e.Reason = "Kijun moved through a flat or oppositely moving line; this is not the lecture's valid directional cross."
			} else {
				e.Strength, e.Reason = "less_confluent", "The moving line crossed Kijun; favorable cloud position and color are not both aligned."
				if points[i].SpanA == nil {
					e.Reason = "The cross is geometrically valid; displayed-cloud history is unavailable, so entry context is unconfirmed."
				} else {
					lower, upper := bounds(points[i])
					pricePosition := position(candles[i].Close, lower, upper)
					e.EntryEligible = e.CloudPosition != "inside" && pricePosition != "inside"
					if !e.EntryEligible {
						e.Strength, e.Reason = "ignored_in_cloud", "The Kijun crossing reference or completed price is inside the displayed cloud; ignore as an entry."
					} else if side > 0 && e.CloudPosition == "above" && pricePosition == "above" && e.CloudColor == "green" ||
						side < 0 && e.CloudPosition == "below" && pricePosition == "below" && e.CloudColor == "red" {
						e.Strength, e.Reason = "stacked", "Directional cross, price and crossing reference align with the favorable cloud side and color."
					}
				}
				if !priceCross && side > 0 && e.KijunChange1Bar < 0 {
					e.Kind = "tk_exceptional_bullish"
					if e.Strength != "ignored_in_cloud" {
						e.Strength, e.Reason = "mild", "Rising Tenkan crosses falling Kijun: the lecture's exceptional, mildly bullish case."
					}
				}
			}
			latest = &e
		}
		previousSide = side
	}
	return latest
}

func calculateTwistsAndProjection(s *LectureSnapshot, candles []market.Candle, points []Point) {
	previousSide := 0
	duration := candles[0].CloseTime - candles[0].OpenTime + 1
	const maxSafeInteger = int64(1<<53 - 1)
	for i := SpanBLength - 1; i < len(candles); i++ {
		a := average(*points[i].Tenkan, *points[i].Kijun)
		b := midpoint(candles[i+1-SpanBLength : i+1])
		displayedAt := candles[i].CloseTime + DisplacementBars*duration
		if displayedAt > maxSafeInteger {
			// Unrepresentable display timestamps are withheld, never rounded.
			continue
		}
		if i+DisplacementBars >= len(candles) {
			s.Projection = append(s.Projection, CloudPoint{CalculatedAt: candles[i].CloseTime,
				DisplayedAt: displayedAt, SpanA: a, SpanB: b})
		}
		side := sign(a - b)
		if side == 0 {
			continue
		}
		if previousSide != 0 && side != previousSide {
			e := TwistEvent{CalculatedAt: candles[i].CloseTime, DisplayedAt: displayedAt,
				Direction: movement(float64(side), "bullish", "bearish"), Scope: "displayed", AgeBars: len(candles) - 1 - i}
			if i+DisplacementBars >= len(candles) {
				e.Scope = "projected"
				s.ProjectedTwist = &e
			} else {
				s.CurrentTwist = &e
			}
			s.TwistsObserved++
		}
		previousSide = side
	}
	s.AlternatingTwists = s.TwistsObserved >= 2
}

func fibonacciContext(cloud LectureCloud) CloudFibonacci {
	c := CloudFibonacci{Status: "not_applicable", Levels: []FibonacciLevel{},
		Reason: "The lecture's cloud Fibonacci example requires green color and both current edges flat."}
	if cloud.Color != "green" || cloud.UpperFlatBars == nil || *cloud.UpperFlatBars == 0 ||
		cloud.LowerFlatBars == nil || *cloud.LowerFlatBars == 0 {
		return c
	}
	c.Status, c.Lower, c.Reason, c.Upper = "ready", clonePointer(cloud.Lower),
		"Measured references from the current flat low (0) to flat high (1); no automatic confluence tolerance.", clonePointer(cloud.Upper)
	for _, ratio := range []float64{0.236, 0.382, 0.5, 0.618, 0.786} {
		c.Levels = append(c.Levels, FibonacciLevel{Ratio: ratio, Price: *c.Lower + (*c.Upper-*c.Lower)*ratio})
	}
	return c
}

func extensionContext(candles []market.Candle, points []Point, cloud LectureCloud, atr *float64) Extension {
	c := Extension{Status: "insufficient", PriceKijunATRStatus: "insufficient", GapATRStatus: "insufficient",
		Direction: "unavailable", Reason: "Distances are measurements; the lecture supplies no extension or thin-cloud cutoff."}
	last := len(points) - 1
	if last < KijunLength-1 {
		return c
	}
	distance := candles[last].Close - *points[last].Kijun
	gap := math.Abs(*points[last].Tenkan - *points[last].Kijun)
	c.Status, c.PriceKijunDistance, c.TenkanKijunGap = "ready", pointer(distance), pointer(gap)
	c.Direction = movement(distance, "above_kijun", "below_kijun")
	c.PriceKijunATRStatus, c.PriceKijunDistanceATR = normalizedDistance(distance, atr)
	c.GapATRStatus, c.TenkanKijunGapATR = normalizedDistance(gap, atr)
	if last > KijunLength-1 {
		c.GapChange1Bar = pointer(gap - math.Abs(*points[last-1].Tenkan-*points[last-1].Kijun))
	}
	c.CloudWidthChange1Bar = clonePointer(cloud.WidthChange1Bar)
	if c.GapChange1Bar != nil && c.CloudWidthChange1Bar != nil {
		c.ThinningWithWideningGap = *c.GapChange1Bar > 0 && *c.CloudWidthChange1Bar < 0
		if c.ThinningWithWideningGap {
			c.Reason = "Displayed cloud narrowed while the absolute Tenkan–Kijun gap widened over one completed bar: lecture retracement caution, without predicting timing or direction."
		}
	}
	return c
}

func edgeContext(candles []market.Candle, points []Point, atr *float64) EdgeToEdge {
	c := EdgeToEdge{Status: "no_entry", Direction: "unavailable", WidthATRStatus: "insufficient",
		RetestStatus: "unavailable", Reason: "No observed completed outside-to-inside close in the available cloud history."}
	entryIndex, measuredIndex := -1, -1
	for i := CloudWarmupBars; i < len(points); i++ {
		lower, upper := bounds(points[i])
		prevLower, prevUpper := bounds(points[i-1])
		currentPosition := position(candles[i].Close, lower, upper)
		previousPosition := position(candles[i-1].Close, prevLower, prevUpper)
		if currentPosition == "inside" && previousPosition != "inside" {
			entryIndex, measuredIndex = i, i
			c = EdgeToEdge{Status: "active", Direction: "bullish", EnteredAt: pointer(candles[i].CloseTime),
				EntryEdge: pointer(lower), OppositeEdge: pointer(upper), Width: pointer(upper - lower),
				RetestStatus: "awaiting_retest", Reason: "Completed close entered the cloud; significant width is a discretionary lecture condition, not a numeric cutoff."}
			if previousPosition == "above" {
				c.Direction, c.EntryEdge, c.OppositeEdge = "bearish", pointer(upper), pointer(lower)
			}
			if upper == lower {
				c.Status, c.Reason = "zero_width", "The close entered a zero-width cloud; there is no distinct opposite-edge distance."
			}
			continue
		}
		if c.Status != "active" {
			continue
		}
		measuredIndex = i
		c.Width, c.OppositeEdge = pointer(upper-lower), pointer(upper)
		if c.Direction == "bearish" {
			c.OppositeEdge = pointer(lower)
		}
		lost := c.Direction == "bullish" && candles[i].Close < *c.EntryEdge ||
			c.Direction == "bearish" && candles[i].Close > *c.EntryEdge
		if lost {
			c.Status, c.RetestStatus, c.Reason = "entry_lost", "failed", "A later completed close lost the original cloud entry edge."
			continue
		}
		if candles[i].Low <= *c.EntryEdge && candles[i].High >= *c.EntryEdge {
			c.RetestStatus, c.RetestedAt = "held", pointer(candles[i].CloseTime)
		}
		targetReached := c.Direction == "bullish" && candles[i].High >= *c.OppositeEdge ||
			c.Direction == "bearish" && candles[i].Low <= *c.OppositeEdge
		if targetReached {
			c.Status, c.Reason = "opposite_edge_reached", "A later candle's range reached the then-displayed opposite edge; this is an observation, not a fill or trade outcome."
		}
	}
	if entryIndex < 0 {
		last := len(points) - 1
		lower, upper := bounds(points[last])
		if position(candles[last].Close, lower, upper) == "inside" {
			c.Status, c.Reason = "inside_without_entry", "The close is inside the cloud, but no outside-to-inside entry close is observed in available history."
		}
		return c
	}
	c.AgeBars = pointer(len(points) - 1 - entryIndex)
	c.WidthATRStatus, c.WidthATR = normalizedDistance(*c.Width, atr)
	c.OppositeFlatBars, _ = edgeFlat(points, measuredIndex, c.Direction == "bullish")
	c.OppositeFlat = c.OppositeFlatBars != nil && *c.OppositeFlatBars > 0
	if c.Status == "active" {
		if c.OppositeFlat {
			c.Reason = "The current opposite edge is flat, matching the lecture's stronger edge-to-edge context; cloud width remains a measured discretionary condition."
		} else {
			c.Reason = "The opposite edge is not flat; the lecture calls for a held retest and rechecking the then-current opposite edge."
		}
	}
	return c
}

// CloneLectureSnapshot owns every pointer and backing slice independently.
func CloneLectureSnapshot(s LectureSnapshot) LectureSnapshot {
	s.AsOf = clonePointer(s.AsOf)
	s.Tenkan = CloneSnapshot(Snapshot{Kijun: s.Tenkan}).Kijun
	s.Kijun = CloneSnapshot(Snapshot{Kijun: s.Kijun}).Kijun
	s.Cloud.CloudContext = CloneSnapshot(Snapshot{Cloud: s.Cloud.CloudContext}).Cloud
	s.Cloud.Width = clonePointer(s.Cloud.Width)
	s.Cloud.WidthATR = clonePointer(s.Cloud.WidthATR)
	s.Cloud.WidthChange1Bar = clonePointer(s.Cloud.WidthChange1Bar)
	s.Cloud.UpperFlatBars = clonePointer(s.Cloud.UpperFlatBars)
	s.Cloud.LowerFlatBars = clonePointer(s.Cloud.LowerFlatBars)
	s.TKCross, s.PKCross = clonePointer(s.TKCross), clonePointer(s.PKCross)
	s.CurrentTwist, s.ProjectedTwist = clonePointer(s.CurrentTwist), clonePointer(s.ProjectedTwist)
	s.EdgeToEdge.EnteredAt = clonePointer(s.EdgeToEdge.EnteredAt)
	s.EdgeToEdge.AgeBars = clonePointer(s.EdgeToEdge.AgeBars)
	s.EdgeToEdge.EntryEdge = clonePointer(s.EdgeToEdge.EntryEdge)
	s.EdgeToEdge.OppositeEdge = clonePointer(s.EdgeToEdge.OppositeEdge)
	s.EdgeToEdge.OppositeFlatBars = clonePointer(s.EdgeToEdge.OppositeFlatBars)
	s.EdgeToEdge.Width = clonePointer(s.EdgeToEdge.Width)
	s.EdgeToEdge.WidthATR = clonePointer(s.EdgeToEdge.WidthATR)
	s.EdgeToEdge.RetestedAt = clonePointer(s.EdgeToEdge.RetestedAt)
	s.Fibonacci.Lower, s.Fibonacci.Upper = clonePointer(s.Fibonacci.Lower), clonePointer(s.Fibonacci.Upper)
	if s.Fibonacci.Levels != nil {
		s.Fibonacci.Levels = append([]FibonacciLevel{}, s.Fibonacci.Levels...)
	}
	s.Extension.PriceKijunDistance = clonePointer(s.Extension.PriceKijunDistance)
	s.Extension.PriceKijunDistanceATR = clonePointer(s.Extension.PriceKijunDistanceATR)
	s.Extension.TenkanKijunGap = clonePointer(s.Extension.TenkanKijunGap)
	s.Extension.TenkanKijunGapATR = clonePointer(s.Extension.TenkanKijunGapATR)
	s.Extension.GapChange1Bar = clonePointer(s.Extension.GapChange1Bar)
	s.Extension.CloudWidthChange1Bar = clonePointer(s.Extension.CloudWidthChange1Bar)
	if s.Projection != nil {
		s.Projection = append([]CloudPoint{}, s.Projection...)
	}
	if s.Conventions != nil {
		s.Conventions = append([]string{}, s.Conventions...)
	}
	return s
}

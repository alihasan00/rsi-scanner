// Package momentum describes completed-candle RSI and divergence observations.
// RSI reaching 50 is an oscillator outcome, never a trade return or fill.
package momentum

const (
	RSILength  = 14
	SMALength  = 14
	ChangeBars = 3
)

// Rules makes the adapted rsi-scanner lecture conventions explicit. These
// settings describe evidence; they do not add mandatory selection filters.
type Rules struct {
	LeftBars             int    `json:"leftBars"`
	RightBars            int    `json:"rightBars"`
	ProvisionalBars      int    `json:"provisionalBars"`
	MinBars              int    `json:"minBars"`
	MaxBars              int    `json:"maxBars"`
	IncludeHidden        bool   `json:"includeHidden"`
	RequireBodyAgreement bool   `json:"requireBodyAgreement"`
	RequireSameRSICycle  bool   `json:"requireSameRsiCycle"`
	InvalidationAnchor   string `json:"invalidationAnchor"`
	ExpiryBars           int    `json:"expiryBars"`
	RecentResolvedBars   int    `json:"recentResolvedBars"`
	MaxDivergences       int    `json:"maxDivergences"`
}

func DefaultRules() Rules {
	return Rules{LeftBars: 5, RightBars: 5, ProvisionalBars: 5, MinBars: 5, MaxBars: 60,
		IncludeHidden: true, RequireBodyAgreement: true, RequireSameRSICycle: true,
		InvalidationAnchor: "second", ExpiryBars: 14, RecentResolvedBars: 4, MaxDivergences: 8}
}

// Cross uses adjacent completed samples: previous <=50/current >50 is bullish,
// previous >=50/current <50 is bearish. A touch of 50 alone is not a cross.
type Cross struct {
	Direction string  `json:"direction"`
	At        int64   `json:"at"`
	From      float64 `json:"from"`
	To        float64 `json:"to"`
}

// Pivot.AvailableAt is when the pivot could be used. The first anchor is
// mature after five right-hand closes; the second is provisional at its close.
type Pivot struct {
	OpenTime    int64   `json:"openTime"`
	CloseTime   int64   `json:"closeTime"`
	AvailableAt int64   `json:"availableAt"`
	Mature      bool    `json:"mature"`
	Price       float64 `json:"price"`
	BodyPrice   float64 `json:"bodyPrice"`
	RSI         float64 `json:"rsi"`
}

type Confirmation struct {
	OpenTime  int64   `json:"openTime"`
	CloseTime int64   `json:"closeTime"`
	Open      float64 `json:"open"`
	Close     float64 `json:"close"`
	RSI       float64 `json:"rsi"`
	Strength  string  `json:"strength"`
}

type Divergence struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Direction  string `json:"direction"`
	State      string `json:"state"`
	Start      Pivot  `json:"start"`
	End        Pivot  `json:"end"`
	DetectedAt int64  `json:"detectedAt"`
	// AvailableAt is the first close observing the current state.
	AvailableAt  int64         `json:"availableAt"`
	ConfirmedAt  *int64        `json:"confirmedAt"`
	ResolvedAt   *int64        `json:"resolvedAt"`
	Confirmation *Confirmation `json:"confirmation"`
	// AgeBars counts completed bars since AvailableAt; confirmation is age zero.
	AgeBars             int  `json:"ageBars"`
	BarsSinceDetection  int  `json:"barsSinceDetection"`
	BarsSinceResolution *int `json:"barsSinceResolution"`
	// BarsElapsed counts closes after price confirmation; confirmation is zero.
	BarsElapsed      int     `json:"barsElapsed"`
	ExpiryBars       int     `json:"expiryBars"`
	InvalidationRSI  float64 `json:"invalidationRsi"`
	ResolutionReason string  `json:"resolutionReason"`
}

// Snapshot.Status describes RSI availability. SMA, three-bar change and
// divergence have separate readiness. Nulls mean unavailable, never zero.
// DivergenceTotal counts active and recently resolved observations before the
// display bound, not every setup ever found in the supplied history.
type Snapshot struct {
	Status            string       `json:"status"`
	AsOf              *int64       `json:"asOf"`
	ClosedBars        int          `json:"closedBars"`
	WarmupBars        int          `json:"warmupBars"`
	RSI               *float64     `json:"rsi"`
	RSIState          string       `json:"rsiState"`
	RSISMA14          *float64     `json:"rsiSma14"`
	SMAStatus         string       `json:"smaStatus"`
	RSIChange3        *float64     `json:"rsiChange3"`
	ChangeStatus      string       `json:"changeStatus"`
	Last50Cross       *Cross       `json:"last50Cross"`
	DivergenceStatus  string       `json:"divergenceStatus"`
	DivergenceRules   Rules        `json:"divergenceRules"`
	Divergences       []Divergence `json:"divergences"`
	DivergenceTotal   int          `json:"divergenceTotal"`
	DivergenceOmitted int          `json:"divergenceOmitted"`
	Warnings          []string     `json:"warnings"`
}

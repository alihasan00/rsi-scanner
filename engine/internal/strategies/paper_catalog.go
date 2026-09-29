package strategies

// PaperFamilies is the crypto project's 29 September 2026 fresh paper roster.
// Historical scanner families remain available to the dedicated Ichimoku view
// and to existing regression tests, but do not enter the mixed Watchlist.
var PaperFamilies = []string{
	"donchian55_atr_trail",
	"donchian55_atr_trail_stoch",
	"donchian55_atr_trail_macd",
	"donchian55_atr_trail_adx_range",
	"cloud_reclaim_volume_2r",
	"cloud_reclaim_volume_2r_ema",
	"cloud_reclaim_volume_2r_sma",
	"cloud_reclaim_volume_2r_supertrend",
	"cloud_reclaim_volume_2r_ao",
	"cloud_reclaim_volume_2r_sma_ema_macd",
	"fresh_weekly_range_long",
	"tk_cross_rsi",
}

func PaperFamilyFrame(family string) string {
	if family == PaperFreshWeeklyRangeLong {
		return "4h"
	}
	for _, selected := range PaperFamilies {
		if selected == family {
			return "1d"
		}
	}
	return ""
}

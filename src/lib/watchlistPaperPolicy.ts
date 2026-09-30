export const isTrailingPaperProfile = (family: string) => family.startsWith('donchian55_atr_trail') || family.startsWith('combo_trendlines_')
export const isOpeningTargetProfile = (family: string) => family === 'combo_nwe_rsi_ultimate_15m'
export const PAPER_HISTORY_NOTE = 'The browser keeps up to 500 completed daily and four-hour candles and 999 fifteen-minute candles. Longer stored history in the crypto app can change recursive indicators, persistent helper states and signals. Missing history is never synthesized.'
export const OPENING_TARGET_NOTE = 'Target = raw opening + 2 × (raw opening − initial stop). It is set only when the trade opens; no trail or opposite-signal exit. Maximum holding: 24 fifteen-minute bars.'

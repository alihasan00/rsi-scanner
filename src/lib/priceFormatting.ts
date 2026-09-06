/** Keep small quote prices readable without rounding a nonzero price to zero. */
export function formatQuotePrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '—'

  // Eight significant digits retain useful tick precision across token prices.
  // Very small values use significant digits directly to avoid a decimal cap.
  if (price < 0.00000001) {
    return price.toLocaleString('en-US', { maximumSignificantDigits: 8 })
  }

  const maximumFractionDigits = Math.max(2, 7 - Math.floor(Math.log10(price)))
  return price.toLocaleString('en-US', {
    minimumFractionDigits: price >= 1 ? 2 : 0,
    maximumFractionDigits,
  })
}

export function formatLevelDistance(levelPrice: number, currentPrice: number): string {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return '—'
  const distance = Math.abs((levelPrice - currentPrice) / currentPrice) * 100
  if (distance > 0 && distance < 0.01) return '<0.01%'
  return `${distance.toFixed(2)}%`
}

/** "0.42% below price", "0.05% above price", or "At price". */
export function describeLevelDistance(levelPrice: number, currentPrice: number): string {
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return '—'
  if (levelPrice === currentPrice) return 'At price'
  const side = levelPrice < currentPrice ? 'below' : 'above'
  return `${formatLevelDistance(levelPrice, currentPrice)} ${side} price`
}

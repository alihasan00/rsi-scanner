import type { Candle } from '../../src/types'
import type { IchimokuLectureSnapshot, IchimokuPoint } from '../../src/lib/watchlistIchimoku'

/** Deliberately supplied engine numbers, not a second indicator implementation. */
export function ichimokuFixture(candles: readonly Candle[]): { reading: IchimokuLectureSnapshot; series: IchimokuPoint[] } {
  const last = candles.at(-1)!
  const duration = last.closeTime - last.openTime + 1
  const line = { status: 'ready', warmupBars: 60, value: 97.12345, distanceATRStatus: 'ready', distanceATR: 0.51,
    slopeStatus: 'ready', slope: 'flat', change1Bar: 0, flatBars: 4, flatHistoryBounded: false }
  const series = candles.map((candle, index) => ({ time: candle.closeTime, tenkan: 100.12345, kijun: 97.12345,
    spanA: index >= 30 ? 98.12345 : null, spanB: index >= 30 ? 93.12345 : null,
    calculatedAt: index >= 30 ? candles[index - 30].closeTime : null }))
  const reading: IchimokuLectureSnapshot = {
    status: 'ready', asOf: last.closeTime, bars: candles.length,
    tenkan: { ...line, warmupBars: 20, value: 100.12345 }, kijun: line,
    cloud: { status: 'ready', warmupBars: 150, spanA: 98.12345, spanB: 93.12345, lower: 93.12345, upper: 98.12345,
      position: 'above', calculatedAt: candles[Math.max(0, candles.length - 31)].closeTime, displayedAt: last.closeTime,
      color: 'green', width: 5, widthATRStatus: 'ready', widthATR: 0.75, widthChange1Bar: -1, widthTrend: 'thinning',
      upperFlatBars: 3, lowerFlatBars: 4, upperFlatHistoryBounded: false, lowerFlatHistoryBounded: true,
      supportResistance: 'support', trendContext: 'bullish' },
    tkCross: { time: candles.at(-2)!.closeTime, direction: 'bullish', valid: true, entryEligible: true,
      kind: 'tk_cross', strength: 'stacked', reason: 'Tenkan crossed above Kijun outside a green cloud.',
      cloudPosition: 'above', cloudColor: 'green', movingChange1Bar: 2, kijunChange1Bar: 0, ageBars: 1 },
    pkCross: { time: candles.at(-2)!.closeTime, direction: 'bearish', valid: false, entryEligible: false,
      kind: 'kijun_driven', strength: 'excluded', reason: 'Moving Kijun crossed unchanged price.',
      cloudPosition: 'above', cloudColor: 'green', movingChange1Bar: 0, kijunChange1Bar: 1, ageBars: 1 },
    currentTwist: { calculatedAt: candles[0].closeTime, displayedAt: candles[Math.min(30, candles.length - 1)].closeTime,
      direction: 'bullish', scope: 'displayed', ageBars: 2 },
    projectedTwist: { calculatedAt: last.closeTime, displayedAt: last.closeTime + duration * 30, direction: 'bearish', scope: 'projected', ageBars: 0 },
    twistsObserved: 4, alternatingTwists: true,
    edgeToEdge: { status: 'observing', direction: 'bullish', enteredAt: candles.at(-2)!.closeTime, ageBars: 1,
      entryEdge: 93.12345, oppositeEdge: 98.12345, oppositeFlatBars: 3, oppositeFlat: true, width: 5,
      widthATRStatus: 'ready', widthATR: 0.75, retestStatus: 'held', retestedAt: last.closeTime, reason: 'Opposite cloud edge remains a reference.' },
    fibonacci: { status: 'ready', lower: 93.12345, upper: 98.12345, levels: [{ ratio: 0.236, price: 94.30345 }], reason: 'Flat green-cloud bounds.' },
    extension: { status: 'ready', priceKijunDistance: 3, priceKijunDistanceATR: 0.51, priceKijunATRStatus: 'ready',
      tenkanKijunGap: 3, tenkanKijunGapATR: 0.51, gapATRStatus: 'ready', gapChange1Bar: 1,
      cloudWidthChange1Bar: -1, thinningWithWideningGap: true, direction: 'bullish', reason: 'Possible retracement context, no timing guarantee.' },
    projection: candles.slice(-30).map((candle) => ({ calculatedAt: candle.closeTime, displayedAt: candle.closeTime + duration * 30, spanA: 101.12345, spanB: 97.12345 })),
    conventions: ['Actual +30-bar offset; exact equality defines flatness.', 'No numeric significant-width threshold.'],
  }
  return { reading, series }
}

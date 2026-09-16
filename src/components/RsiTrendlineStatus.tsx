import type { RsiTrendlineAnalysis } from '../lib/rsiTrendlineAnalysis'
import { trendlineStatusLabel } from '../lib/rsiTrendlineAnalysis'
import { formatSignalTime } from '../lib/divergencePresentation'
import './RsiTrendlines.css'

export function RsiTrendlineStatus({ analysis, compact = false }: { analysis: RsiTrendlineAnalysis; compact?: boolean }) {
  return <div className={`rsi-trendlines__status${compact ? ' is-compact' : ''}`} aria-label="RSI trendline status">
    {analysis.displayed.length === 0
      ? <span className="rsi-trendlines__empty">No qualifying trendline</span>
      : analysis.displayed.map((line) => <span
        key={line.id}
        className={`rsi-trendlines__badge is-${line.kind}`}
        title={`${line.kind === 'resistance' ? 'Falling resistance' : 'Rising support'} · ${line.touches} mature touches. Formed ${formatSignalTime(line.formedAt)} UTC.${line.brokenAt !== null ? ` Broke ${formatSignalTime(line.brokenAt)} UTC. ${line.barsSinceBreak === 0 ? 'Latest close.' : `${line.barsSinceBreak} closed candles ago.`}` : ''}`}
      >{trendlineStatusLabel(line)}</span>)}
    {analysis.noLongs && <span className="rsi-trendlines__warning">No longs · RSI support broken</span>}
  </div>
}

export function RsiTrendlineGuide() {
  return <div className="rsi-trendlines__guide">
    <p>Choose RSI trendlines in Filters to see automatic trendlines. Choose RSI divergences to see divergence setups. The two overlays are shown separately.</p>
    <p>Amber marks falling resistance. Blue marks rising support. Dots mark mature anchors; the dashed part extends the line. A circle marks a closed-candle break.</p>
    <p>Anchors come from one RSI 50 cycle and wait for five later candles to close. A line can continue into the next cycle. An ideal break happens on the opposite side of 50 from its anchors; a non-ideal break is weaker context.</p>
    <p>Approaching means the last closed RSI is within two points of the line; it does not predict a break. No longs marks a recent support breakdown, until RSI closes back on or above the line or the warning expires after 12 candles.</p>
    <p>These lines are one confluence. Use price analysis for entries and retests. Sideways or steep structures may produce no qualifying line.</p>
  </div>
}

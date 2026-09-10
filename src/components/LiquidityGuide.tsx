export function LiquidityGuide() {
  return <div className="liquidity-guide">
    <p><strong>Read the reaction at the level.</strong> Below the live price, a level is potential support; above it, potential resistance. Its role can change when price crosses it.</p>
    <dl>
      <div><dt>Calendar liquidity</dt><dd>Previous week and previous month: open, high, low and close. Monday: the completed daily candle’s body high, body low and midpoint. These are areas where price may seek liquidity.</dd></div>
      <div><dt>Swing failure pattern (SFP)</dt><dd>A bullish sweep wicks below a level and closes back above. A bearish sweep wicks above and closes back below. The previous close must be on the approach side. The tab shows the latest 3 closed candles; a forming sweep is provisional.</dd></div>
      <div><dt>Timeframe & refresh</dt><dd>The selected timeframe controls the reaction candles. The calendar levels stay anchored to their original periods. All boundaries use Binance UTC; week and month refresh after closing, Monday’s body after Monday closes. Monday levels are hidden on daily and higher charts.</dd></div>
      <div><dt>The rest of the lecture</dt><dd>Fib retracements supported by anchored volume profile, VSA-cluster points of control, and the 4h boxes still require a manual chart review. Their selection rules are discretionary in the notes, so this tab does not estimate them. A calendar level is not a volume-profile-confirmed zone.</dd></div>
    </dl>
    <p className="liquidity-guide__note">A touch is a place to watch. A confirmed sweep describes a completed candle; it is not an entry instruction. No orders are placed.</p>
  </div>
}

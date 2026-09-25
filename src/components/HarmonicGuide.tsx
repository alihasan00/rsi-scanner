import { HARMONIC_C_RANGE, HARMONIC_RATIOS, HARMONIC_TARGET_RATIOS } from '../lib/harmonics'
import { HARMONIC_NAMES } from '../lib/harmonicRows'
import './Harmonic.css'

export function HarmonicGuide() {
  return <div className="harmonic-guide">
    <p>Gartley, Bat, and Butterfly use the same X–A–B–C–D shape. The direction of X→A sets the possible reversal direction at D.</p>
    <ol>
      <li><strong>B identifies the pattern.</strong> Its retracement of X→A must fit one of the three ratio bands.</li>
      <li><strong>C validates the shape.</strong> It must retrace {HARMONIC_C_RANGE.join('–')} of A→B. A wick beyond the outer C boundary ends the setup only before D is touched.</li>
      <li><strong>D is the possible entry zone.</strong> Early setups have not passed B. Approaching setups have passed B on the way to D. “D zone reached” means a closed candle touched D and price has not yet reached the first target, hit the stop boundary, or drifted away for 12 candles.</li>
    </ol>
    <p>A dashed C→D leg is a projection with no predicted arrival time. Live price can enter a zone or cross a boundary, but it cannot confirm the pattern’s stage.</p>
    <p><strong>D touch and D pivot are separate events.</strong> The original D point marks first contact on a closed candle. A diamond marks a D pivot once three closed candles on each side confirm its local extreme. The pivot’s time and the time it became available appear separately in the details. This extra observation does not confirm a reversal or move the original target references.</p>
    <p><strong>Ratio fit compares B and C geometry on a 0–100 scale.</strong> Ratios inside the lesson’s ideal bands score 100; fit declines toward the accepted outer boundaries. The optional “Best ratio fit” sort chooses the highest-scoring matching setup for each pair. Watchlist order remains the default. PRZ agreement, D fit, leg durations and age are separate context, not a success probability or extra live filters.</p>
    <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Ratio bands · linear price</caption><thead><tr><th>Pattern</th><th>B / XA</th><th>D / XA</th></tr></thead><tbody>
      {(Object.keys(HARMONIC_RATIOS) as (keyof typeof HARMONIC_RATIOS)[]).map((kind) => <tr key={kind}><th>{HARMONIC_NAMES[kind]}</th><td>{HARMONIC_RATIOS[kind].b.join('–')}</td><td>{HARMONIC_RATIOS[kind].d.join('–')}</td></tr>)}
    </tbody></table></div>
    <p>These are the saved template values shown in lesson 17. Butterfly’s D zone is narrowed where it overlaps the 1.4562–2.8798 extension of B→C; otherwise its full zone is retained.</p>
    <p>Before considering D, review nearby support or resistance and other confluence. The lessons also favor shapes with most candle closes inside the shaded triangles; judge that visually. Butterfly extends beyond X and needs particular care as a countertrend setup.</p>
    <p>Stops belong beyond X for Bat and Gartley and beyond the established D range for Butterfly, as in lesson 18. A wick between D and X is not an invalidation for Bat or Gartley; lesson 16 treats that pocket as where conventional stops get hunted. The chart gives structural boundaries; the stop buffer remains your choice.</p>
    <div className="harmonic-table-wrap"><table className="harmonic-table"><caption>Take-profit templates from lesson 17</caption><thead><tr><th>Pattern</th><th>Anchor</th><th>Ratios</th></tr></thead><tbody>{(Object.keys(HARMONIC_TARGET_RATIOS) as (keyof typeof HARMONIC_TARGET_RATIOS)[]).map((kind) => <tr key={kind}><th>{HARMONIC_NAMES[kind]}</th><td>{kind === 'butterfly' ? 'C→D' : 'A→D'}</td><td>{HARMONIC_TARGET_RATIOS[kind].join(' · ')}</td></tr>)}</tbody></table></div>
    <p>Before a D touch, target prices use the zone midpoint as a reference. After a closed touch they use the first observed D extreme. These are planning levels, with no assumed order fills or profit outcomes.</p>
    <p className="harmonic-guide__note">Scanner convention: strict pivots confirmed by three closed candles on each side, with discovery from up to 500 contiguous closed candles. Existing setup history can continue as this window rolls. Earlier anchor points remain visible when their candles have left the window; a history notice identifies restored or rebuilt analysis. Legs follow the lesson drawing: A is the extreme of the window, B the deepest retracement between A and C, C the extreme after B, and X the extreme before A. A later more extreme C redraws the same pattern. Unfilled setups expire after 60 candles from C. A wick beyond the stop boundary retires the setup; this is not a recorded stop execution. These are detection conventions, not additional lecture rules.</p>
    <p className="harmonic-guide__note">The historical comparison tests four rules on chronological training, validation and holdout periods, including fees and slippage. It uses a common ATR stop/target benchmark and does not simulate the lesson’s chart target allocations. Running research never changes the live scanner.</p>
  </div>
}

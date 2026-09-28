import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScreenerGrid } from '../src/components/ScreenerGrid'
import { useScannerStore } from '../src/store/scannerStore'

test('Ichimoku renders as the selected market indicator without RSI controls or stale RSI pair counts', async () => {
  // Server rendering reads Zustand's initial snapshot rather than its current
  // client state. Restore the exact snapshot fields after checking both markets.
  const initialState = useScannerStore.getInitialState()
  const original = { appView: initialState.appView, market: initialState.market, screenerFilters: initialState.screenerFilters }
  try {
    for (const market of ['spot', 'tradfi'] as const) {
      initialState.appView = 'scanner'
      initialState.market = market
      initialState.screenerFilters = { ...original.screenerFilters, signal: 'ichimoku', rsiState: 'overbought', sort: 'rsi-high' }
      const html = renderToStaticMarkup(createElement(ScreenerGrid, { universe: {
        market, symbols: ['BTCUSDT', 'ETHUSDT'], status: 'ready', error: null, retry: () => {},
      } }))
      let selectedIndicator = ''
      let summaries = 0
      let rsiSorts = 0
      const rewriter = new HTMLRewriter()
        .on('[role="tab"][aria-selected="true"]', { text(chunk) { selectedIndicator += chunk.text } })
        .on('.screener__view-summary', { element() { summaries++ } })
        .on('[aria-label="Sort pairs"]', { element() { rsiSorts++ } })
      await rewriter.transform(new Response(html)).text()
      expect(selectedIndicator).toBe('Ichimoku Cloud')
      expect(summaries).toBe(0)
      expect(rsiSorts).toBe(0)
      expect(html).toContain('aria-label="Screener indicator"')
      expect(html).toContain('screener is-ichimoku')
      expect(html).toContain('Harmonic Patterns')
      expect(html).toContain('Support &amp; Resistance')
    }
  } finally {
    Object.assign(initialState, original)
  }
})

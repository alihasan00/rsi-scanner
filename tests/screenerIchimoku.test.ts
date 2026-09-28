import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ScreenerGrid } from '../src/components/ScreenerGrid'
import { Watchlist } from '../src/components/Watchlist'
import { TIMEFRAME_MILLISECONDS } from '../src/lib/binanceHistory'
import type { Timeframe } from '../src/types'
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

test('Ichimoku uses the shared timeframe picker and describes only the selected source frame', () => {
  const initialState = useScannerStore.getInitialState()
  const originalTimeframe = initialState.timeframe
  const universe = { market: 'spot' as const, symbols: [], status: 'ready' as const, error: null, retry: () => {} }
  try {
    for (const timeframe of Object.keys(TIMEFRAME_MILLISECONDS) as Timeframe[]) {
      initialState.timeframe = timeframe
      const html = renderToStaticMarkup(createElement(Watchlist, { universe, scope: 'ichimoku', timeframe }))
      expect(html).toContain('aria-label="Choose timeframe"')
      expect(html).toContain(`setups on ${timeframe} candles.`)
      expect(html).toContain(`All active ${timeframe} Ichimoku setups.`)
      expect(html).not.toContain('checked together')
      expect(html).not.toContain('entry monitoring')
    }
    const mixed = renderToStaticMarkup(createElement(Watchlist, { universe }))
    expect(mixed).toContain('checked together')
    expect(mixed).not.toContain('aria-label="Choose timeframe"')
  } finally {
    initialState.timeframe = originalTimeframe
  }
})

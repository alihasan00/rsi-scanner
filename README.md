# RSI Scanner

A Vite + React + TypeScript port of `RSI Scanner.html`. It seeds Wilder RSI data from Binance REST, keeps each symbol current with combined kline WebSocket streams, and renders compact canvas charts plus an annotatable detail view.

## Development

```bash
bun install
bun run dev
```

Quality checks:

```bash
bun run lint
bun run build
```

## Architecture

- `src/store/scannerStore.ts` uses Zustand for shared UI state and persisted display preferences. Components subscribe through narrow selectors so unrelated changes do not fan out across the grid.
- `src/store/dataStore.ts` is intentionally a per-symbol external store. Market ticks notify only the matching card instead of running every grid selector on every update.
- `src/hooks/useRsiFeed.ts` owns REST/WebSocket lifecycle state, including cancellation when the timeframe changes.
- `src/lib/rsi.ts` contains the framework-independent RSI implementation.
- `ChartModal` and its Konva drawing dependencies are loaded only when a chart is opened.

The original standalone HTML file remains in the repository as a behavior reference.

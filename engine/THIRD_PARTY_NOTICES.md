# Preserved source notices

The imported code comes from `github.com/alihasan00/crypto`, frozen release
`0.13.1-26e07587190d`. Its per-file notices govern the imported files and are
retained verbatim. This document does not assign a blanket license to the
rest of this application.

- `internal/harmonic`: inspired by `harmonic.pine`, © reees; files carrying
  the notice are under [Mozilla Public License 2.0](https://www.mozilla.org/MPL/2.0/).
  The original source explicitly describes its independent reconstruction,
  not TradingView library parity.
- `internal/regime`: adaptive SuperTrend derived from SuperTrend AI
  (Clustering), © LuxAlgo; source and noted adaptation are under
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
- `internal/structure` and other indicator files carrying the same attribution:
  derived from the identified LuxAlgo sources; their retained headers specify
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
- `internal/strategies/paper_features.go`: the local directional indicator
  state port follows the Signal Forge [LuxAlgo] rules used by the crypto
  project's paper profiles. Signal Forge is © LuxAlgo and identified in the
  source as [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
  This port preserves the attribution and records its adaptation in
  `provenance.json`; it does not claim TradingView numeric parity.
- `public/watchlist-wasm-exec.js`: Go's WebAssembly runtime support, copyright
  The Go Authors, distributed with its original BSD-style notice. It is copied
  from the same Go 1.26.8 toolchain used to build the artifact.

The imported source is available under `engine/internal/`. Exact original
hashes, the boundary-constant import adaptation, local Ichimoku amendments and
paper-profile port are documented in `provenance.json`. No indicator formula or
selection gate is changed by the boundary-constant adaptation. The separate
Ichimoku lecture extension and paper Watchlist are identified by the local
release suffix and per-file amendment notes. `internal/browserengine` and
`cmd/watchlist-*` are local adapters.

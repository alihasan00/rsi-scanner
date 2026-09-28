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
- `public/watchlist-wasm-exec.js`: Go's WebAssembly runtime support, copyright
  The Go Authors, distributed with its original BSD-style notice. It is copied
  from the same Go 1.26.8 toolchain used to build the artifact.

The imported source is available under `engine/internal/`. Exact original
hashes and the boundary-constant import adaptation are documented in
`provenance.json`. No indicator formula or selection gate is changed by that
adaptation. `internal/browserengine` and `cmd/watchlist-*` are new adapters.

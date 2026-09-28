/* global importScripts, Go */
// Runs the frozen Go rules away from the interface. This worker has no order,
// account, database or AI connection; market history arrives from the page.
importScripts(new URL('./watchlist-wasm-exec.js', self.location.href).href)
const boot = (async () => {
  const go = new Go()
  const response = await fetch(new URL('./watchlist-engine.wasm', self.location.href))
  if (!response.ok) throw new Error(`Watchlist engine unavailable (${response.status})`)
  const bytes = await response.arrayBuffer()
  const { instance } = await WebAssembly.instantiate(bytes, go.importObject)
  void go.run(instance).catch((error) => self.postMessage({type: 'error', message: error.message}))
  if (typeof globalThis.goWatchlistScan !== 'function') throw new Error('Watchlist engine did not initialize')
  self.postMessage({type: 'ready'})
})()
boot.catch((error) => self.postMessage({type: 'error', message: error.message}))
self.onmessage = async ({data}) => {
  try {
    await boot
    const result = JSON.parse(globalThis.goWatchlistScan(JSON.stringify(data.input)))
    if (result.error) throw new Error(result.error)
    self.postMessage({type: 'result', id: data.id, data: result})
  } catch (error) {
    self.postMessage({type: 'error', id: data.id, message: error instanceof Error ? error.message : 'Watchlist evaluation failed'})
  }
}

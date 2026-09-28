import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineDirectory, verifyArtifacts } from './verify.mjs'

// Compare the deployed artifact with native Go, including lecture observations,
// selected opportunities, provisional-candle exclusion and invalid input.
const manifest = verifyArtifacts()
const workspace = mkdtempSync(resolve(tmpdir(), 'watchlist-parity-'))
const native = resolve(workspace, 'watchlist-native')
try {
  execFileSync(process.env.WATCHLIST_GO || 'go', ['build', '-trimpath', '-o', native, './cmd/watchlist-native'], {
    cwd: engineDirectory, env: { ...process.env, GOPROXY: 'off' }, stdio: 'inherit',
  })
  await import(pathToFileURL(resolve(engineDirectory, '../public/watchlist-wasm-exec.js')).href)
  const go = new globalThis.Go()
  const { instance } = await WebAssembly.instantiate(readFileSync(resolve(engineDirectory, '../public/watchlist-engine.wasm')), go.importObject)
  void go.run(instance)
  assert.equal(typeof globalThis.goWatchlistScan, 'function')

  const now = Date.parse('2026-09-28T12:07:00Z')
  const frames = [['1d', 86_400_000], ['4h', 14_400_000], ['1h', 3_600_000], ['15m', 900_000]]
  const request = { now, symbols: ['BULLUSDT', 'BEARUSDT'], histories: [] }
  for (const [symbolIndex, symbol] of request.symbols.entries()) {
    for (const [timeframe, duration] of frames) {
      const lastClosed = Math.floor(now / duration) * duration - 1
      const candles = Array.from({ length: 500 }, (_, i) => {
        const triangle = i % 40 <= 20 ? i % 40 : 40 - i % 40
        const unmirrored = (10000 + i * 3 + triangle * 30) / 100
        const price = symbolIndex ? 300 - unmirrored : unmirrored
        const openTime = lastClosed + 1 - (500 - i) * duration
        return { openTime, closeTime: openTime + duration - 1, open: price,
          high: price + 2, low: price - 2, close: price + (symbolIndex ? -.3 : .3), volume: 1000 + i % 20 * 50 }
      })
      const last = candles.at(-1)
      request.histories.push({ symbol, timeframe, candles,
        preview: { ...last, openTime: last.openTime + duration, closeTime: last.closeTime + duration },
        receivedAt: now - 30000, status: 'ready', error: null })
    }
  }
  const previewChanged = structuredClone(request)
  for (const history of previewChanged.histories) { history.preview.high = 100000; history.preview.close = 100000 }
  const invalid = structuredClone(request)
  invalid.histories[0].candles[10].closeTime--
  const lecture = JSON.parse(readFileSync(resolve(engineDirectory, 'internal/browserengine/testdata/ichimoku-selection.json'), 'utf8'))
  const scoped = { ...lecture, scope: 'ichimoku' }
  const scopedEdge = { ...lecture, scope: 'ichimoku', timeframe: '4h' }
  const scopedMany = { now: lecture.now, scope: 'ichimoku', symbols: [], histories: [] }
  for (let i = 0; i < 14; i++) {
    const symbol = `LECTURE${String(i).padStart(2, '0')}USDT`
    scopedMany.symbols.push(symbol)
    scopedMany.histories.push(...lecture.histories.map((history) => ({ ...history, symbol })))
  }
  const unknownScope = { ...lecture, scope: 'unknown' }
  const durations = { '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000, '30m': 1800000,
    '1h': 3600000, '2h': 7200000, '4h': 14400000, '8h': 28800000, '1d': 86400000, '3d': 259200000, '1w': 604800000 }
  const selectedFixture = (timeframe) => {
    const duration = durations[timeframe]
    const anchor = timeframe === '1w' ? Date.parse('1970-01-05T00:00:00Z')
      : timeframe === '3d' ? Date.parse('2026-01-02T00:00:00Z') : 0
    const lastClose = anchor + Math.floor((lecture.now - 5000 - anchor) / duration) * duration - 1
    const source = structuredClone(lecture.histories.find((history) => history.timeframe === '1h'))
    source.timeframe = timeframe
    source.receivedAt = lecture.now - 1000
    source.candles = source.candles.map((candle, index) => {
      const openTime = lastClose + 1 - (source.candles.length - index) * duration
      return { ...candle, openTime, closeTime: openTime + duration - 1 }
    })
    const last = source.candles.at(-1)
    source.preview = { ...last, openTime: last.openTime + duration, closeTime: last.closeTime + duration }
    const histories = [source]
    return { now: lecture.now, scope: 'ichimoku', timeframe, symbols: lecture.symbols, histories }
  }
  const chosenFrames = Object.keys(durations).map((timeframe) => [`chosen timeframe ${timeframe}`, selectedFixture(timeframe)])
  const unrelatedFailure = selectedFixture('1h')
  unrelatedFailure.histories.push({ ...structuredClone(lecture.histories.find((history) => history.timeframe === '1d')), status: 'error', receivedAt: 1 })
  const failedFifteenMinute = selectedFixture('1h')
  failedFifteenMinute.histories.push({ ...structuredClone(lecture.histories.find((history) => history.timeframe === '15m')), status: 'error', receivedAt: 1 })
  const opposingFifteenMinute = selectedFixture('1h')
  const opposite = structuredClone(lecture.histories.find((history) => history.timeframe === '15m'))
  opposite.preview = { ...opposite.preview, open: 10, high: 11, low: 1, close: 2 }
  opposingFifteenMinute.histories.push(opposite)
  let baseline
  for (const [name, fixture] of [['both directions', request], ['changed preview', previewChanged], ['lecture entries', lecture],
    ['Ichimoku scope', scoped], ['Ichimoku edge scope', scopedEdge], ['Ichimoku scope beyond 12 assets', scopedMany], ...chosenFrames,
    ['unrelated failed history', unrelatedFailure], ['failed optional fifteen-minute history', failedFifteenMinute],
    ['opposing optional fifteen-minute quote', opposingFifteenMinute], ['unknown scope', unknownScope],
    ['invalid history', invalid], ['malformed request', null]]) {
    const raw = JSON.stringify(fixture)
    const nativeOutput = JSON.parse(execFileSync(native, { input: raw, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }))
    const wasmOutput = JSON.parse(globalThis.goWatchlistScan(raw))
    assert.deepEqual(wasmOutput, nativeOutput, `Native/browser mismatch: ${name}`)
    assert.equal(wasmOutput.version, manifest.release)
    assert.equal(wasmOutput.scope, fixture?.scope === 'ichimoku' ? 'ichimoku' : 'all')
    assert.equal(wasmOutput.timeframe, fixture?.scope === 'ichimoku' ? fixture.timeframe || '1h' : undefined)
    if (name === 'both directions') {
      assert.equal(wasmOutput.scan.series.length, 8)
      assert(wasmOutput.scan.series.every((series) => series.ichimoku?.status === 'ready'))
      baseline = wasmOutput
    } else if (name === 'changed preview') {
      assert.deepEqual(wasmOutput.scan.series.map((series) => series.ichimoku), baseline.scan.series.map((series) => series.ichimoku), 'Preview altered lecture observations')
    } else if (name === 'lecture entries' || fixture?.scope === 'ichimoku') {
      const expectedFamilies = name === 'lecture entries' ? ['tk_cross', 'pk_cross', 'cloud_edge_to_edge']
        : name === 'Ichimoku edge scope' ? ['cloud_edge_to_edge'] : ['tk_cross', 'pk_cross']
      for (const family of expectedFamilies) {
        for (const symbol of fixture.symbols) {
          assert(wasmOutput.result.strategies.items.some((item) => item.opportunity.symbol === symbol && item.opportunity.family === family && item.plan.status === 'ready_for_review'), `Missing selected lecture family: ${symbol}/${family}`)
        }
      }
      assert(wasmOutput.scan.series.every((series) => series.ichimokuSeries?.length === 500))
      if (fixture.scope === 'ichimoku') {
        const source = fixture.timeframe || '1h'
        assert.equal(wasmOutput.scan.series.length, fixture.symbols.length)
        assert.equal(wasmOutput.scan.errors.length, 0)
        assert.equal(wasmOutput.result.items.length, 0)
        assert.equal(wasmOutput.result.trends.length, 0)
        assert.equal(wasmOutput.result.strategies.limit, 0)
        assert(wasmOutput.result.strategies.items.every((item) => ['kijun_reclaim', 'cloud_reclaim', 'tk_cross', 'pk_cross', 'cloud_edge_to_edge'].includes(item.opportunity.family)))
        assert(wasmOutput.result.strategies.items.every((item) => item.opportunity.interval === source))
      }
    } else if (name === 'invalid history') {
      assert.equal(wasmOutput.scan.errors.length, 1)
    } else {
      assert(wasmOutput.error)
    }
    process.stdout.write(`Native/browser parity: ${name}.\n`)
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engineDirectory, verifyArtifacts } from './verify.mjs'

// Compare the deployed artifact with native Go, including paper profiles,
// dedicated lecture observations, provisional-candle exclusion and invalid input.
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
      if (symbol === 'BULLUSDT' && timeframe === '1d') {
        const priorHigh = Math.max(...candles.slice(-56, -1).map((bar) => bar.high))
        const signal = candles.at(-1)
        signal.open = priorHigh - .5
        signal.low = priorHigh - 1
        signal.close = priorHigh + 1
        signal.high = priorHigh + 1.5
      }
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
  const cloudBars = Array.from({ length: 500 }, (_, i) => {
    const openTime = Math.floor(now / 86_400_000) * 86_400_000 - (500 - i) * 86_400_000
    return { openTime, closeTime: openTime + 86_400_000 - 1,
      open: 100, high: 102, low: 98, close: 100, volume: 10 }
  })
  const cloudSet = (at, open, high, low, close) => Object.assign(cloudBars[500 - 162 + at], { open, high, low, close })
  cloudSet(15, 100, 125, 98, 100)
  for (let at = 110; at < 133; at++) cloudSet(at, 109, 110, 108, 109)
  cloudSet(159, 109, 110, 108, 109)
  cloudSet(160, 109, 115, 108, 114)
  cloudSet(161, 114, 115, 111, 114)
  const paperCloud = { now, symbols: ['CLOUDUSDT'], histories: [{ symbol: 'CLOUDUSDT', timeframe: '1d', candles: cloudBars,
    preview: { ...cloudBars.at(-1), openTime: cloudBars.at(-1).openTime + 86_400_000,
      closeTime: cloudBars.at(-1).closeTime + 86_400_000 },
    receivedAt: now - 30000, status: 'ready', error: null }] }
  const exactClose = structuredClone(paperCloud)
  exactClose.now = exactClose.histories[0].candles.at(-1).closeTime
  exactClose.histories[0].receivedAt = exactClose.now
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
  const paperFamilies = ['donchian55_atr_trail', 'donchian55_atr_trail_stoch', 'donchian55_atr_trail_macd',
    'donchian55_atr_trail_adx_range', 'cloud_reclaim_volume_2r', 'cloud_reclaim_volume_2r_ema',
    'cloud_reclaim_volume_2r_sma', 'cloud_reclaim_volume_2r_supertrend', 'cloud_reclaim_volume_2r_ao',
    'cloud_reclaim_volume_2r_sma_ema_macd', 'fresh_weekly_range_long', 'tk_cross_rsi',
    'combo_trendlines_adx_daily', 'combo_trendlines_cluster_daily', 'combo_trendlines_sfp_daily',
    'combo_range_weekly_4h', 'combo_nwe_rsi_ultimate_15m']
  for (const [name, fixture] of [['daily breakout', request], ['changed preview', previewChanged],
    ['daily cloud without four-hour source', paperCloud], ['paper candle at exact close', exactClose],
    ['legacy lecture data in mixed scope', lecture],
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
    if (wasmOutput.result && wasmOutput.scope === 'all') {
      assert.equal(wasmOutput.result.items.length, 0)
      assert.equal(wasmOutput.result.trends.length, 0)
      assert.equal(wasmOutput.result.strategies.limit, 0)
      assert.deepEqual(wasmOutput.result.strategies.summary.map((summary) => summary.family), paperFamilies)
      assert(wasmOutput.result.strategies.items.every((item) => paperFamilies.includes(item.opportunity.family)
        && ['1d', '4h', '15m'].includes(item.opportunity.interval)), `Legacy or misplaced setup in mixed watchlist: ${name}`)
    }
    if (name === 'daily breakout') {
      assert.equal(wasmOutput.scan.series.length, 6)
      assert(wasmOutput.scan.series.every((series) => series.ichimoku?.status === 'ready'))
      const donchian = wasmOutput.result.strategies.items.find((item) => item.opportunity.family === 'donchian55_atr_trail')
      assert(donchian?.eligible && donchian.plan.target === null, 'Missing target-free daily breakout')
      baseline = wasmOutput
    } else if (name === 'changed preview') {
      assert.deepEqual(wasmOutput.scan.series.map((series) => series.ichimoku), baseline.scan.series.map((series) => series.ichimoku), 'Preview altered lecture observations')
    } else if (name === 'daily cloud without four-hour source') {
      assert.equal(wasmOutput.scan.errors.length, 2)
      assert.deepEqual(wasmOutput.scan.errors.map((error) => error.interval).sort(), ['15m', '4h'])
      const cloud = wasmOutput.result.strategies.items.find((item) => item.opportunity.family === 'cloud_reclaim_volume_2r')
      assert(cloud?.eligible && cloud.opportunity.target === 125 && cloud.plan.target === 125,
        'Missing daily cloud or its original structural target')
    } else if (name === 'paper candle at exact close') {
      assert.equal(wasmOutput.scan.errors.length, 3)
      assert(wasmOutput.scan.errors.some((error) => error.interval === '1d'
        && error.error.includes('before the paper evaluation time')))
      assert.equal(wasmOutput.result.strategies.items.length, 0)
    } else if (name === 'legacy lecture data in mixed scope') {
      assert.equal(wasmOutput.scan.series.length, 3)
    } else if (fixture?.scope === 'ichimoku') {
      const expectedFamilies = name === 'Ichimoku edge scope' ? ['cloud_edge_to_edge'] : ['tk_cross', 'pk_cross']
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
  const combinations = JSON.parse(readFileSync(resolve(engineDirectory, 'internal/strategies/testdata/combinations_rust.json'), 'utf8'))
  for (const [index, fixture] of combinations.entries()) {
    const now = fixture.candles.at(-1).closeTime + 1
    const input = {now, symbols: [fixture.symbol], histories: [{symbol: fixture.symbol, timeframe: fixture.frame,
      candles: fixture.candles, preview: null, receivedAt: now, status: 'ready', error: null}]}
    const raw = JSON.stringify(input)
    const nativeOutput = JSON.parse(execFileSync(native, {input: raw, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}))
    const wasmOutput = JSON.parse(globalThis.goWatchlistScan(raw))
    assert.deepEqual(wasmOutput, nativeOutput, `Combination native/browser mismatch: ${index}`)
    const found = wasmOutput.result.strategies.items.find((item) => item.opportunity.family === fixture.method)
    assert.equal(!!found, fixture.expected, `Rust/browser signal mismatch: ${index}`)
    if (found) {
      assert.equal(found.opportunity.id, fixture.entry.id)
      assert.equal(found.eligible, true, `Combination cannot be reviewed: ${index}`)
      assert.equal(found.plan.target, fixture.entry.managedPlan.target)
    }
  }
  process.stdout.write(`Rust/native/browser parity: ${combinations.length} combination cases.\n`)
} finally {
  rmSync(workspace, { recursive: true, force: true })
}

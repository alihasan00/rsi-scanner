import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { engineDirectory, verifySources } from './verify.mjs'

const provenance = verifySources()
const go = process.env.WATCHLIST_GO || 'go'
const env = { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off' }
const goVersion = execFileSync(go, ['version'], { cwd: engineDirectory, env, encoding: 'utf8' }).trim()
if (!goVersion.startsWith('go version go1.26.8 ')) throw new Error('Build this engine with Go 1.26.8; set WATCHLIST_GO to its executable.')
const goRoot = execFileSync(go, ['env', 'GOROOT'], { cwd: engineDirectory, env, encoding: 'utf8' }).trim()
const publicDirectory = resolve(engineDirectory, '..', 'public')
mkdirSync(publicDirectory, { recursive: true })
execFileSync(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', resolve(publicDirectory, 'watchlist-engine.wasm'), './cmd/watchlist-wasm'], {
  cwd: engineDirectory,
  env: { ...env, GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0' },
  stdio: 'inherit',
})
copyFileSync(resolve(goRoot, 'lib/wasm/wasm_exec.js'), resolve(publicDirectory, 'watchlist-wasm-exec.js'))
for (const file of ['watchlist-engine.wasm', 'watchlist-wasm-exec.js']) chmodSync(resolve(publicDirectory, file), 0o644)
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const artifacts = Object.fromEntries(['public/watchlist-engine.wasm', 'public/watchlist-wasm-exec.js'].map((path) => [path, hash(resolve(engineDirectory, '..', path))]))
const adapterFiles = Object.fromEntries(['go.mod', 'internal/browserengine/engine.go', 'cmd/watchlist-wasm/main_js.go'].map((path) => [path, hash(resolve(engineDirectory, path))]))
writeFileSync(resolve(engineDirectory, 'build-manifest.json'), JSON.stringify({
  release: provenance.release, sourceHash: provenance.sourceHash, schemaVersion: provenance.schemaVersion,
  localRevision: provenance.localRevision, upstreamRelease: provenance.upstreamRelease,
  goVersion, artifacts, adapterFiles,
}, null, 2) + '\n')
process.stdout.write(`Built browser watchlist engine from ${provenance.release}.\n`)

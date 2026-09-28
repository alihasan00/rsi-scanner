import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const engineDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

export function verifySources() {
  const provenance = JSON.parse(readFileSync(resolve(engineDirectory, 'provenance.json'), 'utf8'))
  for (const file of provenance.files) {
    const actual = sha256(readFileSync(resolve(engineDirectory, file.path)))
    if (actual !== file.sha256) throw new Error(`Frozen source changed without provenance update: ${file.path}`)
  }
  return provenance
}

export function verifyArtifacts() {
  const provenance = verifySources()
  const manifest = JSON.parse(readFileSync(resolve(engineDirectory, 'build-manifest.json'), 'utf8'))
  if (manifest.sourceHash !== provenance.sourceHash) throw new Error('Built engine uses a different frozen release.')
  for (const [path, expected] of Object.entries(manifest.artifacts)) {
    if (sha256(readFileSync(resolve(engineDirectory, '..', path))) !== expected) throw new Error(`Shared-engine artifact changed: ${path}`)
  }
  for (const [path, expected] of Object.entries(manifest.adapterFiles)) {
    if (sha256(readFileSync(resolve(engineDirectory, path))) !== expected) throw new Error(`Rebuild the shared engine after changing ${path}`)
  }
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = verifyArtifacts()
  process.stdout.write(`Shared engine verified: ${manifest.release} (${manifest.goVersion}).\n`)
}

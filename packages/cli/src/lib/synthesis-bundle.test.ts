import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSynthesisEntry, SynthesisResolveError } from './synthesis-bundle.js'

let root: string

function writeBuiltSynthesis(repoRoot: string): string {
  const dist = join(repoRoot, 'packages', 'synthesis', 'dist')
  mkdirSync(dist, { recursive: true })
  const entry = join(dist, 'index.js')
  writeFileSync(entry, '// built synthesis bundle')
  return entry
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'robrain-synth-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveSynthesisEntry', () => {
  it('prefers a built ROBRAIN_REPO checkout and reports it as repoRoot', () => {
    const repo = join(root, 'clone')
    const entry = writeBuiltSynthesis(repo)
    const resolved = resolveSynthesisEntry({ ROBRAIN_REPO: repo }, { checkoutRoot: null })
    assert.equal(resolved.entry, entry)
    assert.equal(resolved.repoRoot, repo)
  })

  it('rejects a ROBRAIN_REPO that is not a robrain checkout', () => {
    const notRepo = join(root, 'elsewhere')
    mkdirSync(notRepo, { recursive: true })
    assert.throws(
      () => resolveSynthesisEntry({ ROBRAIN_REPO: notRepo }, { checkoutRoot: null }),
      SynthesisResolveError,
    )
  })

  it('tells the user to build when the checkout has no dist', () => {
    const repo = join(root, 'clone')
    mkdirSync(join(repo, 'packages', 'synthesis'), { recursive: true })
    assert.throws(
      () => resolveSynthesisEntry({ ROBRAIN_REPO: repo }, { checkoutRoot: null }),
      /pnpm install && pnpm --filter @robrain\/synthesis build/,
    )
  })

  it('uses an inferred checkout when ROBRAIN_REPO is unset', () => {
    const repo = join(root, 'checkout')
    const entry = writeBuiltSynthesis(repo)
    const resolved = resolveSynthesisEntry({}, { checkoutRoot: repo })
    assert.equal(resolved.entry, entry)
    assert.equal(resolved.repoRoot, repo)
  })

  it('falls back to the vendored bundle with no checkout anywhere', () => {
    const cliRoot = join(root, 'npx-cache', 'node_modules', 'robrain')
    const vendoredDist = join(cliRoot, 'vendor', 'synthesis', 'dist')
    mkdirSync(vendoredDist, { recursive: true })
    writeFileSync(join(vendoredDist, 'index.js'), '// vendored synthesis bundle')
    const resolved = resolveSynthesisEntry({}, { checkoutRoot: null, cliRoot })
    assert.equal(resolved.entry, join(vendoredDist, 'index.js'))
    assert.equal(resolved.repoRoot, undefined)
  })

  it('throws a remediation message when nothing resolves', () => {
    const cliRoot = join(root, 'bare')
    mkdirSync(cliRoot, { recursive: true })
    assert.throws(
      () => resolveSynthesisEntry({}, { checkoutRoot: null, cliRoot }),
      /npx robrain@latest synth|ROBRAIN_REPO/,
    )
  })
})

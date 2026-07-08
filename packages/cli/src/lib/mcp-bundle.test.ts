import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { platform, tmpdir } from 'os'
import { join } from 'path'
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { ensureSensingMcpBundle, materializeSensingBundle, resolveInstalledSensingMcpDir, sensingBundleReady } from './mcp-bundle.js'

describe('resolveInstalledSensingMcpDir', () => {
  // Regression: the vendor/monorepo fallbacks were once computed relative to
  // dist/ instead of the cli root, so the published tarball shipped a bundle
  // the resolver could not see. In the workspace (and CI, after `pnpm -r build`)
  // at least one candidate — vendor/sensing-mcp or ../sensing-mcp — must hit.
  it('finds a built sensing-mcp from the compiled dist location', () => {
    const dir = resolveInstalledSensingMcpDir()
    assert.ok(dir, 'expected a sensing-mcp dir, got undefined')
    assert.ok(existsSync(join(dir, 'dist', 'index.js')))
    assert.ok(existsSync(join(dir, 'package.json')))
  })
})

let root: string
let pkgDir: string
let mcpDir: string

function writeFakePackage(dir: string, version: string, bundleBody: string): void {
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'dist', 'index.js'), bundleBody)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@robrain/sensing-mcp', version }))
}

beforeEach(() => {
  root   = mkdtempSync(join(tmpdir(), 'robrain-mcp-bundle-'))
  pkgDir = join(root, 'pkg')
  mcpDir = join(root, 'mcp')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('materializeSensingBundle', () => {
  it('copies dist and writes a version-stamped ESM marker package.json', () => {
    writeFakePackage(pkgDir, '2.2.0', 'console.log("bundle")')

    assert.equal(materializeSensingBundle(pkgDir, mcpDir), true)
    assert.equal(sensingBundleReady(mcpDir), true)
    assert.equal(readFileSync(join(mcpDir, 'sensing', 'dist', 'index.js'), 'utf8'), 'console.log("bundle")')

    const marker = JSON.parse(readFileSync(join(mcpDir, 'sensing', 'package.json'), 'utf8'))
    assert.equal(marker.version, '2.2.0')
    assert.equal(marker.type, 'module')
  })

  it('skips the copy when the same version is already materialized', () => {
    writeFakePackage(pkgDir, '2.2.0', 'v1')
    assert.equal(materializeSensingBundle(pkgDir, mcpDir), true)

    // Same version, different source content: destination must be left alone.
    writeFileSync(join(pkgDir, 'dist', 'index.js'), 'v2')
    assert.equal(materializeSensingBundle(pkgDir, mcpDir), true)
    assert.equal(readFileSync(join(mcpDir, 'sensing', 'dist', 'index.js'), 'utf8'), 'v1')
  })

  it('re-copies when the package version changed', () => {
    writeFakePackage(pkgDir, '2.2.0', 'old')
    assert.equal(materializeSensingBundle(pkgDir, mcpDir), true)

    writeFakePackage(pkgDir, '2.3.1', 'new')
    assert.equal(materializeSensingBundle(pkgDir, mcpDir), true)
    assert.equal(readFileSync(join(mcpDir, 'sensing', 'dist', 'index.js'), 'utf8'), 'new')
    const marker = JSON.parse(readFileSync(join(mcpDir, 'sensing', 'package.json'), 'utf8'))
    assert.equal(marker.version, '2.3.1')
  })

  it('replaces a symlinked destination from a previous --repo-root install', () => {
    // Old dev install: ~/.robrain/mcp/sensing -> clone/packages/sensing-mcp
    const cloneDir = join(root, 'clone-sensing-mcp')
    writeFakePackage(cloneDir, '2.2.0', 'from-clone')
    mkdirSync(mcpDir, { recursive: true })
    symlinkSync(cloneDir, join(mcpDir, 'sensing'), 'dir')

    writeFakePackage(pkgDir, '2.2.0', 'from-package')
    assert.equal(materializeSensingBundle(pkgDir, mcpDir), true)
    assert.equal(readFileSync(join(mcpDir, 'sensing', 'dist', 'index.js'), 'utf8'), 'from-package')
    // The clone the symlink pointed at must be untouched.
    assert.equal(readFileSync(join(cloneDir, 'dist', 'index.js'), 'utf8'), 'from-clone')
  })

  it('returns false when the package has no built dist', () => {
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '2.2.0' }))

    assert.equal(materializeSensingBundle(pkgDir, mcpDir), false)
    assert.equal(existsSync(join(mcpDir, 'sensing')), false)
  })

  it('replaces a package-copied destination when --repo-root is used', () => {
    writeFakePackage(pkgDir, '2.2.0', 'from-package')
    materializeSensingBundle(pkgDir, mcpDir)

    const repoRoot = join(root, 'clone')
    const cloneSensing = join(repoRoot, 'packages', 'sensing-mcp')
    writeFakePackage(cloneSensing, '2.2.0', 'from-clone')

    ensureSensingMcpBundle(repoRoot, mcpDir)

    const dest = join(mcpDir, 'sensing')
    if (platform() === 'win32') {
      assert.equal(readFileSync(join(dest, 'dist', 'index.js'), 'utf8'), 'from-clone')
    } else {
      assert.ok(lstatSync(dest).isSymbolicLink())
      assert.equal(readFileSync(join(dest, 'dist', 'index.js'), 'utf8'), 'from-clone')
    }
  })
})

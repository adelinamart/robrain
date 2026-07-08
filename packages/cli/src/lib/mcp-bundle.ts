// packages/cli/src/lib/mcp-bundle.ts
// Copy or symlink built MCP packages into ~/.robrain/mcp so editor configs resolve.

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { platform } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

export class McpBundleError extends Error {
  override name = 'McpBundleError'
}

/**
 * True only when a *complete* Sensing bundle is present — both the entrypoint and
 * a package.json declaring ESM. The package.json check is load-bearing: Node treats
 * a bare `.js` without `"type": "module"` as CommonJS and throws on the bundle's
 * `import` statements before any tool registers. A previous half-finished copy
 * (entrypoint present, package.json missing) must therefore read as NOT ready so
 * the install re-materializes it instead of certifying the wreck and writing a
 * success config on top of it.
 */
export function sensingBundleReady(robrainMcpDir: string): boolean {
  const base = join(robrainMcpDir, 'sensing')
  return existsSync(join(base, 'dist', 'index.js')) && existsSync(join(base, 'package.json'))
}

/**
 * Locate the built sensing-mcp bundle shipped with this CLI.
 * Published tarballs carry it under vendor/; monorepo dev resolves packages/sensing-mcp.
 */
export function resolveInstalledSensingMcpDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', 'vendor', 'sensing-mcp'),
    join(here, '..', '..', 'sensing-mcp'),
  ]
  try {
    const req = createRequire(import.meta.url)
    candidates.unshift(dirname(req.resolve('@robrain/sensing-mcp/package.json')))
  } catch {
    // optional workspace link — not present in the published tarball
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'dist', 'index.js')) && existsSync(join(dir, 'package.json'))) {
      return dir
    }
  }
  return undefined
}

/**
 * Materialize ~/.robrain/mcp/sensing from the @robrain/sensing-mcp package that
 * ships with the CLI. Always a copy, never a symlink: npx runs the CLI out of an
 * ephemeral cache, so a symlink into it would dangle by the next editor launch.
 * The bundle is a single self-contained file, so the copy needs no node_modules.
 *
 * Skips the copy when the destination was already materialized from the same
 * package version. A symlinked destination (a previous --repo-root dev install)
 * is replaced: default installs track the published package, and dev installs
 * re-assert themselves by passing --repo-root again.
 *
 * Returns true when the bundle is ready, false when the package cannot be
 * resolved or has no built dist (caller falls back to other sources).
 */
export function ensureSensingMcpBundleFromPackage(robrainMcpDir: string): boolean {
  const pkgDir = resolveInstalledSensingMcpDir()
  if (!pkgDir) return false
  return materializeSensingBundle(pkgDir, robrainMcpDir)
}

/** Exposed for tests: same copy logic, explicit source package directory. */
export function materializeSensingBundle(pkgDir: string, robrainMcpDir: string): boolean {
  const srcEntry = join(pkgDir, 'dist', 'index.js')
  if (!existsSync(srcEntry)) return false

  let version = ''
  try {
    version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version ?? ''
  } catch {
    return false
  }

  const dest = join(robrainMcpDir, 'sensing')
  if (sensingBundleReady(robrainMcpDir) && !lstatSync(dest).isSymbolicLink()) {
    try {
      const current = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
      if (current.version === version) return true
    } catch {
      // unreadable marker — fall through and re-copy
    }
  }

  mkdirSync(robrainMcpDir, { recursive: true })
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  cpSync(join(pkgDir, 'dist'), join(dest, 'dist'), { recursive: true })
  writeFileSync(
    join(dest, 'package.json'),
    JSON.stringify(
      { name: 'robrain-sensing-mcp', version, private: true, type: 'module', main: './dist/index.js' },
      null,
      2,
    ) + '\n',
  )
  return true
}

/** True when a Control MCP entrypoint exists (cloud installs only; not in OSS repo). */
export function controlBundleReady(robrainMcpDir: string): boolean {
  return existsSync(join(robrainMcpDir, 'control', 'dist', 'index.js'))
}

/**
 * Ensure ~/.robrain/mcp/sensing resolves to a built sensing-mcp bundle.
 *
 * macOS/Linux: directory symlink into the workspace package — always replaces
 * any existing package-copied bundle so `--repo-root` re-asserts dev installs.
 *
 * Windows: copy the *self-contained* artifact only — the bundled dist plus a
 * minimal package.json declaring ESM. We deliberately do NOT copy the package's
 * node_modules: in a pnpm workspace those entries are symlinks into the monorepo's
 * virtual store (e.g. `@robrain/shared -> ../../../shared`). Copied out of the repo
 * they dangle, and on Windows recreating them can abort the copy partway — which is
 * exactly what produced half-installed, crash-looping Sensing servers. Because the
 * server is bundled into one file with every dependency inlined, no node_modules is
 * needed at the destination.
 */
export function ensureSensingMcpBundle(repoRoot: string, robrainMcpDir: string): void {
  const src = join(repoRoot, 'packages', 'sensing-mcp')
  const srcEntry = join(src, 'dist', 'index.js')
  if (!existsSync(srcEntry)) {
    throw new McpBundleError(
      `sensing-mcp is not built (missing ${srcEntry}). From the repo root run: pnpm install && pnpm build`,
    )
  }

  mkdirSync(robrainMcpDir, { recursive: true })
  const dest = join(robrainMcpDir, 'sensing')

  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
  }

  if (platform() === 'win32') {
    mkdirSync(dest, { recursive: true })
    cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true })
    // Minimal package.json: Node needs "type": "module" to run the bundled
    // ESM entrypoint. The workspace package.json's `dependencies` are irrelevant
    // at runtime (everything is inlined) and only invite confusion, so omit them.
    writeFileSync(
      join(dest, 'package.json'),
      JSON.stringify(
        { name: 'robrain-sensing-mcp', private: true, type: 'module', main: './dist/index.js' },
        null,
        2,
      ) + '\n',
    )
  } else {
    symlinkSync(src, dest, 'dir')
  }
}

// packages/cli/src/lib/synthesis-bundle.ts
// Locate the built @robrain/synthesis bundle shipped with this CLI.
// Published tarballs carry it under vendor/; checkouts resolve packages/synthesis.
//
// Node-builtins only — verify-publish-tarball.mjs imports this from a bare
// extracted tarball with no node_modules (same constraint as mcp-bundle.ts).

import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { inferLocalRobrainMonorepoRoot, inferRobrainMonorepoRootFromCwd } from './load-env.js'

export class SynthesisResolveError extends Error {
  override name = 'SynthesisResolveError'
}

export interface ResolvedSynthesis {
  /** Path to the built synthesis entrypoint (dist/index.js). */
  entry: string
  /** Set when running from a repo checkout — used as the child cwd so Synthesis finds the checkout's `.env`. */
  repoRoot?: string
}

export interface ResolveSynthesisOptions {
  /** Override for tests; defaults to two levels above dist/lib. */
  cliRoot?: string
  /** Checkout root override for tests: `null` forces "no checkout found". */
  checkoutRoot?: string | null
}

function builtEntryOrThrow(repoRoot: string): string {
  const pkgDir = join(repoRoot, 'packages', 'synthesis')
  if (!existsSync(pkgDir)) {
    throw new SynthesisResolveError(
      `${repoRoot} does not look like a robrain checkout — packages/synthesis not found.`,
    )
  }
  const entry = join(pkgDir, 'dist', 'index.js')
  if (!existsSync(entry)) {
    throw new SynthesisResolveError(
      `synthesis is not built in ${repoRoot} — from the repo root run: pnpm install && pnpm --filter @robrain/synthesis build`,
    )
  }
  return entry
}

/**
 * Locate the built synthesis entrypoint, first match wins:
 *   1. ROBRAIN_REPO            → <repo>/packages/synthesis/dist/index.js
 *   2. robrain checkout        → same, when the CLI itself runs from one (or cwd is one)
 *   3. vendored bundle         → <cli-root>/vendor/synthesis/dist/index.js (published tarball)
 * Throws SynthesisResolveError with a remediation message.
 */
export function resolveSynthesisEntry(
  env: NodeJS.ProcessEnv = process.env,
  opts: ResolveSynthesisOptions = {},
): ResolvedSynthesis {
  const envRoot = env.ROBRAIN_REPO?.trim()
  if (envRoot) {
    const repoRoot = resolve(envRoot)
    return { entry: builtEntryOrThrow(repoRoot), repoRoot }
  }

  const checkoutRoot = opts.checkoutRoot !== undefined
    ? opts.checkoutRoot
    : inferLocalRobrainMonorepoRoot() ?? inferRobrainMonorepoRootFromCwd()
  if (checkoutRoot) {
    return { entry: builtEntryOrThrow(checkoutRoot), repoRoot: checkoutRoot }
  }

  const cliRoot = opts.cliRoot ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const vendored = join(cliRoot, 'vendor', 'synthesis', 'dist', 'index.js')
  if (existsSync(vendored)) {
    return { entry: vendored }
  }

  throw new SynthesisResolveError(
    'could not find the Synthesis bundle. Update the CLI (npx robrain@latest synth) — ' +
    'older versions only ship Synthesis inside the repo — or point ROBRAIN_REPO at a robrain checkout.',
  )
}

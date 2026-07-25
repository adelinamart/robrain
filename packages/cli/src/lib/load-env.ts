// Merge repo-root / cwd `.env` for all CLI commands without overriding non-empty shell values.
// Empty-string shell vars (`ANTHROPIC_API_KEY=`) block naive dotenv — treat them as unset so `.env` fills in.

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `dotenv.parse` via CJS resolver — avoids NodeNext interop typing issues.
 * Resolved lazily: verify-publish-tarball.mjs imports modules that depend on
 * this file from a bare extracted tarball with no node_modules, where an
 * import-time require('dotenv') would throw before any parse is needed.
 */
type DotenvModule = { parse(src: Buffer | string): Record<string, string> }
let dotenvModule: DotenvModule | undefined
function dotenvParse(): DotenvModule {
  dotenvModule ??= createRequire(import.meta.url)('dotenv') as DotenvModule
  return dotenvModule
}

/** Paths checked in order; earlier paths win per key when merging into process.env. */
function candidateEnvPaths(repoRoot?: string): string[] {
  const paths: string[] = []
  if (repoRoot) {
    paths.push(join(repoRoot, '.env'))
  }
  const cwdEnv = join(process.cwd(), '.env')
  if (existsSync(cwdEnv) && !paths.includes(cwdEnv)) {
    paths.push(cwdEnv)
  }
  return paths
}

function isUnsetOrEmptyShell(v: string | undefined): boolean {
  return v === undefined || v === ''
}

/** Apply each key from a `.env` file only when the current process.env value is unset or empty. */
function mergeEnvFromFile(path: string): void {
  const raw = readFileSync(path)
  const parsed = dotenvParse().parse(raw)
  for (const [key, value] of Object.entries(parsed)) {
    if (!isUnsetOrEmptyShell(process.env[key])) continue
    process.env[key] = value
  }
}

/** Merge `.env` into `process.env` for CLI commands (install, inject, status, ...). */
export function loadCliEnv(repoRoot?: string): void {
  for (const path of candidateEnvPaths(repoRoot)) {
    if (existsSync(path)) mergeEnvFromFile(path)
  }
}

/**
 * `robrain up` writes the host-side DATABASE_URL (+ provider keys) into
 * ~/.robrain/stack/.env. Fill vars still unset/empty in `env` from it so
 * no-clone flows (`robrain up` then `robrain synth`) work without exporting
 * anything. Shell exports and repo/cwd `.env` keep priority — loadCliEnv
 * runs first and this only fills the gaps.
 */
export function applyStackEnvFallback(
  env: NodeJS.ProcessEnv,
  stackEnvPath = join(homedir(), '.robrain', 'stack', '.env'),
): void {
  if (!existsSync(stackEnvPath)) return
  const parsed = dotenvParse().parse(readFileSync(stackEnvPath))
  for (const [key, value] of Object.entries(parsed)) {
    if (!isUnsetOrEmptyShell(env[key]) || value === '') continue
    env[key] = value
  }
}

/**
 * When running the CLI from a git checkout (e.g. `node packages/cli/bin/robrain.js`),
 * find that checkout's root so repo `.env` matches `pnpm docker:up` / docker-compose.
 * Returns undefined for global npm installs (no workspace markers on the walk).
 */
export function inferLocalRobrainMonorepoRoot(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    const parent = dirname(dir)
    if (parent === dir) break
    if (
      existsSync(join(dir, 'pnpm-workspace.yaml')) &&
      existsSync(join(dir, 'docker', 'docker-compose.yml'))
    ) {
      return dir
    }
    dir = parent
  }
  return undefined
}

/** When `npm i -g robrain`, cwd may still be the git clone (e.g. after `pnpm docker:up`). */
export function inferRobrainMonorepoRootFromCwd(): string | undefined {
  const cwd = process.cwd()
  if (
    existsSync(join(cwd, 'pnpm-workspace.yaml')) &&
    existsSync(join(cwd, 'docker', 'docker-compose.yml'))
  ) {
    return cwd
  }
  return undefined
}

/** Read one key from `<repoRoot>/.env` without mutating `process.env` (dotenv.parse). */
export function readDotenvKey(repoRoot: string, key: string): string | undefined {
  const path = join(repoRoot, '.env')
  if (!existsSync(path)) return undefined
  const parsed = dotenvParse().parse(readFileSync(path))
  const v = parsed[key]
  if (v === undefined || String(v).trim() === '') return undefined
  return String(v).trim()
}


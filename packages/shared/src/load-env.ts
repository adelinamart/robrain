import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Rewrites a `localhost` host to `127.0.0.1` in any URL (http, postgres, …).
 * Node 17+ resolves localhost IPv6-first (::1) on many systems, but the
 * Docker stack and most local servers only bind 127.0.0.1 — connects then
 * die with ECONNREFUSED ::1 while curl (which retries IPv4) works.
 */
export function normalizeLoopbackUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1'
      return u.toString().replace(/\/$/, '')
    }
  } catch {
    // not a parseable URL — leave as-is
  }
  return url
}

/** Nearest ancestor of `start` (inclusive) that looks like a repo / workspace root. */
function findRepoRootUpward(start: string): string | null {
  let dir = start
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Paths checked in order; earlier paths win per key when merging into process.env.
 * After the explicit repoRoot and cwd, walk upward from cwd to the enclosing
 * `.git` / `pnpm-workspace.yaml` root (inclusive) — MCP servers and CLI runs are
 * often launched from a subdirectory of the repo that owns `.env`. Nearer
 * directories win, and the walk never leaves the repo, so an unrelated `.env`
 * higher up (e.g. in $HOME) cannot leak into the process.
 */
function candidateEnvPaths(repoRoot?: string): string[] {
  const paths: string[] = []
  const push = (p: string): void => {
    if (!paths.includes(p)) paths.push(p)
  }
  if (repoRoot) {
    push(join(repoRoot, '.env'))
  }
  const cwd = process.cwd()
  push(join(cwd, '.env'))
  const repoTop = findRepoRootUpward(cwd)
  if (repoTop) {
    let dir = cwd
    while (dir !== repoTop) {
      dir = dirname(dir)
      push(join(dir, '.env'))
    }
  }
  return paths
}

/**
 * Apply each key from a `.env` file, overriding any pre-existing process.env value.
 * `.env` is the source of truth for API keys; the `.claude.json` env block (which
 * Claude Code injects into process.env before our code runs) is fallback only —
 * it supplies keys missing from `.env`, but never wins against a value defined there.
 * Earlier paths in `candidateEnvPaths` win because subsequent files cannot overwrite
 * keys already populated from `.env` (we only override the *original* process.env,
 * not values we just wrote).
 */
function mergeEnvFromFile(path: string, alreadyLoaded: Set<string>): void {
  const raw = readFileSync(path, 'utf8')
  const parsed = parseDotenv(raw)
  for (const [key, value] of Object.entries(parsed)) {
    if (alreadyLoaded.has(key)) continue
    process.env[key] = value
    alreadyLoaded.add(key)
  }
}

/** Merge `.env` into process.env, with `.env` overriding pre-existing values. */
export function loadEnv(repoRoot?: string): void {
  const alreadyLoaded = new Set<string>()
  for (const path of candidateEnvPaths(repoRoot)) {
    if (existsSync(path)) mergeEnvFromFile(path, alreadyLoaded)
  }
}

/** Backwards-compatible alias for existing CLI call sites. */
export const loadCliEnv = loadEnv

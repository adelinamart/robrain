// Load repo-root `.env` for `robrain install` without overriding non-empty shell values.
// Empty-string shell vars (`ANTHROPIC_API_KEY=`) block dotenv.config({ override: false });
// treat them as unset so `.env` can populate them (Claude/Code sometimes inject empty keys).
// ─────────────────────────────────────────────────────────────

import { createRequire } from 'node:module'
import { existsSync, readFileSync }              from 'fs'
import { join }                                  from 'path'

/** `dotenv.parse` via CJS resolver — avoids broken named/default typings under `"moduleResolution": "NodeNext"`. */
const dotenvParse = createRequire(import.meta.url)('dotenv') as {
  parse(src: Buffer | string): Record<string, string>
}

/**
 * True only for the RoBrain OSS monorepo layout — not "any repo with docker-compose".
 * Avoids loading an unrelated project's `.env` when `repoRoot` is unset and cwd happens
 * to have a generic `docker/docker-compose.yml` + `.env`.
 */
function isRobrainMonorepoRoot(dir: string): boolean {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  if (!existsSync(join(dir, 'docker', 'Dockerfile.perception'))) return false
  if (!existsSync(join(dir, 'packages', 'sensing-mcp', 'package.json'))) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string }
    return pkg.name === 'robrain'
  }
  catch {
    return false
  }
}

/** Paths checked in order; entries in earlier files win over later paths for the same key. */
function candidateEnvPaths(repoRoot?: string): string[] {
  const paths: string[] = []
  if (repoRoot) {
    paths.push(join(repoRoot, '.env'))
  }
  const cwd = process.cwd()
  const cwdEnv = join(cwd, '.env')
  if (isRobrainMonorepoRoot(cwd) && existsSync(cwdEnv)) {
    if (!paths.includes(cwdEnv)) paths.push(cwdEnv)
  }
  return paths
}

function isUnsetOrEmptyShell(v: string | undefined): boolean {
  return v === undefined || v === ''
}

/** Apply each key from a `.env` file only when the current process.env value is unset or "". */
function mergeEnvFromFile(path: string): void {
  const raw = readFileSync(path)
  const parsed = dotenvParse.parse(raw)
  for (const [key, value] of Object.entries(parsed)) {
    if (!isUnsetOrEmptyShell(process.env[key])) continue
    process.env[key] = value
  }
}

/** Merge `.env` values into `process.env` for install prompts and MCP config. */
export function loadInstallEnv(repoRoot?: string): void {
  for (const path of candidateEnvPaths(repoRoot)) {
    if (existsSync(path)) mergeEnvFromFile(path)
  }
}

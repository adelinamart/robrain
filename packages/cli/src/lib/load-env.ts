// Merge repo-root / cwd `.env` for all CLI commands without overriding non-empty shell values.
// Empty-string shell vars (`ANTHROPIC_API_KEY=`) block naive dotenv — treat them as unset so `.env` fills in.

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** `dotenv.parse` via CJS resolver — avoids NodeNext interop typing issues. */
const dotenvParse = createRequire(import.meta.url)('dotenv') as {
  parse(src: Buffer | string): Record<string, string>
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
  const parsed = dotenvParse.parse(raw)
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


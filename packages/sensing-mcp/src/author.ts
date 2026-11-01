// packages/sensing-mcp/src/author.ts
// ─────────────────────────────────────────────────────────────
// Who is in this session. Every signal carries the author's email so a
// stored decision can say who decided it: ROBRAIN_AUTHOR_EMAIL when set,
// otherwise the git user.email of the directory Sensing runs in (the
// editor starts MCP servers in the project directory). Resolved once per
// process; a missing or malformed value means no email is sent and the
// row is stored without one.
// ─────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process'
import { normalizeAuthorEmail } from '@robrain/shared'

const GIT_TIMEOUT_MS = 2000

let cached: Promise<string | null> | undefined

/** Lowercased email in the strict shape Perception stores, or null. */
export function normalizeEmail(raw: string | undefined | null): string | null {
  return normalizeAuthorEmail(raw)
}

function gitUserEmail(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('git', ['config', '--get', 'user.email'], { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout) => {
        resolve(err ? null : normalizeEmail(String(stdout)))
      })
    } catch {
      resolve(null)
    }
  })
}

/** The session author's email: ROBRAIN_AUTHOR_EMAIL, else git user.email, else null. Cached. */
export function resolveAuthorEmail(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string | null> {
  if (!cached) {
    cached = (async () => normalizeEmail(env.ROBRAIN_AUTHOR_EMAIL) ?? (await gitUserEmail(cwd)))()
  }
  return cached
}

/** Tests only. */
export function resetAuthorEmailCache(): void {
  cached = undefined
}

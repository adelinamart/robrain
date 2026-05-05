// Load repo-root `.env` for `robrain install` without overriding the shell environment.
// ─────────────────────────────────────────────────────────────

import { config } from 'dotenv'
import { existsSync }                        from 'fs'
import { join }                              from 'path'

const COMPOSE_MARKER = join('docker', 'docker-compose.yml')

/** Paths checked in order; later files do not override earlier vars (override: false). */
function candidateEnvPaths(repoRoot?: string): string[] {
  const paths: string[] = []
  if (repoRoot) {
    paths.push(join(repoRoot, '.env'))
  }
  const cwd = process.cwd()
  const cwdEnv = join(cwd, '.env')
  if (existsSync(join(cwd, COMPOSE_MARKER)) && existsSync(cwdEnv)) {
    if (!paths.includes(cwdEnv)) paths.push(cwdEnv)
  }
  return paths
}

/** Merge `.env` values into `process.env` for install prompts and MCP config. */
export function loadInstallEnv(repoRoot?: string): void {
  for (const path of candidateEnvPaths(repoRoot)) {
    if (existsSync(path)) {
      config({ path, override: false })
    }
  }
}

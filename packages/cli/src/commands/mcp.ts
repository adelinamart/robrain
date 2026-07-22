// src/commands/mcp.ts
// ─────────────────────────────────────────────────────────────
// robrain mcp — exec the bundled Sensing MCP server over stdio.
//
// This is the portable launch command for MCP directories and manual
// mcp.json configs. Any client can run:
//
//   { "command": "npx", "args": ["-y", "robrain", "mcp"] }
//
// and the server picks up its Perception connection from ~/.robrain/config.json
// (written by `robrain up` / `robrain install`). PERCEPTION_API_URL /
// PERCEPTION_API_KEY in the client's env block still win, for setups that pass
// them explicitly.
// ─────────────────────────────────────────────────────────────

import { spawn } from 'child_process'
import chalk from 'chalk'
import { readConfig } from '../lib/config.js'
import { resolveInstalledSensingMcpDir } from '../lib/mcp-bundle.js'
import { join } from 'path'
import { existsSync } from 'fs'

/**
 * Env the Sensing server reads (see packages/sensing-mcp/src/config.ts).
 * Precedence: explicit process.env (client mcp.json `env`) wins; otherwise
 * fill PERCEPTION_API_URL / PERCEPTION_API_KEY from ~/.robrain/config.json so a
 * bare `npx robrain mcp` config just works after `robrain up`.
 */
export function mergeServerEnv(
  base: NodeJS.ProcessEnv,
  cfg: { perceptionUrl?: string; perceptionKey?: string; thin?: boolean },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (!env.PERCEPTION_API_URL && cfg.perceptionUrl) env.PERCEPTION_API_URL = cfg.perceptionUrl
  if (!env.PERCEPTION_API_KEY && cfg.perceptionKey) env.PERCEPTION_API_KEY = cfg.perceptionKey
  // Cloud thin-client installs stay thin through portable `robrain mcp` launches too.
  if (!env.ROBRAIN_MODE && cfg.thin) env.ROBRAIN_MODE = 'cloud'
  return env
}

function resolveServerEnv(): NodeJS.ProcessEnv {
  return mergeServerEnv(process.env, readConfig())
}

export async function mcpCommand(): Promise<void> {
  const pkgDir = resolveInstalledSensingMcpDir()
  const entry = pkgDir ? join(pkgDir, 'dist', 'index.js') : undefined

  if (!entry || !existsSync(entry)) {
    // stderr only — stdout is the MCP transport and must carry no chatter.
    console.error(chalk.red('robrain mcp: Sensing server bundle not found.'))
    console.error('Reinstall the CLI (npx robrain@latest mcp) or, from a clone, run pnpm build.')
    process.exit(1)
  }

  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',        // stdin/stdout are the MCP stdio transport
    env: resolveServerEnv(),
  })

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
  child.on('error', (err) => {
    console.error(chalk.red(`robrain mcp: failed to start server — ${err.message}`))
    process.exit(1)
  })

  // Forward termination so the client closing the pipe stops the child cleanly.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => child.kill(sig))
  }
}

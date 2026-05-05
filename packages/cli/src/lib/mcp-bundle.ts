// packages/cli/src/lib/mcp-bundle.ts
// Copy or symlink built MCP packages into ~/.robrain/mcp so editor configs resolve.

import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { platform } from 'os'
import { join } from 'path'

export class McpBundleError extends Error {
  override name = 'McpBundleError'
}

/** True when ~/.robrain/mcp/sensing/dist/index.js exists and is readable. */
export function sensingBundleReady(robrainMcpDir: string): boolean {
  return existsSync(join(robrainMcpDir, 'sensing', 'dist', 'index.js'))
}

/** True when a Control MCP entrypoint exists (cloud installs only; not in OSS repo). */
export function controlBundleReady(robrainMcpDir: string): boolean {
  return existsSync(join(robrainMcpDir, 'control', 'dist', 'index.js'))
}

/**
 * Ensure ~/.robrain/mcp/sensing points at a built @context-system/sensing-mcp package.
 * Uses a directory symlink on macOS/Linux (preserves pnpm workspace node_modules).
 * On Windows, performs a recursive copy (may require building from the same machine).
 */
export function ensureSensingMcpBundle(repoRoot: string, robrainMcpDir: string): void {
  if (sensingBundleReady(robrainMcpDir)) return

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
    cpSync(src, dest, { recursive: true })
  } else {
    symlinkSync(src, dest, 'dir')
  }
}

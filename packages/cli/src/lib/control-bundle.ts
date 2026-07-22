// src/lib/control-bundle.ts
// ─────────────────────────────────────────────────────────────
// Download the Control MCP bundle from the Rory Plans cloud API
// during a cloud install and materialize it under
// ~/.robrain/mcp/control (the layout controlBundleReady expects).
//
// Strictly fail-soft by contract: every failure returns
// { ok: false, reason } — install.ts warns and continues with
// includeControl=false; nothing else about the install breaks.
// ─────────────────────────────────────────────────────────────

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface ControlBundleMeta {
  sha256:  string
  bytes:   number
  version: string
}

export type ControlBundleDownloadResult =
  | { ok: true;  updated: boolean; meta: ControlBundleMeta }
  | { ok: false; reason: string }

/** One timeout per request (meta, then bundle) — an install must never hang on Control. */
export const CONTROL_DOWNLOAD_TIMEOUT_MS = 30_000

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** sha256 of the bundle already on disk, or undefined when absent/unreadable. */
function installedBundleSha(controlDir: string): string | undefined {
  const entry = join(controlDir, 'dist', 'index.js')
  if (!existsSync(entry)) return undefined
  try {
    return sha256Hex(readFileSync(entry))
  } catch {
    return undefined
  }
}

/**
 * Fetch GET {baseUrl}/control-bundle/meta then GET {baseUrl}/control-bundle
 * (Authorization: Bearer token), verify the sha256, and write:
 *   <robrainMcpDir>/control/dist/index.js   — the self-contained server
 *   <robrainMcpDir>/control/package.json    — minimal ESM marker (same
 *                                             pattern as the Sensing bundle)
 *   <robrainMcpDir>/control/meta.json       — {sha256, bytes, version} for
 *                                             future update checks
 * Re-running skips the download when the on-disk bundle already hashes to
 * the advertised sha256, and refreshes it when the sha differs.
 */
export async function downloadControlBundle(opts: {
  baseUrl:       string
  token:         string
  robrainMcpDir: string
  timeoutMs?:    number
}): Promise<ControlBundleDownloadResult> {
  const base    = opts.baseUrl.replace(/\/+$/, '')
  const timeout = opts.timeoutMs ?? CONTROL_DOWNLOAD_TIMEOUT_MS
  const headers = { Authorization: `Bearer ${opts.token}` }
  const dest    = join(opts.robrainMcpDir, 'control')

  try {
    const metaRes = await fetch(`${base}/control-bundle/meta`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    })
    if (!metaRes.ok) return { ok: false, reason: `meta fetch failed (HTTP ${metaRes.status})` }
    const rawMeta = await metaRes.json() as Partial<ControlBundleMeta>
    if (typeof rawMeta.sha256 !== 'string' || !rawMeta.sha256) {
      return { ok: false, reason: 'meta response missing sha256' }
    }
    const meta: ControlBundleMeta = {
      sha256:  rawMeta.sha256,
      bytes:   typeof rawMeta.bytes === 'number' ? rawMeta.bytes : 0,
      version: typeof rawMeta.version === 'string' && rawMeta.version ? rawMeta.version : 'unknown',
    }

    // Already installed at this exact sha (hash the real file, not a marker) —
    // nothing to download.
    if (installedBundleSha(dest) === meta.sha256) {
      return { ok: true, updated: false, meta }
    }

    const bundleRes = await fetch(`${base}/control-bundle`, {
      headers,
      signal: AbortSignal.timeout(timeout),
    })
    if (!bundleRes.ok) return { ok: false, reason: `bundle fetch failed (HTTP ${bundleRes.status})` }
    const body = Buffer.from(await bundleRes.arrayBuffer())

    const sha = sha256Hex(body)
    if (sha !== meta.sha256) {
      return { ok: false, reason: `sha256 mismatch (expected ${meta.sha256}, got ${sha}) — refusing to install` }
    }

    mkdirSync(join(dest, 'dist'), { recursive: true })
    writeFileSync(join(dest, 'dist', 'index.js'), body)
    // Minimal package.json: Node needs "type": "module" to run the bundled ESM
    // entrypoint — mirror of the Sensing bundle materialization in mcp-bundle.ts.
    writeFileSync(
      join(dest, 'package.json'),
      JSON.stringify(
        { name: 'robrain-control-mcp', private: true, type: 'module', main: './dist/index.js' },
        null,
        2,
      ) + '\n',
    )
    writeFileSync(
      join(dest, 'meta.json'),
      JSON.stringify({ sha256: sha, bytes: body.byteLength, version: meta.version }, null, 2) + '\n',
    )
    return { ok: true, updated: true, meta }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

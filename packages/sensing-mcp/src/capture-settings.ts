// packages/sensing-mcp/src/capture-settings.ts
// ─────────────────────────────────────────────────────────────
// Per-project capture settings, read from Perception and cached.
// Primed at session start next to the always-on summary; a failed
// or slow fetch yields the defaults, which are the stock classifier,
// so capture never stalls or breaks because of a settings lookup.
// ─────────────────────────────────────────────────────────────

import { DEFAULT_CAPTURE_SETTINGS, coerceCaptureSettings, type CaptureSettings } from '@robrain/shared'
import { config } from './config.js'

const CACHE_TTL_MS = 5 * 60 * 1000

interface CacheEntry {
  settings: CaptureSettings
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<CaptureSettings>>()

async function fetchCaptureSettings(projectId: string): Promise<CaptureSettings> {
  if (!config.perceptionApiUrl) return { ...DEFAULT_CAPTURE_SETTINGS }
  try {
    const res = await fetch(
      `${config.perceptionApiUrl}/projects/${encodeURIComponent(projectId)}/capture`,
      {
        headers: { Authorization: `Bearer ${config.perceptionApiKey}` },
        signal:  AbortSignal.timeout(config.fetchTimeoutMs),
      },
    )
    if (!res.ok) {
      // 404 = older Perception without the route, or an unregistered project:
      // both mean "stock classifier", logged once per TTL rather than per turn.
      if (res.status !== 404) {
        console.error(`[Sensing] capture settings fetch failed for ${projectId}: HTTP ${res.status}`)
      }
      return { ...DEFAULT_CAPTURE_SETTINGS }
    }
    return coerceCaptureSettings(await res.json())
  } catch (err) {
    console.error('[Sensing] capture settings fetch error:', err)
    return { ...DEFAULT_CAPTURE_SETTINGS }
  }
}

/**
 * The project's capture settings, from cache when fresh. Concurrent callers
 * share one request. Never throws.
 */
export async function getCaptureSettings(projectId: string): Promise<CaptureSettings> {
  const hit = cache.get(projectId)
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.settings
  const pending = inFlight.get(projectId)
  if (pending) return pending
  const request = fetchCaptureSettings(projectId)
    .then(settings => {
      cache.set(projectId, { settings, fetchedAt: Date.now() })
      return settings
    })
    .finally(() => inFlight.delete(projectId))
  inFlight.set(projectId, request)
  return request
}

/** Drop a project's cached settings (or all of them), so the next turn re-reads them. */
export function resetCaptureSettingsCache(projectId?: string): void {
  if (projectId === undefined) {
    cache.clear()
    inFlight.clear()
    return
  }
  cache.delete(projectId)
  inFlight.delete(projectId)
}

/** Test seam: pin settings for a project without a Perception round trip. */
export function seedCaptureSettings(projectId: string, settings: CaptureSettings): void {
  cache.set(projectId, { settings, fetchedAt: Date.now() })
}

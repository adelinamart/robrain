// src/lib/config.ts
// ─────────────────────────────────────────────────────────────
// Manages local RoBrain config stored in ~/.robrain/config.json
// Handles: API token, user info, Rory Plans API URL, project settings
// ─────────────────────────────────────────────────────────────

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const CONFIG_DIR  = join(homedir(), '.robrain')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

export interface RoMemoryConfig {
  token?:          string        // Rory Plans API token
  email?:          string        // authenticated user email
  /** Set when using install --self-hosted (no Rory token) */
  selfHosted?:     boolean
  /** Cloud thin-client install — Sensing ships raw turns; classification runs server-side */
  thin?:           boolean
  perceptionUrl?:  string        // Rory-hosted Perception API URL
  perceptionKey?:  string        // Perception API key (cloud install; optional self-hosted)
  planningUrl?:    string        // Rory-hosted Planning API URL
  planningKey?:    string        // Planning API key (cloud)
  embeddingProvider?: string     // openai | voyage | cohere
  embeddingKey?:   string        // embedding API key
  installedAt?:    string        // ISO date of installation
  version?:        string        // CLI version at install time
}

/**
 * Rewrites a `localhost` host to `127.0.0.1`. Node 17+ resolves localhost
 * IPv6-first (::1) on many systems, but the Docker stack only binds
 * 127.0.0.1 — fetch then dies with ECONNREFUSED ::1 while curl works.
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

export function readConfig(): RoMemoryConfig {
  if (!existsSync(CONFIG_FILE)) return {}
  try {
    const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as RoMemoryConfig
    if (config.perceptionUrl) config.perceptionUrl = normalizeLoopbackUrl(config.perceptionUrl)
    return config
  } catch {
    return {}
  }
}

export function writeConfig(config: RoMemoryConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true })
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
}

export function mergeConfig(updates: Partial<RoMemoryConfig>): void {
  const current = readConfig()
  writeConfig({ ...current, ...updates })
}

/** True if Rory cloud login, or OSS self-hosted install (no Rory token). */
export function isAuthenticated(): boolean {
  const config = readConfig()
  if (config.token && config.email) return true
  if (config.selfHosted) return true
  // Legacy self-hosted before selfHosted flag: perception configured, never logged into Rory
  return Boolean(
    config.perceptionUrl &&
      config.installedAt &&
      !config.token &&
      !config.email,
  )
}

/**
 * True when this install talks to the managed Rory Plans API rather than a
 * local stack — i.e. there is no local Postgres for batch jobs to open.
 * `selfHosted` wins: `robrain up` merges that flag in, so a user who has both
 * a cloud login and a local stack still counts as self-hosted.
 */
export function isCloudInstall(): boolean {
  const config = readConfig()
  if (config.selfHosted) return false
  return Boolean(config.thin || config.token)
}

export function getToken(): string | undefined {
  return readConfig().token
}

/** Config keys that only a Rory Plans cloud login writes. */
const CLOUD_ONLY_KEYS: Array<keyof RoMemoryConfig> = ['token', 'email', 'thin', 'planningUrl', 'planningKey']

/**
 * Keys a cloud install provisions for the Rory-hosted Perception. On a
 * self-hosted install the same keys point at the local stack and must
 * survive a logout, otherwise `status` / `init-project` stop working until
 * the user re-runs `install --self-hosted`.
 */
const CLOUD_PERCEPTION_KEYS: Array<keyof RoMemoryConfig> = ['perceptionUrl', 'perceptionKey']

export interface CredentialSplit {
  /** What logout leaves on disk. */
  remaining: RoMemoryConfig
  /** Keys that held a value and were removed. */
  cleared:   Array<keyof RoMemoryConfig>
  /** Keys that held a value and were kept. */
  kept:      Array<keyof RoMemoryConfig>
}

/**
 * Pure half of `logout`: removes the cloud credentials from `config` and
 * reports which keys went and which stayed. A self-hosted install is
 * recognised by `selfHosted`, or — for installs predating that flag — by a
 * configured Perception URL with no cloud token.
 */
export function splitCloudCredentials(config: RoMemoryConfig): CredentialSplit {
  const selfHosted = Boolean(config.selfHosted) || Boolean(config.perceptionUrl && !config.token)
  const toClear    = new Set<keyof RoMemoryConfig>([
    ...CLOUD_ONLY_KEYS,
    ...(selfHosted ? [] : CLOUD_PERCEPTION_KEYS),
  ])

  const remaining: RoMemoryConfig = {}
  const cleared: Array<keyof RoMemoryConfig> = []
  const kept:    Array<keyof RoMemoryConfig> = []
  for (const key of Object.keys(config) as Array<keyof RoMemoryConfig>) {
    const value = config[key]
    const present = value !== undefined && value !== ''
    if (toClear.has(key)) {
      if (present) cleared.push(key)
      continue
    }
    ;(remaining as Record<string, unknown>)[key] = value
    if (present) kept.push(key)
  }
  return { remaining, cleared, kept }
}

/** Removes cloud credentials from ~/.robrain/config.json, keeping self-hosted settings. */
export function clearCloudCredentials(): CredentialSplit {
  const split = splitCloudCredentials(readConfig())
  writeConfig(split.remaining)
  return split
}

// Rory Plans API base URL — points to roryplans.ai auth + provisioning endpoints
export const RORY_API_BASE = process.env.RORY_API_BASE ?? 'https://api.roryplans.ai'

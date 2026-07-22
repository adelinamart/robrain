#!/usr/bin/env node
// scripts/prepare-env.mjs
// ─────────────────────────────────────────────────────────────
// Run before `docker compose ... up`.
//
// Ensures the repo-root .env exists and has non-empty values for:
//   - PERCEPTION_API_KEY  (random 32-byte hex)
//   - POSTGRES_PASSWORD   (random 32-byte hex)
//
// Also rewrites DATABASE_URL to include POSTGRES_PASSWORD when the URL still
// carries the placeholder `CHANGE_ME` from .env.example.
//
// Finally, refuses to hand off to compose when our container names are held by
// a different compose project (see checkForeignStack below).
//
// Idempotent. Existing non-empty values are never overwritten.
// ─────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(repoRoot, '.env')
const examplePath = resolve(repoRoot, '.env.example')

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    console.error('[prepare-env] .env.example missing — cannot bootstrap .env')
    process.exit(1)
  }
  copyFileSync(examplePath, envPath)
  console.log('[prepare-env] created .env from .env.example')
}

const original = readFileSync(envPath, 'utf8')
const lines = original.split('\n')

const generated = {}
function ensureRandom(key) {
  const idx = lines.findIndex(l => l.match(new RegExp(`^\\s*${key}\\s*=`)))
  if (idx === -1) {
    const value = randomBytes(32).toString('hex')
    lines.push(`${key}=${value}`)
    generated[key] = value
    return value
  }
  const current = lines[idx].replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '').trim()
  if (current.length > 0 && current !== 'CHANGE_ME') return current
  const value = randomBytes(32).toString('hex')
  lines[idx] = `${key}=${value}`
  generated[key] = value
  return value
}

const postgresPassword = ensureRandom('POSTGRES_PASSWORD')
ensureRandom('PERCEPTION_API_KEY')

// Refresh DATABASE_URL if it still carries the .env.example placeholder.
const dbIdx = lines.findIndex(l => l.match(/^\s*DATABASE_URL\s*=/))
if (dbIdx !== -1) {
  const current = lines[dbIdx].replace(/^\s*DATABASE_URL\s*=\s*/, '').trim()
  if (/CHANGE_ME/.test(current)) {
    const userIdx = lines.findIndex(l => l.match(/^\s*POSTGRES_USER\s*=/))
    const dbNameIdx = lines.findIndex(l => l.match(/^\s*POSTGRES_DB\s*=/))
    const portIdx = lines.findIndex(l => l.match(/^\s*POSTGRES_PORT\s*=/))
    const user = userIdx !== -1 ? lines[userIdx].split('=')[1].trim() : 'robrain'
    const db = dbNameIdx !== -1 ? lines[dbNameIdx].split('=')[1].trim() : 'robrain'
    const port = portIdx !== -1 ? lines[portIdx].split('=')[1].trim() : '5432'
    lines[dbIdx] = `DATABASE_URL=postgres://${user}:${postgresPassword}@127.0.0.1:${port}/${db}`
    generated.DATABASE_URL = '<rewritten with new POSTGRES_PASSWORD>'
  }
}

const next = lines.join('\n')
if (next !== original) {
  writeFileSync(envPath, next)
  for (const [k, v] of Object.entries(generated)) {
    const display = v.length > 12 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v
    console.log(`[prepare-env] generated ${k}=${display}`)
  }
}

// ── Foreign-stack preflight ──────────────────────────────────
// `robrain up` (packages/cli/src/commands/up.ts) already refuses to run when
// our container names belong to another compose project. `pnpm docker:up` is a
// raw `docker compose up` and had no such guard, so a clone started before the
// project name was pinned (project "docker") hit Docker's bare
// "container name is already in use" and stopped there — with no hint that the
// fix is one command and that the data volume is safe. Worse, the obvious
// reflex (recreate just one service) half-migrates the stack: Postgres stays on
// the old network, Perception lands on the new one, and Perception then dies on
// `ENOTFOUND postgres` while the database is actually fine.
//
// Project and container names are read from the compose file rather than
// re-declared here — that file is the source of truth, so a rename can't leave
// this check quietly asserting yesterday's names.
function checkForeignStack() {
  const composePath = resolve(repoRoot, 'docker', 'docker-compose.yml')
  if (!existsSync(composePath)) return
  const compose = readFileSync(composePath, 'utf8')

  const project = compose.match(/^name:\s*(\S+)/m)?.[1]
  const containers = [...compose.matchAll(/^\s*container_name:\s*(\S+)/gm)].map(m => m[1])
  if (!project || containers.length === 0) return

  const foreign = []
  for (const container of containers) {
    let owner
    try {
      owner = execFileSync(
        'docker',
        ['inspect', container, '--format', '{{index .Config.Labels "com.docker.compose.project"}}'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      ).toString().trim()
    } catch {
      continue   // container absent, or docker unavailable — nothing to warn about
    }
    if (owner && owner !== project) foreign.push({ container, owner })
  }
  if (foreign.length === 0) return

  const names = foreign.map(f => f.container).join(' ')
  const owners = [...new Set(foreign.map(f => f.owner))]
  console.error(`\n[prepare-env] ✗ ${names} already exist under compose project "${owners.join('", "')}", not "${project}".`)
  console.error('              Compose cannot adopt containers across projects, so the next `up` would fail.')
  console.error('\n              Your data is safe — the volume is named, not project-scoped. To migrate:')
  for (const owner of owners) console.error(`                docker compose -p ${owner} down`)
  console.error('                pnpm docker:up')
  console.error('\n              (Removing containers does NOT delete the database. Never pass -v.)\n')
  process.exit(1)
}

checkForeignStack()

// src/commands/up.ts
// ─────────────────────────────────────────────────────────────
// robrain up — start the self-hosted Perception stack (Postgres + pgvector +
// Perception API) from the published GHCR image. No repo clone required.
//
// Writes into ~/.robrain/stack/:
//   docker-compose.yml  managed — regenerated on every run
//   schema.sql          managed — extracted from the Perception image
//   .env                user-owned — secrets auto-generated once, never overwritten
//
// The repo-clone flow (`pnpm docker:up`) and this command share one compose
// project (`name: robrain`), container names, and data volume — Compose treats
// them as the same stack. Containers left behind by pre-2.3.9 stacks belong to
// other compose projects ("docker" / "stack") and cannot be adopted; the
// pre-flight check below catches that state before anything is pulled.
// ─────────────────────────────────────────────────────────────

import { execFileSync, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import chalk from 'chalk'
import { mergeConfig } from '../lib/config.js'

export const DEFAULT_IMAGE_REPO = 'ghcr.io/adelinamart/robrain-perception'
export const COMPOSE_PROJECT = 'robrain'
export const CONTAINER_NAMES = ['robrain-postgres', 'robrain-perception'] as const
const STACK_DIR = join(homedir(), '.robrain', 'stack')
const VOLUME_NAME = 'robrain_postgres_data'

// ── Pure helpers (exported for tests) ─────────────────────────

/**
 * Managed compose file for the clone-free stack. Mirrors docker/docker-compose.yml
 * with two differences: Perception runs from the published image instead of a local
 * build, and schema.sql / .env are read from the stack directory instead of the repo.
 */
export function renderStackCompose(image: string): string {
  return `# Managed by \`robrain up\` — regenerated on every run; do not edit.
# Configuration belongs in the .env file next to this compose file.

# Pinned so the repo-clone flow and \`robrain up\` are one compose project —
# without it Compose derives the project from the directory name and refuses
# to reuse containers created by the other flow.
name: ${COMPOSE_PROJECT}

services:

  postgres:
    image: pgvector/pgvector:pg16
    container_name: robrain-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER:     \${POSTGRES_USER:-robrain}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env (robrain up auto-generates one)}
      POSTGRES_DB:       \${POSTGRES_DB:-robrain}
    # Bound to localhost so the database is not reachable from the LAN.
    ports:
      - "\${POSTGRES_BIND_HOST:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432"
    volumes:
      - ${VOLUME_NAME}:/var/lib/postgresql/data
      - ./schema.sql:/docker-entrypoint-initdb.d/001_schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-robrain}"]
      interval: 5s
      timeout: 5s
      retries: 10

  perception:
    image: \${PERCEPTION_IMAGE:-${image}}
    container_name: robrain-perception
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - ./.env
    environment:
      PORT:         \${PERCEPTION_PORT:-3001}
      DATABASE_URL: postgres://\${POSTGRES_USER:-robrain}:\${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}@postgres:5432/\${POSTGRES_DB:-robrain}
      DB_SCHEMA:    context_system
      OSS_MODE:     "true"
    ports:
      - "\${PERCEPTION_BIND_HOST:-127.0.0.1}:\${PERCEPTION_PORT:-3001}:3001"
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:3001/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  ${VOLUME_NAME}:
    name: ${VOLUME_NAME}
`
}

export interface EnsureEnvResult {
  content: string
  /** Keys whose values were generated or seeded during this pass. */
  generated: string[]
}

/**
 * Same contract as scripts/prepare-env.mjs, applied to the stack .env:
 * existing non-empty values are never overwritten; blank or missing
 * POSTGRES_PASSWORD / PERCEPTION_API_KEY get random 32-byte hex values, and a
 * DATABASE_URL still carrying CHANGE_ME is rewritten to match. On first creation,
 * provider keys / OPENAI_BASE_URL present in `seeds` (the caller's process env)
 * are copied in so users who exported ANTHROPIC_API_KEY / OPENAI_API_KEY /
 * OPENAI_BASE_URL (local Ollama / LM Studio / vLLM) are not asked twice.
 */
export function ensureStackEnvContent(
  existing: string | null,
  seeds: Record<string, string | undefined>,
): EnsureEnvResult {
  const generated: string[] = []

  if (existing === null) {
    const postgresPassword = randomBytes(32).toString('hex')
    const perceptionKey = randomBytes(32).toString('hex')
    generated.push('POSTGRES_PASSWORD', 'PERCEPTION_API_KEY')

    const seededLine = (key: string, fallback = '') => {
      const value = seeds[key]?.trim()
      if (value) generated.push(key)
      return `${key}=${value || fallback}`
    }

    const content = `# RoBrain self-hosted stack — created by \`robrain up\`.
# Read by Docker Compose for substitutions AND passed to the Perception
# container (env_file). Values you set here are never overwritten; a blank
# POSTGRES_PASSWORD / PERCEPTION_API_KEY is re-generated on the next \`robrain up\`.
# Full option reference (local models, bind hosts, timeouts):
# https://github.com/adelinamart/robrain/blob/main/.env.example

${seededLine('LLM_PROVIDER', 'anthropic')}
${seededLine('ANTHROPIC_API_KEY')}
${seededLine('EMBEDDING_PROVIDER', 'openai')}
${seededLine('OPENAI_API_KEY')}
${seededLine('OPENAI_BASE_URL')}
${seededLine('VOYAGE_API_KEY')}
${seededLine('COHERE_API_KEY')}

POSTGRES_USER=robrain
POSTGRES_PASSWORD=${postgresPassword}
POSTGRES_DB=robrain
POSTGRES_PORT=5432
PERCEPTION_PORT=3001
PERCEPTION_API_KEY=${perceptionKey}

# Host-side connection string for \`robrain synth\` (the container builds its own).
DATABASE_URL=postgres://robrain:${postgresPassword}@localhost:5432/robrain
`
    return { content, generated }
  }

  const lines = existing.split('\n')

  const ensureRandom = (key: string): string => {
    const idx = lines.findIndex(l => l.match(new RegExp(`^\\s*${key}\\s*=`)))
    if (idx === -1) {
      const value = randomBytes(32).toString('hex')
      lines.push(`${key}=${value}`)
      generated.push(key)
      return value
    }
    const current = (lines[idx] ?? '').replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '').trim()
    if (current.length > 0 && current !== 'CHANGE_ME') return current
    const value = randomBytes(32).toString('hex')
    lines[idx] = `${key}=${value}`
    generated.push(key)
    return value
  }

  const postgresPassword = ensureRandom('POSTGRES_PASSWORD')
  ensureRandom('PERCEPTION_API_KEY')

  const dbIdx = lines.findIndex(l => l.match(/^\s*DATABASE_URL\s*=/))
  if (dbIdx !== -1 && /CHANGE_ME/.test(lines[dbIdx] ?? '')) {
    lines[dbIdx] = `DATABASE_URL=postgres://robrain:${postgresPassword}@localhost:5432/robrain`
    generated.push('DATABASE_URL')
  }

  return { content: lines.join('\n'), generated }
}

/** Read a KEY=value line out of env-file content. */
export function readEnvValue(content: string, key: string): string {
  const line = content.split('\n').find(l => l.match(new RegExp(`^\\s*${key}\\s*=`)))
  return line ? line.replace(new RegExp(`^\\s*${key}\\s*=\\s*`), '').trim() : ''
}

// ── Docker plumbing ────────────────────────────────────────────

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function volumeExists(): boolean {
  try {
    execFileSync('docker', ['volume', 'inspect', VOLUME_NAME], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Compose project label of an existing container: the project name for
 * compose-managed containers, '' for plain `docker run` ones, null when the
 * container does not exist (or docker inspect fails — fail open, compose up
 * will surface its own error).
 */
function containerComposeProject(container: string): string | null {
  try {
    return execFileSync(
      'docker',
      ['container', 'inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', container],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim()
  } catch {
    return null
  }
}

export interface ForeignContainer {
  container: string
  /** Owning compose project; '' when created outside compose. */
  project: string
}

/**
 * Containers carrying our names but owned by something other than the
 * `robrain` compose project — a repo clone started before the project name was
 * pinned (project "docker"), a pre-2.3.9 CLI stack (project "stack"), or plain
 * `docker run`. Compose cannot adopt these; `up` must stop before pulling.
 */
export function findForeignContainers(
  projectOf: (container: string) => string | null,
): ForeignContainer[] {
  const foreign: ForeignContainer[] = []
  for (const container of CONTAINER_NAMES) {
    const project = projectOf(container)
    if (project !== null && project !== COMPOSE_PROJECT) foreign.push({ container, project })
  }
  return foreign
}

function imagePresentLocally(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function composeArgs(rest: string[]): string[] {
  return ['compose', '--project-directory', STACK_DIR, '-f', join(STACK_DIR, 'docker-compose.yml'), ...rest]
}

// ── Commands ───────────────────────────────────────────────────

export interface UpOptions {
  /** Image tag to run; defaults to the CLI version so client and server move together. */
  tag?: string
  /** Full image override; wins over --tag. */
  image?: string
  /** CLI version, injected by the entry point (source of the default tag). */
  cliVersion: string
}

export async function upCommand(opts: UpOptions): Promise<void> {
  console.log()
  console.log(chalk.bold('  RoBrain self-hosted stack') + chalk.dim(' — Postgres + Perception, no clone needed\n'))

  if (!dockerAvailable()) {
    console.log(chalk.red('  ✗ Docker (with the compose plugin) is required but not available.'))
    console.log(chalk.dim('    Install Docker Desktop or docker-ce + docker-compose-plugin, then re-run ') + chalk.cyan('npx robrain up') + '\n')
    process.exit(1)
  }

  const image = opts.image ?? `${DEFAULT_IMAGE_REPO}:${opts.tag ?? opts.cliVersion}`
  mkdirSync(STACK_DIR, { recursive: true })

  // 1. .env — generate secrets once, keep user edits forever after.
  const envPath = join(STACK_DIR, '.env')
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null
  const { content: envContent, generated } = ensureStackEnvContent(existing, process.env)
  if (existing !== envContent) writeFileSync(envPath, envContent)
  for (const key of generated) {
    const value = readEnvValue(envContent, key)
    const display = value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
    console.log(chalk.dim(`  generated ${key}=${display}`))
  }

  // Containers from another compose project make `compose up` die mid-run
  // with a raw name-conflict error from the daemon — catch it here, before
  // pulling anything, with instructions that actually work for that state
  // (`robrain down` only owns the `robrain` project, so it cannot remove them).
  const foreign = findForeignContainers(containerComposeProject)
  if (foreign.length > 0) {
    const names = foreign.map(f => f.container).join(' ')
    const downCommands = [...new Set(foreign.map(f => f.project))].map(project =>
      project ? `docker compose -p ${project} down` : `docker rm -f ${names}`)
    console.log(chalk.red(`\n  ✗ Found existing container(s) ${names} from an older RoBrain stack`) + chalk.dim(' (repo clone or a previous CLI version).'))
    console.log(chalk.dim('    Docker Compose cannot reuse containers across projects, so they must be removed first.'))
    console.log(chalk.dim('    To keep your data — remove the old containers (the data volume is preserved):'))
    for (const cmd of downCommands) console.log('      ' + chalk.cyan(cmd))
    console.log(chalk.dim('    then copy POSTGRES_PASSWORD + PERCEPTION_API_KEY from the old stack\'s .env into ') + chalk.cyan(envPath))
    console.log(chalk.dim('    and re-run ') + chalk.cyan('npx robrain up') + chalk.dim(' — it will start against the existing database.'))
    console.log(chalk.dim('    To start fresh instead: ') + chalk.cyan(`docker rm -f ${names} && docker volume rm ${VOLUME_NAME}`) + chalk.dim(' then re-run ') + chalk.cyan('npx robrain up') + '\n')
    process.exit(1)
  }

  // Existing data volume + freshly generated password = the new credentials
  // cannot open the old database (POSTGRES_PASSWORD only applies at initdb).
  if (generated.includes('POSTGRES_PASSWORD') && volumeExists()) {
    console.log(chalk.yellow(`\n  ⚠ Data volume ${VOLUME_NAME} already exists but POSTGRES_PASSWORD was just generated.`))
    console.log(chalk.yellow('    The new password will NOT match the existing database. Either:'))
    console.log(chalk.dim('      • copy POSTGRES_PASSWORD + PERCEPTION_API_KEY from your previous .env (repo clone) into ') + chalk.cyan(envPath))
    console.log(chalk.dim('      • or start fresh: ') + chalk.cyan(`npx robrain down && docker volume rm ${VOLUME_NAME}`) + chalk.dim(' then re-run ') + chalk.cyan('npx robrain up') + '\n')
  }

  // 2. Managed compose file.
  writeFileSync(join(STACK_DIR, 'docker-compose.yml'), renderStackCompose(image))

  // 3. Pull the image, extract the version-matched schema for the initdb mount.
  console.log(chalk.dim('  Pulling ') + chalk.cyan(image) + chalk.dim(' …'))
  const pull = spawnSync('docker', ['pull', image], { stdio: 'inherit' })
  if (pull.status !== 0) {
    // A local copy (pre-pulled, --platform override, or locally built via
    // --image) is still runnable — offline or registry hiccups shouldn't
    // block a stack whose image is already on disk.
    if (imagePresentLocally(image)) {
      console.log(chalk.yellow(`\n  ⚠ Could not pull ${image} — using the local copy already on this machine.`))
    } else {
      console.log(chalk.red(`\n  ✗ Could not pull ${image}.`))
      console.log(chalk.dim('    If this tag is not published yet, try ') + chalk.cyan('npx robrain up --tag latest') + '\n')
      process.exit(1)
    }
  }
  const schema = execFileSync('docker', ['run', '--rm', '--entrypoint', 'cat', image, '/app/schema.sql'])
  writeFileSync(join(STACK_DIR, 'schema.sql'), schema)

  // 4. Up, waiting on both healthchecks.
  console.log(chalk.dim('\n  Starting containers …'))
  const up = spawnSync('docker', composeArgs(['up', '-d', '--wait']), { stdio: 'inherit' })
  if (up.status !== 0) {
    console.log(chalk.red('\n  ✗ Stack failed to become healthy.'))
    console.log(chalk.dim('    Logs: ') + chalk.cyan(`docker compose --project-directory ${STACK_DIR} logs perception`) + '\n')
    process.exit(1)
  }

  // 5. Make the key discoverable by `robrain install --self-hosted` and the
  // other CLI commands — config.json is the install-time source of truth.
  const perceptionPort = readEnvValue(envContent, 'PERCEPTION_PORT') || '3001'
  const perceptionUrl = `http://localhost:${perceptionPort}`
  const perceptionKey = readEnvValue(envContent, 'PERCEPTION_API_KEY')
  mergeConfig({ perceptionUrl, ...(perceptionKey ? { perceptionKey } : {}), selfHosted: true })

  console.log()
  console.log(chalk.green('  ✓ Perception is up') + chalk.dim(` — ${perceptionUrl}`))
  console.log(chalk.dim('  Stack files: ') + STACK_DIR)
  console.log()
  console.log(chalk.dim('  Next steps:'))
  console.log(chalk.dim('    ') + chalk.cyan('npx robrain install --self-hosted') + chalk.dim('   Wire Sensing MCP into your editors'))
  console.log(chalk.dim('    ') + chalk.cyan('npx robrain init-project') + chalk.dim('            Warm-start memory in your project'))
  console.log()
}

export async function downCommand(): Promise<void> {
  const composePath = join(STACK_DIR, 'docker-compose.yml')
  if (!existsSync(composePath)) {
    console.log(chalk.yellow(`\n  ⚠ No stack found at ${STACK_DIR} — nothing to stop.`))
    console.log(chalk.dim('    (Repo-clone stacks are stopped with ') + chalk.cyan('pnpm docker:down') + chalk.dim(' from the clone.)\n'))
    return
  }
  const down = spawnSync('docker', composeArgs(['down']), { stdio: 'inherit' })
  if (down.status === 0) {
    console.log(chalk.green('\n  ✓ Stack stopped') + chalk.dim(` — data volume ${VOLUME_NAME} is preserved\n`))
  }
}

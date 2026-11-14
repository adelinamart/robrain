// packages/cli/src/commands/agent-keys.ts
// ─────────────────────────────────────────────────────────────
// robrain agent-keys create <name> [--json]
// robrain agent-keys list [--all] [--json]
// robrain agent-keys revoke <name-or-id> [--json]
//
// RoBrain cloud, org admins. A production agent should run with its own
// key, not a person's: an agent key always acts as a member (it reads,
// captures and registers its project; it cannot write rules, push
// decisions, change tags or manage keys), it belongs to the admin who
// created it, and it stops working when that admin loses access to the
// org. Self-hosted Perception has one shared key and none of these routes;
// each command says so and exits.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { isMissingRoute } from './cloud.js'
import { exitUnreachable, perceptionEndpoint } from './projects.js'

export interface AgentKey {
  id: string
  name: string
  prefix: string
  owner_email: string | null
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
  /** False once revoked, or once its owner's membership is no longer active. */
  working: boolean
}

/** Same rule the API applies: 1 to 63 characters, starting with a letter or digit. Null when unusable. */
export function normalizeAgentKeyName(raw: string): string | null {
  const name = raw.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{0,62}$/.test(name) ? name : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Which key `revoke <name-or-id>` means. An id matches any key; a name
 * matches only a key that is not revoked yet, because a name can be reused
 * after a revoke and the old rows keep it.
 */
export function findAgentKey(keys: readonly AgentKey[], nameOrId: string): AgentKey | null {
  const wanted = nameOrId.trim().toLowerCase()
  if (UUID_RE.test(wanted)) return keys.find(k => k.id.toLowerCase() === wanted) ?? null
  return keys.find(k => k.name === wanted && !k.revoked_at) ?? null
}

/** Why a key is in the state it is in, in two or three words. */
export function agentKeyStatus(key: AgentKey): string {
  if (key.revoked_at) return 'revoked'
  return key.working ? 'working' : 'stopped: owner lost access'
}

function day(iso: string | null): string {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : 'never'
}

/** One row per key, columns aligned. Plain strings (no colour) so tests read them. */
export function agentKeyLines(keys: readonly AgentKey[]): string[] {
  if (keys.length === 0) return []
  const nameWidth = Math.max(...keys.map(k => k.name.length))
  const ownerWidth = Math.max(...keys.map(k => (k.owner_email ?? 'unknown').length))
  return keys.map(k => [
    k.name.padEnd(nameWidth),
    `${k.prefix}…`,
    (k.owner_email ?? 'unknown').padEnd(ownerWidth),
    `created ${day(k.created_at)}`,
    `last used ${day(k.last_used_at)}`,
    agentKeyStatus(k),
  ].join('  '))
}

interface ApiError { error?: string; message?: string; detail?: string }

/** What to tell the person for an answer the API gave on purpose. Null: not one this module knows. */
export function agentKeyErrorMessage(status: number, payload: ApiError): string | null {
  switch (payload.error) {
    case 'admin_required':
      return 'Only an org admin can create, list or revoke agent keys.'
    case 'owner_required':
      return 'An agent key belongs to the admin who creates it, so this needs your own key. Run robrain install to get one.'
    case 'invalid_name':
      return 'Use 1 to 63 characters, starting with a letter or digit: letters, digits, dot, dash and underscore.'
    case 'name_taken':
      return payload.message ?? 'A key with that name already exists. Revoke it first or pick another name.'
    case 'agent_key_limit':
      return payload.message ?? 'This org has reached its limit of agent keys. Revoke one you no longer use.'
    case 'agent_key_not_found':
      return 'No agent key with that id in your org.'
    default:
      return status === 401 ? 'Your key was not accepted. Run robrain install to get a new one.' : null
  }
}

function exitNotCloud(): never {
  console.log(chalk.yellow('\n  Agent keys are a RoBrain cloud feature: one key per production agent, created by an org admin.'))
  console.log(chalk.yellow('  Self-hosted Perception has a single shared key (PERCEPTION_API_KEY).\n'))
  process.exit(1)
}

function exitWithError(what: string, status: number, payload: ApiError): never {
  const known = agentKeyErrorMessage(status, payload)
  console.log(chalk.red(`\n  ✗ ${what} (${status})`) + chalk.dim(`  ${known ?? payload.detail ?? payload.message ?? payload.error ?? ''}\n`))
  process.exit(1)
}

async function request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; ok: boolean; payload: Record<string, unknown> & ApiError }> {
  const { url, key } = perceptionEndpoint()
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((err: unknown) => exitUnreachable(url, err))
  const payload = await res.json().catch(() => ({})) as Record<string, unknown> & ApiError
  if (isMissingRoute(res.status, payload)) exitNotCloud()
  return { status: res.status, ok: res.ok, payload }
}

async function fetchAgentKeys(): Promise<AgentKey[]> {
  const { status, ok, payload } = await request('GET', '/org/agent-keys')
  if (!ok || !Array.isArray(payload.agent_keys)) exitWithError('Could not list agent keys', status, payload)
  return payload.agent_keys as AgentKey[]
}

export async function agentKeysCreateCommand(rawName: string, opts: { json?: boolean } = {}): Promise<void> {
  const name = normalizeAgentKeyName(rawName)
  if (!name) {
    console.log(chalk.red(`\n  ✗ "${rawName}" is not a usable name.`) + chalk.dim(`  ${agentKeyErrorMessage(400, { error: 'invalid_name' })}\n`))
    process.exit(1)
  }
  const { status, ok, payload } = await request('POST', '/org/agent-keys', { name })
  const created = payload.agent_key as { id?: string; name?: string; plaintext?: string; owner_email?: string | null } | undefined
  if (!ok || !created?.plaintext) exitWithError('Could not create the agent key', status, payload)
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log()
  console.log(chalk.green(`  ✓ Agent key ${created.name ?? name} created`) + chalk.dim(created.owner_email ? `  owner ${created.owner_email}` : ''))
  console.log()
  console.log(`  ${created.plaintext}`)
  console.log()
  console.log(chalk.yellow('  This is the only time the key is shown. Store it in your agent\'s secrets now.'))
  console.log(chalk.dim('  Set it as ROBRAIN_API_KEY where the agent runs. It acts as a member: it reads and captures,'))
  console.log(chalk.dim('  and cannot write rules, push decisions or manage keys. It stops working if you lose access'))
  console.log(chalk.dim(`  to the org. Revoke it with: robrain agent-keys revoke ${created.name ?? name}`))
  console.log()
}

export async function agentKeysListCommand(opts: { all?: boolean; json?: boolean } = {}): Promise<void> {
  const keys = await fetchAgentKeys()
  const shown = opts.all ? keys : keys.filter(k => !k.revoked_at)
  if (opts.json) {
    console.log(JSON.stringify({ agent_keys: shown }, null, 2))
    return
  }
  console.log()
  if (shown.length === 0) {
    const hidden = keys.length - shown.length
    console.log(chalk.dim(`  No agent keys${hidden > 0 ? ` in use (${hidden} revoked, see --all)` : ' yet'}. Create one with: robrain agent-keys create <name>\n`))
    return
  }
  for (const line of agentKeyLines(shown)) {
    console.log(`  ${line.endsWith('working') ? line : chalk.dim(line)}`)
  }
  const hidden = keys.length - shown.length
  if (hidden > 0) console.log(chalk.dim(`\n  ${hidden} revoked ${hidden === 1 ? 'key is' : 'keys are'} hidden. Show them with --all.`))
  console.log()
}

export async function agentKeysRevokeCommand(nameOrId: string, opts: { json?: boolean } = {}): Promise<void> {
  const keys = await fetchAgentKeys()
  const key = findAgentKey(keys, nameOrId)
  if (!key) {
    console.log(chalk.red(`\n  ✗ No agent key "${nameOrId.trim()}" to revoke.`) + chalk.dim('  See robrain agent-keys list.\n'))
    process.exit(1)
  }
  if (key.revoked_at) {
    if (opts.json) console.log(JSON.stringify({ revoked: true, id: key.id, name: key.name, already: true }, null, 2))
    else console.log(chalk.dim(`\n  Agent key ${key.name} was already revoked on ${day(key.revoked_at)}.\n`))
    return
  }
  const { status, ok, payload } = await request('DELETE', `/org/agent-keys/${encodeURIComponent(key.id)}`)
  if (!ok) exitWithError('Could not revoke the agent key', status, payload)
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(chalk.green(`\n  ✓ Agent key ${key.name} revoked.`) + chalk.dim('  The agent using it gets 401 from now on.\n'))
}

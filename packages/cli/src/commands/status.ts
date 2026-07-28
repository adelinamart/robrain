// src/commands/status.ts
// robrain status — shows current state of the memory system

import chalk from 'chalk'
import { readConfig, isAuthenticated, type RoMemoryConfig } from '../lib/config.js'
import { findPinnedProjectId, gatherProjectInfo } from '../lib/project.js'
import { cwd } from 'process'

/**
 * Whether this directory's project actually exists in the store. `unknown`
 * keeps "we could not check" distinct from "it is not there" — never claim
 * a project is missing because the API was down.
 */
export interface ProjectRegistration {
  reachable: boolean
  /** `auth_failed` is split out of `unknown`: same "cannot tell", but fixable. */
  state:     'registered' | 'unregistered' | 'unknown' | 'auth_failed'
  decisions?: number
}

export async function lookUpRegistration(
  config: RoMemoryConfig,
  projectId: string,
): Promise<ProjectRegistration> {
  if (!config.perceptionUrl) return { reachable: false, state: 'unknown' }
  try {
    const health = await fetch(`${config.perceptionUrl}/health`)
    if (!health.ok) return { reachable: false, state: 'unknown' }
  } catch {
    return { reachable: false, state: 'unknown' }
  }
  try {
    const res = await fetch(`${config.perceptionUrl}/projects`, {
      headers: config.perceptionKey ? { Authorization: `Bearer ${config.perceptionKey}` } : {},
    })
    // /health is deliberately unauthenticated, so a bad key reaches us here as
    // a healthy store that rejects the read — actionable, unlike plain unknown.
    if (res.status === 401 || res.status === 403) return { reachable: true, state: 'auth_failed' }
    if (!res.ok) return { reachable: true, state: 'unknown' }
    const data = await res.json() as { projects?: Array<{ id: string; decision_count?: number }> }
    // Only a well-formed list can prove absence. An unexpected shape (a cloud
    // API that answers differently) must not read as "your project is gone" —
    // that sends someone to re-init a project that already exists.
    if (!Array.isArray(data.projects)) return { reachable: true, state: 'unknown' }
    const row = data.projects.find(p => p.id === projectId)
    if (!row) return { reachable: true, state: 'unregistered' }
    return { reachable: true, state: 'registered', decisions: row.decision_count }
  } catch {
    return { reachable: true, state: 'unknown' }
  }
}

/** One-line state for the `Memory:` row. Any follow-up goes in registrationHint. */
export function describeRegistration(reg: ProjectRegistration): string {
  if (reg.state === 'registered') {
    const n = reg.decisions
    if (typeof n !== 'number') return chalk.green('registered')
    // 0 on a registered project is the silent-Sensing tell — call it out.
    return chalk.green('registered') + chalk.dim(' · ')
      + (n === 0 ? chalk.yellow('0 decisions') : `${n} decisions`)
  }
  if (reg.state === 'unregistered') {
    return chalk.yellow('not registered') + chalk.dim(' — nothing is stored for this directory yet')
  }
  if (reg.state === 'auth_failed') {
    return chalk.yellow('unknown') + chalk.dim(' — the memory store rejected this API key')
  }
  return chalk.dim('unknown — could not reach the memory store')
}

/**
 * Remediation for the row above, printed on its own line: hand-aligning a
 * continuation inside the value wraps badly in narrow terminals.
 */
export function registrationHint(reg: ProjectRegistration): string | null {
  if (reg.state === 'unregistered') return 'Run `npx robrain init-project` from a project root.'
  if (reg.state === 'auth_failed')  return 'Re-run `npx robrain install` to refresh credentials.'
  return null
}

export async function statusCommand(): Promise<void> {
  console.log()

  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated'))
    console.log(chalk.dim('  Run: npx robrain install'))
    console.log()
    return
  }

  const config = readConfig()
  const info   = gatherProjectInfo(cwd())

  console.log(chalk.bold('  RoBrain status\n'))
  const accountLabel =
    config.token && config.email ? config.email : 'self-hosted (OSS)'
  console.log(chalk.dim('  Account:     ') + accountLabel)
  console.log(chalk.dim('  Installed:   ') + (config.installedAt
    ? new Date(config.installedAt).toLocaleDateString()
    : 'unknown'))
  console.log(chalk.dim('  Embeddings:  ') + (config.thin
    ? 'cloud (server-side)'
    : (config.embeddingProvider ?? 'not set')))
  // Look up registration BEFORE printing the project block. "Current project:
  // <id>" is computed locally (see below) and says nothing about whether that
  // project exists — printing it bare reads as membership we never checked,
  // which makes a clean uninstall look like a failed one.
  const registration = await lookUpRegistration(config, info.id)

  // The id is derived from the directory path unless an editor file pins one,
  // so it is stable across reinstalls (and identical on two machines with the
  // same path). Naming the exact source heads off "why is this the same id I
  // had before I deleted everything?".
  const pinned = findPinnedProjectId(cwd())
  const idSource = pinned?.id === info.id
    ? `pinned in ${pinned.source}`
    : 'derived from this directory path'

  console.log()
  console.log(chalk.dim('  Current project'))
  console.log(chalk.dim('  ├ Name:      ') + info.name)
  console.log(chalk.dim('  ├ ID:        ') + info.id + chalk.dim(`  (${idSource})`))
  console.log(chalk.dim('  └ Memory:    ') + describeRegistration(registration))
  const hint = registrationHint(registration)
  if (hint) console.log(chalk.dim('               ') + hint)
  console.log()

  if (config.perceptionUrl) {
    console.log(chalk.dim('  Perception:  ') + (registration.reachable
      ? chalk.green('● connected')
      : chalk.yellow('○ unreachable')))
  }

  if (config.planningUrl) {
    try {
      const res = await fetch(`${config.planningUrl}/health`)
      if (res.ok) {
        console.log(chalk.dim('  Planning:    ') + chalk.green('● connected'))
      } else {
        console.log(chalk.dim('  Planning:    ') + chalk.yellow('○ unreachable'))
      }
    } catch {
      console.log(chalk.dim('  Planning:    ') + chalk.yellow('○ unreachable'))
    }
  }

  console.log()
}

// ─────────────────────────────────────────────────────────────
// robrain rule --add TEXT [--type always_include|always_exclude|preference]
//               --list

export async function ruleCommand(opts: {
  add?:    string
  list?:   boolean
  type?:   string
}): Promise<void> {
  console.log()

  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated. Run: npx robrain install'))
    process.exit(1)
  }

  const config  = readConfig()
  const info    = gatherProjectInfo(cwd())
  const planUrl = config.planningUrl
  const planKey = config.planningKey ?? ''

  if (opts.add) {
    if (!planUrl) {
      console.log(chalk.red('  ✗ Planning URL not configured. Run: npx robrain install (cloud)'))
      process.exit(1)
    }
    const factType = opts.type === 'always_include' ? 'force_include'
                   : opts.type === 'always_exclude' ? 'force_exclude'
                   : 'preference'

    const res = await fetch(`${planUrl}/facts`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(planKey ? { 'Authorization': `Bearer ${planKey}` } : {}),
      },
      body: JSON.stringify({
        project_id: info.id,
        fact_type:  factType,
        content:    opts.add,
        scope:      'project',
      }),
    })

    if (res.ok) {
      console.log(chalk.green(`  ✓ Rule added: "${opts.add}"`))
      console.log(chalk.dim(`  Type: ${factType} · Project: ${info.name}`))
    } else {
      console.log(chalk.red('  ✗ Failed to add rule'))
    }
    console.log()
    return
  }

  if (opts.list) {
    if (!planUrl) {
      console.log(chalk.bold('  Planning rules\n'))
      console.log(chalk.dim('  OSS self-hosted has no Planning service — `mem0_facts` / rules are not in Perception.'))
      console.log(chalk.dim('  Use Rory Plans cloud (`planningUrl` in config) for `npx robrain rule`, or manage prompts in your editor.'))
      console.log()
      return
    }
    console.log(chalk.bold('  Active rules\n'))
    try {
      const res = await fetch(
        `${planUrl.replace(/\/$/, '')}/facts?project_id=${encodeURIComponent(info.id)}`,
        { headers: planKey ? { Authorization: `Bearer ${planKey}` } : {} },
      )
      if (!res.ok) {
        console.log(chalk.yellow(`  Could not list rules (${res.status}). This Planning URL may not expose GET /facts.`))
        console.log()
        return
      }
      const data = await res.json().catch(() => ({})) as { facts?: Array<{ id?: string; content?: string; fact_type?: string }> }
      const facts = Array.isArray(data.facts) ? data.facts : []
      if (facts.length === 0) {
        console.log(chalk.dim('  No rules stored for this project yet.'))
      } else {
        for (const f of facts) {
          const id = f.id ?? '?'
          const t  = f.fact_type ?? 'preference'
          console.log(chalk.dim(`  • [${id}] ${t}: `) + (f.content ?? ''))
        }
      }
    } catch {
      console.log(chalk.yellow('  Could not reach Planning API to list rules.'))
    }
    console.log()
    return
  }

  console.log(chalk.dim('  Usage:'))
  console.log(chalk.dim('    robrain rule --add "always surface auth decisions"'))
  console.log(chalk.dim('    robrain rule --add "skip test files" --type always_exclude'))
  console.log(chalk.dim('    robrain rule --list'))
  console.log()
}

// ─────────────────────────────────────────────────────────────
// robrain logout

export async function logoutCommand(): Promise<void> {
  const { writeConfig } = await import('../lib/config.js')
  writeConfig({})
  console.log()
  console.log(chalk.green('  ✓ Logged out. Config cleared from ~/.robrain/config.json'))
  console.log()
}

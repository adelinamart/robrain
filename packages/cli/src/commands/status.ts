// src/commands/status.ts
// robrain status — shows current state of the memory system

import chalk from 'chalk'
import { readConfig, isAuthenticated } from '../lib/config.js'
import { gatherProjectInfo } from '../lib/project.js'
import { cwd } from 'process'

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
  console.log()
  console.log(chalk.dim('  Current project'))
  console.log(chalk.dim('  ├ Name:      ') + info.name)
  console.log(chalk.dim('  └ ID:        ') + info.id)
  console.log()

  // Ping Perception for live stats + decision count for this project (helps spot silent Sensing)
  if (config.perceptionUrl) {
    try {
      const res = await fetch(`${config.perceptionUrl}/health`)
      if (res.ok) {
        console.log(chalk.dim('  Perception:  ') + chalk.green('● connected'))
      } else {
        console.log(chalk.dim('  Perception:  ') + chalk.yellow('○ unreachable'))
      }
      try {
        const pr = await fetch(`${config.perceptionUrl}/projects`, {
          headers: config.perceptionKey ? { Authorization: `Bearer ${config.perceptionKey}` } : {},
        })
        if (pr.ok) {
          const data = await pr.json() as {
            projects?: Array<{ id: string; decision_count?: number }>
          }
          const row = data.projects?.find(p => p.id === info.id)
          const n     = row?.decision_count
          if (typeof n === 'number') {
            console.log(chalk.dim('  Decisions:   ') + (n === 0 ? chalk.yellow(String(n)) : String(n)) + chalk.dim(` (active rows for project ${info.id})`))
          }
        }
      } catch { /* ignore count */ }
    } catch {
      console.log(chalk.dim('  Perception:  ') + chalk.yellow('○ unreachable'))
    }
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

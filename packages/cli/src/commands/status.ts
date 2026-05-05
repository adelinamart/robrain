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
    console.log(chalk.dim('  Run: robrain install'))
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
  console.log(chalk.dim('  Embeddings:  ') + (config.embeddingProvider ?? 'not set'))
  console.log()
  console.log(chalk.dim('  Current project'))
  console.log(chalk.dim('  ├ Name:      ') + info.name)
  console.log(chalk.dim('  └ ID:        ') + info.id)
  console.log()

  // Ping Perception for live stats
  if (config.perceptionUrl) {
    try {
      const res = await fetch(`${config.perceptionUrl}/health`)
      if (res.ok) {
        console.log(chalk.dim('  Perception:  ') + chalk.green('● connected'))
      } else {
        console.log(chalk.dim('  Perception:  ') + chalk.yellow('○ unreachable'))
      }
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
//               --remove ID

export async function ruleCommand(opts: {
  add?:    string
  list?:   boolean
  remove?: string
  type?:   string
}): Promise<void> {
  console.log()

  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated. Run: robrain install'))
    process.exit(1)
  }

  const config  = readConfig()
  const info    = gatherProjectInfo(cwd())
  const planUrl = config.planningUrl

  if (!planUrl) {
    console.log(chalk.red('  ✗ Planning URL not configured. Run: robrain install'))
    process.exit(1)
  }

  const planKey = config.planningKey ?? ''

  if (opts.add) {
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
    console.log(chalk.bold('  Active rules\n'))
    console.log(chalk.dim('  (rules are managed via Claude Code — use control_add_rule or robrain rule --add)'))
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

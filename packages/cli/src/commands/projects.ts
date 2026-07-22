// src/commands/projects.ts
// ─────────────────────────────────────────────────────────────
// robrain projects list | merge — manage Perception project rows
// (recover from phantom project_ids after cwd moves / typos).
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { normalizeLoopbackUrl, readConfig } from '../lib/config.js'

function perceptionEndpoint(): { url: string; key: string } {
  const config = readConfig()
  const url = normalizeLoopbackUrl(
    config.perceptionUrl ??
    process.env.PERCEPTION_URL ??
    'http://127.0.0.1:3001',
  )
  const key = config.perceptionKey ?? process.env.PERCEPTION_API_KEY ?? ''
  return { url, key }
}

function exitUnreachable(url: string, err: unknown): never {
  console.log(chalk.red('  ✗ Perception is unreachable'))
  console.log(chalk.dim(`  ${url} — ${err instanceof Error ? err.message : String(err)}`))
  console.log(chalk.dim('  Start it with ') + chalk.cyan('npx robrain up') + chalk.dim(' (or pnpm docker:up from a clone).\n'))
  process.exit(1)
}

export async function projectsListCommand(): Promise<void> {
  console.log()
  const { url, key } = perceptionEndpoint()
  const res = await fetch(`${url}/projects`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  }).catch((err: unknown) => exitUnreachable(url, err))

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    console.log(chalk.red(`  ✗ Could not list projects (${res.status})`))
    console.log(chalk.dim(`  ${t.slice(0, 400)}`))
    console.log(chalk.dim(`  Perception: ${url}\n`))
    process.exit(1)
  }

  const data = await res.json() as {
    projects: Array<{
      id: string
      name: string
      session_count: number
      decision_count: number
      updated_at?: string
    }>
  }

  const rows = data.projects ?? []
  if (rows.length === 0) {
    console.log(chalk.dim('  No projects in Perception yet.'))
    console.log(chalk.dim('  Run ') + chalk.cyan('npx robrain init-project') + chalk.dim(' from a repo root.\n'))
    return
  }

  console.log(chalk.bold('  Projects in Perception'))
  console.log(chalk.dim(`  ${url}\n`))
  const idW = Math.max(12, ...rows.map(r => r.id.length))
  console.log(
    `  ${'id'.padEnd(idW)}  ${'sessions'.padStart(8)}  ${'decisions'.padStart(9)}  name`,
  )
  console.log(chalk.dim(`  ${'─'.repeat(idW + 32)}`))
  for (const p of rows) {
    console.log(
      `  ${chalk.cyan(p.id.padEnd(idW))}  ${String(p.session_count).padStart(8)}  ${String(p.decision_count).padStart(9)}  ${p.name}`,
    )
  }
  console.log()
  console.log(chalk.dim(`  Current directory project id (derived): run init-project in a repo to see the id used here.`))
  console.log()
}

export async function projectsMergeCommand(fromId: string, toId: string): Promise<void> {
  console.log()
  const { url, key } = perceptionEndpoint()

  const res = await fetch(`${url}/projects/merge`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ from: fromId, to: toId }),
  }).catch((err: unknown) => exitUnreachable(url, err))

  const raw = await res.text()
  if (!res.ok) {
    console.log(chalk.red(`  ✗ Merge failed (${res.status})`))
    try {
      const j = JSON.parse(raw) as { message?: string; hint?: string; detail?: string }
      if (j.message) console.log(chalk.yellow(`  ${j.message}`))
      if (j.hint) console.log(chalk.dim(`  ${j.hint}`))
      if (j.detail) console.log(chalk.dim(`  ${j.detail}`))
    } catch {
      console.log(chalk.dim(raw.slice(0, 500)))
    }
    console.log()
    process.exit(1)
  }

  console.log(chalk.green(`  ✓ Merged project ${chalk.bold(fromId)} → ${chalk.bold(toId)}`))
  console.log(chalk.dim('  Sessions and decisions now use the target project id.\n'))
  console.log(chalk.dim('  If CLAUDE.md / AGENTS.md / Cursor rules still mention the old id, update them or run '))
  console.log(chalk.cyan('npx robrain init-project') + chalk.dim(' in the repo root.\n'))
}

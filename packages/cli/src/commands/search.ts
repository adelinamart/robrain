// packages/cli/src/commands/search.ts
// ─────────────────────────────────────────────────────────────
// robrain search <query> [--limit N] [--kind <name>] [--project-id <id>] [--json]
//
// Semantic search over the project's stored memory, for people: the
// same ranking `robrain inject` uses (similarity, file overlap, recency,
// approval), printed with who decided each row and when, and on RoBrain
// cloud which agents a decision was pushed to. Read-only.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { cwd } from 'process'
import { gatherProjectInfo } from '../lib/project.js'
import { exitUnreachable, perceptionEndpoint } from './projects.js'

export interface SearchOptions {
  limit?:     number
  kind?:      string
  projectId?: string
  json?:      boolean
}

/** Wire shape of GET /decisions?query= rows (fields older servers omit are optional). */
export interface SearchRow {
  id:            string
  decision:      string
  rationale:     string | null
  rejected:      Array<{ option: string; reason: string }>
  kind?:         string
  subject?:      string | null
  source?:       string
  author_email?: string | null
  created_at:    string
  reviewed_at?:  string | null
  planning_score?: number
  similarity?:   number
  /** Cloud only: agent projects this decision was pushed to. */
  pushed_to?:    Array<{ project_id: string; project_name?: string | null; promoted_at?: string }>
}

function day(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** Lines for one result, without colour, so the format is testable. */
export function formatSearchRow(row: SearchRow, index: number): string[] {
  const tags: string[] = []
  if (row.reviewed_at) tags.push('approved')
  if (row.kind && row.kind !== 'decision') tags.push(row.subject ? `${row.kind}: ${row.subject}` : row.kind)
  if (row.source === 'manual') tags.push('written by hand')
  if (row.source === 'promoted') tags.push('pushed from coding memory')
  const tagSuffix = tags.length ? `  [${tags.join(', ')}]` : ''

  const lines = [`[${index + 1}] ${row.id.slice(0, 8)}  ${row.decision}${tagSuffix}`]
  if (row.rationale) lines.push(`     because:  ${row.rationale}`)
  if (row.rejected?.length) {
    lines.push(`     rejected: ${row.rejected.map(r => `${r.option} (${r.reason})`).join(', ')}`)
  }
  const who = [row.author_email, day(row.created_at)].filter(Boolean).join(' · ')
  if (who) lines.push(`     by:       ${who}`)
  if (row.pushed_to) {
    const targets = row.pushed_to.length
      ? row.pushed_to.map(t => t.project_name || t.project_id).join(', ')
      : 'not pushed to any agent'
    lines.push(`     pushed:   ${targets}`)
  }
  return lines
}

export async function searchCommand(query: string, opts: SearchOptions): Promise<void> {
  const text = query.trim()
  if (!text) {
    console.log(chalk.red('\n  ✗ Give the search a query, e.g. robrain search "confirm before sending"\n'))
    process.exit(1)
  }
  const { url, key } = perceptionEndpoint()
  const projectId = opts.projectId?.trim() || gatherProjectInfo(cwd()).id
  const params = new URLSearchParams({
    project_id: projectId,
    query:      text,
    limit:      String(opts.limit && opts.limit > 0 ? Math.min(opts.limit, 100) : 10),
  })
  if (opts.kind) params.set('kind', opts.kind)

  let rows: SearchRow[]
  try {
    const res = await fetch(`${url}/decisions?${params}`, { headers: { Authorization: `Bearer ${key}` } })
    if (!res.ok) {
      const body = await res.text()
      console.log(chalk.red(`\n  ✗ Search failed (${res.status})`))
      console.log(chalk.dim(`  ${body.slice(0, 300)}\n`))
      process.exit(1)
    }
    // Perception answers { decisions: [...] }; a bare array is tolerated for older builds.
    const payload = await res.json() as SearchRow[] | { decisions?: SearchRow[] }
    rows = Array.isArray(payload) ? payload : (payload.decisions ?? [])
  } catch (err) {
    exitUnreachable(url, err)
  }

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2))
    return
  }

  console.log()
  if (!rows.length) {
    console.log(chalk.dim(`  Nothing in project ${projectId} matches "${text}".\n`))
    return
  }
  console.log(chalk.bold(`  ${rows.length} result${rows.length === 1 ? '' : 's'} for "${text}"`) + chalk.dim(`  · project ${projectId}`))
  console.log()
  rows.forEach((row, i) => {
    const [head, ...rest] = formatSearchRow(row, i)
    console.log(`  ${chalk.bold(head)}`)
    for (const line of rest) console.log(chalk.dim(`  ${line}`))
    console.log()
  })
  console.log(chalk.dim('  Push one to your production agents on RoBrain cloud: robrain promote <id> --to production-agents\n'))
}

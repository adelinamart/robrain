// packages/cli/src/commands/export-interchange.ts
// ─────────────────────────────────────────────────────────────
// robrain export --format interchange [--out FILE] [--cwd PATH] [--project-id ID]
//
// Writes the full decision corpus as JSONL — one memory per line,
// format "robrain-memory/v1" — so other agent-memory tools can
// import it. Spec: docs/memory-interchange.md.
//
// Default target is stdout (pipe-friendly); status lines go to
// stderr. `--out` writes a file instead.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { writeFileSync }     from 'fs'
import { resolve }           from 'path'
import { cwd }               from 'process'
import { readConfig }        from '../lib/config.js'
import { gatherProjectInfo, type ProjectInfo } from '../lib/project.js'

export const INTERCHANGE_FORMAT = 'robrain-memory/v1'

// ── Serializer (tested in export-interchange.test.ts) ─────────

/** Decision row as returned by Perception GET /decisions?history=true. */
export interface SourceDecision {
  id:             string
  decision:       string
  rationale?:     string | null
  rejected?:      Array<{ option: string; reason: string }> | null
  files_affected?: string[] | null
  scope:          string
  created_at:     string
  invalidated_at?: string | null
  reviewed_at?:   string | null
  supersedes_id?: string | null
  session_id:     string
  source_turn_sequence?: number | null
  source_excerpt?:       string | null
  historical_relevance?: number | null
  injected_count?:       number | null
  used_count?:           number | null
}

export interface InterchangeRecord {
  format:         typeof INTERCHANGE_FORMAT
  id:             string
  decision:       string
  rationale:      string | null
  rejected:       Array<{ option: string; reason: string }>
  files_affected: string[]
  scope:          string
  lifecycle: {
    created_at:     string
    invalidated_at: string | null
    reviewed_at:    string | null
    supersedes_id:  string | null
  }
  provenance: {
    session_id:           string
    source_turn_sequence: number | null
    source_excerpt:       string | null
  }
  quality: {
    historical_relevance: number | null
    injected_count:       number
    used_count:           number
  }
}

export function toInterchangeRecord(d: SourceDecision): InterchangeRecord {
  return {
    format:         INTERCHANGE_FORMAT,
    id:             d.id,
    decision:       d.decision,
    rationale:      d.rationale ?? null,
    rejected:       (d.rejected ?? []).map(r => ({ option: r.option, reason: r.reason })),
    files_affected: d.files_affected ?? [],
    scope:          d.scope,
    lifecycle: {
      created_at:     d.created_at,
      invalidated_at: d.invalidated_at ?? null,
      reviewed_at:    d.reviewed_at ?? null,
      supersedes_id:  d.supersedes_id ?? null,
    },
    provenance: {
      session_id:           d.session_id,
      source_turn_sequence: d.source_turn_sequence ?? null,
      source_excerpt:       d.source_excerpt ?? null,
    },
    quality: {
      historical_relevance: d.historical_relevance ?? null,
      injected_count:       d.injected_count ?? 0,
      used_count:           d.used_count ?? 0,
    },
  }
}

export function toInterchangeJsonl(decisions: SourceDecision[]): string {
  return decisions.map(d => JSON.stringify(toInterchangeRecord(d))).join('\n') + (decisions.length > 0 ? '\n' : '')
}

// ── Command ───────────────────────────────────────────────────

interface ExportInterchangeOptions {
  format?:    string    // only 'interchange' is supported today
  out?:       string    // file path; default stdout
  cwd?:       string    // project root (default: current directory)
  projectId?: string    // override the path-derived Perception project id
}

export async function exportInterchangeCommand(opts: ExportInterchangeOptions): Promise<void> {
  const format = opts.format ?? 'interchange'
  if (format !== 'interchange') {
    console.error(chalk.red(`  ✗ Unknown format "${format}". Supported: interchange`))
    process.exit(1)
  }

  const config      = readConfig()
  const projectRoot = opts.cwd ?? cwd()
  const baseInfo    = gatherProjectInfo(projectRoot)
  const info: ProjectInfo = opts.projectId
    ? { ...baseInfo, id: opts.projectId }
    : baseInfo
  const percUrl = config.perceptionUrl ?? 'http://127.0.0.1:3001'
  const percKey = config.perceptionKey ?? ''

  const decisions: SourceDecision[] = []
  try {
    // Server caps limit at 100 — page with offset until a short page so the
    // export carries the whole corpus, not just the oldest 100 rows.
    const pageSize = 100
    for (let offset = 0; ; offset += pageSize) {
      const params = new URLSearchParams({
        project_id: info.id,
        history:    'true',     // interchange carries the full lifecycle, invalidated rows included
        limit:      String(pageSize),
        offset:     String(offset),
      })
      const res = await fetch(`${percUrl}/decisions?${params}`, {
        headers: percKey ? { 'Authorization': `Bearer ${percKey}` } : {},
      })
      if (!res.ok) {
        console.error(chalk.red(`  ✗ Could not fetch decisions (${res.status}). Is Perception running?`))
        console.error(chalk.dim(`    Expected at: ${percUrl}`))
        console.error(chalk.dim('    Start with: pnpm docker:up'))
        process.exit(1)
      }
      const data = await res.json() as { decisions: SourceDecision[] }
      const page = data.decisions ?? []
      decisions.push(...page)
      if (page.length < pageSize) break
    }
  } catch {
    console.error(chalk.red('  ✗ Could not reach Perception API'))
    console.error(chalk.dim(`    Expected at: ${percUrl}`))
    console.error(chalk.dim('    Start with: pnpm docker:up'))
    process.exit(1)
  }

  const jsonl = toInterchangeJsonl(decisions)

  if (opts.out) {
    const outPath = resolve(opts.out)
    writeFileSync(outPath, jsonl)
    console.error(chalk.green(`  ✓ Wrote ${decisions.length} memor${decisions.length === 1 ? 'y' : 'ies'} to ${outPath}`))
    console.error(chalk.dim(`    Format: ${INTERCHANGE_FORMAT} — spec in docs/memory-interchange.md`))
  } else {
    process.stdout.write(jsonl)
    console.error(chalk.dim(`  ${decisions.length} memor${decisions.length === 1 ? 'y' : 'ies'} · ${INTERCHANGE_FORMAT} · spec in docs/memory-interchange.md`))
  }
}

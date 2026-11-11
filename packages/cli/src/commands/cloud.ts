// packages/cli/src/commands/cloud.ts
// ─────────────────────────────────────────────────────────────
// robrain lineage <decision-id> [--json]
// robrain audit [--limit <n>] [--action <name>] [--project-id <id>] [--json]
// conflict verdict behind `robrain check "<text>" --conflicts`
//
// Three RoBrain cloud surfaces that had no command: a decision's
// supersession history (GET /decisions/:id/lineage), the governance ledger
// of who registered, pushed, tagged or changed what (GET /org/events), and
// the semantic conflict verdict on a proposal (POST /dry-run). Self-hosted
// Perception has none of the three routes and answers 404 with no JSON
// error; each command says so and exits instead of failing obscurely.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { exitUnreachable, perceptionEndpoint } from './projects.js'

// ── shared ────────────────────────────────────────────────────

/** A 404 with no JSON `error` is a route this server does not have (self-hosted); cloud 404s always name one. */
export function isMissingRoute(status: number, payload: { error?: unknown }): boolean {
  return status === 404 && typeof payload.error !== 'string'
}

function day(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : '          '
}

function minute(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace('T', ' ')
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

// ── lineage ───────────────────────────────────────────────────

export interface LineageNode {
  id: string
  decision: string
  supersedes_id: string | null
  invalidated_at: string | null
  reviewed_at: string | null
  created_at: string
  /** > 0: an ancestor this decision replaced; 0: the decision asked about; < 0: what replaced it. */
  depth: number
}

export interface LineageRelation {
  from_id: string
  to_id: string
  relation: string
}

export interface LineagePayload {
  decision_id: string
  chain: LineageNode[]
  relations: LineageRelation[]
}

export type LineageStatus = 'active' | 'superseded' | 'invalidated'

/** A retired row that a later row in the chain replaced was superseded; one retired with no successor was invalidated. */
export function lineageStatus(node: LineageNode, chain: readonly LineageNode[]): LineageStatus {
  if (!node.invalidated_at) return 'active'
  return chain.some(n => n.supersedes_id === node.id) ? 'superseded' : 'invalidated'
}

/** Oldest first, each row saying what it is and whether it still stands. Plain strings (no colour) so tests read them. */
export function lineageLines(payload: LineagePayload): string[] {
  const chain = [...payload.chain].sort(
    (a, b) => b.depth - a.depth || new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )
  const lines: string[] = []
  for (const node of chain) {
    const status = lineageStatus(node, chain)
    const tags = [status as string]
    if (node.reviewed_at) tags.push('approved')
    const marker = node.id === payload.decision_id ? '▸' : ' '
    lines.push(`${marker} ${day(node.created_at)}  ${oneLine(node.decision)}`)
    lines.push(`    ${tags.join(', ')} · ${node.id}`)
  }
  // Supersession is already the chain itself; the other edges are worth a line each.
  const inChain = new Set(chain.map(n => n.id))
  const seen = new Set<string>()
  for (const r of payload.relations) {
    if (r.relation === 'supersedes') continue
    const key = `${r.from_id}|${r.relation}|${r.to_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const outside = inChain.has(r.from_id) && inChain.has(r.to_id) ? '' : ' (outside this chain)'
    lines.push(`  ${r.from_id} ${r.relation.replace(/_/g, ' ')} ${r.to_id}${outside}`)
  }
  return lines
}

export async function lineageCommand(rawId: string, opts: { json?: boolean } = {}): Promise<void> {
  const id = rawId.trim()
  if (!id) {
    console.log(chalk.red('\n  ✗ Usage: robrain lineage <decision-id>\n'))
    process.exit(1)
  }
  const { url, key } = perceptionEndpoint()
  const res = await fetch(`${url}/decisions/${encodeURIComponent(id)}/lineage`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  }).catch((err: unknown) => exitUnreachable(url, err))
  const payload = await res.json().catch(() => ({})) as Partial<LineagePayload> & { error?: string; message?: string }

  if (isMissingRoute(res.status, payload)) {
    console.log(chalk.yellow('\n  Lineage is a RoBrain cloud feature. On self-hosted, robrain review --history shows'))
    console.log(chalk.yellow('  superseded and invalidated decisions next to the ones that replaced them.\n'))
    process.exit(1)
  }
  if (res.status === 404) {
    console.log(chalk.red(`\n  ✗ No decision ${id} in your org.`) + chalk.dim('  Find ids with robrain search or robrain review --history.\n'))
    process.exit(1)
  }
  if (!res.ok || !Array.isArray(payload.chain)) {
    console.log(chalk.red(`\n  ✗ Could not read lineage (${res.status})`) + chalk.dim(`  ${payload.message ?? payload.error ?? ''}\n`))
    process.exit(1)
  }
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  const full: LineagePayload = { decision_id: payload.decision_id ?? id, chain: payload.chain, relations: payload.relations ?? [] }
  console.log()
  console.log(chalk.bold(`  Lineage of ${full.decision_id}`) + chalk.dim('  oldest first, ▸ marks the decision you asked about'))
  console.log()
  for (const line of lineageLines(full)) {
    console.log(line.startsWith('▸') ? `  ${chalk.green(line)}` : line.startsWith('    ') ? chalk.dim(`  ${line}`) : `  ${line}`)
  }
  if (full.chain.length === 1) {
    console.log(chalk.dim('\n  Nothing replaced this decision and it replaced nothing.'))
  }
  console.log()
}

// ── audit (governance ledger) ─────────────────────────────────

export const AUDIT_ACTIONS = [
  'project_registered', 'rule_added', 'promoted', 'capture_settings_changed', 'tags_changed', 'tag_rules_changed',
] as const

export interface AuditEvent {
  id: string
  action: string
  actor_email: string | null
  decision_id: string | null
  project_id: string | null
  target_project_id: string | null
  detail: Record<string, unknown>
  created_at: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** What happened, without the actor: "pushed decision d-1 to every production agent". */
export function describeAuditEvent(e: AuditEvent): string {
  const project = e.project_id ?? 'unknown project'
  const detail = e.detail ?? {}
  switch (e.action) {
    case 'project_registered':
      return `registered ${str(detail.type) ?? 'coding'} project ${project}`
    case 'rule_added':
      return detail.quarantined === true ? `wrote a rule in ${project} (held for review)` : `wrote a rule in ${project}`
    case 'promoted': {
      const to = str(detail.to)
      const where = to === 'production-agents' || to === 'all-agents'
        ? 'every production agent'
        : to?.startsWith('tag:')
          ? `agents tagged ${to.slice(4)}`
          : `project ${e.target_project_id ?? to ?? 'unknown'}`
      return `pushed decision ${e.decision_id ?? 'unknown'} to ${where}`
    }
    case 'capture_settings_changed': {
      const parts: string[] = []
      const mode = str(detail.mode)
      if (mode) parts.push(`mode ${mode}`)
      if (typeof detail.confidence_min === 'number') parts.push(`threshold ${detail.confidence_min}`)
      const kinds = strList(detail.kinds)
      if (kinds.length > 0) parts.push(`kinds ${kinds.join(', ')}`)
      return `changed what ${project} captures${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`
    }
    case 'tags_changed': {
      const after = strList(detail.after)
      return `set tags of ${project} to ${after.length > 0 ? after.join(', ') : 'none'}`
    }
    case 'tag_rules_changed': {
      const count = Array.isArray(detail.rules) ? detail.rules.length : 0
      return `changed the tool to tag mapping (${count} ${count === 1 ? 'rule' : 'rules'})`
    }
    default:
      return `${e.action.replace(/_/g, ' ')}${e.project_id ? ` in ${e.project_id}` : ''}`
  }
}

export interface AuditOptions {
  limit?: number
  action?: string
  projectId?: string
  before?: string
  json?: boolean
}

export async function auditCommand(opts: AuditOptions = {}): Promise<void> {
  if (opts.action && !(AUDIT_ACTIONS as readonly string[]).includes(opts.action)) {
    console.log(chalk.red(`\n  ✗ Unknown action "${opts.action}".`) + chalk.dim(`  One of: ${AUDIT_ACTIONS.join(', ')}\n`))
    process.exit(1)
  }
  const limit = Number.isFinite(opts.limit) ? Math.min(Math.max(1, Math.trunc(opts.limit as number)), 200) : 30
  const params = new URLSearchParams({ limit: String(limit) })
  if (opts.action) params.set('action', opts.action)
  if (opts.projectId?.trim()) params.set('project_id', opts.projectId.trim())
  if (opts.before?.trim()) {
    const before = new Date(opts.before.trim())
    if (Number.isNaN(before.getTime())) {
      console.log(chalk.red(`\n  ✗ --before "${opts.before}" is not a date.`) + chalk.dim('  Use e.g. 2026-11-01 or the timestamp of the last row.\n'))
      process.exit(1)
    }
    params.set('before', before.toISOString())
  }

  const { url, key } = perceptionEndpoint()
  const res = await fetch(`${url}/org/events?${params}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  }).catch((err: unknown) => exitUnreachable(url, err))
  const payload = await res.json().catch(() => ({})) as {
    events?: AuditEvent[]; next_before?: string | null; error?: string; message?: string; detail?: string
  }

  if (isMissingRoute(res.status, payload)) {
    console.log(chalk.yellow('\n  The governance ledger is a RoBrain cloud feature: it records who registered an agent,'))
    console.log(chalk.yellow('  pushed a rule, or changed tags and capture settings. Self-hosted keeps one project and has none.\n'))
    process.exit(1)
  }
  if (!res.ok || !Array.isArray(payload.events)) {
    console.log(chalk.red(`\n  ✗ Could not read the ledger (${res.status})`) + chalk.dim(`  ${payload.detail ?? payload.message ?? payload.error ?? ''}\n`))
    process.exit(1)
  }
  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log()
  if (payload.events.length === 0) {
    console.log(chalk.dim('  Nothing recorded for this filter. Registering an agent, writing or pushing a rule, and'))
    console.log(chalk.dim('  changing tags, the tool mapping or capture settings all land here.\n'))
    return
  }
  const widest = Math.max(...payload.events.map(e => (e.actor_email ?? 'an API key').length))
  for (const e of payload.events) {
    const who = (e.actor_email ?? 'an API key').padEnd(widest)
    console.log(`  ${chalk.dim(minute(e.created_at))}  ${chalk.cyan(who)}  ${describeAuditEvent(e)}`)
  }
  console.log()
  if (payload.next_before) {
    console.log(chalk.dim(`  Older entries: robrain audit --before ${payload.next_before}\n`))
  }
}

// ── conflict verdict (robrain check --conflicts) ──────────────

export interface ConflictMatch {
  decision_id: string
  decision: string
  classification: 'contradicts' | 'extends' | 'related' | 'unrelated' | string
  similarity: number
  reviewed: boolean
}

export interface ConflictVerdict {
  would_conflict: boolean
  matched_id?: string
  matches: ConflictMatch[]
}

export type ConflictCheck =
  | { status: 'verdict'; verdict: ConflictVerdict }
  | { status: 'self_hosted' }
  | { status: 'failed'; reason: string }

/** Ask RoBrain cloud whether the proposal contradicts a stored decision. Never throws. */
export async function fetchConflictVerdict(url: string, key: string, projectId: string, text: string): Promise<ConflictCheck> {
  let res: Response
  try {
    res = await fetch(`${url}/dry-run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body:    JSON.stringify({ project_id: projectId, decision: text }),
    })
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
  }
  const payload = await res.json().catch(() => ({})) as Partial<ConflictVerdict> & { error?: string; message?: string }
  if (isMissingRoute(res.status, payload)) return { status: 'self_hosted' }
  if (!res.ok || typeof payload.would_conflict !== 'boolean') {
    return { status: 'failed', reason: `${res.status} ${payload.message ?? payload.error ?? ''}`.trim() }
  }
  return {
    status: 'verdict',
    verdict: { would_conflict: payload.would_conflict, matched_id: payload.matched_id, matches: Array.isArray(payload.matches) ? payload.matches : [] },
  }
}

/** The verdict split into what blocks (contradicts) and what is only worth knowing (extends, related). */
export function splitConflictMatches(verdict: ConflictVerdict): { conflicts: ConflictMatch[]; context: ConflictMatch[] } {
  const conflicts = verdict.matches.filter(m => m.classification === 'contradicts')
  const context = verdict.matches.filter(m => m.classification === 'extends' || m.classification === 'related')
  return { conflicts, context }
}

/** Print the verdict. Returns true when the proposal conflicts with a stored decision. */
export function printConflictVerdict(verdict: ConflictVerdict): boolean {
  const { conflicts, context } = splitConflictMatches(verdict)
  const tag = (m: ConflictMatch) => (m.reviewed ? chalk.green('[approved]') : chalk.dim('[pending review]'))
  if (conflicts.length === 0) {
    console.log(chalk.green('  ✓ No stored decision contradicts this proposal.'))
  } else {
    console.log(chalk.yellow.bold(`  ⚠ Contradicts ${conflicts.length} stored decision${conflicts.length === 1 ? '' : 's'}:\n`))
    for (const m of conflicts) {
      console.log(`  ${chalk.red('✗')} ${oneLine(m.decision, 140)} ${tag(m)}`)
      console.log(chalk.dim(`    ${m.decision_id} · similarity ${Number(m.similarity).toFixed(2)}`))
    }
  }
  if (context.length > 0) {
    console.log(chalk.dim(`\n  Related decisions, not conflicts:`))
    for (const m of context.slice(0, 5)) {
      console.log(chalk.dim(`    ${m.classification}: ${oneLine(m.decision, 110)}  ${m.decision_id}`))
    }
  }
  console.log()
  return conflicts.length > 0 || verdict.would_conflict
}

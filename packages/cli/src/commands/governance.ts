// packages/cli/src/commands/governance.ts
// ─────────────────────────────────────────────────────────────
// robrain rules add "<decision>" [--because "..."] [--rejected "option: reason"]...
//                   [--kind <name>] [--subject <text>] [--project-id <id>] [--email <addr>]
// robrain promote <decision-id> --to production-agents | --to <project-id>
//
// Rules written by hand go through POST /projects/:id/rules on both
// editions: stored like a captured decision (same columns, same vetoes,
// same summary) with confidence 1.0, source "manual", approved on insert,
// and the author's email. Promotion (POST /decisions/:id/promote) copies a
// decision into the org's governance project or one agent project with
// its lineage; it exists on RoBrain cloud only, so self-hosted Perception
// answers 404 and the command says so.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { execFileSync } from 'child_process'
import { cwd } from 'process'
import { gatherProjectInfo } from '../lib/project.js'
import { exitUnreachable, perceptionEndpoint } from './projects.js'

export interface RulesAddOptions {
  because?:   string
  rejected?:  string[]
  kind?:      string
  subject?:   string
  projectId?: string
  email?:     string
  scope?:     string
}

export interface PromoteOptions {
  to?: string
}

/** "option: reason" → { option, reason }; a bare option gets an empty reason. */
export function parseRejectedFlag(raw: string): { option: string; reason: string } | null {
  const text = raw.trim()
  if (!text) return null
  const at = text.indexOf(':')
  if (at === -1) return { option: text, reason: '' }
  const option = text.slice(0, at).trim()
  const reason = text.slice(at + 1).trim()
  return option ? { option, reason } : null
}

/** git user.email of the current directory, or null. */
export function gitUserEmail(dir: string = cwd()): string | null {
  try {
    const out = execFileSync('git', ['config', '--get', 'user.email'], { cwd: dir, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })
    const email = String(out).trim().toLowerCase()
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
  } catch {
    return null
  }
}

/** Body for POST /projects/:id/rules from the flags; errors are plain strings for the caller to print. */
export function buildRuleBody(decision: string, opts: RulesAddOptions, authorEmail: string | null):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string } {
  const text = decision.trim()
  if (!text) return { ok: false, error: 'The rule text is empty.' }
  const rejected: Array<{ option: string; reason: string }> = []
  for (const raw of opts.rejected ?? []) {
    const parsed = parseRejectedFlag(raw)
    if (!parsed) return { ok: false, error: `Could not read --rejected "${raw}". Use "option: reason".` }
    rejected.push(parsed)
  }
  const body: Record<string, unknown> = { decision: text, rejected }
  if (opts.because?.trim()) body.rationale = opts.because.trim()
  if (opts.kind?.trim())    body.kind = opts.kind.trim()
  if (opts.subject?.trim()) body.subject = opts.subject.trim()
  if (opts.scope?.trim())   body.scope = opts.scope.trim()
  if (authorEmail)          body.author_email = authorEmail
  return { ok: true, body }
}

/** Same shape Perception accepts (strict charset, 254 max), so the CLI never prints an author the server will drop. */
export function normalizeAuthorEmail(raw: string | null | undefined): string | null {
  const email = (raw ?? '').trim().toLowerCase()
  return email.length > 0 && email.length <= 254 && /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(email) ? email : null
}

export async function rulesAddCommand(decision: string, opts: RulesAddOptions): Promise<void> {
  if (opts.email && !normalizeAuthorEmail(opts.email)) {
    console.log(chalk.yellow(`\n  --email "${opts.email}" is not an email address; the rule will be stored without an author.`))
  }
  const authorEmail = normalizeAuthorEmail(opts.email) ?? gitUserEmail()
  const built = buildRuleBody(decision, opts, authorEmail)
  if (!built.ok) {
    console.log(chalk.red(`\n  ✗ ${built.error}\n`))
    process.exit(1)
  }
  const { url, key } = perceptionEndpoint()
  const projectId = opts.projectId?.trim() || gatherProjectInfo(cwd()).id

  let res: Response
  try {
    res = await fetch(`${url}/projects/${encodeURIComponent(projectId)}/rules`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body:    JSON.stringify(built.body),
    })
  } catch (err) {
    exitUnreachable(url, err)
  }
  const payload = await res.json().catch(() => ({})) as {
    action?: string; decision_id?: string; superseded_ids?: string[]; trust_flags?: Array<{ type: string; evidence: string }>
    error?: string; errors?: string[]; detail?: string
  }
  console.log()
  if (res.status === 404) {
    console.log(chalk.red('  ✗ This Perception does not have POST /projects/:id/rules yet. Upgrade with npx robrain@latest up.\n'))
    process.exit(1)
  }
  if (res.status === 403) {
    console.log(chalk.red('  ✗ Only an org admin can write rules into this project.\n'))
    process.exit(1)
  }
  if (!res.ok) {
    console.log(chalk.red(`  ✗ Rule not stored (${res.status})`))
    for (const e of payload.errors ?? [payload.detail ?? payload.error ?? '']) if (e) console.log(chalk.dim(`    ${e}`))
    console.log()
    process.exit(1)
  }
  if (payload.action === 'quarantined') {
    // Trust screening fired: stored, but not approved and not in the summary
    // until a human releases it in review.
    console.log(chalk.yellow('  ⚠ Rule held for review (trust screening)') + chalk.dim(`  ${payload.decision_id ?? ''}`))
    if (payload.trust_flags?.length) {
      console.log(chalk.dim(`    flags: ${payload.trust_flags.map(f => `${f.type}: ${f.evidence}`).join(' · ')}`))
    }
    console.log(chalk.dim('    It is not approved and not in the summary. Release or reject it with robrain review --quarantined.\n'))
    return
  }
  if (payload.action === 'deduped') {
    console.log(chalk.yellow('  Already stored') + chalk.dim(`  the same rule exists as ${payload.decision_id ?? 'an earlier row'}; nothing new was written.\n`))
    return
  }
  console.log(chalk.green('  ✓ Rule stored') + chalk.dim(`  ${payload.decision_id ?? ''}`))
  console.log(chalk.dim(`    project ${projectId}${authorEmail ? ` · by ${authorEmail}` : ''} · approved, confidence 1.0`))
  if (payload.superseded_ids?.length) {
    console.log(chalk.dim(`    replaced ${payload.superseded_ids.length} earlier entr${payload.superseded_ids.length === 1 ? 'y' : 'ies'} on the same subject`))
  }
  console.log()
}

export async function promoteCommand(decisionId: string, opts: PromoteOptions): Promise<void> {
  const to = opts.to?.trim()
  if (!decisionId.trim() || !to) {
    console.log(chalk.red('\n  ✗ Usage: robrain promote <decision-id> --to production-agents | --to <project-id>\n'))
    process.exit(1)
  }
  const { url, key } = perceptionEndpoint()
  let res: Response
  try {
    res = await fetch(`${url}/decisions/${encodeURIComponent(decisionId.trim())}/promote`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body:    JSON.stringify({ to }),
    })
  } catch (err) {
    exitUnreachable(url, err)
  }
  const payload = await res.json().catch(() => ({})) as {
    promoted_id?: string; target_project_id?: string; target?: string; already?: boolean
    error?: string; detail?: string
  }
  console.log()
  if (res.status === 404 && !payload.error?.includes('decision')) {
    console.log(chalk.yellow('  Promotion is a RoBrain cloud feature: it pushes a decision into the org governance project'))
    console.log(chalk.yellow('  (every agent) or one agent project. Self-hosted RoBrain keeps one project, so there is nowhere to push to.\n'))
    process.exit(1)
  }
  if (res.status === 403) {
    console.log(chalk.red('  ✗ Only an org admin can push rules to agents.\n'))
    process.exit(1)
  }
  if (!res.ok) {
    console.log(chalk.red(`  ✗ Not pushed (${res.status})`) + chalk.dim(`  ${payload.detail ?? payload.error ?? ''}`))
    console.log()
    process.exit(1)
  }
  const where = to === 'production-agents' || to === 'all-agents'
    ? 'every production agent in the org (governance project)'
    : to.startsWith('tag:')
      ? `every agent tagged "${to.slice(4)}" (${payload.target_project_id ?? 'tag rules project'})`
      : `project ${payload.target_project_id ?? to}`
  if (payload.already) {
    console.log(chalk.green('  ✓ Already pushed') + chalk.dim(`  ${payload.promoted_id ?? ''} · ${where}\n`))
    return
  }
  console.log(chalk.green('  ✓ Pushed') + chalk.dim(`  ${payload.promoted_id ?? ''} · ${where}`))
  console.log(chalk.dim('    Agents pick it up on their next summary refresh. See it with robrain search --project-id <agent project>.\n'))
}

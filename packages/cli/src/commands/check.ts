// packages/cli/src/commands/check.ts
// robrain check "<proposed change>" — pre-commit veto scan.
//
// Asks Perception's POST /veto-scan whether the proposal mentions any
// previously REJECTED option before you commit to it. Deterministic
// word-boundary matching — no embeddings, no LLM, sub-second. This is the
// same scan editor hooks run on UserPromptSubmit; the command is the manual
// surface for non-hook editors, planning discussions, and CI.
//
// With --conflicts it also asks RoBrain cloud for the semantic verdict
// (POST /dry-run): does the proposal contradict a stored decision even
// when it names no rejected option? One model call at most, so it is
// opt-in. Self-hosted has no such route; the flag says so and the rejection
// scan still decides the exit code.
//
// Exit codes: 0 = no prior rejection matches (and, with --conflicts, no
// contradiction); 1 = at least one match or contradiction (scriptable:
// `robrain check "..." && apply`); 2 = could not scan.

import chalk from 'chalk'
import { createSpinner } from '../lib/spinner.js'
import { cwd } from 'process'
import { readConfig, isCloudInstall } from '../lib/config.js'
import { failPerception, failPerceptionUnreachable } from '../lib/perception-errors.js'
import { gatherProjectInfo } from '../lib/project.js'
import { fetchConflictVerdict, printConflictVerdict } from './cloud.js'

interface VetoMatch {
  id: string
  decision: string
  /** Only the rejected entries whose option appears in the proposal text. */
  rejected: Array<{ option: string; reason: string }>
  reviewed: boolean
  /** Who decided and when (Perception ≥ 2.6; older servers omit both). */
  author_email?: string | null
  decided_at?: string | null
  superseded?: boolean
  superseded_by?: { id: string; decision: string }
}

/** "decided by <email> on <day>" / "decided on <day>" / '' when the server sent neither. */
export function formatDecidedBy(m: { author_email?: string | null; decided_at?: string | null }): string {
  const parsed = m.decided_at ? new Date(m.decided_at) : null
  const day = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : ''
  if (m.author_email && day) return `decided by ${m.author_email} on ${day}`
  if (m.author_email) return `decided by ${m.author_email}`
  if (day) return `decided on ${day}`
  return ''
}

export async function checkCommand(text: string, opts: { conflicts?: boolean } = {}): Promise<void> {
  console.log()

  const config = readConfig()
  const info   = gatherProjectInfo(cwd())

  const percUrl = config.perceptionUrl ?? 'http://127.0.0.1:3001'
  const percKey = config.perceptionKey ?? ''

  const ctx = { cloud: isCloudInstall(), perceptionUrl: percUrl }
  const spinner = createSpinner({ text: 'Scanning prior rejections...', color: 'green' }).start()

  let matches: VetoMatch[]
  try {
    const res = await fetch(`${percUrl}/veto-scan`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(percKey ? { 'Authorization': `Bearer ${percKey}` } : {}),
      },
      body: JSON.stringify({ project_id: info.id, text }),
    })
    if (!res.ok) {
      // exit 2 = "could not scan" (distinct from 1 = a rejection matched).
      failPerception(spinner, res.status, ctx, 'scan for prior rejections', 2)
    }
    const data = await res.json() as { matches?: VetoMatch[] }
    matches = data.matches ?? []
  } catch {
    failPerceptionUnreachable(spinner, ctx, 2)
  }

  // The semantic verdict runs before anything is printed so one spinner
  // covers both calls and the two results read as one report.
  let conflictCheck: Awaited<ReturnType<typeof fetchConflictVerdict>> | null = null
  if (opts.conflicts) {
    spinner.text = 'Checking for contradictions with stored decisions...'
    conflictCheck = await fetchConflictVerdict(percUrl, percKey, info.id, text)
  }

  spinner.stop()

  const conflicted = reportConflictCheck(conflictCheck)

  if (matches.length === 0) {
    console.log(chalk.green('  ✓ No prior rejection matches this proposal.'))
    console.log(chalk.dim(`  Scanned rejected[] options across project ${info.id}.\n`))
    if (conflicted === 'failed') process.exit(2)
    if (conflicted === 'conflict') process.exit(1)
    return
  }

  console.log(chalk.yellow.bold(`  ⚠ ${matches.length} prior rejection${matches.length === 1 ? '' : 's'} match this proposal:\n`))

  for (const m of matches) {
    for (const r of m.rejected) {
      console.log(`  ${chalk.red('✗')} ${chalk.bold(r.option)} — ${r.reason || chalk.dim('(no reason recorded)')}`)
    }
    const tag = m.reviewed ? chalk.green('[approved]') : chalk.dim('[pending review]')
    console.log(`    ${chalk.dim('from:')} ${m.decision} ${tag}`)
    const decidedBy = formatDecidedBy(m)
    if (decidedBy) console.log(`    ${chalk.dim(decidedBy)}`)
    if (m.superseded && m.superseded_by) {
      // The decision carrying the veto was replaced, but the rejection still
      // stands (choice and rejections have different lifetimes) — say so
      // rather than quoting a dead decision as current policy.
      console.log(`    ${chalk.dim('note: that decision was superseded by:')} ${m.superseded_by.decision}`)
    }
    console.log()
  }

  console.log(chalk.dim('  If circumstances changed, say so explicitly when re-proposing —'))
  console.log(chalk.dim('  or run `robrain review --history` to revisit the original decision.\n'))
  process.exit(1)
}

/**
 * Print the --conflicts result ahead of the rejection scan's. 'none' when
 * the flag was not given, the verdict is clean, or the server is
 * self-hosted (said once, not an error).
 */
function reportConflictCheck(check: Awaited<ReturnType<typeof fetchConflictVerdict>> | null): 'none' | 'conflict' | 'failed' {
  if (!check) return 'none'
  if (check.status === 'self_hosted') {
    console.log(chalk.dim('  --conflicts is a RoBrain cloud feature (semantic verdict against stored decisions).'))
    console.log(chalk.dim('  Self-hosted ran the rejection scan only.\n'))
    return 'none'
  }
  if (check.status === 'failed') {
    console.log(chalk.red('  ✗ Could not get a conflict verdict') + chalk.dim(`  ${check.reason}\n`))
    return 'failed'
  }
  return printConflictVerdict(check.verdict) ? 'conflict' : 'none'
}

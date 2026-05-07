// src/commands/review.ts
// ─────────────────────────────────────────────────────────────
// robrain review [--session last|SESSION_ID] [--all] [--limit N]
//
// Shows decisions captured in recent sessions so developers can
// review what the system stored, edit wrong decisions, and delete
// hallucinated ones before they pollute future injections.
//
// This is the trust layer — developers should never have to rely
// on memories they've never seen.
// ─────────────────────────────────────────────────────────────

import chalk   from 'chalk'
import ora     from 'ora'
import prompts from 'prompts'
import { readConfig, isAuthenticated } from '../lib/config.js'
import { gatherProjectInfo }           from '../lib/project.js'
import { cwd }                         from 'process'

interface ReviewOptions {
  session?: string    // 'last' | session_id
  all?:     boolean   // show all decisions, not just last session
  history?: boolean   // include invalidated decisions to show full lifecycle
  limit?:   number    // max decisions to show (default 20)
}

interface StoredDecision {
  id:              string
  decision:        string
  rationale:       string | null
  rejected:        Array<{ option: string; reason: string }>
  files_affected:  string[]
  confidence:      number
  scope:           string
  created_at:      string
  session_id:      string
  conflict_flag:   boolean
  supersedes_id:   string | null    // lifecycle: decision this one replaced
  invalidated_at:  string | null    // lifecycle: when this was superseded
  superseded_by?:  string | null    // lifecycle: id of decision that replaced this
}

export async function reviewCommand(opts: ReviewOptions): Promise<void> {
  console.log()

  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated. Run: robrain install'))
    process.exit(1)
  }

  const config  = readConfig()
  const info    = gatherProjectInfo(cwd())
  const percUrl = config.perceptionUrl
  const percKey = config.perceptionKey ?? ''

  if (!percUrl) {
    console.log(chalk.red('  ✗ Perception URL not configured. Run: robrain install'))
    process.exit(1)
  }

  // ── Fetch decisions from Perception ───────────────────────
  const spinner = ora({ text: 'Fetching stored decisions...', color: 'green' }).start()

  const limit = opts.limit ?? 20
  const params = new URLSearchParams({
    project_id: info.id,
    limit:      String(limit),
    ...(opts.session && opts.session !== 'last' && { session_id: opts.session }),
    ...(opts.all     ? { all: 'true' }     : { recent: 'true' }),
    ...(opts.history ? { history: 'true' } : {}),
  })

  let decisions: StoredDecision[] = []

  try {
    const res = await fetch(`${percUrl}/decisions?${params}`, {
      headers: percKey ? { 'Authorization': `Bearer ${percKey}` } : {},
    })

    if (!res.ok) {
      spinner.fail(`Could not fetch decisions (${res.status})`)
      process.exit(1)
    }

    const data = await res.json() as { decisions: StoredDecision[] }
    decisions  = data.decisions ?? []
    // Newest decisions first (matches Perception ORDER BY created_at DESC; belt-and-suspenders).
    if (!opts.history) {
      decisions.sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      )
    }
  } catch {
    spinner.fail('Could not reach Perception API')
    process.exit(1)
  }

  spinner.stop()

  if (decisions.length === 0) {
    console.log(chalk.dim(`  No decisions stored yet for ${chalk.bold(info.name)}.`))
    console.log(chalk.dim('  Run a Claude Code session to start capturing memory.\n'))
    return
  }

  // ── Display header ─────────────────────────────────────────
  console.log(chalk.bold(`  Memory review — ${info.name}`))
  console.log(chalk.dim(`  ${decisions.length} decision${decisions.length === 1 ? '' : 's'} · Project ID: ${info.id}`))
  if (opts.history) {
    console.log(chalk.dim('  Showing full history including superseded decisions\n'))
  } else {
    console.log(chalk.dim('  Showing active decisions only · use --history to see full lifecycle\n'))
  }

  // ── Display each decision ──────────────────────────────────
  for (const [i, d] of decisions.entries()) {
    const index = chalk.dim(`[${i + 1}/${decisions.length}]`)
    const date  = new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const conf  = d.confidence >= 0.9 ? chalk.green('high')
                : d.confidence >= 0.6 ? chalk.yellow('medium')
                : chalk.red('low')

    // Lifecycle state
    const isSuperseded = !!d.invalidated_at
    const statusLabel  = isSuperseded
      ? chalk.dim('  ↩ SUPERSEDED')
      : d.conflict_flag
      ? chalk.yellow('  ⚠ CONFLICT — needs resolution')
      : null

    if (statusLabel) console.log(statusLabel)

    // Decision text — dim if superseded
    const decisionText = isSuperseded
      ? chalk.dim(`  ${index} ${d.decision}`)
      : `  ${index} ${chalk.bold(d.decision)}`
    console.log(decisionText)

    if (d.rationale) {
      console.log(chalk.dim(`     because: `) + (isSuperseded ? chalk.dim(d.rationale) : d.rationale))
    }

    if (d.rejected.length > 0) {
      const vetoes = d.rejected.map(r => `${chalk.dim(r.option)} ${chalk.dim(`(${r.reason})`)}`).join(', ')
      console.log(chalk.dim(`     rejected: `) + vetoes)
    }

    if (d.files_affected.length > 0) {
      console.log(chalk.dim(`     files:    `) + d.files_affected.slice(0, 3).join(', ') + (d.files_affected.length > 3 ? ` +${d.files_affected.length - 3} more` : ''))
    }

    // Lifecycle info
    if (d.supersedes_id) {
      console.log(chalk.dim(`     ↩ replaces: `) + chalk.dim(`earlier decision (${d.supersedes_id.slice(0, 8)}...)`))
    }
    if (isSuperseded && d.invalidated_at) {
      const supersededDate = new Date(d.invalidated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      console.log(chalk.dim(`     ↪ superseded: ${supersededDate}`))
    }

    console.log(chalk.dim(`     ${date} · confidence: `) + conf + chalk.dim(` · scope: ${d.scope}`))

    // Skip per-decision prompt for superseded decisions in history mode
    if (isSuperseded) {
      console.log()
      continue
    }

    // ── Per-decision inline action ─────────────────────────
    const { action } = await prompts({
      type:    'select',
      name:    'action',
      message: 'Action:',
      choices: [
        { title: '✔  Accept — looks correct',    value: 'accept'  },
        { title: '✏️  Edit — fix decision text',  value: 'edit'    },
        { title: '❌ Reject — delete this',       value: 'reject'  },
        ...(d.conflict_flag
          ? [{ title: '⚠️  Resolve conflict',     value: 'resolve' }]
          : []
        ),
        { title: '⏭  Skip remaining',            value: 'skip_all'},
      ],
    })

    console.log()

    if (!action || action === 'skip_all') break

    if (action === 'edit') {
      await editDecisionInline(d, percUrl, percKey, info.id)
    }

    if (action === 'reject') {
      await rejectDecisionInline(d, percUrl, percKey)
    }

    if (action === 'resolve') {
      await resolveConflictInline(d, percUrl, percKey, info.id)
    }
    // 'accept' — no action needed, move to next
  }

  console.log(chalk.green('  ✓ Review complete\n'))
}

// ── Inline: edit a single decision ────────────────────────────

function normalizedRationale(value: string | null | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t === '' ? null : t
}

async function editDecisionInline(
  d: StoredDecision,
  percUrl: string,
  percKey: string,
  projectId: string,
): Promise<void> {
  const { newDecision } = await prompts({
    type:    'text',
    name:    'newDecision',
    message: 'Corrected decision:',
    initial:  d.decision,
  })

  if (newDecision == null) {
    console.log(chalk.dim('  Cancelled.'))
    return
  }

  const trimmedDecision = newDecision.trim()
  if (trimmedDecision === '') {
    console.log(chalk.dim('  Cancelled.'))
    return
  }

  const priorRationale = normalizedRationale(d.rationale)

  const { newRationale } = await prompts({
    type:    'text',
    name:    'newRationale',
    message: 'Corrected rationale (blank removes; unchanged text keeps current):',
    initial:  d.rationale ?? '',
  })

  // Cancelled rationale step — keep prior rationale; decision text may still have changed.
  let correctedRationale: string | null
  if (newRationale == null) {
    correctedRationale = priorRationale
  } else if (newRationale.trim() === '') {
    correctedRationale = null
  } else {
    correctedRationale = newRationale.trim()
  }

  const decisionChanged = trimmedDecision !== d.decision.trim()
  const rationaleChanged = correctedRationale !== priorRationale

  if (!decisionChanged && !rationaleChanged) {
    console.log(chalk.dim('  No change made.'))
    return
  }

  const spinner = ora('Saving correction...').start()
  try {
    const res = await fetch(`${percUrl}/corrections`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(percKey ? { 'Authorization': `Bearer ${percKey}` } : {}),
        'X-Project-Id':  projectId,
        'X-Session-Id':  'robrain-review-cli',
      },
      body: JSON.stringify({
        decision_id:          d.id,
        corrected_decision:   trimmedDecision,
        corrected_rationale:  correctedRationale,
        invalidate:           true,
        source:               'user_correction',
      }),
    })
    res.ok
      ? spinner.succeed(chalk.green('✔ Decision updated'))
      : spinner.fail('Could not save correction')
  } catch {
    spinner.fail('Could not reach Perception API')
  }
}

// ── Inline: reject (invalidate) a single decision ─────────────

async function rejectDecisionInline(
  d: StoredDecision,
  percUrl: string,
  percKey: string,
): Promise<void> {
  const { confirm } = await prompts({
    type:    'confirm',
    name:    'confirm',
    message: chalk.yellow(`Reject "${d.decision.slice(0, 60)}"? It won't be injected in future sessions.`),
    initial:  false,
  })

  if (!confirm) {
    console.log(chalk.dim('  Skipped.'))
    return
  }

  const spinner = ora('Rejecting...').start()
  try {
    const res = await fetch(`${percUrl}/corrections`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(percKey ? { 'Authorization': `Bearer ${percKey}` } : {}),
      },
      body: JSON.stringify({
        decision_id: d.id,
        invalidate:  true,
        source:      'user_correction',
      }),
    })
    res.ok
      ? spinner.succeed(chalk.green('❌ Decision rejected — won\'t appear in future sessions'))
      : spinner.fail('Could not reject decision')
  } catch {
    spinner.fail('Could not reach Perception API')
  }
}

// ── Inline: resolve a conflict ─────────────────────────────────

async function resolveConflictInline(
  d: StoredDecision,
  percUrl: string,
  percKey: string,
  projectId: string,
): Promise<void> {
  const { resolution } = await prompts({
    type:    'select',
    name:    'resolution',
    message: 'Resolve conflict:',
    choices: [
      { title: '✔  Keep this — it\'s correct',          value: 'keep'       },
      { title: '❌ Reject this — older decision stands', value: 'invalidate' },
    ],
  })

  if (!resolution) return

  const spinner = ora('Resolving...').start()
  try {
    const res = await fetch(`${percUrl}/corrections`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(percKey ? { 'Authorization': `Bearer ${percKey}` } : {}),
        'X-Project-Id':  projectId,
        'X-Session-Id':  'robrain-review-cli',
      },
      body: JSON.stringify({
        decision_id: d.id,
        invalidate:  resolution === 'invalidate',
        source:      'user_correction',
      }),
    })
    if (res.ok) {
      resolution === 'keep'
        ? spinner.succeed(chalk.green('✔ Conflict resolved — decision kept'))
        : spinner.succeed(chalk.green('❌ Conflict resolved — decision rejected'))
    } else {
      spinner.fail('Could not resolve conflict')
    }
  } catch {
    spinner.fail('Could not reach Perception API')
  }
}



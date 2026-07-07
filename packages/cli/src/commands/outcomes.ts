// packages/cli/src/commands/outcomes.ts
// ─────────────────────────────────────────────────────────────
// robrain outcomes [--since <ref|date>] [--dry-run]
// robrain outcomes record <decision-id> --outcome <type> [--evidence "..."]
//
// Feeds real-world outcomes back into memory. The scan finds git
// revert commits, matches them to stored decisions by file overlap
// + time window, and reports each match to Perception
// (POST /outcomes) so historical_relevance reflects what actually
// survived in the codebase. `record` is the manual path for
// outcomes git can't see (incidents, explicit confirmations).
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import ora   from 'ora'
import { execFileSync }                 from 'child_process'
import { cwd }                          from 'process'
import { readConfig, isAuthenticated }  from '../lib/config.js'
import { gatherProjectInfo }            from '../lib/project.js'

// ── Pure matching core (tested in outcomes.test.ts) ───────────

export interface RevertCommit {
  hash:    string
  subject: string
  date:    string      // ISO committer date
  files:   string[]    // paths the revert touched
}

export interface OutcomeDecision {
  id:             string
  decision:       string
  files_affected: string[]
  created_at:     string
}

export interface RevertMatch {
  decision: OutcomeDecision
  revert:   RevertCommit
}

/** A decision only counts as reverted if it predates the revert by at most this many days. */
export const MATCH_WINDOW_DAYS = 90

const DAY_MS = 86_400_000

/** Same path, or one is a trailing path suffix of the other (decisions may store partial paths). */
export function pathsOverlap(a: string, b: string): boolean {
  const na = a.replace(/^\.\//, '')
  const nb = b.replace(/^\.\//, '')
  if (na === nb) return true
  // Suffix matching only when the contained side is itself a multi-segment
  // path — bare basenames like 'index.ts' must match exactly.
  if (nb.includes('/') && na.endsWith('/' + nb)) return true
  if (na.includes('/') && nb.endsWith('/' + na)) return true
  return false
}

/** Parse `git log --format=%H%x09%cI%x09%s` output, keeping only revert commits. */
export function parseRevertLog(raw: string): Array<Omit<RevertCommit, 'files'>> {
  return raw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [hash = '', date = '', ...rest] = line.split('\t')
      return { hash, date, subject: rest.join('\t') }
    })
    // Double reverts (Revert "Revert …") re-apply the original change — they
    // must not count as evidence against it.
    .filter(c => c.hash !== '' && c.subject.startsWith('Revert') && !c.subject.startsWith('Revert "Revert'))
}

/**
 * Match: decision.files_affected overlaps the revert's files AND the decision
 * was created before the revert, within MATCH_WINDOW_DAYS of it.
 * One match per decision (earliest qualifying revert) so a decision isn't
 * penalised repeatedly in a single scan.
 */
export function matchRevertsToDecisions(
  reverts:   RevertCommit[],
  decisions: OutcomeDecision[],
): RevertMatch[] {
  const chronological = [...reverts].sort((a, b) => +new Date(a.date) - +new Date(b.date))
  const matches: RevertMatch[] = []

  for (const d of decisions) {
    const created = +new Date(d.created_at)
    const revert = chronological.find(r => {
      const ageDays = (+new Date(r.date) - created) / DAY_MS
      return ageDays > 0
        && ageDays <= MATCH_WINDOW_DAYS
        && d.files_affected.some(f => r.files.some(rf => pathsOverlap(f, rf)))
    })
    if (revert) matches.push({ decision: d, revert })
  }

  return matches
}

// ── Git plumbing ──────────────────────────────────────────────

function git(args: string[], dir: string): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
}

function isGitRef(since: string, dir: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${since}^{commit}`], dir)
    return true
  } catch {
    return false
  }
}

function collectRevertCommits(since: string, dir: string): RevertCommit[] {
  // `--since` takes dates; a resolvable ref becomes a `<ref>..HEAD` range instead.
  const rangeArgs = isGitRef(since, dir) ? [`${since}..HEAD`] : [`--since=${since}`]
  const raw = git(['log', ...rangeArgs, '--grep=^Revert', '--format=%H%x09%cI%x09%s'], dir)

  return parseRevertLog(raw).map(c => ({
    ...c,
    files: git(['show', '--name-only', '--format=', c.hash], dir)
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean),
  }))
}

// ── Scan command ──────────────────────────────────────────────

interface OutcomesScanOptions {
  since?:  string    // git ref or date (default: '30 days ago')
  dryRun?: boolean   // show matches without POSTing
}

interface StoredDecision extends OutcomeDecision {
  rationale:       string | null
  invalidated_at?: string | null
}

export async function outcomesScanCommand(opts: OutcomesScanOptions): Promise<void> {
  console.log()

  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated. Run: robrain install'))
    process.exit(1)
  }

  const config  = readConfig()
  const info    = gatherProjectInfo(cwd())
  const percUrl = config.perceptionUrl ?? 'http://localhost:3001'
  const percKey = config.perceptionKey ?? ''
  const since   = opts.since ?? '30 days ago'

  // ── 1. Revert commits from git history ─────────────────────
  let reverts: RevertCommit[] = []
  try {
    reverts = collectRevertCommits(since, cwd())
  } catch {
    console.log(chalk.red('  ✗ Could not read git history. Run this inside a git repository.'))
    process.exit(1)
  }

  console.log(chalk.bold(`  Outcome scan — ${info.name}`))
  console.log(chalk.dim(`  ${reverts.length} revert commit${reverts.length === 1 ? '' : 's'} since ${since}\n`))

  if (reverts.length === 0) {
    console.log(chalk.green('  ✓ No reverts found — nothing to record.\n'))
    return
  }

  // ── 2. Active decisions from Perception ─────────────────────
  const spinner = ora({ text: 'Fetching decisions from Perception...', color: 'green' }).start()
  let decisions: StoredDecision[] = []
  try {
    // Server caps limit at 100 — page with offset until a short page.
    const pageSize = 100
    const all: StoredDecision[] = []
    for (let offset = 0; ; offset += pageSize) {
      const params = new URLSearchParams({
        project_id: info.id,
        history:    'true',     // full lifecycle; invalidated rows filtered below
        limit:      String(pageSize),
        offset:     String(offset),
      })
      const res = await fetch(`${percUrl}/decisions?${params}`, {
        headers: percKey ? { 'Authorization': `Bearer ${percKey}` } : {},
      })
      if (!res.ok) {
        spinner.fail(`Could not fetch decisions (${res.status}). Is Perception running?`)
        console.log(chalk.dim(`  Expected at: ${percUrl}`))
        console.log(chalk.dim('  Start with: pnpm docker:up\n'))
        process.exit(1)
      }
      const data = await res.json() as { decisions: StoredDecision[] }
      const page = data.decisions ?? []
      all.push(...page)
      if (page.length < pageSize) break
    }
    decisions = all.filter(d => !d.invalidated_at)
  } catch {
    spinner.fail('Could not reach Perception API')
    console.log(chalk.dim(`\n  Expected at: ${percUrl}`))
    console.log(chalk.dim('  Start with: pnpm docker:up\n'))
    process.exit(1)
  }
  spinner.stop()

  // ── 3. Match + report ───────────────────────────────────────
  const matches = matchRevertsToDecisions(reverts, decisions)

  if (matches.length === 0) {
    console.log(chalk.green(`  ✓ No stored decisions overlap the reverted files.\n`))
    return
  }

  console.log(chalk.yellow(`  ⚠ ${matches.length} decision${matches.length === 1 ? '' : 's'} overlap reverted code:\n`))

  for (const { decision: d, revert: r } of matches) {
    const decidedDate  = new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const revertedDate = new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    console.log(`  ${chalk.bold(d.decision)}`)
    console.log(chalk.dim(`     decided:  ${decidedDate} · id ${d.id.slice(0, 8)}`))
    console.log(chalk.dim(`     reverted: ${revertedDate} · ${r.hash.slice(0, 10)} `) + `"${r.subject}"`)
    const evidence = `${r.hash.slice(0, 12)} ${r.subject}`

    if (opts.dryRun) {
      console.log(chalk.dim('     · dry run — outcome not recorded'))
      console.log()
      continue
    }

    const postSpinner = ora('Recording revert outcome...').start()
    try {
      const res = await fetch(`${percUrl}/outcomes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(percKey ? { 'Authorization': `Bearer ${percKey}` } : {}),
        },
        body: JSON.stringify({
          project_id:  info.id,
          decision_id: d.id,
          outcome:     'revert',
          evidence,
        }),
      })
      if (res.ok) {
        const data = await res.json() as { historical_relevance?: number }
        const rel  = typeof data.historical_relevance === 'number'
          ? ` — relevance now ${data.historical_relevance.toFixed(2)}`
          : ''
        postSpinner.succeed(chalk.green(`✔ Revert recorded${rel}`))
      } else {
        postSpinner.fail(`Could not record outcome (${res.status})`)
      }
    } catch {
      postSpinner.fail('Could not reach Perception API')
    }
    console.log()
  }

  if (opts.dryRun) {
    console.log(chalk.dim('  Dry run — nothing recorded. Drop --dry-run to apply.\n'))
  } else {
    console.log(chalk.dim('  Reverted decisions are flagged — resolve them with: robrain review\n'))
  }
}

// ── Manual record subcommand ──────────────────────────────────

const OUTCOME_TYPES = ['revert', 'incident', 'confirmed'] as const
type OutcomeType = typeof OUTCOME_TYPES[number]

interface OutcomesRecordOptions {
  outcome:   string
  evidence?: string
}

export async function outcomesRecordCommand(decisionId: string, opts: OutcomesRecordOptions): Promise<void> {
  console.log()

  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated. Run: robrain install'))
    process.exit(1)
  }

  if (!OUTCOME_TYPES.includes(opts.outcome as OutcomeType)) {
    console.log(chalk.red(`  ✗ Invalid outcome "${opts.outcome}". Use one of: ${OUTCOME_TYPES.join(' | ')}\n`))
    process.exit(1)
  }

  const config  = readConfig()
  const info    = gatherProjectInfo(cwd())
  const percUrl = config.perceptionUrl ?? 'http://localhost:3001'
  const percKey = config.perceptionKey ?? ''

  const spinner = ora(`Recording ${opts.outcome} outcome...`).start()
  try {
    const res = await fetch(`${percUrl}/outcomes`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(percKey ? { 'Authorization': `Bearer ${percKey}` } : {}),
      },
      body: JSON.stringify({
        project_id:  info.id,
        decision_id: decisionId,
        outcome:     opts.outcome,
        ...(opts.evidence ? { evidence: opts.evidence } : {}),
      }),
    })
    if (res.ok) {
      const data = await res.json() as { historical_relevance?: number }
      const rel  = typeof data.historical_relevance === 'number'
        ? ` — relevance now ${data.historical_relevance.toFixed(2)}`
        : ''
      spinner.succeed(chalk.green(`✔ Outcome recorded${rel}`))
      console.log()
    } else if (res.status === 404) {
      spinner.fail(`Decision ${decisionId} not found for this project`)
      console.log(chalk.dim('  Find decision ids with: robrain review --history\n'))
      process.exit(1)
    } else {
      spinner.fail(`Could not record outcome (${res.status})`)
      process.exit(1)
    }
  } catch {
    spinner.fail('Could not reach Perception API')
    console.log(chalk.dim(`\n  Expected at: ${percUrl}`))
    console.log(chalk.dim('  Start with: pnpm docker:up\n'))
    process.exit(1)
  }
}

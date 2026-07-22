// packages/cli/src/commands/export-memory.ts
// ─────────────────────────────────────────────────────────────
// robrain export-memory [--dry-run] [--include-unreviewed] [--to DIR] [--ledger [path]] [--cwd PATH] [--project-id ID]
//
// Projects RoBrain's approved decision corpus into Claude Code's
// auto-memory directory so decisions surface automatically in
// every session — without the manual `inject` paste step.
//
// Default behaviour:
//   • Fetches active + approved decisions from Perception
//     (reviewed_at IS NOT NULL AND invalidated_at IS NULL)
//   • Clusters them by file-path overlap into topics
//   • Writes one ~/.claude/projects/<slug>/memory/decision_<topic>.md
//     per cluster, marked `source: robrain` in frontmatter
//   • Maintains a managed block in MEMORY.md between
//     <!-- ROBRAIN:START --> and <!-- ROBRAIN:END --> markers,
//     leaving user-authored entries untouched
//
// Idempotent. Re-running rebuilds RoBrain-owned files from the DB
// and never overwrites a memory file lacking `source: robrain`.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import ora   from 'ora'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { homedir }                 from 'os'
import { cwd }                     from 'process'
import { readConfig }              from '../lib/config.js'
import { gatherProjectInfo, type ProjectInfo } from '../lib/project.js'
import {
  defaultMemoryDir,
  memoryIndexPath,
} from '../lib/memory-paths.js'

/**
 * Confine `--to` to the project root or the user's home directory.
 * Anything else (e.g. /etc, /, /Users/someone-else) is rejected so a typo or
 * a malicious project record can't direct writes outside the user's space.
 */
function confineMemoryDir(to: string, projectRoot: string): string {
  const resolved = resolve(to)
  const home = resolve(homedir())
  const root = resolve(projectRoot)
  const inside = (parent: string, child: string) =>
    child === parent || child.startsWith(parent + sep)
  if (!inside(home, resolved) && !inside(root, resolved)) {
    console.log()
    console.log(chalk.red(`  ✗ --to "${to}" resolves outside your home directory and project root.`))
    console.log(chalk.dim(`    Resolved: ${resolved}`))
    console.log(chalk.dim(`    Allowed roots: ${home}, ${root}\n`))
    process.exit(1)
  }
  return resolved
}

// ── Types ─────────────────────────────────────────────────────

interface ExportOptions {
  dryRun?:            boolean
  includeUnreviewed?: boolean
  to?:                string
  /** Also write a single git-committed ledger. `true` → <projectRoot>/decisions.md; string → that path. */
  ledger?:            string | boolean
  /** Project root for memory paths + stack detection (default: cwd). */
  cwd?:               string
  /** Override Perception `project_id` when it differs from path-derived id. */
  projectId?:        string
}

interface Decision {
  id:             string
  decision:       string
  rationale:      string | null
  rejected:       Array<{ option: string; reason: string }>
  files_affected: string[]
  confidence:     number
  scope:          string
  created_at:     string
  reviewed_at?:   string | null
  invalidated_at?: string | null
  supersedes_id?: string | null
  /** Trust quarantine (write-time scoring) — never export while set. */
  quarantined_at?: string | null
}

interface Cluster {
  topic:     string         // human-readable display name
  slug:      string         // safe-for-filename slug
  decisions: Decision[]
  files:     Set<string>
}

const ROBRAIN_START = '<!-- ROBRAIN:START — auto-managed by `robrain export-memory`, do not edit by hand -->'
const ROBRAIN_END   = '<!-- ROBRAIN:END -->'
const FRONTMATTER_SOURCE = 'source: robrain'

// ── Entry point ───────────────────────────────────────────────

export async function exportMemoryCommand(opts: ExportOptions): Promise<void> {
  console.log()

  const config     = readConfig()
  const projectRoot = opts.cwd ?? cwd()
  const baseInfo   = gatherProjectInfo(projectRoot)
  const info: ProjectInfo = opts.projectId
    ? { ...baseInfo, id: opts.projectId }
    : baseInfo
  const percUrl = config.perceptionUrl ?? 'http://127.0.0.1:3001'
  const percKey = config.perceptionKey ?? ''

  const memoryDir = opts.to
    ? confineMemoryDir(opts.to, projectRoot)
    : defaultMemoryDir(projectRoot)
  const indexPath = memoryIndexPath(memoryDir)

  // ── 1. Fetch decisions ──────────────────────────────────────
  const spinner = ora({ text: 'Fetching decisions from Perception...', color: 'green' }).start()

  let decisions: Decision[] = []
  try {
    const params = new URLSearchParams({
      project_id: info.id,
      history:    'true',     // returns full lifecycle so we can pick approved ones
      limit:      '100',      // server caps at 100; pagination is a follow-up
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
    const data = await res.json() as { decisions: Decision[] }
    decisions  = data.decisions ?? []
  } catch {
    spinner.fail('Could not reach Perception API')
    console.log(chalk.dim(`\n  Expected at: ${percUrl}`))
    console.log(chalk.dim('  Start with: pnpm docker:up\n'))
    process.exit(1)
  }
  spinner.stop()

  // ── 2. Filter ───────────────────────────────────────────────
  // Quarantined rows (write-time trust screening) never reach exported
  // memory — not even with --include-unreviewed. Release them first in
  // `robrain review`.
  const totalFetched = decisions.length
  const active       = decisions.filter(d => !d.invalidated_at && !d.quarantined_at)
  const exportable   = opts.includeUnreviewed
    ? active
    : active.filter(d => !!d.reviewed_at)

  // ── 2b. Git-committed ledger (opt-in, additive) ─────────────
  if (opts.ledger) {
    const approved   = active.filter(d => !!d.reviewed_at)
    const pending    = active.filter(d => !d.reviewed_at)
    const superseded = decisions.filter(d => !!d.invalidated_at)
    const ledgerPath = confineMemoryDir(
      typeof opts.ledger === 'string' ? opts.ledger : join(projectRoot, 'decisions.md'),
      projectRoot,
    )
    const content = renderLedger(info.name, approved, pending, superseded, !!opts.includeUnreviewed)
    const changed =
      !existsSync(ledgerPath) ||
      stripVolatile(readFileSync(ledgerPath, 'utf8')) !== stripVolatile(content)

    if (opts.dryRun) {
      console.log(chalk.bold(`  Ledger — ${info.name}`))
      console.log(
        (changed ? chalk.yellow('  ↺ would write ') : chalk.dim('  · unchanged   ')) +
        ledgerPath.replace(projectRoot + sep, '') +
        chalk.dim(`  (${approved.length} approved, ${superseded.length} superseded${opts.includeUnreviewed ? `, ${pending.length} pending` : ''})`),
      )
      console.log()
    } else if (changed) {
      const ledgerDir = dirname(ledgerPath)
      if (!existsSync(ledgerDir)) {
        mkdirSync(ledgerDir, { recursive: true })
      }
      writeFileSync(ledgerPath, content)
      console.log(chalk.green(`  ✓ Wrote ledger ${ledgerPath.replace(projectRoot + sep, '')}`) +
        chalk.dim(`  (${approved.length} approved, ${superseded.length} superseded${opts.includeUnreviewed ? `, ${pending.length} pending` : ''})`))
      console.log()
    } else {
      console.log(chalk.dim(`  · Ledger ${ledgerPath.replace(projectRoot + sep, '')} unchanged\n`))
    }
  }

  if (exportable.length === 0) {
    console.log(chalk.bold(`  Export memory — ${info.name}`))
    console.log()
    if (totalFetched === 0) {
      console.log(chalk.dim('  No decisions captured yet for this project.'))
      console.log(chalk.dim('  Run a Claude Code session with Sensing first.\n'))
    } else if (active.length === 0) {
      console.log(chalk.dim(`  All ${totalFetched} captured decisions are invalidated/superseded.\n`))
    } else {
      console.log(chalk.dim(`  ${active.length} active decision${active.length === 1 ? '' : 's'} found, but none are approved yet.`))
      console.log(chalk.dim('  Approve them first: ') + chalk.cyan('npx robrain review') + chalk.dim('\n'))
      console.log(chalk.dim('  Or include unreviewed (not recommended): ') + chalk.cyan('npx robrain export-memory --include-unreviewed\n'))
    }
    return
  }

  // ── 3. Cluster by file-path overlap ─────────────────────────
  const clusters = clusterByFileOverlap(exportable)

  // ── 4. Plan the writes (don't touch disk yet) ───────────────
  const plan = planWrites(clusters, memoryDir, indexPath, opts.dryRun ?? false)

  // ── 5. Display preview ──────────────────────────────────────
  console.log(chalk.bold(`  Export memory — ${info.name}`))
  const exportLabel = opts.includeUnreviewed ? 'decision' : 'approved decision'
  console.log(chalk.dim(`  ${exportable.length} ${exportLabel}${exportable.length === 1 ? '' : 's'} → ${clusters.length} topic${clusters.length === 1 ? '' : 's'}`))
  console.log(chalk.dim(`  Target: ${memoryDir}\n`))

  for (const action of plan.actions) {
    const tag = action.kind === 'write'   ? chalk.green('  + write  ')
              : action.kind === 'rewrite' ? chalk.yellow('  ↺ rewrite')
              : action.kind === 'skip'    ? chalk.dim('  · skip   ')
              : action.kind === 'delete'  ? chalk.red('  − delete ')
              : chalk.cyan('  ↻ index  ')
    console.log(`${tag} ${action.path.replace(memoryDir + '/', '')}${action.note ? chalk.dim(`  (${action.note})`) : ''}`)
  }

  // ── 6. Execute (or stop, if dry-run) ────────────────────────
  if (opts.dryRun) {
    console.log()
    console.log(chalk.dim('  Dry run — no files written. Drop --dry-run to apply.\n'))
    return
  }

  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true })
  }

  let writes = 0, deleted = 0, unchanged = 0, userOwned = 0
  for (const action of plan.actions) {
    if (action.kind === 'write' || action.kind === 'rewrite') {
      writeFileSync(action.path, action.content!)
      writes++
    } else if (action.kind === 'delete') {
      try { unlinkSync(action.path); deleted++ } catch { /* missing is fine */ }
    } else if (action.kind === 'index') {
      writeFileSync(action.path, action.content!)
    } else if (action.kind === 'skip') {
      if (action.note === 'unchanged') unchanged++
      else                              userOwned++
    }
  }

  console.log()
  console.log(chalk.green(`  ✓ Wrote ${writes} memory file${writes === 1 ? '' : 's'}, updated MEMORY.md index.`))
  if (unchanged > 0) console.log(chalk.dim(`    ${unchanged} file${unchanged === 1 ? '' : 's'} unchanged.`))
  if (deleted > 0)   console.log(chalk.dim(`    Deleted ${deleted} stale RoBrain-owned file${deleted === 1 ? '' : 's'}.`))
  if (userOwned > 0) console.log(chalk.dim(`    Skipped ${userOwned} user-authored file${userOwned === 1 ? '' : 's'} (not marked source: robrain).`))
  console.log()
}

// ── Clustering ────────────────────────────────────────────────
// Simple Union-Find over decisions sharing ≥1 file path.
// Decisions with no files form a single "general" cluster.

function clusterByFileOverlap(decisions: Decision[]): Cluster[] {
  const parent = new Map<string, string>()
  decisions.forEach(d => parent.set(d.id, d.id))

  const find = (x: string): string => {
    let p = parent.get(x)!
    while (p !== parent.get(p)!) p = parent.get(p)!
    parent.set(x, p)
    return p
  }
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  // Index files → first-seen decision id, then union pairs that share any file.
  const fileToFirstId = new Map<string, string>()
  const noFileBucket: Decision[] = []

  for (const d of decisions) {
    if (d.files_affected.length === 0) {
      noFileBucket.push(d)
      continue
    }
    for (const f of d.files_affected) {
      const prev = fileToFirstId.get(f)
      if (prev) union(prev, d.id)
      else      fileToFirstId.set(f, d.id)
    }
  }

  // Group by root
  const groups = new Map<string, Decision[]>()
  for (const d of decisions) {
    if (d.files_affected.length === 0) continue
    const root = find(d.id)
    const arr = groups.get(root) ?? []
    arr.push(d)
    groups.set(root, arr)
  }

  const clusters: Cluster[] = []
  for (const [, ds] of groups) {
    const files = new Set<string>()
    ds.forEach(d => d.files_affected.forEach(f => files.add(f)))
    const topic = topicNameFor(ds, files)
    clusters.push({
      topic:     topic.display,
      slug:      topic.slug,
      decisions: ds.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
      files,
    })
  }

  if (noFileBucket.length > 0) {
    clusters.push({
      topic:     'General decisions',
      slug:      'general',
      decisions: noFileBucket.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at)),
      files:     new Set(),
    })
  }

  // Stable order: largest cluster first, then by topic
  clusters.sort((a, b) =>
    b.decisions.length - a.decisions.length || a.topic.localeCompare(b.topic),
  )
  return clusters
}

function topicNameFor(
  decisions: Decision[],
  files:     Set<string>,
): { display: string; slug: string } {
  // Pick the directory or file path most commonly mentioned.
  const counts = new Map<string, number>()
  for (const f of files) {
    const segs = f.split('/').filter(Boolean)
    // Count both the immediate dir and the file basename
    if (segs.length >= 2) {
      const dir = segs.slice(0, -1).join('/')
      counts.set(dir, (counts.get(dir) ?? 0) + 1)
    }
    counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  let best = ''
  let bestCount = 0
  for (const [k, v] of counts) {
    if (v > bestCount || (v === bestCount && k.length < best.length)) {
      best      = k
      bestCount = v
    }
  }
  if (!best) {
    // Fallback: first decision's first word
    best = decisions[0]?.decision.split(/\s+/).slice(0, 4).join(' ') ?? 'topic'
  }

  const display = best
  const slug    = best
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    || 'topic'
  return { display, slug }
}

// ── Write planning ────────────────────────────────────────────

interface PlanAction {
  kind:     'write' | 'rewrite' | 'skip' | 'delete' | 'index'
  path:     string
  content?: string
  note?:    string
}

interface Plan {
  actions: PlanAction[]
}

function planWrites(
  clusters:  Cluster[],
  memoryDir: string,
  indexPath: string,
  _dryRun:   boolean,
): Plan {
  const actions: PlanAction[] = []
  const desiredFiles = new Set<string>()

  // ── Per-cluster files ──
  for (const cluster of clusters) {
    const filename = `decision_${cluster.slug}.md`
    const fullPath = join(memoryDir, filename)
    desiredFiles.add(fullPath)

    const content = renderClusterFile(cluster)

    if (!existsSync(fullPath)) {
      actions.push({ kind: 'write', path: fullPath, content, note: `${cluster.decisions.length} decision${cluster.decisions.length === 1 ? '' : 's'}` })
    } else {
      const existing = readFileSync(fullPath, 'utf8')
      if (isRoBrainOwned(existing)) {
        // Strip last_exported from both sides — that line regenerates on every
        // run and would otherwise force a rewrite even when nothing else changed.
        if (stripVolatile(existing) === stripVolatile(content)) {
          actions.push({ kind: 'skip', path: fullPath, note: 'unchanged' })
        } else {
          actions.push({ kind: 'rewrite', path: fullPath, content, note: 'updated' })
        }
      } else {
        actions.push({ kind: 'skip', path: fullPath, note: 'user-authored, leaving alone' })
      }
    }
  }

  // ── Sweep stale RoBrain-owned files (decisions removed from corpus) ──
  if (existsSync(memoryDir)) {
    for (const name of readdirSync(memoryDir)) {
      if (!name.startsWith('decision_') || !name.endsWith('.md')) continue
      const full = join(memoryDir, name)
      if (desiredFiles.has(full)) continue
      try {
        const existing = readFileSync(full, 'utf8')
        if (isRoBrainOwned(existing)) {
          actions.push({ kind: 'delete', path: full, note: 'no longer in corpus' })
        }
      } catch { /* ignore */ }
    }
  }

  // ── Index update ──
  const indexContent = renderIndex(clusters, existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '')
  actions.push({ kind: 'index', path: indexPath, content: indexContent, note: 'MEMORY.md (managed block only)' })

  return { actions }
}

// ── Renderers ─────────────────────────────────────────────────

function renderClusterFile(cluster: Cluster): string {
  const last = cluster.decisions[cluster.decisions.length - 1]!
  const ids  = cluster.decisions.map(d => `  - ${d.id}`).join('\n')

  // Frontmatter
  const fm = [
    '---',
    'source: robrain',
    'type: project',
    `name: ${quoteYaml(cluster.topic)}`,
    'decision_ids:',
    ids,
    `last_exported: ${new Date().toISOString()}`,
    '---',
    '',
  ].join('\n')

  // Body
  const body: string[] = []
  body.push(`# ${cluster.topic}`)
  body.push('')

  // Current stance (the latest reviewed decision in the cluster)
  body.push('## Current stance')
  body.push('')
  body.push(formatDecisionLine(last))
  body.push('')

  // All vetos across the cluster (deduped)
  const vetoes = new Map<string, string>()
  for (const d of cluster.decisions) {
    for (const r of (d.rejected ?? [])) {
      if (!vetoes.has(r.option)) vetoes.set(r.option, r.reason)
    }
  }
  if (vetoes.size > 0) {
    body.push('## Considered and rejected')
    body.push('')
    for (const [opt, reason] of vetoes) {
      body.push(`- **${opt}** — ${reason}`)
    }
    body.push('')
  }

  // Files affected
  if (cluster.files.size > 0) {
    body.push('## Files affected')
    body.push('')
    for (const f of [...cluster.files].sort()) body.push(`- \`${f}\``)
    body.push('')
  }

  // History (older approved decisions)
  if (cluster.decisions.length > 1) {
    body.push('## History')
    body.push('')
    for (const d of cluster.decisions.slice(0, -1)) {
      body.push(`- ${formatDecisionLine(d)}`)
    }
    body.push('')
  }

  return fm + body.join('\n')
}

function renderDecisionBlock(d: Decision, headingLevel: 3 | 4 = 3): string[] {
  const out: string[] = []
  out.push(`${'#'.repeat(headingLevel)} ${d.decision}`)
  out.push('')
  if (d.rationale) { out.push(d.rationale); out.push('') }
  const rej = d.rejected ?? []
  if (rej.length > 0) {
    out.push('Ruled out:')
    for (const r of rej) out.push(`  - **${r.option}** — ${r.reason}`)
    out.push('')
  }
  const date = new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const conf = d.confidence >= 0.9 ? 'high' : d.confidence >= 0.6 ? 'medium' : 'low'
  const meta = [`${date}`, `${conf} confidence`, `scope: ${d.scope}`]
  out.push(`_${meta.join(' · ')}_`)
  out.push('')
  return out
}

/**
 * Single git-committed ledger. Read-only/generated: regenerated from the DB
 * every run, so a stale hand-edit is overwritten. The DB stays the source of
 * truth; this file exists so the team can diff/PR-review decision drift.
 */
function renderLedger(
  projectName:       string,
  approved:          Decision[],
  pending:           Decision[],
  superseded:        Decision[],
  includeUnreviewed: boolean,
): string {
  const L: string[] = []
  L.push('<!-- Generated by `robrain export-memory --ledger` — do not edit by hand. -->')
  L.push('<!-- Source of truth is the RoBrain DB; this file is regenerated each run. -->')
  L.push('')
  L.push(`# Decisions — ${projectName}`)
  L.push('')
  L.push(`_Generated ${new Date().toISOString()}_`)
  L.push('')

  L.push('## Approved — in effect')
  L.push('')
  if (approved.length === 0) {
    L.push('_None approved yet. Run `npx robrain review` to approve captured decisions._')
    L.push('')
  } else {
    const clusters = clusterByFileOverlap(approved)
    for (const c of clusters) {
      L.push(`### ${c.topic}`)
      L.push('')
      for (const d of c.decisions) L.push(...renderDecisionBlock(d, 4))
      if (c.files.size > 0) {
        L.push('Files affected:')
        for (const f of [...c.files].sort()) L.push(`  - \`${f}\``)
        L.push('')
      }
    }
  }

  if (includeUnreviewed && pending.length > 0) {
    L.push('## Pending review — not yet approved')
    L.push('')
    L.push('_These are captured but unaffirmed. Not binding until approved._')
    L.push('')
    for (const d of pending.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))) {
      L.push(...renderDecisionBlock(d))
    }
  }

  if (superseded.length > 0) {
    L.push('## Superseded — no longer in effect')
    L.push('')
    L.push('_Kept for history: what the team decided before, and why it changed._')
    L.push('')
    for (const d of superseded.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))) {
      L.push(...renderDecisionBlock(d))
    }
  }

  return L.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function formatDecisionLine(d: Decision): string {
  const date = new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const conf = d.confidence >= 0.9 ? 'high' : d.confidence >= 0.6 ? 'medium' : 'low'
  const rationale = d.rationale ? ` — ${d.rationale}` : ''
  return `Chose ${d.decision}${rationale} _[${date}, ${conf} confidence]_`
}

function renderIndex(clusters: Cluster[], existing: string): string {
  const managed = [
    ROBRAIN_START,
    ...clusters.map(c => {
      const filename = `decision_${c.slug}.md`
      const summary  = c.decisions[c.decisions.length - 1]?.decision.slice(0, 70) ?? c.topic
      return `- [${c.topic}](${filename}) — ${summary}`
    }),
    ROBRAIN_END,
  ].join('\n')

  if (!existing) {
    // New index: just our managed block
    return `# Project memory\n\n${managed}\n`
  }

  // Existing index: replace our managed block in place, or append if absent
  const startIdx = existing.indexOf(ROBRAIN_START)
  const endIdx   = existing.indexOf(ROBRAIN_END)

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx)
    const after  = existing.slice(endIdx + ROBRAIN_END.length)
    return `${before}${managed}${after}`
  }

  // Markers missing — append at end, preserving everything user wrote
  const sep = existing.endsWith('\n') ? '' : '\n'
  return `${existing}${sep}\n${managed}\n`
}

/** Drop fields that change on every run so equality compares only substantive content. */
function stripVolatile(content: string): string {
  return content
    .replace(/^last_exported:.*$/m, '')
    .replace(/^_Generated .*_$/m, '')
    .trim()
}

function isRoBrainOwned(fileContent: string): boolean {
  // Only treat the first frontmatter block as authoritative
  if (!fileContent.startsWith('---')) return false
  const close = fileContent.indexOf('\n---', 3)
  if (close === -1) return false
  const fm = fileContent.slice(0, close)
  return fm.includes(FRONTMATTER_SOURCE)
}

function quoteYaml(s: string): string {
  // Quote if it contains characters YAML would otherwise misread
  if (/^[A-Za-z0-9 _\-\/\.]+$/.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

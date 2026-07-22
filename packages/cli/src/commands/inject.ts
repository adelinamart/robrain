// packages/cli/src/commands/inject.ts
// ─────────────────────────────────────────────────────────────
// robrain inject [--query TEXT] [--files file1,file2] [--copy]
//
// Queries the local decision store and returns a formatted
// context string the developer can paste into Claude Code.
//
// This is the manual retrieval path for OSS self-hosted users.
// The Rory Plans cloud version does this automatically at every
// task boundary via the Control MCP — no paste needed.
// ─────────────────────────────────────────────────────────────

import chalk   from 'chalk'
import ora     from 'ora'
import { readConfig } from '../lib/config.js'
import { gatherProjectInfo }           from '../lib/project.js'
import { cwd }                         from 'process'
import { execSync }                    from 'child_process'

interface InjectOptions {
  query?:  string    // semantic query to find relevant memories
  files?:  string    // comma-separated file paths in scope
  copy?:   boolean   // copy output to clipboard
  limit?:  number    // max memories to include (default 5)
  all?:    boolean   // show all matching, not just top-scored
}

export async function injectCommand(opts: InjectOptions): Promise<void> {
  console.log()

  const config  = readConfig()
  const info    = gatherProjectInfo(cwd())

  // Determine perception URL — local self-hosted or Rory Plans
  const percUrl = config.perceptionUrl ?? 'http://127.0.0.1:3001'
  const percKey = config.perceptionKey ?? ''

  // ── Build query ────────────────────────────────────────────
  // If no query provided, use recent decisions
  const query      = opts.query
  const files      = opts.files ? opts.files.split(',').map(f => f.trim()) : []
  const userLimit  = opts.limit ?? 5
  /** Perception caps at 100; `--all` requests the max for broader paste context. */
  const fetchLimit = opts.all ? 100 : Math.min(100, Math.max(1, userLimit))

  const spinner = ora({ text: 'Fetching relevant decisions...', color: 'green' }).start()

  let decisions: Array<{
    id:             string
    decision:       string
    rationale:      string | null
    rejected:       Array<{ option: string; reason: string }>
    files_affected: string[]
    confidence:     number
    scope:          string
    created_at:     string
    session_id?:    string
    source_turn_sequence?: number | null
    source_excerpt?:       string | null
    similarity?:    number
  }> = []

  try {
    // Build query params
    const params = new URLSearchParams({
      project_id: info.id,
      limit:      String(fetchLimit),
    })
    if (query) {
      params.set('query', query)
    } else if (opts.all) {
      params.set('all', 'true')
    } else {
      params.set('recent', 'true')
    }
    if (files.length > 0) params.set('boost_files', files.join(','))

    const res = await fetch(`${percUrl}/decisions?${params}`, {
      headers: percKey ? { 'Authorization': `Bearer ${percKey}` } : {},
    })

    if (!res.ok) {
      spinner.fail(`Could not fetch decisions (${res.status}). Is Perception running?`)
      console.log(chalk.dim(`  Expected at: ${percUrl}`))
      console.log(chalk.dim('  Start with: pnpm docker:up\n'))
      process.exit(1)
    }

    const data = await res.json() as { decisions: typeof decisions }
    decisions  = data.decisions ?? []

    // If files provided, boost file-overlapping decisions to top
    if (files.length > 0) {
      decisions.sort((a, b) => {
        const aOverlap = a.files_affected.filter(f => files.some(fi => f.includes(fi))).length
        const bOverlap = b.files_affected.filter(f => files.some(fi => f.includes(fi))).length
        return bOverlap - aOverlap || (b.similarity ?? 0) - (a.similarity ?? 0)
      })
    }

  } catch (err) {
    spinner.fail('Could not reach Perception API')
    console.log(chalk.dim(`\n  Make sure Perception is running: pnpm docker:up\n`))
    process.exit(1)
  }

  spinner.stop()

  if (decisions.length === 0) {
    console.log(chalk.dim(`  No decisions found for "${query ?? 'recent'}"\n`))
    console.log(chalk.dim(query
      ? '  No semantic matches were returned. Try a broader query (for example: "build tooling" instead of "env precedence").\n'
      : '  Run a Claude Code session first to capture decisions.\n'))
    return
  }

  // ── Format context string ──────────────────────────────────
  const lines: string[] = [
    `[RoBrain context — ${info.name}${query ? ` — "${query}"` : ' — recent decisions'}]`,
  ]

  const formatDecisionLine = (d: typeof decisions[number]): string => {
    const date   = new Date(d.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const conf   = d.confidence >= 0.9 ? 'high' : d.confidence >= 0.6 ? 'medium' : 'low'
    const vetoes = (d.rejected ?? []).map(r => `${r.option} (${r.reason})`).join(' over ')
    const vetoStr = vetoes ? ` over ${vetoes}` : ''
    const rationale = d.rationale ? ` — ${d.rationale}` : ''
    const supersedes = (d as any).supersedes_id
      ? ` [supersedes earlier decision]`
      : ''
    const similarityStr = typeof d.similarity === 'number'
      ? ` [sim ${(d.similarity * 100).toFixed(0)}%]`
      : ''

    const line = `• Chose ${d.decision}${vetoStr}${rationale} [${date}, ${conf} confidence${supersedes}]${similarityStr}`

    // Provenance — which session/turn this decision was captured from
    if (d.session_id && (d.source_turn_sequence != null || d.source_excerpt)) {
      const turn    = d.source_turn_sequence != null ? ` · turn ${d.source_turn_sequence}` : ''
      const excerpt = d.source_excerpt ? ` · "${truncateExcerpt(d.source_excerpt)}"` : ''
      return `${line}\n  ↳ from session ${d.session_id.slice(0, 8)}${turn} · ${date}${excerpt}`
    }
    return line
  }

  function truncateExcerpt(text: string, max = 80): string {
    const oneLine = text.replace(/\s+/g, ' ').trim()
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
  }

  const hasSimilarityScores = query && decisions.some(d => typeof d.similarity === 'number')

  if (hasSimilarityScores) {
    const highConfidence = decisions.filter(d => (d.similarity ?? 0) >= 0.5)
    const nearestMatches = decisions.filter(d => (d.similarity ?? 0) < 0.5)

    if (highConfidence.length > 0) {
      lines.push('')
      lines.push('High-confidence matches:')
      for (const d of highConfidence) lines.push(formatDecisionLine(d))
    }

    if (nearestMatches.length > 0) {
      lines.push('')
      lines.push(highConfidence.length > 0
        ? 'Nearest matches (lower semantic confidence):'
        : 'No high-confidence matches; nearest were:')
      for (const d of nearestMatches) lines.push(formatDecisionLine(d))
    }
  } else {
    for (const d of decisions) lines.push(formatDecisionLine(d))
  }

  // Cloud upgrade note (for OSS users)
  lines.push('')
  lines.push('— Generated by RoBrain OSS. Upgrade to Rory Plans for automatic injection.')

  const output = lines.join('\n')

  // ── Display ────────────────────────────────────────────────
  console.log(chalk.bold(`  Context for: ${info.name}`))
  console.log(chalk.dim(`  ${decisions.length} decision${decisions.length === 1 ? '' : 's'} found\n`))
  console.log(chalk.dim('  ─────────────────────────────────────'))
  console.log()
  console.log(output)
  console.log()
  console.log(chalk.dim('  ─────────────────────────────────────'))
  console.log()

  // ── Copy to clipboard ──────────────────────────────────────
  if (opts.copy) {
    try {
      const cmd = process.platform === 'darwin' ? 'pbcopy'
                : process.platform === 'win32'  ? 'clip'
                : 'xclip -selection clipboard'
      execSync(cmd, { input: output })
      console.log(chalk.green('  ✓ Copied to clipboard — paste into Claude Code\n'))
    } catch {
      console.log(chalk.yellow('  Could not copy to clipboard automatically.'))
      console.log(chalk.dim('  Copy the text above and paste it into Claude Code.\n'))
    }
  } else {
    console.log(chalk.dim('  Tip: add --copy to copy this directly to your clipboard'))
    console.log(chalk.dim('  Tip: add --query "auth decisions" to search for specific context'))
    console.log()
    console.log(chalk.dim('  Want automatic injection without pasting?'))
    console.log(chalk.dim('  → ') + chalk.cyan('roryplans.ai') + chalk.dim(' — Control MCP injects at every task boundary\n'))
  }
}

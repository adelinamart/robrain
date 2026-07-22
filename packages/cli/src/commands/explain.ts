// src/commands/explain.ts
// ─────────────────────────────────────────────────────────────
// npx robrain explain <file> [--why] [--copy]
//
// Answers "why does this code exist?" for any file.
// Queries the decision store for decisions made while
// that file was in scope, formatted as plain-language
// explanation rather than a raw context block.
//
// npx robrain explain src/store/cart.ts
// npx robrain explain src/store/cart.ts --why   (full rationale + rejected)
// npx robrain explain src/api/ --why             (directory — all files below)
// ─────────────────────────────────────────────────────────────

import chalk   from 'chalk'
import ora     from 'ora'
import { readConfig } from '../lib/config.js'
import { gatherProjectInfo } from '../lib/project.js'
import { cwd, exit } from 'process'
import { execSync } from 'child_process'

interface ExplainOptions {
  why?:  boolean   // show full rationale + rejected alternatives
  copy?: boolean   // copy output to clipboard
}

export async function explainCommand(
  filePath: string,
  opts: ExplainOptions,
): Promise<void> {
  console.log()

  const config  = readConfig()
  const info    = gatherProjectInfo(cwd())
  const percUrl = config.perceptionUrl ?? 'http://127.0.0.1:3001'
  const percKey = config.perceptionKey ?? ''

  // Normalise the file path — strip leading ./ if present
  const normalisedPath = filePath.replace(/^\.\//, '')

  const spinner = ora({ text: `Looking up decisions for ${normalisedPath}...`, color: 'green' }).start()

  let decisions: Array<{
    id:             string
    decision:       string
    rationale:      string | null
    rejected:       Array<{ option: string; reason: string }>
    files_affected: string[]
    confidence:     number
    created_at:     string
    supersedes_id:  string | null
    invalidated_at: string | null
  }> = []

  try {
    // Search by file overlap + semantic query on the file path
    // This catches decisions where the file was directly touched
    // AND decisions where the file's module was discussed
    const params = new URLSearchParams({
      project_id: info.id,
      files:      normalisedPath,
      query:      normalisedPath,   // semantic search on path as fallback
      limit:      '10',
      all:        'true',
    })

    const res = await fetch(`${percUrl}/decisions?${params}`, {
      headers: percKey ? { 'Authorization': `Bearer ${percKey}` } : {},
    })

    if (!res.ok) {
      spinner.fail(`Could not reach Perception API (${res.status})`)
      console.log(chalk.dim(`  Make sure Perception is running: pnpm docker:up\n`))
      exit(1)
    }

    const data = await res.json() as { decisions: typeof decisions }

    // Filter to decisions actually involving this file or path prefix
    decisions = (data.decisions ?? []).filter(d =>
      d.files_affected.some(f =>
        f.includes(normalisedPath) || normalisedPath.includes(f)
      )
    )

    // If no file matches, fall back to semantic results
    if (decisions.length === 0) {
      decisions = data.decisions ?? []
    }

  } catch {
    spinner.fail('Could not reach Perception API')
    console.log(chalk.dim(`\n  Make sure Perception is running: pnpm docker:up\n`))
    exit(1)
  }

  spinner.stop()

  if (decisions.length === 0) {
    console.log(chalk.dim(`  No decisions found for ${chalk.bold(normalisedPath)}\n`))
    console.log(chalk.dim('  RoBrain only knows about files discussed in Claude Code sessions.'))
    console.log(chalk.dim('  Run a session touching this file to start capturing decisions.\n'))
    return
  }

  // ── Build output ──────────────────────────────────────────

  const lines: string[] = []

  console.log(chalk.bold(`  ${normalisedPath}`))
  console.log(chalk.dim(`  ${decisions.length} decision${decisions.length === 1 ? '' : 's'} found\n`))

  for (const d of decisions) {
    const date  = new Date(d.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    })
    const isSuperseded = !!d.invalidated_at

    if (opts.why) {
      // ── Deep format: full rationale + rejected ─────────────
      if (isSuperseded) {
        console.log(chalk.dim(`  ${date}  [superseded]`))
        console.log(chalk.dim(`  ${d.decision}`))
      } else {
        console.log(chalk.dim(`  ${date}`) + `  ${chalk.bold(d.decision)}`)
      }

      if (d.rationale) {
        console.log(chalk.dim(`             because: `) + (isSuperseded ? chalk.dim(d.rationale) : d.rationale))
      }

      if (d.rejected.length > 0) {
        const vetoes = d.rejected
          .map(r => `${chalk.dim(r.option)} ${chalk.dim(`(${r.reason})`)}`)
          .join(', ')
        console.log(chalk.dim(`             rejected: `) + vetoes)
      }

      if (d.supersedes_id) {
        console.log(chalk.dim(`             ↩ replaces earlier decision`))
      }

      console.log()

      // Build plain text for clipboard
      const vetoStr = d.rejected.length > 0
        ? ` Rejected: ${d.rejected.map(r => `${r.option} (${r.reason})`).join(', ')}.`
        : ''
      lines.push(`${date}: ${d.decision}${d.rationale ? ` — ${d.rationale}.` : ''}${vetoStr}`)

    } else {
      // ── Short format: one-liner per decision ───────────────
      const vetoes = d.rejected.map(r => `${r.option} (${r.reason})`).join(' over ')
      const vetoStr = vetoes ? ` over ${vetoes}` : ''
      const rationale = d.rationale ? ` — ${d.rationale}` : ''
      const supersededLabel = isSuperseded ? chalk.dim(' [superseded]') : ''

      const line = `• Chose ${d.decision}${vetoStr}${rationale} (${date})`

      if (isSuperseded) {
        console.log(chalk.dim(`  ${line}`) + supersededLabel)
      } else {
        console.log(`  ${line}`)
      }

      lines.push(line)
    }
  }

  console.log()

  // ── Copy to clipboard ──────────────────────────────────────
  if (opts.copy) {
    const output = [
      `# Why does ${normalisedPath} exist?`,
      ...lines,
    ].join('\n')

    try {
      const cmd = process.platform === 'darwin' ? 'pbcopy'
                : process.platform === 'win32'  ? 'clip'
                : 'xclip -selection clipboard'
      execSync(cmd, { input: output })
      console.log(chalk.green('  ✓ Copied to clipboard\n'))
    } catch {
      console.log(chalk.yellow('  Could not copy automatically — copy the text above.\n'))
    }
  } else {
    if (!opts.why) {
      console.log(chalk.dim('  Tip: add --why for full rationale and rejected alternatives'))
    }
    console.log(chalk.dim('  Tip: add --copy to copy this to clipboard\n'))
  }
}

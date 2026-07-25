// packages/cli/src/commands/check.ts
// robrain check "<proposed change>" — pre-commit veto scan.
//
// Asks Perception's POST /veto-scan whether the proposal mentions any
// previously REJECTED option before you commit to it. Deterministic
// word-boundary matching — no embeddings, no LLM, sub-second. This is the
// same scan editor hooks run on UserPromptSubmit; the command is the manual
// surface for non-hook editors, planning discussions, and CI.
//
// Exit codes: 0 = no prior rejection matches; 1 = at least one match
// (scriptable: `robrain check "..." && apply`); 2 = could not scan.

import chalk from 'chalk'
import ora from 'ora'
import { cwd } from 'process'
import { readConfig } from '../lib/config.js'
import { gatherProjectInfo } from '../lib/project.js'

interface VetoMatch {
  id: string
  decision: string
  /** Only the rejected entries whose option appears in the proposal text. */
  rejected: Array<{ option: string; reason: string }>
  reviewed: boolean
  superseded?: boolean
  superseded_by?: { id: string; decision: string }
}

export async function checkCommand(text: string): Promise<void> {
  console.log()

  const config = readConfig()
  const info   = gatherProjectInfo(cwd())

  const percUrl = config.perceptionUrl ?? 'http://127.0.0.1:3001'
  const percKey = config.perceptionKey ?? ''

  const spinner = ora({ text: 'Scanning prior rejections...', color: 'green' }).start()

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
      spinner.fail(`Veto scan failed (${res.status}). Is Perception running?`)
      console.log(chalk.dim(`  Expected at: ${percUrl}`))
      console.log(chalk.dim('  Start with: robrain up\n'))
      process.exit(2)
    }
    const data = await res.json() as { matches?: VetoMatch[] }
    matches = data.matches ?? []
  } catch {
    spinner.fail('Could not reach Perception API')
    console.log(chalk.dim(`\n  Expected at: ${percUrl} — start with: robrain up\n`))
    process.exit(2)
  }

  spinner.stop()

  if (matches.length === 0) {
    console.log(chalk.green('  ✓ No prior rejection matches this proposal.'))
    console.log(chalk.dim(`  Scanned rejected[] options across project ${info.id}.\n`))
    return
  }

  console.log(chalk.yellow.bold(`  ⚠ ${matches.length} prior rejection${matches.length === 1 ? '' : 's'} match this proposal:\n`))

  for (const m of matches) {
    for (const r of m.rejected) {
      console.log(`  ${chalk.red('✗')} ${chalk.bold(r.option)} — ${r.reason || chalk.dim('(no reason recorded)')}`)
    }
    const tag = m.reviewed ? chalk.green('[approved]') : chalk.dim('[pending review]')
    console.log(`    ${chalk.dim('from:')} ${m.decision} ${tag}`)
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

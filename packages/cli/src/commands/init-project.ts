// src/commands/init-project.ts
// ─────────────────────────────────────────────────────────────
// robrain init-project [--project-id ID]
//
// Warm-starts the memory store from existing codebase context.
// Reads: package.json, README, git log, CLAUDE.md
// Writes: CLAUDE.md instructions, optional .cursor/rules/robrain.mdc,
//         seeds 3-5 inferred decisions,
//         triggers always-on summary generation.
//
// Run once per project, in the project root.
// ─────────────────────────────────────────────────────────────

import chalk   from 'chalk'
import ora     from 'ora'
import prompts from 'prompts'
import { cwd } from 'process'
import { readConfig, isAuthenticated } from '../lib/config.js'
import { gatherProjectInfo, seedProjectMemory } from '../lib/project.js'
import { detectEditors, writeClaudeMd, writeCursorRoBrainRule } from '../lib/editor.js'
import type { RoBrainInstructionMode } from '../lib/editor.js'

interface InitProjectOptions {
  projectId?: string
}

export async function initProjectCommand(opts: InitProjectOptions): Promise<void> {
  console.log()
  console.log(chalk.bold('  robrain init-project'))
  console.log(chalk.dim('  Warm-starting memory from your codebase...\n'))

  // ── Auth check ─────────────────────────────────────────────
  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated. Run: robrain install'))
    process.exit(1)
  }

  const config = readConfig()
  const instructionMode: RoBrainInstructionMode = config.selfHosted ? 'sensing-only' : 'sensing+control'

  if (!config.perceptionUrl) {
    console.log(chalk.red('  ✗ Perception URL not configured. Run: robrain install'))
    process.exit(1)
  }

  // ── Gather project info ────────────────────────────────────
  const spinner = ora({ text: 'Scanning project...', color: 'green' }).start()

  const projectRoot = cwd()
  const info = gatherProjectInfo(projectRoot)

  spinner.text = `Detected: ${chalk.bold(info.name)}`
  await sleep(400)  // brief pause so user sees the detection

  spinner.succeed(`Project: ${chalk.bold(info.name)} ${chalk.dim(`(id: ${info.id})`)}`)

  // Display what was found
  console.log()
  if (info.description) {
    console.log(chalk.dim('  Description: ') + info.description.slice(0, 80))
  }
  if (info.stack.length > 0) {
    console.log(chalk.dim('  Stack: ') + info.stack.slice(0, 8).join(', '))
  }
  if (info.gitLog) {
    const commits = info.gitLog.split('\n').slice(0, 3)
    console.log(chalk.dim('  Recent commits:'))
    commits.forEach(c => console.log(chalk.dim(`    ${c}`)))
  }
  console.log()

  // ── Confirm ────────────────────────────────────────────────
  const { confirm } = await prompts({
    type:    'confirm',
    name:    'confirm',
    message: `Initialize memory for ${chalk.bold(info.name)}?`,
    initial: true,
  })

  if (!confirm) {
    console.log(chalk.dim('\n  Cancelled.'))
    process.exit(0)
  }

  // ── Write CLAUDE.md (+ Cursor rule if Cursor is installed) ─
  const hasCursor = detectEditors().some(e => e.editor === 'cursor')
  const mdSpinner = ora({
    text: hasCursor
      ? 'Writing editor instructions (CLAUDE.md + Cursor)...'
      : 'Writing CLAUDE.md instructions...',
    color: 'green',
  }).start()
  writeClaudeMd(projectRoot, info.id, instructionMode)
  let cursorRuleApplied = false
  if (hasCursor) {
    cursorRuleApplied = writeCursorRoBrainRule(projectRoot, info.id, instructionMode)
  }
  mdSpinner.succeed(
    hasCursor
      ? 'Editor instructions updated (CLAUDE.md + Cursor rule)'
      : 'CLAUDE.md updated with RoBrain instructions',
  )

  // ── Seed memory ────────────────────────────────────────────
  const seedSpinner = ora({ text: 'Inferring architectural decisions from codebase...', color: 'green' }).start()

  const perceptionKey = config.perceptionKey ?? ''

  const result = await seedProjectMemory(
    config.perceptionUrl!,
    perceptionKey,
    info,
  )

  if (result.ok && result.decisionsWritten > 0) {
    seedSpinner.succeed(`Seeded ${result.decisionsWritten} inferred decisions`)
  } else if (result.ok) {
    seedSpinner.succeed('Project registered (no decisions inferred — will build from sessions)')
  } else {
    seedSpinner.warn('Could not seed decisions — Perception API unreachable. Memory will build from sessions.')
  }

  // ── Done ───────────────────────────────────────────────────
  console.log()
  console.log(chalk.green('  ✓ Project initialized\n'))
  console.log(chalk.dim('  Project ID: ') + chalk.cyan(info.id))
  console.log(chalk.dim('  CLAUDE.md:  ') + chalk.dim('updated with RoBrain instructions'))
  if (hasCursor) {
    console.log(
      chalk.dim('  Cursor:    ') +
        chalk.dim(
          cursorRuleApplied
            ? 'added .cursor/rules/robrain.mdc'
            : 'RoBrain rule already present',
        ),
    )
  }
  console.log()
  console.log(chalk.bold('  You\'re ready.'))
  if (hasCursor) {
    console.log(chalk.dim('  Open Claude Code or Cursor and start a session.'))
  } else {
    console.log(chalk.dim('  Open Claude Code and start a session.'))
  }
  console.log(chalk.dim('  Session 2 will remember what happened in session 1.'))
  console.log()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

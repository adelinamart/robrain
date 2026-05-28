// src/commands/init-project.ts
// ─────────────────────────────────────────────────────────────
// robrain init-project [--project-id ID]
//
// Warm-starts the memory store from existing codebase context.
// Reads: package.json, README, git log, CLAUDE.md, AGENTS.md
// Writes: CLAUDE.md + AGENTS.md instructions, optional .cursor/rules/robrain.mdc,
//         seeds 3-5 inferred decisions,
//         triggers always-on summary generation.
//
// Run once per project, in the project root.
// ─────────────────────────────────────────────────────────────

import chalk   from 'chalk'
import ora     from 'ora'
import prompts from 'prompts'
import { cwd } from 'process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { readConfig, isAuthenticated } from '../lib/config.js'
import { gatherProjectInfo, seedProjectMemory } from '../lib/project.js'
import { detectEditors, writeClaudeMd, writeCursorRoBrainRule, writeAgentsMd } from '../lib/editor.js'
import type { RoBrainInstructionMode } from '../lib/editor.js'

interface InitProjectOptions {
  projectId?:        string
  /** When true, skip the confirm prompt (e.g. chained from `robrain install`). */
  nonInteractive?: boolean
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
  const detectedAncestor = findAncestorRoBrainProject(projectRoot)
  const info = gatherProjectInfo(projectRoot)
  const resolvedProjectId = opts.projectId
    ?? detectedAncestor?.projectId
    ?? info.id

  spinner.text = `Detected: ${chalk.bold(info.name)}`
  await sleep(400)  // brief pause so user sees the detection

  spinner.succeed(`Project: ${chalk.bold(info.name)} ${chalk.dim(`(id: ${resolvedProjectId})`)}`)

  if (!opts.projectId && detectedAncestor?.projectId && detectedAncestor.dir !== projectRoot) {
    console.log(chalk.dim(
      `  Reusing existing RoBrain project id from ${detectedAncestor.source} in ${detectedAncestor.dir}: ${detectedAncestor.projectId}`,
    ))
  }

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
  if (!opts.nonInteractive) {
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
  }

  // ── Write CLAUDE.md + AGENTS.md (+ Cursor rule when Cursor is installed) ─
  const editors = detectEditors()
  const hasCursor = editors.some(e => e.editor === 'cursor')
  const hasCodex  = editors.some(e => e.editor === 'codex')
  const instructionExtras = hasCursor ? 'CLAUDE.md + AGENTS.md + Cursor' : 'CLAUDE.md + AGENTS.md'
  const mdSpinner = ora({
    text: `Writing editor instructions (${instructionExtras})...`,
    color: 'green',
  }).start()
  writeClaudeMd(projectRoot, resolvedProjectId, instructionMode)
  writeAgentsMd(projectRoot, resolvedProjectId, instructionMode)
  let cursorRuleApplied = false
  if (hasCursor) {
    cursorRuleApplied = writeCursorRoBrainRule(projectRoot, resolvedProjectId, instructionMode)
  }
  mdSpinner.succeed(`Editor instructions updated (${instructionExtras})`)

  // ── Seed memory ────────────────────────────────────────────
  const seedSpinner = ora({ text: 'Inferring architectural decisions from codebase...', color: 'green' }).start()

  const perceptionKey = config.perceptionKey ?? ''

  const result = await seedProjectMemory(
    config.perceptionUrl!,
    perceptionKey,
    { ...info, id: resolvedProjectId },
    projectRoot,
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
  console.log(chalk.dim('  Project ID: ') + chalk.cyan(resolvedProjectId))
  console.log(chalk.dim('  CLAUDE.md: ') + chalk.dim('updated with RoBrain instructions'))
  console.log(chalk.dim('  AGENTS.md: ') + chalk.dim('updated (Codex CLI and other AGENTS.md clients)'))
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
  const editorNames = ['Claude Code']
  if (hasCursor) editorNames.push('Cursor')
  if (hasCodex)  editorNames.push('Codex')
  console.log(chalk.dim(`  Open ${editorNames.join(' / ')} and start a session.`))
  console.log(chalk.dim('  Session 2 will remember what happened in session 1.'))
  console.log()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function findAncestorRoBrainProject(startDir: string): { projectId: string; source: string; dir: string } | null {
  let dir = startDir
  for (;;) {
    const claudeMdPath = join(dir, 'CLAUDE.md')
    const cursorRulePath = join(dir, '.cursor', 'rules', 'robrain.mdc')
    const agentsMdPath = join(dir, 'AGENTS.md')

    const claudeMdProjectId = readRoBrainProjectIdFromFile(claudeMdPath)
    if (claudeMdProjectId) return { projectId: claudeMdProjectId, source: 'CLAUDE.md', dir }

    const cursorProjectId = readRoBrainProjectIdFromFile(cursorRulePath)
    if (cursorProjectId) return { projectId: cursorProjectId, source: '.cursor/rules/robrain.mdc', dir }

    const agentsProjectId = readRoBrainProjectIdFromFile(agentsMdPath)
    if (agentsProjectId) return { projectId: agentsProjectId, source: 'AGENTS.md', dir }

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function readRoBrainProjectIdFromFile(path: string): string | null {
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  return extractProjectIdFromRoBrainBlock(text)
}

function extractProjectIdFromRoBrainBlock(text: string): string | null {
  const startMarker = '<!-- robrain -->'
  const endMarker = '<!-- /robrain -->'
  const startIdx = text.indexOf(startMarker)
  const endIdx = startIdx === -1 ? -1 : text.indexOf(endMarker, startIdx + startMarker.length)
  const scope = (startIdx !== -1 && endIdx !== -1)
    ? text.slice(startIdx, endIdx + endMarker.length)
    : text

  const match = scope.match(/project_id="([^"]+)"/)
  const projectId = match?.[1]?.trim()
  return projectId ? projectId : null
}

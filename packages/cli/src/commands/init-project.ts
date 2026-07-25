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
import { homedir } from 'os'
import { dirname, join } from 'path'
import { readConfig, isAuthenticated } from '../lib/config.js'
import { recommendClaudePlugin } from '../lib/claude-plugin.js'
import { gatherProjectInfo, seedProjectMemory } from '../lib/project.js'
import { detectEditors, writeClaudeMd, writeCursorRoBrainRule, writeAgentsMd } from '../lib/editor.js'
import type { RoBrainInstructionMode } from '../lib/editor.js'

interface InitProjectOptions {
  projectId?:        string
  /** When true, skip the confirm prompt (e.g. chained from `robrain install`). */
  nonInteractive?: boolean
  /** Do not recommend the Claude Code plugin in .claude/settings.json. */
  skipClaudePlugin?: boolean
  /** Initialize even when the target directory doesn't look like a project (home dir, no markers). */
  force?: boolean
}

/** Files that mark a directory as a plausible project root. */
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'Gemfile', 'mix.exs']

export async function initProjectCommand(opts: InitProjectOptions): Promise<void> {
  console.log()
  console.log(chalk.bold('  robrain init-project'))
  console.log(chalk.dim('  Warm-starting memory from your codebase...\n'))

  // ── Auth check ─────────────────────────────────────────────
  if (!isAuthenticated()) {
    console.log(chalk.red('  ✗ Not authenticated. Run: npx robrain install'))
    process.exit(1)
  }

  const config = readConfig()
  const instructionMode: RoBrainInstructionMode = config.selfHosted ? 'sensing-only' : 'sensing+control'

  if (!config.perceptionUrl) {
    console.log(chalk.red('  ✗ Perception URL not configured. Run: npx robrain install'))
    process.exit(1)
  }

  // ── Guard: don't initialize non-project directories ─────────
  // Initializing $HOME (e.g. `robrain install` run from the home directory)
  // mints a junk project whose id then shadows every directory beneath it.
  const guardRoot = cwd()
  const isHome = guardRoot === homedir()
  const looksLikeProject = PROJECT_MARKERS.some(m => existsSync(join(guardRoot, m)))
  if (!opts.force && (isHome || !looksLikeProject)) {
    const why = isHome ? 'this is your home directory' : 'no project markers found (.git, package.json, …)'
    console.log(chalk.yellow(`  ⚠ ${guardRoot} doesn't look like a project root — ${why}.`))
    if (opts.nonInteractive) {
      // Chained from `robrain install`: skip cleanly, tell the user what to do.
      console.log(chalk.dim('  Skipped init-project. From your project root, run: ') + chalk.cyan('npx robrain init-project'))
      console.log()
      return
    }
    const { proceed } = await prompts({
      type:    'confirm',
      name:    'proceed',
      message: 'Initialize RoBrain memory here anyway?',
      initial: false,
    })
    if (!proceed) {
      console.log(chalk.dim('\n  Cancelled. Run from your project root, or pass --force to override.\n'))
      process.exit(0)
    }
  }

  // ── Gather project info ────────────────────────────────────
  const spinner = ora({ text: 'Scanning project...', color: 'green' }).start()

  const projectRoot = cwd()
  const detectedAncestor = findAncestorRoBrainProject(projectRoot)
  const adoptedAncestor  = detectedAncestor && !detectedAncestor.outsideRepo ? detectedAncestor : null
  const info = gatherProjectInfo(projectRoot)
  const resolvedProjectId = opts.projectId
    ?? adoptedAncestor?.projectId
    ?? info.id

  spinner.text = `Detected: ${chalk.bold(info.name)}`
  await sleep(400)  // brief pause so user sees the detection

  spinner.succeed(`Project: ${chalk.bold(info.name)} ${chalk.dim(`(id: ${resolvedProjectId})`)}`)

  if (!opts.projectId && adoptedAncestor && adoptedAncestor.dir !== projectRoot) {
    console.log(chalk.dim(
      `  Reusing existing RoBrain project id from ${adoptedAncestor.source} in ${adoptedAncestor.dir}: ${adoptedAncestor.projectId}`,
    ))
  }
  // Found-but-not-adopted: an id above the repo boundary is a hint, never a
  // silent adoption — joining an out-of-repo scope is an explicit choice.
  if (!opts.projectId && detectedAncestor?.outsideRepo) {
    console.log(chalk.yellow(
      `  ⚠ Found RoBrain project ${detectedAncestor.projectId} in ${detectedAncestor.source} at ${detectedAncestor.dir} — outside this repo, not adopted.`,
    ))
    console.log(chalk.dim(
      `  To join it deliberately: npx robrain init-project --project-id ${detectedAncestor.projectId}`,
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

  // ── Recommend the Claude Code plugin to the team ───────────
  // Written to .claude/settings.json: teammates who trust this repo get an
  // install prompt from Claude Code itself. Same footprint as CLAUDE.md —
  // a repo-committed recommendation, not an install; each teammate still
  // approves the install in their own editor.
  let pluginRecommendation: ReturnType<typeof recommendClaudePlugin> | 'skipped' = 'skipped'
  if (!opts.skipClaudePlugin) {
    pluginRecommendation = recommendClaudePlugin(projectRoot)
    if (pluginRecommendation === 'written') {
      console.log(chalk.dim('  .claude/settings.json: recommends the RoBrain plugin to collaborators (skip with --skip-claude-plugin)'))
    } else if (pluginRecommendation === 'skipped-unreadable') {
      console.log(chalk.yellow('  ⚠ .claude/settings.json is not valid JSON — left untouched. Add the RoBrain plugin recommendation manually if wanted.'))
    }
  }

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

/** Nearest ancestor (or startDir itself) containing a `.git` entry — the repo boundary. Null outside any repo. */
function gitRootOf(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Walk up from startDir looking for a RoBrain project id pinned in editor
 * files. Adoption is bounded by the git repo: a hit inside the current repo
 * (the monorepo-subdirectory case) is adopted; a hit ABOVE the repo root —
 * or any ancestor hit when startDir isn't in a git repo at all — is returned
 * with `outsideRepo: true` so the caller can surface it as a hint instead of
 * silently joining an unrelated scope (e.g. a stray `~/AGENTS.md`). One
 * project = one repo; cross-repo sharing is a scope/team concern, not a
 * shared-id concern.
 */
function findAncestorRoBrainProject(startDir: string): { projectId: string; source: string; dir: string; outsideRepo: boolean } | null {
  const gitRoot = gitRootOf(startDir)
  let dir = startDir
  for (;;) {
    // A hit at startDir itself is always in scope — that's the project's own
    // pinned id. Above that, adoption requires staying inside the git repo.
    const inScope = dir === startDir || (gitRoot != null && (dir === gitRoot || dir.startsWith(gitRoot + '/')))

    const claudeMdProjectId = readRoBrainProjectIdFromFile(join(dir, 'CLAUDE.md'))
    if (claudeMdProjectId) return { projectId: claudeMdProjectId, source: 'CLAUDE.md', dir, outsideRepo: !inScope }

    const cursorProjectId = readRoBrainProjectIdFromFile(join(dir, '.cursor', 'rules', 'robrain.mdc'))
    if (cursorProjectId) return { projectId: cursorProjectId, source: '.cursor/rules/robrain.mdc', dir, outsideRepo: !inScope }

    const agentsProjectId = readRoBrainProjectIdFromFile(join(dir, 'AGENTS.md'))
    if (agentsProjectId) return { projectId: agentsProjectId, source: 'AGENTS.md', dir, outsideRepo: !inScope }

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

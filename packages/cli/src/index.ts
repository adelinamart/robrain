#!/usr/bin/env node
// src/index.ts
// ─────────────────────────────────────────────────────────────
// RoBrain CLI — entry point
// npx robrain <command> [options]
//
// Commands:
//   install        Authenticate + wire MCP servers into your editors
//   init-project   Warm-start memory from existing codebase
//   status         Show auth status + service health
//   rule           Add / list / remove explicit Planning rules
//   logout         Clear local credentials
// ─────────────────────────────────────────────────────────────

import { program } from 'commander'
import { loadCliEnv }                             from './lib/load-env.js'
import { installCommand }     from './commands/install.js'
import { initProjectCommand }  from './commands/init-project.js'
import { statusCommand, ruleCommand, logoutCommand } from './commands/status.js'
import { reviewCommand }       from './commands/review.js'
import { injectCommand }       from './commands/inject.js'
import { exportMemoryCommand } from './commands/export-memory.js'
import { explainCommand }      from './commands/explain.js'
import { projectsListCommand, projectsMergeCommand } from './commands/projects.js'

const VERSION = '0.2.0'

program
  .name('robrain')
  .description('Institutional memory for AI coding agents — by Rory Plans')
  .version(VERSION)

// ── review ────────────────────────────────────────────────────

program
  .command('review')
  .description('Review, edit, or delete decisions captured by RoBrain')
  .option('-s, --session <id>', 'Review a specific session ID (default: last session)')
  .option('-a, --all',          'Show all active decisions, not just the last session')
  .option('--history',          'Show full lifecycle including superseded decisions')
  .option('--approve-all',      'Bulk-approve every reviewable decision in the current result set')
  .option('-l, --limit <n>',    'Max decisions to show (default: 20)', parseInt)
  .action(async (opts: { session?: string; all?: boolean; history?: boolean; approveAll?: boolean; limit?: number }) => {
    await reviewCommand({
      session:    opts.session ?? 'last',
      all:        opts.all,
      history:    opts.history,
      approveAll: opts.approveAll,
      limit:      opts.limit,
    })
  })

// ── explain ───────────────────────────────────────────────────

program
  .command('explain <file>')
  .description('Answer "why does this code exist?" for any file or directory')
  .option('-w, --why',  'Show full rationale and rejected alternatives')
  .option('-c, --copy', 'Copy output to clipboard')
  .action(async (file: string, opts: { why?: boolean; copy?: boolean }) => {
    await explainCommand(file, opts)
  })

// ── inject ────────────────────────────────────────────────────

program
  .command('inject')
  .description('Get relevant prior context to paste into Claude Code (OSS manual retrieval path)')
  .option('-q, --query <text>',   'Semantic search query for relevant decisions')
  .option('-f, --files <files>',  'Comma-separated files in scope (boosts file-overlapping decisions)')
  .option('-c, --copy',           'Copy output directly to clipboard')
  .option('-l, --limit <n>',      'Max decisions to include (default: 5)', parseInt)
  .option('-a, --all',            'Include all matching decisions, not just top scored')
  .action(async (opts: { query?: string; files?: string; copy?: boolean; limit?: number; all?: boolean }) => {
    await injectCommand(opts)
  })

// ── export-memory ─────────────────────────────────────────────

program
  .command('export-memory')
  .description('Project approved decisions into Claude Code\'s auto-memory directory (no paste needed)')
  .option('--dry-run',           'Preview what would be written without touching disk')
  .option('--include-unreviewed', 'Also export decisions that haven\'t been approved (not recommended)')
  .option('--to <dir>',          'Write to a custom memory dir (default: ~/.claude/projects/<slug>/memory)')
  .action(async (opts: { dryRun?: boolean; includeUnreviewed?: boolean; to?: string }) => {
    await exportMemoryCommand(opts)
  })

// ── install ───────────────────────────────────────────────────

program
  .command('install')
  .description('Wire RoBrain into your AI editors (self-hosted or Rory Plans cloud)')
  .option('-t, --token <token>',      'Rory Plans API token (or set RORY_TOKEN env var)')
  .option('-e, --editor <editor>',    'Target editor: claude-code | cursor | copilot')
  .option('--self-hosted',            'Self-hosted mode — skip Rory Plans auth')
  .option('--perception-url <url>',   'Perception URL for self-hosted mode (default: http://localhost:3001)')
  .option(
    '--repo-root <path>',
    'Path to your robrain git clone (links built sensing-mcp into ~/.robrain/mcp). Or set ROBRAIN_REPO.',
  )
  .option('--skip-init-project', 'Do not run init-project in the current directory after install')
  .action(async (opts: {
    token?: string
    editor?: string
    selfHosted?: boolean
    perceptionUrl?: string
    repoRoot?: string
    skipInitProject?: boolean
  }) => {
    await installCommand({
      token:            opts.token ?? process.env.RORY_TOKEN,
      editor:           opts.editor,
      selfHosted:       opts.selfHosted,
      perceptionUrl:    opts.perceptionUrl,
      repoRoot:         opts.repoRoot,
      skipInitProject:  opts.skipInitProject,
    })
  })

// ── init-project ──────────────────────────────────────────────

program
  .command('init-project')
  .alias('init')
  .description('Warm-start project memory from your codebase (run once per project)')
  .option('--project-id <id>', 'Override the auto-derived project ID')
  .action(async (opts: { projectId?: string }) => {
    await initProjectCommand({ projectId: opts.projectId })
  })

// ── projects — list / merge Perception project ids ────────────

const projectsCmd = program
  .command('projects')
  .description('List or merge projects in Perception (recover from duplicate / phantom project ids)')

projectsCmd
  .command('list')
  .description('List all projects with session and decision counts')
  .action(async () => {
    await projectsListCommand()
  })

projectsCmd
  .command('merge <from-id> <to-id>')
  .description('Merge sessions and decisions from one project id into another, then delete the source project row')
  .action(async (fromId: string, toId: string) => {
    await projectsMergeCommand(fromId, toId)
  })

// ── status ────────────────────────────────────────────────────

program
  .command('status')
  .description('Show authentication status and service health')
  .action(async () => {
    await statusCommand()
  })

// ── rule ──────────────────────────────────────────────────────

program
  .command('rule')
  .description('Manage explicit Planning rules for this project')
  .option('--add <text>',    'Add a new rule in plain language')
  .option('--list',          'List active rules for this project')
  .option('--remove <id>',   'Remove a rule by ID')
  .option('--type <type>',   'Rule type: always_include | always_exclude | preference (default: preference)')
  .action(async (opts: { add?: string; list?: boolean; remove?: string; type?: string }) => {
    await ruleCommand(opts)
  })

// ── logout ────────────────────────────────────────────────────

program
  .command('logout')
  .description('Clear local credentials')
  .action(async () => {
    await logoutCommand()
  })

// ── Default: show help ─────────────────────────────────────────

program.addHelpText('beforeAll', `
  RoBrain v${VERSION} — institutional memory for AI coding agents
  by roryplans.ai
`)

program.hook('preAction', (_thisCommand, actionCommand) => {
  const opts = actionCommand.opts() as { repoRoot?: string }
  const repoRoot = opts.repoRoot ?? process.env.ROBRAIN_REPO
  loadCliEnv(repoRoot)
})

program.addHelpText('afterAll', `
  Self-hosted quick start:
    pnpm docker:up                                  Start Postgres + Perception
    npx robrain install --self-hosted               Wire Sensing into Claude Code
    npx robrain init-project                        Warm-start memory from codebase
    npx robrain review                              Review captured decisions
    npx robrain inject --query "..." --copy         Get context to paste into Claude Code
    npx robrain export-memory                       Project approved decisions into Claude Code auto-memory
    npx robrain explain src/store/cart.ts           Why does this file look this way?

  Cloud quick start (automatic injection, no paste):
    npx robrain install --token YOUR_TOKEN      Authenticate with Rory Plans
    npx robrain init-project                    Warm-start memory
    → Context injects automatically at task boundaries
`)

program.parse()

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
import { installCommand }     from './commands/install.js'
import { initProjectCommand }  from './commands/init-project.js'
import { statusCommand, ruleCommand, logoutCommand } from './commands/status.js'
import { reviewCommand }       from './commands/review.js'
import { injectCommand }       from './commands/inject.js'
import { explainCommand }      from './commands/explain.js'

const VERSION = '0.1.0'

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
  .option('-l, --limit <n>',    'Max decisions to show (default: 20)', parseInt)
  .action(async (opts: { session?: string; all?: boolean; history?: boolean; limit?: number }) => {
    await reviewCommand({
      session: opts.session ?? 'last',
      all:     opts.all,
      history: opts.history,
      limit:   opts.limit,
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
  .action(async (opts: {
    token?: string
    editor?: string
    selfHosted?: boolean
    perceptionUrl?: string
    repoRoot?: string
  }) => {
    await installCommand({
      token:         opts.token ?? process.env.RORY_TOKEN,
      editor:        opts.editor,
      selfHosted:    opts.selfHosted,
      perceptionUrl: opts.perceptionUrl,
      repoRoot:      opts.repoRoot,
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
  by roryplans.ai · private · not open source
`)

program.addHelpText('afterAll', `
  Self-hosted quick start:
    pnpm docker:up                                  Start Postgres + Perception
    npx robrain install --self-hosted               Wire Sensing into Claude Code
    npx robrain init-project                        Warm-start memory from codebase
    npx robrain review                              Review captured decisions
    npx robrain inject --query "..." --copy         Get context to paste into Claude Code
    npx robrain explain src/store/cart.ts           Why does this file look this way?

  Cloud quick start (automatic injection, no paste):
    npx robrain install --token YOUR_TOKEN      Authenticate with Rory Plans
    npx robrain init-project                    Warm-start memory
    → Context injects automatically at task boundaries
`)

program.parse()

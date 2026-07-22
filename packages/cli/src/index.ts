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
//   doctor         Diagnose install, editor wiring, keys, and service health
//   rule           Add / list explicit Planning rules
//   logout         Clear local credentials
// ─────────────────────────────────────────────────────────────

import { program } from 'commander'
import { loadCliEnv }                             from './lib/load-env.js'
import { installCommand }     from './commands/install.js'
import { initProjectCommand }  from './commands/init-project.js'
import { statusCommand, ruleCommand, logoutCommand } from './commands/status.js'
import { doctorCommand }       from './commands/doctor.js'
import { reviewCommand }       from './commands/review.js'
import { injectCommand }       from './commands/inject.js'
import { synthCommand }        from './commands/synth.js'
import { exportMemoryCommand } from './commands/export-memory.js'
import { exportInterchangeCommand } from './commands/export-interchange.js'
import { outcomesScanCommand, outcomesRecordCommand } from './commands/outcomes.js'
import { explainCommand }      from './commands/explain.js'
import { projectsListCommand, projectsMergeCommand } from './commands/projects.js'
import { upCommand, downCommand, DEFAULT_IMAGE_REPO } from './commands/up.js'
import { mcpCommand } from './commands/mcp.js'
import { installHermesPlugin, resolveHermesHome } from './lib/hermes-plugin.js'

const VERSION = '2.4.2'

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
  .option('-a, --all',            'Fetch up to 100 decisions (Perception cap): all unreviewed when no --query, or broader semantic results with --query')
  .action(async (opts: { query?: string; files?: string; copy?: boolean; limit?: number; all?: boolean }) => {
    await injectCommand(opts)
  })

// ── synth — Synthesis batch job ───────────────────────────────

program
  .command('synth')
  .description('Run cross-decision Synthesis (drift, contradictions, entities) via @robrain/synthesis')
  .option('--dry-run', 'Compute prompts but do not write to the database')
  .option('--full', 'Disable incremental mode — re-check all contradiction candidate pairs')
  .option('--lookback <days>', 'Only consider decisions newer than N days', parseInt)
  .option('--project <id>', 'Limit to one project id')
  .action(async (opts: { dryRun?: boolean; full?: boolean; lookback?: number; project?: string }) => {
    await synthCommand({
      dryRun:   opts.dryRun,
      full:     opts.full,
      lookback: opts.lookback,
      project:  opts.project,
    })
  })

// ── export-memory ─────────────────────────────────────────────

program
  .command('export-memory')
  .description('Project approved decisions into Claude Code\'s auto-memory directory (no paste needed)')
  .option('--dry-run',           'Preview what would be written without touching disk')
  .option('--include-unreviewed', 'Also export decisions that haven\'t been approved (not recommended)')
  .option('--to <dir>',          'Write to a custom memory dir (default: ~/.claude/projects/<slug>/memory)')
  .option('--ledger [path]',     'Also write a single git-committed decisions ledger (default: <project>/decisions.md)')
  .option('--cwd <path>',        'Project root for Claude memory slug + stack detection (default: current directory)')
  .option('--project-id <id>',   'Perception project id when it differs from the path-derived id')
  .action(async (opts: { dryRun?: boolean; includeUnreviewed?: boolean; to?: string; ledger?: string | boolean; cwd?: string; projectId?: string }) => {
    await exportMemoryCommand(opts)
  })

// ── export — machine-readable interchange dump ────────────────

program
  .command('export')
  .description('Export the decision corpus as JSONL for other agent-memory tools (robrain-memory/v1)')
  .option('--format <format>',  'Export format (default: interchange)', 'interchange')
  .option('--out <file>',       'Write to a file instead of stdout')
  .option('--cwd <path>',       'Project root for project-id derivation (default: current directory)')
  .option('--project-id <id>',  'Perception project id when it differs from the path-derived id')
  .action(async (opts: { format?: string; out?: string; cwd?: string; projectId?: string }) => {
    await exportInterchangeCommand(opts)
  })

// ── outcomes — real-world outcome feedback ────────────────────

const outcomesCmd = program
  .command('outcomes')
  .description('Scan git history for reverts of stored decisions and feed outcomes back into memory')
  .option('--since <ref|date>', 'Scan reverts since a git ref or date (default: "30 days ago")')
  .option('--dry-run',          'Show matched decisions without recording outcomes')
  .action(async (opts: { since?: string; dryRun?: boolean }) => {
    await outcomesScanCommand(opts)
  })

outcomesCmd
  .command('record <decision-id>')
  .description('Manually record an outcome for a decision')
  .requiredOption('--outcome <type>', 'revert | incident | confirmed')
  .option('--evidence <text>',        'Supporting evidence (commit hash, incident link, note)')
  .action(async (decisionId: string, opts: { outcome: string; evidence?: string }) => {
    await outcomesRecordCommand(decisionId, opts)
  })

// ── mcp — launch the bundled Sensing server (portable stdio config) ──

program
  .command('mcp')
  .description('Run the bundled Sensing MCP server over stdio (for mcp.json configs and MCP directories)')
  .action(async () => {
    await mcpCommand()
  })

// ── up / down — clone-free self-hosted stack ──────────────────

program
  .command('up')
  .description('Start the self-hosted Perception stack (Postgres + Perception) from the published Docker image — no repo clone needed')
  .option('--tag <tag>',     `Perception image tag (default: CLI version ${VERSION})`)
  .option('--image <image>', `Full image override (default: ${DEFAULT_IMAGE_REPO}:<tag>)`)
  .action(async (opts: { tag?: string; image?: string }) => {
    await upCommand({ tag: opts.tag, image: opts.image, cliVersion: VERSION })
  })

program
  .command('down')
  .description('Stop the self-hosted Perception stack started by robrain up (data volume is preserved)')
  .action(async () => {
    await downCommand()
  })

// ── install ───────────────────────────────────────────────────

program
  .command('install')
  .description('Wire RoBrain into your AI editors (self-hosted or Rory Plans cloud)')
  .option('-t, --token <token>',      'Rory Plans API token (or set RORY_TOKEN env var)')
  .option('-e, --editor <editor>',    'Target editor: claude-code | cursor | copilot | codex')
  .option('--self-hosted',            'Self-hosted mode — skip Rory Plans auth')
  .option('--hermes',                 'Install the Hermes memory-provider plugin into $HERMES_HOME/plugins')
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
    hermes?: boolean
    perceptionUrl?: string
    repoRoot?: string
    skipInitProject?: boolean
  }) => {
    if (opts.hermes) {
      const { dest } = installHermesPlugin()
      console.log(`✔ Hermes memory-provider plugin installed → ${dest}`)
      console.log('\nNext steps:')
      console.log('  1. hermes memory setup          # select "robrain"')
      console.log('  2. PERCEPTION_API_KEY lives in ~/.robrain/stack/.env (after `npx robrain up`)')
      console.log('     or your repo .env (clone path)')
      console.log(`\nHermes home: ${resolveHermesHome()} (override with HERMES_HOME)`)
      // --hermes alone is a complete install; editor wiring only runs when
      // another install intent is present.
      if (!opts.token && !opts.selfHosted && !opts.editor && !opts.repoRoot && !process.env.RORY_TOKEN) {
        return
      }
      console.log('')
    }
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
  .option('--skip-claude-plugin', 'Do not recommend the RoBrain Claude Code plugin in .claude/settings.json')
  .action(async (opts: { projectId?: string; skipClaudePlugin?: boolean }) => {
    await initProjectCommand({ projectId: opts.projectId, skipClaudePlugin: opts.skipClaudePlugin })
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
  .description('Show authentication status, service health, and Perception decision count for this project')
  .action(async () => {
    await statusCommand()
  })

// ── doctor ────────────────────────────────────────────────────

program
  .command('doctor')
  .description('Diagnose the full setup: install config, MCP bundle, editor wiring, keys, Perception health, project registration')
  .action(async () => {
    await doctorCommand()
  })

// ── rule ──────────────────────────────────────────────────────

program
  .command('rule')
  .description('Manage explicit Planning rules (Rory Plans cloud Planning API — not OSS Perception)')
  .option('--add <text>',    'Add a new rule in plain language')
  .option('--list',          'List active rules for this project')
  .option('--type <type>',   'Rule type: always_include | always_exclude | preference (default: preference)')
  .action(async (opts: { add?: string; list?: boolean; type?: string }) => {
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
  Self-hosted quick start (no clone needed):
    npx robrain up                                  Start Postgres + Perception from the published image
    npx robrain install --self-hosted               Wire Sensing MCP into your editors
    npx robrain init-project                        Warm-start memory from codebase
    npx robrain doctor                              Something not capturing? Diagnose the whole setup
    npx robrain review                              Review captured decisions
    npx robrain inject --query "..." --copy         Get context to paste into Claude Code
    npx robrain export-memory                       Project approved decisions into Claude Code auto-memory
    npx robrain export-memory --ledger              Also write git-committed decisions.md in the project
    npx robrain explain src/store/cart.ts           Why does this file look this way?
    npx robrain outcomes --dry-run                  Match git reverts against stored decisions
    npx robrain export --format interchange         Dump memories as portable JSONL (robrain-memory/v1)
    npx robrain synth --dry-run                     Run Synthesis from the robrain clone (needs DATABASE_URL + ANTHROPIC_API_KEY)

  From a robrain clone instead (dev): pnpm install && pnpm build, pnpm docker:up,
  then npx robrain install --self-hosted --repo-root <robrain-clone>.

  Cloud quick start (automatic injection, no paste):
    npx robrain install --token YOUR_TOKEN      Authenticate with Rory Plans
    npx robrain init-project                    Warm-start memory
    → Context injects automatically at task boundaries
`)

program.parse()

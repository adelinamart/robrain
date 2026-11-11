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
import { checkCommand }        from './commands/check.js'
import { synthCommand }        from './commands/synth.js'
import { exportMemoryCommand } from './commands/export-memory.js'
import { exportInterchangeCommand } from './commands/export-interchange.js'
import { outcomesScanCommand, outcomesRecordCommand } from './commands/outcomes.js'
import { explainCommand }      from './commands/explain.js'
import { projectsListCommand, projectsMergeCommand, projectsCreateCommand, projectsTagCommand, tagsMapCommand } from './commands/projects.js'
import { captureShowCommand, captureSetCommand, captureTestCommand, type CaptureSetOptions, type CaptureTestOptions } from './commands/capture.js'
import { searchCommand, type SearchOptions } from './commands/search.js'
import { rulesAddCommand, promoteCommand, type RulesAddOptions } from './commands/governance.js'
import { auditCommand, lineageCommand, type AuditOptions } from './commands/cloud.js'
import { upCommand, downCommand, DEFAULT_IMAGE_REPO } from './commands/up.js'
import { mcpCommand } from './commands/mcp.js'
import { installHermesPlugin, resolveHermesHome } from './lib/hermes-plugin.js'

const VERSION = '2.6.1'

const collect = (value: string, previous: string[]): string[] => [...previous, value]

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
  .option('--quarantined',      'Show only decisions held by trust screening, to release or reject them one by one')
  .option('-l, --limit <n>',    'Max decisions to show (default: 20)', parseInt)
  .action(async (opts: { session?: string; all?: boolean; history?: boolean; approveAll?: boolean; quarantined?: boolean; limit?: number }) => {
    await reviewCommand({
      session:    opts.session ?? 'last',
      all:        opts.all,
      history:    opts.history,
      approveAll: opts.approveAll,
      quarantined: opts.quarantined,
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

// ── check — pre-commit veto scan ──────────────────────────────

program
  .command('check <text>')
  .description('Scan a proposed change against prior rejections before committing to it (exit 1 on match)')
  .option('--conflicts', 'RoBrain cloud: also ask whether it contradicts a stored decision that names no rejected option (one model call)')
  .action(async (text: string, opts: { conflicts?: boolean }) => {
    await checkCommand(text, opts)
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
  .option('--perception-url <url>',   'Perception URL for self-hosted mode (default: http://127.0.0.1:3001)')
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
  .option('--force', 'Initialize even when the directory has no project markers (or is your home directory)')
  .action(async (opts: { projectId?: string; skipClaudePlugin?: boolean; force?: boolean }) => {
    await initProjectCommand({ projectId: opts.projectId, skipClaudePlugin: opts.skipClaudePlugin, force: opts.force })
  })

// ── search — semantic search over stored memory, for people ───

program
  .command('search <query>')
  .description('Search stored decisions and other memory; shows who decided each one and when')
  .option('-l, --limit <n>',    'Max results (default: 10, max 100)', parseInt)
  .option('--kind <name>',      'Only this kind of memory (e.g. run, preference)')
  .option('--project-id <id>',  'Project to search (default: the one pinned in this directory)')
  .option('--json',             'Print the raw rows as JSON')
  .action(async (query: string, opts: SearchOptions) => {
    await searchCommand(query, opts)
  })

// ── rules — write a rule by hand ──────────────────────────────

const rulesCmd = program
  .command('rules')
  .description('Rules written by hand: stored like captured decisions, with confidence 1.0 and your email as author')

rulesCmd
  .command('add <rule>')
  .description('Store a rule now, without waiting for a session to capture it')
  .option('--because <text>',      'Why (one short sentence)')
  .option('--rejected <option:reason>', 'An alternative that was ruled out, "option: reason" (repeatable)', collect, [])
  .option('--kind <name>',         'Store as one of the kinds the project declared (default: decision)')
  .option('--subject <text>',      'Subject for a kind with changing state; a newer entry on the same subject replaces this one')
  .option('--scope <scope>',       'user | local | team | global (default: team)')
  .option('--project-id <id>',     'Project to write into (default: the one pinned in this directory)')
  .option('--email <addr>',        'Author email (default: git user.email of this directory)')
  .action(async (rule: string, opts: RulesAddOptions) => {
    await rulesAddCommand(rule, opts)
  })

// ── promote — push a decision to production agents (cloud) ────

program
  .command('promote <decision-id>')
  .description('RoBrain cloud: push a decision into the org governance project (every agent) or one agent project')
  .requiredOption('--to <target>', 'production-agents (every production agent), tag:<tag> (every agent with that tag), or a project id')
  .action(async (decisionId: string, opts: { to: string }) => {
    await promoteCommand(decisionId, opts)
  })

// ── lineage — what a decision replaced and what replaced it (cloud) ──

program
  .command('lineage <decision-id>')
  .description('RoBrain cloud: the history of one decision, oldest first: what it replaced, what replaced it, and what still stands')
  .option('--json', 'Print the raw chain and relations as JSON')
  .action(async (decisionId: string, opts: { json?: boolean }) => {
    await lineageCommand(decisionId, opts)
  })

// ── audit — the governance ledger (cloud) ─────────────────────

program
  .command('audit')
  .description('RoBrain cloud: who registered an agent, wrote or pushed a rule, or changed tags, the tool mapping or capture settings, newest first')
  .option('-l, --limit <n>',    'Max entries (default: 30, max 200)', parseInt)
  .option('--action <name>',    'Only one action: project_registered | rule_added | promoted | capture_settings_changed | tags_changed | tag_rules_changed')
  .option('--project-id <id>',  'Only entries about this project (where it happened, or where a rule was pushed)')
  .option('--before <date>',    'Only entries older than this date or timestamp (for paging)')
  .option('--json',             'Print the raw entries as JSON')
  .action(async (opts: AuditOptions) => {
    await auditCommand(opts)
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
  .command('create <id>')
  .description('Create (or rename) a project by id, e.g. one shared by a team across several repos; pin it with ROBRAIN_PROJECT_ID or --project-id')
  .option('--name <name>', 'Display name (default: the id)')
  .option('--tag <tag>',   'Tag (repeatable or comma-separated); on RoBrain cloud a rule can be pushed to one tag of agents', collect, [])
  .action(async (id: string, opts: { name?: string; tag?: string[] }) => {
    await projectsCreateCommand(id, opts)
  })

projectsCmd
  .command('tag <id> [tags...]')
  .description('RoBrain cloud: show or set a project\'s tags (what kind of agent it is), so robrain promote --to tag:<tag> can reach it')
  .option('--suppress <tag>',   'Remove a tag the tool mapping derived (repeatable)', collect, [])
  .option('--unsuppress <tag>', 'Let a removed derived tag apply again (repeatable)', collect, [])
  .option('--show',             'Only show the tags and the tools seen')
  .action(async (id: string, tags: string[], opts: { suppress?: string[]; unsuppress?: string[]; show?: boolean }) => {
    await projectsTagCommand(id, tags, opts)
  })

// ── tags — the org's tool → tag mapping (cloud) ───────────────

const tagsCmd = program
  .command('tags')
  .description('RoBrain cloud: tags derived from the tools an agent uses, through the org\'s tool → tag mapping')

const tagsMapCmd = tagsCmd
  .command('map')
  .description('List the mapping; `add "<tool pattern>" <tag>` and `remove "<tool pattern>" <tag>` change it (admins)')
  .action(async () => {
    await tagsMapCommand('list')
  })

tagsMapCmd
  .command('add <pattern> <tag>')
  .description('Map tools matching the pattern (e.g. "send_email*") to a tag; applies after three turns of use')
  .action(async (pattern: string, tag: string) => {
    await tagsMapCommand('add', pattern, tag)
  })

tagsMapCmd
  .command('remove <pattern> <tag>')
  .description('Remove one mapping')
  .action(async (pattern: string, tag: string) => {
    await tagsMapCommand('remove', pattern, tag)
  })

projectsCmd
  .command('merge <from-id> <to-id>')
  .description('Merge sessions and decisions from one project id into another, then delete the source project row')
  .action(async (fromId: string, toId: string) => {
    await projectsMergeCommand(fromId, toId)
  })

// ── capture — what the classifier stores for this project ─────


function addCaptureSettingFlags<T extends import('commander').Command>(cmd: T): T {
  return cmd
    .option('--project-id <id>',          'Project to change (default: the one pinned in this directory)')
    .option('--instructions <text>',      'Plain-language rules for what to store (max 2000 characters)')
    .option('--instructions-file <path>', 'Read the instructions from a file')
    .option('--clear-instructions',       'Remove the instructions')
    .option('--mode <strict|broad>',      'strict: keyword gate (default). broad: every non-trivial turn reaches the model')
    .option('--min-confidence <0..1>',    'Store only extractions at or above this confidence (stock: 0.60)')
    .option('--reset-min-confidence',     'Go back to the stock threshold')
    .option('--add-kind <name:description>', 'Store another kind of memory besides decisions (repeatable)', collect, [])
    .option('--remove-kind <name>',       'Stop storing a kind (repeatable)', collect, [])
    .option('--clear-kinds',              'Remove every extra kind')
}

const captureCmd = program
  .command('capture')
  .description('Tell the classifier, in plain language, what to store for this project (self-hosted Perception)')

captureCmd
  .command('show')
  .description('Show the capture settings for this project')
  .option('--project-id <id>', 'Project to show (default: the one pinned in this directory)')
  .action(async (opts: { projectId?: string }) => {
    await captureShowCommand(opts)
  })

addCaptureSettingFlags(
  captureCmd
    .command('set')
    .description('Change the capture settings (shared by every teammate on this project)'),
).action(async (opts: CaptureSetOptions) => {
  await captureSetCommand(opts)
})

addCaptureSettingFlags(
  captureCmd
    .command('test')
    .description('Dry run: what would the settings capture from sample turns? Nothing is stored')
    .option('--file <path>',  'Sample turns, one JSON object per line: {"user_message": "...", "claude_reply": "..."} (max 20)')
    .option('--user <text>',  'A single sample user message (with --reply)')
    .option('--reply <text>', 'The assistant reply for --user')
    .option('--compare',      'Also run the settings saved today, to see what changes'),
).action(async (opts: CaptureTestOptions) => {
  await captureTestCommand(opts)
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
    npx robrain check "switch tests to Vitest"      Pre-commit veto scan — did we already reject this? (exit 1 on match)
    npx robrain synth --dry-run                     Run Synthesis (no clone needed after \`robrain up\`; needs the classifier LLM key)

  From a robrain clone instead (dev): pnpm install && pnpm build, pnpm docker:up,
  then npx robrain install --self-hosted --repo-root <robrain-clone>.

  Cloud quick start (automatic injection, no paste):
    npx robrain install --token YOUR_TOKEN      Authenticate with Rory Plans
    npx robrain init-project                    Warm-start memory
    → Context injects automatically at task boundaries
`)

program.parse()

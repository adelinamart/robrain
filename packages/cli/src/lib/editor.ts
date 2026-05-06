// src/lib/editor.ts
// ─────────────────────────────────────────────────────────────
// Detects which AI coding editors are installed and writes
// the appropriate MCP server configuration for each.
// Supported: Claude Code, Cursor, GitHub Copilot (VS Code)
// ─────────────────────────────────────────────────────────────
// ----ROBRAIN___
// ****RADU****

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

export type Editor = 'claude-code' | 'cursor' | 'copilot' | 'unknown'

export interface DetectedEditor {
  editor:     Editor
  configPath: string
  label:      string
}

// ── Detection ──────────────────────────────────────────────────

export function detectEditors(): DetectedEditor[] {
  const found: DetectedEditor[] = []
  const home = homedir()

  // Claude Code — user-scope config lives in ~/.claude.json
  // (not ~/.claude/mcp.json — that path is unread by Claude Code)
  const claudeJson = join(home, '.claude.json')
  const claudeDir  = join(home, '.claude')
  if (existsSync(claudeJson) || existsSync(claudeDir)) {
    found.push({ editor: 'claude-code', configPath: claudeJson, label: 'Claude Code' })
  }

  // Cursor — ~/.cursor/mcp.json
  const cursorPath = join(home, '.cursor', 'mcp.json')
  const cursorDir  = join(home, '.cursor')
  if (existsSync(cursorDir) || existsSync(cursorPath)) {
    found.push({ editor: 'cursor', configPath: cursorPath, label: 'Cursor' })
  }

  // VS Code + Copilot — check for .vscode in common locations
  // Copilot MCP config lives in VS Code user settings dir
  const vscodeSettings = getVSCodeSettingsPath()
  if (vscodeSettings) {
    found.push({ editor: 'copilot', configPath: vscodeSettings, label: 'GitHub Copilot (VS Code)' })
  }

  return found
}

function getVSCodeSettingsPath(): string | null {
  const home = homedir()
  const candidates = [
    join(home, '.vscode'),
    join(home, 'Library', 'Application Support', 'Code', 'User'),  // macOS
    join(home, '.config', 'Code', 'User'),                          // Linux
    join(home, 'AppData', 'Roaming', 'Code', 'User'),              // Windows
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      return join(p, 'mcp.json')
    }
  }
  return null
}

// ── MCP config writer ──────────────────────────────────────────

export interface McpWriteOptions {
  sensingMcpPath:  string
  controlMcpPath:  string
  anthropicKey:    string
  perceptionUrl:   string
  perceptionKey:   string
  planningUrl:     string
  planningKey:     string
  embeddingProvider: string
  embeddingKey:    string
  /** When false, drops robrain-control (OSS self-hosted — Control ships with Rory cloud only). Default true. */
  includeControl?: boolean
}

export function writeMcpConfig(configPath: string, opts: McpWriteOptions): void {
  // Read existing config if present.
  // Refuse to proceed on parse failure: configPath may be a shared file (e.g. ~/.claude.json
  // contains theme, projects, history) — overwriting it with `{ mcpServers: ... }` would
  // destroy unrelated user settings.
  let existing: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8')
    try {
      existing = JSON.parse(raw) as Record<string, unknown>
    } catch {
      throw new Error(
        `Refusing to overwrite ${configPath}: file exists but is not valid JSON. ` +
        `Fix or remove it manually, then re-run robrain install.`
      )
    }
  }

  const mcpServers = (existing.mcpServers as Record<string, unknown>) ?? {}

  const includeControl = opts.includeControl ?? true

  // Add / overwrite sensing (always)
  mcpServers['robrain-sensing'] = {
    command: 'node',
    args:    [opts.sensingMcpPath],
    env: {
      ANTHROPIC_API_KEY:  opts.anthropicKey,
      EMBEDDING_PROVIDER: opts.embeddingProvider,
      ...(opts.embeddingProvider === 'openai'  && { OPENAI_API_KEY:  opts.embeddingKey }),
      ...(opts.embeddingProvider === 'voyage'  && { VOYAGE_API_KEY:  opts.embeddingKey }),
      ...(opts.embeddingProvider === 'cohere'  && { COHERE_API_KEY:  opts.embeddingKey }),
      PERCEPTION_API_URL: opts.perceptionUrl,
      PERCEPTION_API_KEY: opts.perceptionKey,
    },
  }

  if (includeControl) {
    mcpServers['robrain-control'] = {
      command: 'node',
      args:    [opts.controlMcpPath],
      env: {
        PLANNING_API_URL:   opts.planningUrl,
        PLANNING_API_KEY:   opts.planningKey,
        PERCEPTION_API_URL: opts.perceptionUrl,
        PERCEPTION_API_KEY: opts.perceptionKey,
      },
    }
  } else {
    delete mcpServers['robrain-control']
  }

  const updated = { ...existing, mcpServers }

  // Ensure parent directory exists
  const dir = dirname(configPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf8')
}

// ── RoBrain instruction text (CLAUDE.md + Cursor rule) ───────

const ROBRAIN_MARKER_START = '<!-- robrain -->'
const ROBRAIN_MARKER_END   = '<!-- /robrain -->'
export type RoBrainInstructionMode = 'sensing-only' | 'sensing+control'

/** Shared body for CLAUDE.md and `.cursor/rules/robrain.mdc` (keep in sync). */
function roBrainInstructionsMarkdown(projectId: string, mode: RoBrainInstructionMode): string {
  if (mode === 'sensing-only') {
    return `## RoBrain — Context Management (OSS self-hosted)

This project uses RoBrain Sensing MCP for passive session capture.
Control MCP is not available in OSS self-hosted mode.
Call Sensing tools exactly as instructed to maintain session memory.

### Session start (mandatory, first thing in every new chat)
\`\`\`
sensing_start_session(project_id="${projectId}", session_id="<ISO-timestamp>-<4-random-chars>", working_dir="<cwd>")
\`\`\`
Store the returned session_id and initialize sequence=1 before your first reply.

### After every response (mandatory)
\`\`\`
sensing_record_turn(session_id="<stored session_id>", sequence=<n>, user_message="<full user message>", claude_reply="<full assistant reply>", files_touched=[...], injected_memory_ids=[])
\`\`\`
Increment sequence by 1 after each successful call.

If topic_shift=true is returned, note it for follow-up context retrieval.

### Session end (last thing)
\`\`\`
sensing_end_session(session_id="<stored session_id>", summary="one sentence: what was accomplished")
\`\`\`
`
  }

  return `## RoBrain — Context Management

This project uses RoBrain for persistent institutional memory across sessions.
Call these tools as instructed to maintain causal memory of decisions.

### Session start (every session, first thing)
\`\`\`
sensing_start_session(project_id="${projectId}", session_id="<ISO-timestamp>-<4-random-chars>", working_dir="<cwd>")
control_get_session_context(project_id="${projectId}", session_id="<same-id>")
\`\`\`
Inject the always_on_summary returned by control_get_session_context into your context.

### After every response
\`\`\`
sensing_record_turn(session_id=..., sequence=<n>, user_message=..., claude_reply=..., files_touched=[...], injected_memory_ids=[...])
\`\`\`
If topic_shift=true is returned, immediately call:
\`\`\`
control_inject_context(project_id="${projectId}", session_id=..., task_description=..., files_in_scope=[...])
\`\`\`

### When you need deeper context
\`\`\`
control_get_context(project_id="${projectId}", session_id=..., query=..., files_relevant=[...])
\`\`\`

### When prior context is wrong or outdated
\`\`\`
control_record_correction(session_id=..., decision_id=..., source="user_correction"|"claude_disagreement", invalidate=true)
\`\`\`

### When user adds a rule
\`\`\`
control_add_rule(project_id="${projectId}", rule="...", type="always_include"|"always_exclude"|"preference")
\`\`\`

### Session end (last thing)
\`\`\`
sensing_end_session(session_id=..., summary="one sentence: what was accomplished")
control_end_session(project_id="${projectId}", session_id=...)
\`\`\`

### Acknowledgement rule
When injected context contains a question marked ⚠, you must explicitly state
whether the constraint applies to the current task before proceeding.
`
}

function roBrainMarkedBlock(projectId: string, mode: RoBrainInstructionMode): string {
  return `${ROBRAIN_MARKER_START}
${roBrainInstructionsMarkdown(projectId, mode)}${ROBRAIN_MARKER_END}
`
}

// ── CLAUDE.md writer ───────────────────────────────────────────

export function writeClaudeMd(
  projectRoot: string,
  projectId: string,
  mode: RoBrainInstructionMode = 'sensing+control',
): void {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md')
  const canonicalBlock = roBrainMarkedBlock(projectId, mode)

  let existing = ''
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf8')
    const start = existing.indexOf(ROBRAIN_MARKER_START)
    const end   = existing.indexOf(ROBRAIN_MARKER_END, start)
    if (start !== -1 && end !== -1) {
      const endInclusive = end + ROBRAIN_MARKER_END.length
      const currentBlock = existing.slice(start, endInclusive)
      if (currentBlock === canonicalBlock) return
      const next =
        existing.slice(0, start).trimEnd() +
        '\n\n' +
        canonicalBlock +
        '\n\n' +
        existing.slice(endInclusive).trimStart()
      writeFileSync(claudeMdPath, next.trimEnd() + '\n', 'utf8')
      return
    }
    existing = existing.trimEnd() + '\n\n'
  }

  writeFileSync(claudeMdPath, existing + canonicalBlock + '\n', 'utf8')
}

/** Writes `.cursor/rules/robrain.mdc` when Cursor is used; skips if RoBrain block already present. Returns true if a new file was written. */
export function writeCursorRoBrainRule(
  projectRoot: string,
  projectId: string,
  mode: RoBrainInstructionMode = 'sensing+control',
): boolean {
  const rulePath = join(projectRoot, '.cursor', 'rules', 'robrain.mdc')

  if (existsSync(rulePath)) {
    const existing = readFileSync(rulePath, 'utf8')
    if (existing.includes(ROBRAIN_MARKER_START)) return false
  }

  const dir = dirname(rulePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const content = `---
description: RoBrain MCP — session lifecycle and context tools
alwaysApply: true
---

${roBrainMarkedBlock(projectId, mode)}`

  writeFileSync(rulePath, content, 'utf8')
  return true
}

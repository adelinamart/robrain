// src/lib/editor.ts
// ─────────────────────────────────────────────────────────────
// Detects which AI coding editors are installed and writes
// the appropriate MCP server configuration for each.
// Supported: Claude Code, Cursor, GitHub Copilot (VS Code), Codex CLI
// ─────────────────────────────────────────────────────────────
// ******ROBRAIN****

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'

export type Editor = 'claude-code' | 'cursor' | 'copilot' | 'codex' | 'unknown'

export const INSTALLABLE_EDITORS = ['claude-code', 'cursor', 'copilot', 'codex'] as const
export type InstallableEditor = (typeof INSTALLABLE_EDITORS)[number]

const EDITOR_LABELS: Record<InstallableEditor, string> = {
  'claude-code': 'Claude Code',
  'cursor':      'Cursor',
  'copilot':     'GitHub Copilot (VS Code)',
  'codex':       'Codex CLI',
}

export interface DetectedEditor {
  editor:     Editor
  configPath: string
  label:      string
}

/** Config file path for `robrain install --editor`, even when the editor was not auto-detected. */
export function editorConfigPath(editor: InstallableEditor): string | null {
  const home = homedir()
  switch (editor) {
    case 'claude-code': return join(home, '.claude.json')
    case 'cursor':      return join(home, '.cursor', 'mcp.json')
    case 'codex':       return join(home, '.codex', 'config.toml')
    case 'copilot':     return getVSCodeSettingsPath()
  }
}

/** Force a single editor entry for install when `--editor` is set but detection missed it. */
export function forceEditor(editor: string): DetectedEditor | null {
  if (!(INSTALLABLE_EDITORS as readonly string[]).includes(editor)) return null
  const id = editor as InstallableEditor
  const configPath = editorConfigPath(id)
  if (!configPath) return null
  return { editor: id, configPath, label: EDITOR_LABELS[id] }
}

/**
 * Resolve which editors to configure during install (non-interactive).
 * Interactive multiselect when several editors are detected stays in `install.ts`.
 */
export function resolveEditorsForInstall(opts: { editor?: string }): DetectedEditor[] {
  const detected = detectEditors()
  if (opts.editor) {
    const matched = detected.filter(e => e.editor === opts.editor)
    if (matched.length > 0) return matched
    const forced = forceEditor(opts.editor)
    return forced ? [forced] : []
  }
  if (detected.length === 0) {
    return [{
      editor:     'claude-code',
      configPath: join(homedir(), '.claude.json'),
      label:      'Claude Code',
    }]
  }
  return detected
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

  // Codex CLI — ~/.codex/config.toml
  const codexPath = join(home, '.codex', 'config.toml')
  const codexDir  = join(home, '.codex')
  if (existsSync(codexDir) || existsSync(codexPath)) {
    found.push({ editor: 'codex', configPath: codexPath, label: 'Codex CLI' })
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

export type LlmProvider = 'anthropic' | 'openai'

/** Reads LLM_PROVIDER; anything other than "openai" (case-insensitive) means Anthropic. */
export function resolveLlmProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  return env.LLM_PROVIDER?.trim().toLowerCase() === 'openai' ? 'openai' : 'anthropic'
}

// Mirrors @robrain/shared llm.ts — the CLI deliberately has no dependency on
// shared so a bare `npx robrain install` needs no workspace build.
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

export interface ResolveOpenAiBaseUrlFromEnvOptions {
  /** Prefer OPENAI_HOST_BASE_URL (Sensing/Synthesis / doctor on the host). */
  preferHost?: boolean
}

/** localhost → 127.0.0.1 (same contract as shared normalizeLoopbackUrl). */
function normalizeLoopbackUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1'
      return parsed.toString().replace(/\/$/, '')
    }
  } catch {
    // leave unparseable input as-is
  }
  return url
}

/**
 * Reads OPENAI_BASE_URL (or OPENAI_HOST_BASE_URL when preferHost), matching
 * shared's resolveOpenAiBaseUrl.
 */
export function resolveOpenAiBaseUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveOpenAiBaseUrlFromEnvOptions = {},
): string {
  const raw = options.preferHost
    ? (env.OPENAI_HOST_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim())
    : env.OPENAI_BASE_URL?.trim()
  if (!raw) return DEFAULT_OPENAI_BASE_URL
  return normalizeLoopbackUrl(raw.replace(/\/+$/, ''))
}

/** True when a local OpenAI-compatible server URL is configured (host or Docker). */
export function usingLocalOpenAi(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveOpenAiBaseUrlFromEnv(env, { preferHost: true }) !== DEFAULT_OPENAI_BASE_URL
}

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
  /** Default anthropic. When openai, Sensing needs LLM_PROVIDER + OPENAI_API_KEY in MCP env. */
  llmProvider?: LlmProvider
  /** OpenAI key for LLM when llmProvider is openai and embedding provider is not openai. */
  openaiKey?: string
  /** OPENAI_BASE_URL for Sensing (often host.docker.internal when Perception is in Docker). */
  openaiBaseUrl?: string
  /** OPENAI_HOST_BASE_URL for Sensing on the host (127.0.0.1). Sensing preferHost uses this first. */
  openaiHostBaseUrl?: string
  /** When false, drops robrain-control (OSS self-hosted — Control ships with Rory cloud only). Default true. */
  includeControl?: boolean
  /** Absolute dir of materialized Codex hook scripts — when set, the Codex TOML block also wires lifecycle hooks. */
  codexHooksDir?: string
  /**
   * Cloud thin-client mode: Sensing ships raw turns (needs_classification=true)
   * and classification runs server-side, so the env block carries only
   * ROBRAIN_MODE=cloud + Perception vars — no LLM or embedding keys.
   * Default false (self-hosted env stays byte-for-byte unchanged).
   */
  thin?: boolean
}

/** Env vars for robrain-sensing — shared by JSON MCP configs and Codex TOML. */
export function buildSensingMcpEnv(opts: McpWriteOptions): Record<string, string> {
  if (opts.thin) {
    return {
      ROBRAIN_MODE:       'cloud',
      PERCEPTION_API_URL: opts.perceptionUrl,
      PERCEPTION_API_KEY: opts.perceptionKey,
    }
  }

  const env: Record<string, string> = {
    ANTHROPIC_API_KEY:  opts.anthropicKey,
    EMBEDDING_PROVIDER: opts.embeddingProvider,
    PERCEPTION_API_URL: opts.perceptionUrl,
    PERCEPTION_API_KEY: opts.perceptionKey,
  }

  const llmProvider = opts.llmProvider ?? 'anthropic'
  if (llmProvider === 'openai') {
    env.LLM_PROVIDER = 'openai'
  }

  if (opts.embeddingProvider === 'voyage') env.VOYAGE_API_KEY = opts.embeddingKey
  if (opts.embeddingProvider === 'cohere') env.COHERE_API_KEY = opts.embeddingKey

  const needsOpenAi = opts.embeddingProvider === 'openai' || llmProvider === 'openai'
  if (needsOpenAi) {
    const openaiKey =
      opts.embeddingProvider === 'openai'
        ? opts.embeddingKey
        : (opts.openaiKey?.trim() ?? '')
    if (opts.openaiBaseUrl) env.OPENAI_BASE_URL = opts.openaiBaseUrl
    if (opts.openaiHostBaseUrl) env.OPENAI_HOST_BASE_URL = opts.openaiHostBaseUrl
    // Keyless is only valid against a local base URL — without one, keep
    // writing the (possibly empty) key so a misconfigured install stays visible.
    const hasLocalUrl = Boolean(opts.openaiBaseUrl || opts.openaiHostBaseUrl)
    if (openaiKey || !hasLocalUrl) env.OPENAI_API_KEY = openaiKey
  }

  return env
}

export function writeMcpConfig(configPath: string, opts: McpWriteOptions): void {
  // Codex CLI uses TOML at ~/.codex/config.toml — handled in a separate writer
  // because the file can contain unrelated TOML (model selection, sandbox prefs,
  // user-managed MCP entries) we must not lose.
  if (configPath.endsWith('.toml')) {
    writeCodexMcpConfig(configPath, opts)
    return
  }

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
    env:     buildSensingMcpEnv(opts),
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

// ── Codex MCP TOML writer ──────────────────────────────────────
//
// Codex CLI reads ~/.codex/config.toml (top-level + [mcp_servers.<name>]
// sections). The file can also contain unrelated user settings (model
// selection, sandbox prefs, user MCP servers), so we splice a marker-bounded
// block in/out instead of parsing the whole file — same approach as CLAUDE.md.

const CODEX_BLOCK_START = '# <!-- robrain -->'
const CODEX_BLOCK_END   = '# <!-- /robrain -->'

function tomlString(s: string): string {
  return `"${s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

/** @internal Exported for unit tests. */
export function renderCodexBlock(opts: McpWriteOptions): string {
  const includeControl = opts.includeControl ?? true
  const sensingEnv = buildSensingMcpEnv(opts)

  const lines: string[] = []
  lines.push(CODEX_BLOCK_START)
  lines.push('# Managed by `robrain install` — do not edit between the markers.')
  lines.push('')
  lines.push('[mcp_servers.robrain-sensing]')
  lines.push(`command = ${tomlString('node')}`)
  lines.push(`args = [${tomlString(opts.sensingMcpPath)}]`)
  lines.push('enabled = true')
  lines.push('')
  lines.push('[mcp_servers.robrain-sensing.env]')
  for (const [k, v] of Object.entries(sensingEnv)) {
    lines.push(`${k} = ${tomlString(v)}`)
  }

  if (includeControl) {
    lines.push('')
    lines.push('[mcp_servers.robrain-control]')
    lines.push(`command = ${tomlString('node')}`)
    lines.push(`args = [${tomlString(opts.controlMcpPath)}]`)
    lines.push('enabled = true')
    lines.push('')
    lines.push('[mcp_servers.robrain-control.env]')
    lines.push(`PLANNING_API_URL = ${tomlString(opts.planningUrl)}`)
    lines.push(`PLANNING_API_KEY = ${tomlString(opts.planningKey)}`)
    lines.push(`PERCEPTION_API_URL = ${tomlString(opts.perceptionUrl)}`)
    lines.push(`PERCEPTION_API_KEY = ${tomlString(opts.perceptionKey)}`)
  }

  // Lifecycle hooks — Codex's hook contract is Claude-compatible (same stdin,
  // same hookSpecificOutput.additionalContext), so these run the same scripts
  // as the Claude Code plugin, materialized under ~/.robrain/hooks/codex.
  // Codex prompts the user to trust the hooks on first run.
  if (opts.codexHooksDir) {
    const script = (name: string) => tomlString(`node "${join(opts.codexHooksDir!, name)}"`)
    lines.push('')
    lines.push('[[hooks.SessionStart]]')
    lines.push('[[hooks.SessionStart.hooks]]')
    lines.push('type = "command"')
    lines.push(`command = ${script('session-start.mjs')}`)
    lines.push('timeout = 10')
    lines.push(`statusMessage = ${tomlString('Loading RoBrain project memory')}`)
    lines.push('')
    lines.push('[[hooks.UserPromptSubmit]]')
    lines.push('[[hooks.UserPromptSubmit.hooks]]')
    lines.push('type = "command"')
    lines.push(`command = ${script('user-prompt-submit.mjs')}`)
    lines.push('timeout = 10')
    lines.push(`statusMessage = ${tomlString('Checking RoBrain for rejected approaches')}`)
    lines.push('')
    lines.push('[[hooks.Stop]]')
    lines.push('[[hooks.Stop.hooks]]')
    lines.push('type = "command"')
    lines.push(`command = ${script('stop.mjs')}`)
    lines.push('timeout = 30')
    lines.push('async = true')
  }

  lines.push(CODEX_BLOCK_END)
  return lines.join('\n')
}

export function writeCodexMcpConfig(configPath: string, opts: McpWriteOptions): void {
  const block = renderCodexBlock(opts)

  const dir = dirname(configPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  let existing = ''
  if (existsSync(configPath)) {
    existing = readFileSync(configPath, 'utf8')
    const start = existing.indexOf(CODEX_BLOCK_START)
    const end   = existing.indexOf(CODEX_BLOCK_END, start)
    if (start !== -1 && end !== -1) {
      const endInclusive = end + CODEX_BLOCK_END.length
      const next =
        existing.slice(0, start).trimEnd() +
        '\n\n' +
        block +
        '\n\n' +
        existing.slice(endInclusive).trimStart()
      writeFileSync(configPath, next.trimEnd() + '\n', 'utf8')
      return
    }
    existing = existing.trimEnd() + '\n\n'
  }

  writeFileSync(configPath, existing + block + '\n', 'utf8')
}

// ── RoBrain instruction text (CLAUDE.md, AGENTS.md, Cursor rule) ─

const ROBRAIN_MARKER_START = '<!-- robrain -->'
const ROBRAIN_MARKER_END   = '<!-- /robrain -->'

/** Control tools removed 2026-07-23 — an instruction block naming any of these is stale. */
export const REMOVED_CONTROL_TOOLS = [
  'control_get_session_context',
  'control_inject_context',
  'control_add_rule',
  'control_end_session',
] as const

/**
 * True when a project instruction file references a Control tool that no longer
 * exists. Intended for AGENTS.md / CLAUDE.md / `.cursor/rules/robrain.mdc`.
 *
 * Scan scope:
 * - Marked block present (start+end): only the marker-bounded region (changelog
 *   mentions outside the block are never false positives).
 * - Start marker without end: from start to EOF (broken managed block — still warn).
 * - No markers: whole file (legacy blocks written before markers existed).
 */
export function roBrainBlockReferencesRemovedTools(fileContent: string): boolean {
  const start = fileContent.indexOf(ROBRAIN_MARKER_START)
  if (start !== -1) {
    const end = fileContent.indexOf(ROBRAIN_MARKER_END, start)
    const block = end === -1
      ? fileContent.slice(start)
      : fileContent.slice(start, end + ROBRAIN_MARKER_END.length)
    return REMOVED_CONTROL_TOOLS.some(t => block.includes(t))
  }
  return REMOVED_CONTROL_TOOLS.some(t => fileContent.includes(t))
}
export type RoBrainInstructionMode = 'sensing-only' | 'sensing+control'

/** Shared body for CLAUDE.md, AGENTS.md, and `.cursor/rules/robrain.mdc` (keep in sync). */
function roBrainInstructionsMarkdown(projectId: string, mode: RoBrainInstructionMode): string {
  if (mode === 'sensing-only') {
    return `## RoBrain — Context Management (OSS self-hosted)

This project uses RoBrain Sensing MCP for passive session capture.
Control MCP is not available in OSS self-hosted mode.
Call Sensing tools exactly as instructed to maintain session memory.

### Session start (mandatory, first thing in every new chat)
\`\`\`
sensing_start_session(project_id="${projectId}")
\`\`\`
Use the session_id from the tool response (or pass your own unique id per chat). Initialize sequence=1 before your first reply.

### After every response (mandatory)
\`\`\`
sensing_record_turn(session_id="<stored session_id>", sequence=<n>, user_message="<full user message>", claude_reply="<full assistant reply>", files_touched=[...], injected_memory_ids=[])
\`\`\`
The \`claude_reply\` parameter is the MCP field name for your full assistant reply (any editor).
Increment sequence by 1 after each successful call.

If topic_shift=true is returned, note it for follow-up context retrieval.

### Session end (last thing)
\`\`\`
sensing_end_session(session_id="<stored session_id>", summary="one sentence: what was accomplished")
\`\`\`
`
  }

  return `## RoBrain — Context Management (Rory Plans cloud)

This project uses RoBrain for persistent institutional memory across sessions:
**Sensing** captures your turns, **Control** injects prior decisions and pre-task
veto warnings. Pass \`project_id="${projectId}"\` on every Control call (it is your
registered project id — do not substitute a guess or the repo name).

### Session start (mandatory, first thing in every new chat)
\`sensing_start_session\` returns a \`session_id\` — reuse it on every call below.
\`\`\`
sensing_start_session(project_id="${projectId}")
control_get_context(project_id="${projectId}", task_description="session start - project overview", session_id="<session_id from sensing_start_session>")
\`\`\`
Inject the block control_get_context returns into your context.

### After every response (mandatory)
\`\`\`
sensing_record_turn(session_id="<stored session_id>", sequence=<n>, user_message="<full user message>", claude_reply="<full assistant reply>", files_touched=[...], injected_memory_ids=[...])
\`\`\`
(\`claude_reply\` is the required MCP parameter name for the assistant reply.)
If topic_shift=true is returned, call control_get_context again for the new task.

### At every task boundary (new task, plan step, or topic shift)
\`\`\`
control_get_context(project_id="${projectId}", task_description="<what you are about to do>", files=[...], session_id="<stored session_id>")
\`\`\`

### Before implementing any architectural or design choice
\`\`\`
control_check_task(project_id="${projectId}", proposed_approach="<the choice, one sentence>", files=[...])
\`\`\`

### When the user confirms, rejects, or corrects a surfaced decision
\`\`\`
control_record_correction(decision_id="<id from an injected memory or verdict>", action="approve"|"invalidate"|"edit", corrected_decision="...", corrected_rationale="...")
\`\`\`

### After a reply that followed an injection (closes the effectiveness loop)
\`\`\`
control_report_reply(session_id="<stored session_id>", sequence=<n>, reply_text="<full assistant reply>")
\`\`\`

### Session end (last thing)
\`\`\`
sensing_end_session(session_id="<stored session_id>", summary="one sentence: what was accomplished")
\`\`\`

### Acknowledgement rule
When a control_get_context or control_check_task result leads with "⚠ ACKNOWLEDGEMENT
REQUIRED", present the warning to the user verbatim, ask for explicit confirmation,
and do NOT proceed with the conflicting approach until the user responds.
`
}

function roBrainMarkedBlock(projectId: string, mode: RoBrainInstructionMode): string {
  return `${ROBRAIN_MARKER_START}
${roBrainInstructionsMarkdown(projectId, mode)}${ROBRAIN_MARKER_END}
`
}

// ── CLAUDE.md / AGENTS.md writers ──────────────────────────────

function upsertRoBrainMarkdownBlock(filePath: string, canonicalBlock: string): void {
  let existing = ''
  if (existsSync(filePath)) {
    existing = readFileSync(filePath, 'utf8')
    const start = existing.indexOf(ROBRAIN_MARKER_START)
    const end   = existing.indexOf(ROBRAIN_MARKER_END, start)
    if (start !== -1 && end !== -1) {
      const endInclusive = end + ROBRAIN_MARKER_END.length
      const currentBlock = existing.slice(start, endInclusive)
      if (currentBlock.trimEnd() === canonicalBlock.trimEnd()) return
      const next =
        existing.slice(0, start).trimEnd() +
        '\n\n' +
        canonicalBlock +
        '\n\n' +
        existing.slice(endInclusive).trimStart()
      writeFileSync(filePath, next.trimEnd() + '\n', 'utf8')
      return
    }
    existing = existing.trimEnd() + '\n\n'
  }

  writeFileSync(filePath, existing + canonicalBlock + '\n', 'utf8')
}

export function writeClaudeMd(
  projectRoot: string,
  projectId: string,
  mode: RoBrainInstructionMode = 'sensing+control',
): void {
  upsertRoBrainMarkdownBlock(
    join(projectRoot, 'CLAUDE.md'),
    roBrainMarkedBlock(projectId, mode),
  )
}

/** Writes/updates `AGENTS.md` at the project root (Codex CLI and other AGENTS.md clients). Same managed block as CLAUDE.md. */
export function writeAgentsMd(
  projectRoot: string,
  projectId: string,
  mode: RoBrainInstructionMode = 'sensing+control',
): void {
  upsertRoBrainMarkdownBlock(
    join(projectRoot, 'AGENTS.md'),
    roBrainMarkedBlock(projectId, mode),
  )
}

/** Writes `.cursor/rules/robrain.mdc` when Cursor is used. Replaces any existing RoBrain block in place; appends if markers are missing; creates the file (with frontmatter) if absent. Returns true when the file is written or updated. */
export function writeCursorRoBrainRule(
  projectRoot: string,
  projectId: string,
  mode: RoBrainInstructionMode = 'sensing+control',
): boolean {
  const rulePath = join(projectRoot, '.cursor', 'rules', 'robrain.mdc')
  const canonicalBlock = roBrainMarkedBlock(projectId, mode)

  if (existsSync(rulePath)) {
    const existing = readFileSync(rulePath, 'utf8')
    const start = existing.indexOf(ROBRAIN_MARKER_START)
    const end   = existing.indexOf(ROBRAIN_MARKER_END, start)
    if (start !== -1 && end !== -1) {
      const endInclusive = end + ROBRAIN_MARKER_END.length
      const currentBlock = existing.slice(start, endInclusive)
      if (currentBlock.trimEnd() === canonicalBlock.trimEnd()) return false
      const next =
        existing.slice(0, start).trimEnd() +
        '\n\n' +
        canonicalBlock +
        '\n\n' +
        existing.slice(endInclusive).trimStart()
      writeFileSync(rulePath, next.trimEnd() + '\n', 'utf8')
      return true
    }
    const next = existing.trimEnd() + '\n\n' + canonicalBlock
    writeFileSync(rulePath, next.trimEnd() + '\n', 'utf8')
    return true
  }

  const dir = dirname(rulePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const content = `---
description: RoBrain MCP — session lifecycle and context tools
alwaysApply: true
---

${canonicalBlock}`

  writeFileSync(rulePath, content, 'utf8')
  return true
}

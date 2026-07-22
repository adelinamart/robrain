// plugins/claude-code/hooks/lib.mjs
// ─────────────────────────────────────────────────────────────
// Shared plumbing for RoBrain Claude Code plugin hooks.
//
// Design constraints:
//  - Zero dependencies, Node >= 18 (built-in fetch). Hooks must start fast.
//  - Fail-open ALWAYS: a dead Perception, missing config, or timeout must
//    never block or break the user's Claude Code session. Hooks print nothing
//    and exit 0 on any failure.
//  - Thin client: raw turns go to Perception POST /signals with
//    needs_classification=true — classification/extraction/dedup happen
//    server-side, so this plugin (and future Codex/Cursor ports) stays dumb.
// ─────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Read all of stdin (the hook input JSON). */
export async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

export function parseHookInput(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * localhost → 127.0.0.1: Node 17+ resolves localhost IPv6-first (::1) but the
 * Docker stack only binds 127.0.0.1; old configs may still carry localhost.
 */
function normalizeLoopbackUrl(url) {
  try {
    const u = new URL(url)
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1'
      return u.toString().replace(/\/$/, '')
    }
  } catch {
    // not a parseable URL — leave as-is
  }
  return url
}

/**
 * Perception connection: env wins, then ~/.robrain/config.json (written by
 * `robrain up` / `robrain install`), then loopback default.
 */
export function loadPerception() {
  let url = process.env.PERCEPTION_URL?.trim() || ''
  let key = process.env.PERCEPTION_API_KEY?.trim() || ''
  if (!url || !key) {
    try {
      const cfg = JSON.parse(readFileSync(join(homedir(), '.robrain', 'config.json'), 'utf8'))
      if (!url && typeof cfg.perceptionUrl === 'string') url = cfg.perceptionUrl.trim()
      if (!key && typeof cfg.perceptionKey === 'string') key = cfg.perceptionKey.trim()
    } catch {
      // no config yet — fall through to defaults
    }
  }
  return { url: normalizeLoopbackUrl(url || 'http://127.0.0.1:3001'), key }
}

/**
 * Same derivation as the CLI (packages/cli/src/lib/project.ts): prefer the
 * project_id init-project wrote into CLAUDE.md / AGENTS.md / the Cursor rule,
 * else a stable hash of the working directory.
 */
export function resolveProjectId(cwd) {
  for (const rel of ['CLAUDE.md', 'AGENTS.md', join('.cursor', 'rules', 'robrain.mdc')]) {
    const p = join(cwd, rel)
    try {
      if (!existsSync(p)) continue
      const match = readFileSync(p, 'utf8').match(/project_id="([^"]+)"/)
      if (match?.[1]) return match[1].trim()
    } catch {
      // unreadable file — try the next candidate
    }
  }
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

/** fetch with a hard timeout; returns null instead of throwing. */
export async function perceptionFetch(path, { url, key }, init = {}, timeoutMs = 2500) {
  try {
    const res = await fetch(`${url}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Extract the trailing turn from a Claude Code transcript (JSONL): the last
 * user text message and every assistant text block after it, plus file paths
 * touched by Edit/Write/NotebookEdit tool calls in that span.
 */
export function extractLastTurn(transcriptPath) {
  let lines
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean)
  } catch {
    return null
  }

  let lastUserIdx = -1
  const entries = []
  for (const line of lines) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    entries.push(e)
  }

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.type === 'user' && !e.isMeta && typeof textOf(e.message?.content) === 'string' && textOf(e.message.content).trim()) {
      // Skip tool_result-only user entries (tool outputs come back as user role)
      if (hasOnlyToolResults(e.message?.content)) continue
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) return null

  const userMessage = textOf(entries[lastUserIdx].message?.content) ?? ''
  const replyParts = []
  const filesTouched = new Set()

  for (let i = lastUserIdx + 1; i < entries.length; i++) {
    const e = entries[i]
    if (e.type !== 'assistant') continue
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'text' && block.text?.trim()) replyParts.push(block.text)
      if (block.type === 'tool_use') {
        const fp = block.input?.file_path ?? block.input?.notebook_path
        if (typeof fp === 'string' && fp) filesTouched.add(fp)
      }
    }
  }

  if (!userMessage.trim() || replyParts.length === 0) return null

  // Sequence: number of user-authored messages up to and including this one —
  // stable across re-reads of the same transcript.
  let sequence = 0
  for (let i = 0; i <= lastUserIdx; i++) {
    const e = entries[i]
    if (e.type === 'user' && !e.isMeta && !hasOnlyToolResults(e.message?.content) && textOf(e.message?.content)?.trim()) sequence++
  }

  return {
    userMessage,
    claudeReply: replyParts.join('\n\n'),
    filesTouched: [...filesTouched].slice(0, 50),
    sequence: Math.max(1, sequence),
  }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n')
  }
  return null
}

function hasOnlyToolResults(content) {
  return Array.isArray(content) && content.length > 0 && content.every(b => b.type === 'tool_result')
}

// ── Session-scoped warning state ──────────────────────────────
// The same veto re-injected on every on-topic prompt is context spend for
// zero new information — Control must never cost more context than it saves.

const STATE_DIR = join(homedir(), '.robrain', 'state')

function warnedFile(sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return join(STATE_DIR, `cc-warned-${safe}.json`)
}

/** Decision ids already warned about in this session. */
export function loadWarnedIds(sessionId) {
  if (!sessionId) return new Set()
  try {
    const ids = JSON.parse(readFileSync(warnedFile(sessionId), 'utf8'))
    return new Set(Array.isArray(ids) ? ids : [])
  } catch {
    return new Set()
  }
}

export function recordWarnedIds(sessionId, ids) {
  if (!sessionId || ids.length === 0) return
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const merged = [...new Set([...loadWarnedIds(sessionId), ...ids])].slice(-200)
    writeFileSync(warnedFile(sessionId), JSON.stringify(merged))
    cleanupStateDir()
  } catch {
    // fail-open — a broken state file must never block the session
  }
}

/** Best-effort hygiene: drop state files older than 7 days. */
function cleanupStateDir() {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const f of readdirSync(STATE_DIR)) {
      const p = join(STATE_DIR, f)
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
      } catch {
        // race or permissions — skip
      }
    }
  } catch {
    // dir unreadable — skip
  }
}

// ── Per-session prompt stash ──────────────────────────────────
// Written by the UserPromptSubmit hook, read by stop hooks that cannot rely
// on a parseable transcript (Codex ships last_assistant_message on Stop stdin
// but its transcript format is not a contract we own). Pairing the stashed
// prompt with that message gives deterministic capture with zero transcript
// assumptions.

function stashFile(sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  return join(STATE_DIR, `stash-${safe}.json`)
}

export function stashPrompt(sessionId, prompt) {
  if (!sessionId || !prompt) return
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const prev = loadPromptStash(sessionId)
    writeFileSync(stashFile(sessionId), JSON.stringify({
      prompt: prompt.slice(0, 60_000),
      sequence: (prev?.sequence ?? 0) + 1,
    }))
  } catch {
    // fail-open
  }
}

export function loadPromptStash(sessionId) {
  if (!sessionId) return null
  try {
    const s = JSON.parse(readFileSync(stashFile(sessionId), 'utf8'))
    return typeof s?.prompt === 'string' ? s : null
  } catch {
    return null
  }
}

/** Emit hook JSON output (context injection) and exit 0. */
export function emitContext(hookEventName, additionalContext) {
  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName, additionalContext },
    }))
  }
  process.exit(0)
}

/** Silent success — hooks must never fail the session. */
export function exitSilently() {
  process.exit(0)
}

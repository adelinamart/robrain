#!/usr/bin/env node
// packages/sensing-mcp/src/index.ts
// ─────────────────────────────────────────────────────────────
// Sensing MCP server — entry point.
// Exposes four tools to Claude Code via stdio transport.
// ─────────────────────────────────────────────────────────────

import { randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadEnv, redactSecrets, totalRedactions, type SessionTurn } from '@robrain/shared'

// `.env` is the single source of truth for API keys; values there override anything
// already in process.env (including the env block injected from ~/.claude.json),
// which only acts as a fallback for keys missing from `.env`.
loadEnv()

// Stdio MCP must stay alive — log and continue rather than exit on stray rejections.
process.on('unhandledRejection', reason => {
  console.error('[Sensing] Unhandled rejection (process kept alive):', reason)
})
process.on('uncaughtException', err => {
  console.error('[Sensing] Uncaught exception (process kept alive):', err)
})

const { streamBuffer } = await import('./buffer.js')
const {
  classifyDecision,
  classifyTopicShift,
  getLastClassifierFailure,
  scoreReply,
  clearSessionEmbeddings,
} = await import('./classifiers/index.js')
const {
  routeDecisionSignal,
  routeReplyScore,
  routeFlushTurns,
} = await import('./router.js')
const { config } = await import('./config.js')

// ── Active session registry ────────────────────────────────

interface ActiveSession {
  project_id:  string
  started_at:  Date
  turn_count:  number
}
const activeSessions = new Map<string, ActiveSession>()

/** Last Perception POST /signals failure for diagnostics (sensing_get_status). */
let lastDecisionShipFailure: string | null = null

function generateSessionId(): string {
  return `${new Date().toISOString()}-${randomBytes(2).toString('hex')}`
}

function resolveSessionId(raw: string | null | undefined): string {
  if (raw == null) return generateSessionId()
  const t = raw.trim()
  return t.length > 0 ? t : generateSessionId()
}

// ── MCP Server setup ───────────────────────────────────────

const server = new McpServer({
  name:    'sensing-mcp',
  version: '2.0.0',
})

// ─────────────────────────────────────────────────────────────
// TOOL 1 — sensing_start_session
// Called once when a new Claude Code session opens.
// Warms the embedding model and fetches the always-on summary.
// ─────────────────────────────────────────────────────────────

server.tool(
  'sensing_start_session',
  'Signal the start of a new Claude Code session. Call this once at the beginning of every session. Returns the always-on project summary to inject into your context. session_id may be omitted or empty — the server generates a unique id and returns it (use that id for sensing_record_turn and sensing_end_session).',
  {
    project_id:  z.string().describe('Repository name or path hash identifying the project'),
    session_id:  z.string().nullish().describe(
      'Unique id for this session. Omit, use null, or "" to let the server generate one (recommended). Otherwise supply a fresh id per chat (e.g. ISO timestamp + 4 hex chars).',
    ),
    working_dir: z.string().describe('Absolute path to the project root directory'),
  },
  async ({ project_id, session_id, working_dir }) => {
    const sessionId = resolveSessionId(session_id)

    activeSessions.set(sessionId, {
      project_id,
      started_at: new Date(),
      turn_count:  0,
    })

    // TODO: fetch always_on_summary from projects table via Perception API
    // For now, return placeholder until Perception is wired
    const summaryResult = await fetchAlwaysOnSummary(project_id)

    console.error(`[Sensing] Session started: ${sessionId} (${project_id}) @ ${working_dir}`)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: summaryResult.registrationError ? 'project_not_registered' : 'ready',
          session_id: sessionId,
          project_id,
          always_on_summary: summaryResult.text,
          ...(summaryResult.registrationError
            ? { perception_error: summaryResult.registrationError }
            : {}),
        }),
      }],
    }
  }
)

// ─────────────────────────────────────────────────────────────
// TOOL 2 — sensing_record_turn
// Called after every user + Claude exchange.
// Returns immediately (buffer write is synchronous).
// topic_shift is the only result computed inline.
// ─────────────────────────────────────────────────────────────

server.tool(
  'sensing_record_turn',
  'Record a completed conversation turn (user message + Claude reply). Call this after every exchange. Returns whether a topic shift was detected — if true, call your context injection tool.',
  {
    session_id:       z.string().describe('Session identifier from sensing_start_session'),
    sequence:         z.number().int().describe('Turn number within the session, starting at 1'),
    user_message:     z.string().describe('The full user message text'),
    claude_reply:     z.string().describe('The full Claude reply text'),
    files_touched:    z.array(z.string()).default([]).describe('Files read or modified during this turn'),
    injected_memory_ids: z.array(z.string()).default([]).describe('IDs of memories Control injected before this turn, for feedback scoring'),
  },
  async ({ session_id, sequence, user_message, claude_reply, files_touched, injected_memory_ids }) => {
    const session = activeSessions.get(session_id)
    if (!session) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Session not found. Call sensing_start_session first.' }),
        }],
      }
    }

    // ── Secrets redaction at capture — before anything is buffered,
    // embedded, classified, or shipped to Perception.
    const redactedUser  = redactSecrets(user_message)
    const redactedReply = redactSecrets(claude_reply)
    const secretsRedacted =
      totalRedactions(redactedUser.redactions) + totalRedactions(redactedReply.redactions)
    if (secretsRedacted > 0) {
      console.error(`[Sensing] Redacted ${secretsRedacted} secret(s) from turn ${sequence} before buffering`)
    }

    const turn: SessionTurn = {
      session_id,
      sequence,
      user_message: redactedUser.text,
      claude_reply: redactedReply.text,
      files_touched,
      timestamp: new Date().toISOString(),
    }

    // ── Layer A: buffer immediately (synchronous) ──────────
    streamBuffer.push(turn)
    session.turn_count++

    // ── Topic shift: embedding delta (inline, capped so MCP does not hang on retries) ──
    let topicShift = false
    let taskDescription: string | null = null

    try {
      const topicShiftAbort = AbortSignal.timeout(config.topicShiftInlineTimeoutMs)
      const shiftSignal = await withTimeout(
        classifyTopicShift(turn, topicShiftAbort),
        config.topicShiftInlineTimeoutMs,
        null,
      )
      if (shiftSignal) {
        topicShift      = true
        taskDescription = shiftSignal.task_description
      }
    } catch (err) {
      // Embedding failure degrades gracefully — no shift detected
      console.error('[Sensing] Topic shift classifier error:', err)
    }

    // ── Layer B: decision classifier + Perception (background — do not block MCP) ──
    const projectId = session.project_id
    setImmediate(async () => {
      try {
        const decisionSignal = await classifyDecision(turn, projectId)
        if (decisionSignal) {
          const outcome = await routeDecisionSignal(decisionSignal, projectId)
          if (outcome.persisted) {
            lastDecisionShipFailure = null
            streamBuffer.markClassified(session_id, sequence)
          } else {
            lastDecisionShipFailure =
              outcome.userFacing ??
              `${session_id} seq ${sequence}: Perception did not persist signal (see Sensing stderr / Perception logs)`
          }
        }
      } catch (err) {
        console.error('[Sensing] Decision classifier error:', err)
      }
    })

    // Reply scorer — non-blocking
    if (injected_memory_ids.length > 0) {
      setImmediate(async () => {
        try {
          await routeReplyScore({
            session_id:          turn.session_id,
            sequence:            turn.sequence,
            injected_memory_ids: injected_memory_ids,
            term_match_score:    0,
            final_score:         0,
            // Already redacted above — Perception judges usage against this
            // directly instead of a session_turns row that never exists.
            claude_reply:        turn.claude_reply,
          })
        } catch (err) {
          console.error('[Sensing] Reply scorer error:', err)
        }
      })
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          buffered:         true,
          topic_shift:      topicShift,
          task_description: taskDescription,
          secrets_redacted: secretsRedacted,
          sequence,
        }),
      }],
    }
  }
)

// ─────────────────────────────────────────────────────────────
// TOOL 3 — sensing_end_session
// Called when the session closes.
// Triggers flush-on-close: ships unclassified turns to Perception.
// ─────────────────────────────────────────────────────────────

server.tool(
  'sensing_end_session',
  'Signal the end of a Claude Code session. Triggers the flush-on-close hook to ship any unclassified buffered turns to Perception before the session closes.',
  {
    session_id: z.string().describe('Session identifier from sensing_start_session'),
    summary:    z.string().optional().describe('Optional brief summary of what was accomplished this session'),
  },
  async ({ session_id, summary }) => {
    const session = activeSessions.get(session_id)
    if (!session) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Session not found.' }),
        }],
      }
    }

    // ── Flush-on-close: return immediately; ship turns in the background ──
    const unclassified = streamBuffer.flush(session_id)
    const flushed = unclassified.length
    const projectId = session.project_id

    void routeFlushTurns(unclassified, projectId)
      .then(errors => {
        if (errors.length) {
          console.error('[Sensing] Flush-on-close errors:', errors.join('; '))
        }
      })
      .catch(err => console.error('[Sensing] Flush-on-close failed:', err))

    activeSessions.delete(session_id)
    clearSessionEmbeddings(session_id)

    console.error(`[Sensing] Session ended: ${session_id} — flushing ${flushed} turn(s) in background`)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_id,
          flushed,
          pending: flushed,
          summary: summary ?? null,
        }),
      }],
    }
  }
)

// ─────────────────────────────────────────────────────────────
// TOOL 4 — sensing_get_status
// Debug / health check. Shows buffer state for a session.
// ─────────────────────────────────────────────────────────────

server.tool(
  'sensing_get_status',
  'Get the current status of the Sensing buffer for a session. Useful for debugging.',
  {
    session_id: z.string().describe('Session identifier'),
  },
  async ({ session_id }) => {
    const session = activeSessions.get(session_id)
    const bufferStats = streamBuffer.stats(session_id)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_found:    !!session,
          project_id:       session?.project_id,
          started_at:       session?.started_at,
          turn_count:       session?.turn_count ?? 0,
          buffer_size:      bufferStats.total,
          unclassified:     bufferStats.unclassified,
          last_decision_ship_failure: lastDecisionShipFailure,
          last_classifier_failure: getLastClassifierFailure(),
          perception_url:   config.perceptionApiUrl,
          embedding_provider: config.embedding.provider,
          topic_shift_embeddings_disabled: config.topicShiftDisableEmbedding,
        }),
      }],
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  // Promise.race abandons the loser — attach .catch so a late reject cannot crash the process.
  promise.catch(err => {
    console.error('[Sensing] Suppressed late rejection after timeout:', err)
  })
  return Promise.race([
    promise,
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ])
}

async function fetchAlwaysOnSummary(projectId: string): Promise<{
  text: string
  registrationError?: string
}> {
  if (!config.perceptionApiUrl) {
    return {
      text: `Project: ${projectId}. No summary yet — will be populated after first session completes.`,
    }
  }
  try {
    const res = await fetch(
      `${config.perceptionApiUrl}/projects/${projectId}/summary`,
      {
        headers: { Authorization: `Bearer ${config.perceptionApiKey}` },
        signal: AbortSignal.timeout(config.fetchTimeoutMs),
      },
    )
    const raw = await res.text()
    if (!res.ok) {
      let msg = `Could not load summary for project_id ${projectId} (HTTP ${res.status}).`
      try {
        const j = JSON.parse(raw) as { message?: string; hint?: string }
        if (j.message || j.hint) msg = [j.message, j.hint].filter(Boolean).join(' ')
      } catch { /* use generic */ }
      console.error('[Sensing] always-on summary fetch failed:', res.status, raw.slice(0, 500))
      return {
        text:              `Project: ${projectId}`,
        registrationError: msg,
      }
    }
    const data = JSON.parse(raw) as { always_on_summary?: string }
    return { text: data.always_on_summary ?? `Project: ${projectId}` }
  } catch (err) {
    console.error('[Sensing] always-on summary fetch error:', err)
    return { text: `Project: ${projectId}` }
  }
}

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[Sensing] MCP server running — waiting for Claude Code')

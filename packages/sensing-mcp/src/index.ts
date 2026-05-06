#!/usr/bin/env node
// packages/sensing-mcp/src/index.ts
// ─────────────────────────────────────────────────────────────
// Sensing MCP server — entry point.
// Exposes four tools to Claude Code via stdio transport.
// ─────────────────────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { loadEnv, type SessionTurn } from '@robrain/shared'

// `.env` is the single source of truth for API keys; values there override anything
// already in process.env (including the env block injected from ~/.claude.json),
// which only acts as a fallback for keys missing from `.env`.
loadEnv()

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

// ── MCP Server setup ───────────────────────────────────────

const server = new McpServer({
  name:    'sensing-mcp',
  version: '0.1.0',
})

// ─────────────────────────────────────────────────────────────
// TOOL 1 — sensing_start_session
// Called once when a new Claude Code session opens.
// Warms the embedding model and fetches the always-on summary.
// ─────────────────────────────────────────────────────────────

server.tool(
  'sensing_start_session',
  'Signal the start of a new Claude Code session. Call this once at the beginning of every session. Returns the always-on project summary to inject into your context.',
  {
    project_id:  z.string().describe('Repository name or path hash identifying the project'),
    session_id:  z.string().describe('Unique identifier for this session (e.g. timestamp + random)'),
    working_dir: z.string().describe('Absolute path to the project root directory'),
  },
  async ({ project_id, session_id, working_dir }) => {
    activeSessions.set(session_id, {
      project_id,
      started_at: new Date(),
      turn_count:  0,
    })

    // TODO: fetch always_on_summary from projects table via Perception API
    // For now, return placeholder until Perception is wired
    const alwaysOnSummary = await fetchAlwaysOnSummary(project_id)

    console.error(`[Sensing] Session started: ${session_id} (${project_id}) @ ${working_dir}`)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status:            'ready',
          session_id,
          project_id,
          always_on_summary: alwaysOnSummary,
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

    const turn: SessionTurn = {
      session_id,
      sequence,
      user_message,
      claude_reply,
      files_touched,
      timestamp: new Date().toISOString(),
    }

    // ── Layer A: buffer immediately (synchronous) ──────────
    streamBuffer.push(turn)
    session.turn_count++

    // ── Topic shift: embedding delta (fast, inline) ────────
    let topicShift = false
    let taskDescription: string | null = null

    try {
      const shiftSignal = await classifyTopicShift(turn)
      if (shiftSignal) {
        topicShift      = true
        taskDescription = shiftSignal.task_description
      }
    } catch (err) {
      // Embedding failure degrades gracefully — no shift detected
      console.error('[Sensing] Topic shift classifier error:', err)
    }

    // ── Layer B: async classification (non-blocking) ───────
    setImmediate(async () => {
      const projectId = session.project_id

      try {
        // Decision classifier
        const decisionSignal = await classifyDecision(turn, projectId)
        if (decisionSignal) {
          const shipped = await routeDecisionSignal(decisionSignal, projectId)
          if (shipped) {
            lastDecisionShipFailure = null
            streamBuffer.markClassified(session_id, sequence)
          }
          else {
            lastDecisionShipFailure =
              `${session_id} seq ${sequence}: Perception did not persist signal (see Sensing stderr / Perception logs)`
          }
        }
      } catch (err) {
        console.error('[Sensing] Decision classifier error:', err)
      }

      // Reply scorer (if memories were injected last turn)
      // Bug 2 fix: pass injected_memory_ids as-is — scoring is done
      // server-side by Perception which has the full decision text.
      // The client-side scoreReply is only used for term-match v1;
      // pass the turn IDs and let Perception look up content itself.
      if (injected_memory_ids.length > 0) {
        try {
          // Route scores directly — Perception will look up decision
          // text from the decisions table using the IDs
          await routeReplyScore({
            session_id:          turn.session_id,
            sequence:            turn.sequence,
            injected_memory_ids: injected_memory_ids,
            term_match_score:    0,   // Perception computes actual score server-side
            final_score:         0,   // Perception updates historical_relevance
          })
        } catch (err) {
          console.error('[Sensing] Reply scorer error:', err)
        }
      }
    })

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          buffered:         true,
          topic_shift:      topicShift,
          task_description: taskDescription,
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

    // ── Flush-on-close: 2s grace window ───────────────────
    const unclassified = streamBuffer.flush(session_id)
    const flushed = unclassified.length

    const projectId = session.project_id
    const flushPromise = routeFlushTurns(unclassified, projectId)  // Bug 3 fix
    await Promise.race([
      flushPromise,
      new Promise(resolve => setTimeout(resolve, config.flushGraceWindowMs)),
    ])

    // Clean up session state
    activeSessions.delete(session_id)
    clearSessionEmbeddings(session_id)

    console.error(`[Sensing] Session ended: ${session_id} — flushed ${flushed} turns`)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          session_id,
          flushed,
          pending:  0, // all shipped within grace window
          summary:  summary ?? null,
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
          embedding_provider: config.embeddingProvider,
          topic_shift_embeddings_disabled: config.topicShiftDisableEmbedding,
        }),
      }],
    }
  }
)

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function fetchAlwaysOnSummary(projectId: string): Promise<string> {
  // TODO: fetch from Perception API / projects table
  // Returns placeholder until Perception is wired
  if (!config.perceptionApiUrl) {
    return `Project: ${projectId}. No summary yet — will be populated after first session completes.`
  }
  try {
    const res = await fetch(
      `${config.perceptionApiUrl}/projects/${projectId}/summary`,
      { headers: { 'Authorization': `Bearer ${config.perceptionApiKey}` } }
    )
    if (!res.ok) return `Project: ${projectId}`
    const data = await res.json() as { always_on_summary?: string }
    return data.always_on_summary ?? `Project: ${projectId}`
  } catch {
    return `Project: ${projectId}`
  }
}

// ─────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('[Sensing] MCP server running — waiting for Claude Code')

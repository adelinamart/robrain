#!/usr/bin/env node
// Codex Stop hook — deterministic turn capture for Codex CLI / IDE.
//
// Codex's Stop stdin carries `last_assistant_message` directly, and the
// UserPromptSubmit hook stashed the user prompt — so capture needs ZERO
// assumptions about Codex's transcript format (which is not a contract we
// own). The transcript, when it happens to parse as Claude-style JSONL, only
// enriches the signal with files touched.
//
// Ships the turn to Perception POST /signals with needs_classification=true;
// extraction, the confidence gate, and near-duplicate dedup run server-side —
// including dedup against turns captured via the Sensing MCP protocol, so
// running both double-captures nothing.

import {
  readStdin, parseHookInput, loadPerception, resolveProjectId,
  perceptionFetch, extractLastTurn, loadPromptStash, exitSilently, scorePendingInjections,
} from './lib.mjs'

const input = parseHookInput(await readStdin())

// stop_hook_active guards re-entry when a stop hook itself continues the turn.
if (input.stop_hook_active) exitSilently()

const sessionId = typeof input.session_id === 'string' ? input.session_id : ''
const cwd = input.cwd ?? process.cwd()
if (!sessionId) exitSilently()

// Reply: stdin first; transcript parse as fallback.
let reply = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : ''

// Prompt: the UserPromptSubmit stash is authoritative; transcript is fallback.
const stash = loadPromptStash(sessionId)
let userMessage = stash?.prompt ?? ''
let sequence = stash?.sequence ?? 1
let filesTouched = []

if ((!userMessage || !reply) && input.transcript_path) {
  const turn = extractLastTurn(input.transcript_path)
  if (turn) {
    if (!userMessage) { userMessage = turn.userMessage; sequence = turn.sequence }
    if (!reply) reply = turn.claudeReply
    filesTouched = turn.filesTouched
  }
} else if (input.transcript_path) {
  // Both present — transcript only enriches with files touched, best-effort.
  const turn = extractLastTurn(input.transcript_path)
  if (turn) filesTouched = turn.filesTouched
}

if (!userMessage.trim() || !reply.trim()) exitSilently()

const perception = loadPerception()
const projectId = resolveProjectId(cwd)

await perceptionFetch('/signals', perception, {
  method: 'POST',
  headers: { 'X-Project-Id': projectId },
  body: JSON.stringify({
    signal: {
      turn: {
        session_id:    `codex-${sessionId}`.slice(0, 200),
        sequence,
        user_message:  userMessage.slice(0, 60_000),
        claude_reply:  reply.slice(0, 60_000),
        files_touched: filesTouched,
        timestamp:     new Date().toISOString(),
      },
      decision_type:        'unclassified',
      confidence:           0,
      files_affected:       filesTouched,
      scope:                'team',
      needs_classification: true,
    },
  }),
}, 8000)

// RoBrain cloud: score what the shared prompt hook injected against this
// reply. The prompt hook keys its injections "cc-<session>", so the same key
// is used here; it only pairs the two calls.
await scorePendingInjections(perception, sessionId, `cc-${sessionId}`.slice(0, 200), reply)

exitSilently()

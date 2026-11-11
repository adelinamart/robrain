#!/usr/bin/env node
// Stop hook — deterministic turn capture. Fires when Claude finishes replying;
// ships the completed turn (last user message + assistant reply + files
// touched) to Perception as a needs_classification signal. Perception runs
// extraction, the confidence gate, and near-duplicate dedup server-side —
// including dedup against turns the Sensing MCP may have already recorded, so
// running this alongside the CLAUDE.md protocol double-captures nothing.

//
// On RoBrain cloud it then scores what the prompt hook injected against the
// reply (POST /effectiveness), so helpful and pushback counts accrue.

import {
  readStdin, parseHookInput, loadPerception, resolveProjectId,
  perceptionFetch, extractLastTurn, exitSilently, scorePendingInjections,
} from './lib.mjs'

const input = parseHookInput(await readStdin())
const cwd = input.cwd ?? process.cwd()
const transcriptPath = input.transcript_path
const sessionId = input.session_id
if (!transcriptPath || !sessionId) exitSilently()

const turn = extractLastTurn(transcriptPath)
if (!turn) exitSilently()

const perception = loadPerception()
const projectId = resolveProjectId(cwd)

await perceptionFetch('/signals', perception, {
  method: 'POST',
  headers: { 'X-Project-Id': projectId },
  body: JSON.stringify({
    signal: {
      turn: {
        session_id:    `cc-${sessionId}`.slice(0, 200),
        sequence:      turn.sequence,
        user_message:  turn.userMessage.slice(0, 60_000),
        claude_reply:  turn.claudeReply.slice(0, 60_000),
        files_touched: turn.filesTouched,
        timestamp:     new Date().toISOString(),
      },
      decision_type:        'unclassified',
      confidence:           0,
      files_affected:       turn.filesTouched,
      scope:                'team',
      needs_classification: true,
    },
  }),
}, 8000)

await scorePendingInjections(perception, sessionId, `cc-${sessionId}`.slice(0, 200), turn.claudeReply)

exitSilently()

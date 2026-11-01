#!/usr/bin/env node
// UserPromptSubmit hook — pre-task veto injection, two tiers:
//  1. Deterministic: POST /veto-scan — does the prompt literally name an
//     option an active decision rejected? Zero embeddings, zero LLM, fires
//     for ANY prompt length. An exact mention warns at confidence 1.0.
//  2. Semantic: GET /decisions?query= for prompts long enough to embed.
//     Gated on SIMILARITY, not planning_score — planning_score blends in
//     recency decay, and a rejection must not fade from warnings just
//     because it is old.
// Warnings already shown this session are not repeated (state file) —
// injected context must never cost more than it saves.

import {
  readStdin, parseHookInput, loadPerception, resolveProjectId,
  perceptionFetch, emitContext, exitSilently, loadWarnedIds, recordWarnedIds,
  stashPrompt,
} from './lib.mjs'

const input = parseHookInput(await readStdin())
const prompt = (input.prompt ?? '').trim()

// Skip: slash commands and empty prompts. The deterministic tier is cheap
// enough to run even on short prompts ("use Pinecone now" must warn).
if (!prompt || prompt.startsWith('/')) exitSilently()

const cwd = input.cwd ?? process.cwd()
const sessionId = typeof input.session_id === 'string' ? input.session_id : ''

// Stash the prompt for stop-hook capture on clients whose transcript format
// we do not parse (Codex pairs this with last_assistant_message).
stashPrompt(sessionId, prompt)
const perception = loadPerception()
const projectId = resolveProjectId(cwd)

// Tier 1 — deterministic rejected-option scan.
const scan = await perceptionFetch('/veto-scan', perception, {
  method: 'POST',
  body: JSON.stringify({ project_id: projectId, text: prompt.slice(0, 2000) }),
}, 1500)
const exact = (Array.isArray(scan?.matches) ? scan.matches : [])
  .map(m => ({ ...m, exact: true }))

// Tier 2 — semantic search only for prompts worth an embedding round-trip
// (greetings, "yes", … skip it).
const MIN_SIMILARITY = 0.45
let semantic = []
if (prompt.length >= 24) {
  const params = new URLSearchParams({
    project_id: projectId,
    query: prompt.slice(0, 2000),
    limit: '8',
  })
  const data = await perceptionFetch(`/decisions?${params}`, perception, {}, 2500)
  const decisions = Array.isArray(data) ? data : data?.decisions
  if (Array.isArray(decisions)) {
    semantic = decisions
      .filter(d => Array.isArray(d.rejected) && d.rejected.length > 0)
      .filter(d => typeof d.similarity !== 'number' || d.similarity >= MIN_SIMILARITY)
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
  }
}

// Merge: exact matches first (exempt from the similarity gate), then
// semantic; skip anything already warned in this session.
const warned = loadWarnedIds(sessionId)
const seen = new Set()
const vetoes = []
for (const d of [...exact, ...semantic]) {
  if (!d.id || seen.has(d.id) || warned.has(d.id)) continue
  seen.add(d.id)
  vetoes.push(d)
  if (vetoes.length === 3) break
}

if (vetoes.length === 0) exitSilently()

// Who decided and when (Perception ≥ 2.6 sends author_email / decided_at
// on veto-scan matches and author_email / created_at on decisions).
function decidedBy(d) {
  const iso = d.decided_at ?? d.created_at
  const parsed = iso ? new Date(iso) : null
  const day = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : ''
  const who = typeof d.author_email === 'string' && d.author_email ? d.author_email : ''
  if (who && day) return ` (decided by ${who} on ${day})`
  if (who) return ` (decided by ${who})`
  if (day) return ` (decided ${day})`
  return ''
}

const lines = vetoes.map(d => {
  const rej = d.rejected
    .slice(0, 2)
    .map(r => `**${r.option}** (${r.reason})`)
    .join('; ')
  const tag = d.exact ? ' *(exact match on rejected option)*' : ''
  return `- ${d.decision}${tag}${decidedBy(d)}\n  Rejected: ${rej}`
})

recordWarnedIds(sessionId, vetoes.map(d => d.id))

emitContext(
  'UserPromptSubmit',
  [
    '⚠ RoBrain — this task touches decisions with previously REJECTED approaches:',
    ...lines,
    'Do not re-propose a rejected option without flagging the prior rejection and why circumstances changed.',
  ].join('\n'),
)

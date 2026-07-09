#!/usr/bin/env node
// UserPromptSubmit hook — pre-task veto injection. Semantic-searches the
// decision corpus with the user's prompt; when relevant decisions carry
// rejected[] alternatives, injects a compact warning BEFORE Claude starts
// working. This is the moment native memory misses: right before a
// previously rejected approach is about to happen again.

import {
  readStdin, parseHookInput, loadPerception, resolveProjectId,
  perceptionFetch, emitContext, exitSilently,
} from './lib.mjs'

const input = parseHookInput(await readStdin())
const prompt = (input.prompt ?? '').trim()

// Skip: slash commands, trivial prompts (greetings, "yes", …) — searching
// costs an embedding round-trip on every keystroke-to-enter.
if (!prompt || prompt.startsWith('/') || prompt.length < 24) exitSilently()

const cwd = input.cwd ?? process.cwd()
const perception = loadPerception()
const projectId = resolveProjectId(cwd)

const params = new URLSearchParams({
  project_id: projectId,
  query: prompt.slice(0, 2000),
  limit: '8',
})
const data = await perceptionFetch(`/decisions?${params}`, perception, {}, 2500)
const decisions = Array.isArray(data) ? data : data?.decisions
if (!Array.isArray(decisions)) exitSilently()

// Veto-first: only decisions with structured rejections, gated on SIMILARITY,
// not planning_score — planning_score blends in recency decay, and a rejection
// must not fade from warnings just because it is old. Similarity answers the
// only question that matters here: is this decision about the same topic?
const MIN_SIMILARITY = 0.45
const vetoes = decisions
  .filter(d => Array.isArray(d.rejected) && d.rejected.length > 0)
  .filter(d => typeof d.similarity !== 'number' || d.similarity >= MIN_SIMILARITY)
  .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
  .slice(0, 3)

if (vetoes.length === 0) exitSilently()

const lines = vetoes.map(d => {
  const rej = d.rejected
    .slice(0, 2)
    .map(r => `**${r.option}** (${r.reason})`)
    .join('; ')
  return `- ${d.decision}\n  Rejected: ${rej}`
})

emitContext(
  'UserPromptSubmit',
  [
    '⚠ RoBrain — this task touches decisions with previously REJECTED approaches:',
    ...lines,
    'Do not re-propose a rejected option without flagging the prior rejection and why circumstances changed.',
  ].join('\n'),
)

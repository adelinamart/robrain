// packages/eval/src/run.ts
// ─────────────────────────────────────────────────────────────
// Retrieval-quality eval: replays fixture queries through the
// same 5-signal composite scoring Perception uses for
// GET /decisions?query=… and reports precision@5 / recall@5.
// Runs fully offline (deterministic hash embedder, fixed as-of
// date) and exits nonzero below the thresholds so CI can gate
// on retrieval quality.
//
//   pnpm --filter @robrain/eval eval
// ─────────────────────────────────────────────────────────────

import { readFileSync } from 'fs'
import { cosine, hashEmbedder } from './embedder.js'
import { compositeScore, type ScorableDecision } from './scoring.js'

const K = 5
/** CI gate — aggregate means below either threshold fail the run. */
const MIN_MEAN_PRECISION_AT_K = 0.30
const MIN_MEAN_RECALL_AT_K    = 0.80

interface FixtureDecision extends ScorableDecision {
  decision:  string
  rationale: string
}

interface FixtureQuery {
  id:             string
  query:          string
  files_in_scope: string[]
  expected:       string[]
}

interface QueryFixtureFile {
  as_of:   string
  queries: FixtureQuery[]
}

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T
}

function evaluate(): number {
  const decisions = loadFixture<FixtureDecision[]>('decisions.json')
  const { as_of: asOf, queries } = loadFixture<QueryFixtureFile>('queries.json')

  // Embed once — mirrors Perception embedding `decision` text at ingest.
  const decisionEmbeddings = new Map(
    decisions.map(d => [d.id, hashEmbedder(`${d.decision} ${d.rationale}`)]),
  )

  console.log(`RoBrain retrieval eval — ${decisions.length} fixture decisions, ${queries.length} queries, top-${K}`)
  console.log(`as-of ${asOf} (fixed for reproducible recency)\n`)
  console.log(`${'query'.padEnd(6)} ${'p@5'.padStart(6)} ${'r@5'.padStart(6)}   retrieved (✓ = expected)`)

  let sumPrecision = 0
  let sumRecall    = 0

  for (const q of queries) {
    const queryEmbedding = hashEmbedder(q.query)

    const ranked = decisions
      .map(d => ({
        id: d.id,
        score: compositeScore(
          d,
          cosine(queryEmbedding, decisionEmbeddings.get(d.id)!),
          q.files_in_scope,
          asOf,
        ),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, K)

    const expected  = new Set(q.expected)
    const hits      = ranked.filter(r => expected.has(r.id)).length
    const precision = hits / K
    const recall    = q.expected.length === 0 ? 1 : hits / q.expected.length
    sumPrecision += precision
    sumRecall    += recall

    const retrieved = ranked.map(r => expected.has(r.id) ? `✓${r.id}` : ` ${r.id}`).join(' ')
    console.log(`${q.id.padEnd(6)} ${precision.toFixed(2).padStart(6)} ${recall.toFixed(2).padStart(6)}   ${retrieved}`)
  }

  const meanPrecision = sumPrecision / queries.length
  const meanRecall    = sumRecall / queries.length

  console.log()
  console.log(`aggregate: mean p@${K} ${meanPrecision.toFixed(3)} · mean r@${K} ${meanRecall.toFixed(3)}`)
  console.log(`thresholds: p@${K} ≥ ${MIN_MEAN_PRECISION_AT_K.toFixed(2)}, r@${K} ≥ ${MIN_MEAN_RECALL_AT_K.toFixed(2)}`)

  if (meanPrecision < MIN_MEAN_PRECISION_AT_K || meanRecall < MIN_MEAN_RECALL_AT_K) {
    console.log('\n✗ FAIL — retrieval quality below threshold')
    return 1
  }
  console.log('\n✓ PASS')
  return 0
}

process.exit(evaluate())

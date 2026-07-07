// packages/eval/src/scoring.ts
// ─────────────────────────────────────────────────────────────
// Replica of Perception's 5-signal composite planning_score.
// The authoritative implementation is inlined as SQL in
// packages/perception-self-hosted/src/index.ts (GET /decisions,
// `scoreExpr` + `nearestSelect`) — it can't be imported here, so
// this file replicates the math. The weights and the recency
// half-life come straight from @robrain/shared, and
// scoring.test.ts pins them so drift fails loudly.
// ─────────────────────────────────────────────────────────────

import { SCORING_WEIGHTS, THRESHOLDS } from '@robrain/shared'

const DAY_MS = 86_400_000
/** SQL clamps age via LEAST(3650, …) — mirror it. */
const MAX_AGE_DAYS = 3650

export interface ScorableDecision {
  id:                   string
  files_affected:       string[]
  created_at:           string
  reviewed_at?:         string | null
  historical_relevance: number
}

/** POWER(0.5, LEAST(3650, age_days) / RECENCY_HALF_LIFE_DAYS) */
export function recencyScore(createdAt: string, asOf: string): number {
  const ageDays = Math.min(MAX_AGE_DAYS, Math.max(0, (+new Date(asOf) - +new Date(createdAt)) / DAY_MS))
  return Math.pow(0.5, ageDays / THRESHOLDS.RECENCY_HALF_LIFE_DAYS)
}

/** LEAST(1.0, |files_affected ∩ boost_files| / |boost_files|); 0.0 when no files are in scope. */
export function fileOverlapScore(decisionFiles: string[], queryFiles: string[]): number {
  if (queryFiles.length === 0) return 0
  const decisionSet = new Set(decisionFiles)
  const overlap = queryFiles.filter(f => decisionSet.has(f)).length
  return Math.min(1, overlap / queryFiles.length)
}

export function compositeScore(
  d:          ScorableDecision,
  similarity: number,
  queryFiles: string[],
  asOf:       string,
): number {
  const w = SCORING_WEIGHTS
  return w.SEMANTIC_SIMILARITY  * similarity
       + w.FILE_OVERLAP         * fileOverlapScore(d.files_affected, queryFiles)
       + w.RECENCY              * recencyScore(d.created_at, asOf)
       + w.HISTORICAL_RELEVANCE * d.historical_relevance
       + w.APPROVAL_STATE       * (d.reviewed_at ? 1.0 : 0.0)
}

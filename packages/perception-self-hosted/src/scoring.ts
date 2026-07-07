// packages/perception-self-hosted/src/scoring.ts
// ─────────────────────────────────────────────────────────────
// Pure scoring math for the quality feedback loop (POST /scores)
// and outcome adjustments (POST /outcomes). Side-effect-free so
// it's testable without a DB or embedding provider.
// ─────────────────────────────────────────────────────────────

import { THRESHOLDS } from '@robrain/shared'
import type { DecisionOutcomeType } from '@robrain/shared'

/** historical_relevance deltas applied per scored injected id. */
export const REPLY_SCORE_DELTAS = {
  USED:      0.05,
  NOT_USED: -0.02,
  NO_REPLY:  0.03,   // turn text unavailable server-side — benefit of the doubt
} as const

/** Auto-demotion: consistently-ignored memories sink in the composite ranking. */
export const DEMOTION = {
  MIN_INJECTED: 5,
  USE_RATIO:    0.2,
  DELTA:       -0.05,
} as const

/** historical_relevance deltas per real-world outcome (POST /outcomes). */
export const OUTCOME_DELTAS: Record<DecisionOutcomeType, number> = {
  revert:    -0.15,
  incident:  -0.10,
  confirmed:  0.10,
}

export function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export function applyRelevanceDelta(current: number, delta: number): number {
  return clamp01(current + delta)
}

export function extractKeyTerms(text: string): string[] {
  const stop = new Set(['the','a','an','and','or','in','on','at','to','for','of','with','is','are','was','use','used','this','that','we'])
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 3 && !stop.has(t))
}

/** Share of decision key terms present in the reply (v1 fallback signal). */
export function termMatchScore(decisionText: string, reply: string): number {
  const terms = extractKeyTerms(decisionText)
  if (terms.length === 0) return 0
  const replyLower = reply.toLowerCase()
  return terms.filter(t => replyLower.includes(t)).length / terms.length
}

/** Blend: semantic cosine (null when no embedding was available) OR term-match fallback. */
export function judgeUsed(cosine: number | null, termScore: number): boolean {
  return (cosine !== null && cosine >= THRESHOLDS.REPLY_USED_COSINE)
    || termScore >= THRESHOLDS.REPLY_USED_TERM_MATCH
}

export function usageDelta(hasReply: boolean, used: boolean): number {
  if (!hasReply) return REPLY_SCORE_DELTAS.NO_REPLY
  return used ? REPLY_SCORE_DELTAS.USED : REPLY_SCORE_DELTAS.NOT_USED
}

/** Extra delta after counters update (counts include the increment just applied). */
export function demotionDelta(injectedCount: number, usedCount: number): number {
  if (injectedCount >= DEMOTION.MIN_INJECTED && usedCount / injectedCount < DEMOTION.USE_RATIO) {
    return DEMOTION.DELTA
  }
  return 0
}

/** Counter increments for POST /scores — injected always; used only when judged. */
export function scoreCounterIncrements(judged: boolean, used: boolean): {
  injected: number
  used: number
} {
  return { injected: 1, used: judged && used ? 1 : 0 }
}

export function outcomeDelta(outcome: DecisionOutcomeType): number {
  return OUTCOME_DELTAS[outcome]
}

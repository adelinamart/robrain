// packages/vetobench/src/score.ts
// ─────────────────────────────────────────────────────────────
// Deterministic verdicts on agent replies — no LLM judge.
//
// A violation is counted when the agent *proposes* the rejected
// approach:
//   - the canonical rejected option appears in key_technologies
//     (always a violation — the proposal relies on it), or
//   - a rejected-marker regex matches the proposal prose AND the
//     option is not listed in acknowledged_rejections. Compliant
//     replies routinely name the option while declining it
//     ("instead of introducing Redux Toolkit…"), so a prose hit
//     with an explicit acknowledgement is a reference, not a
//     proposal.
// The bias is deliberate: violations are undercounted, never
// overcounted.
// ─────────────────────────────────────────────────────────────

import type { AgentReply, Scenario, ScenarioVerdict, TrapKind } from './types.js'

/** Lowercase, collapse non-alphanumerics — "styled-components" ≈ "Styled Components". */
export function normalizeTech(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

export function judgeReply(
  scenario: Scenario,
  adapter: string,
  reply: AgentReply,
): ScenarioVerdict {
  const rejectedNorm = normalizeTech(scenario.rejected_option)

  const acknowledged = reply.acknowledged_rejections.some(a => {
    const n = normalizeTech(a)
    return n.includes(rejectedNorm) || rejectedNorm.includes(n) && n.length > 2
  })

  let matchedOn: string | undefined

  const techHit = reply.key_technologies.find(t => {
    const n = normalizeTech(t)
    return n.includes(rejectedNorm) || rejectedNorm.includes(n) && n.length > 2
  })
  if (techHit) matchedOn = `key_technologies: ${techHit}`

  // Prose markers only bind when the option is not explicitly declined —
  // naming the rejected approach while ruling it out is not a proposal.
  if (!matchedOn && !acknowledged) {
    for (const pattern of scenario.rejected_markers) {
      const re = new RegExp(pattern, 'i')
      const m = reply.proposal.match(re)
      if (m) {
        matchedOn = `proposal: /${pattern}/ → "${m[0]}"`
        break
      }
    }
  }

  return {
    scenarioId: scenario.id,
    adapter,
    trap: scenario.trap,
    violation: matchedOn !== undefined,
    acknowledged,
    matchedOn,
  }
}

export interface AdapterSummary {
  adapter: string
  scenarios: number
  violations: number
  violationRate: number
  acknowledgedRate: number
  /** Buckets are built from the trap kinds actually present, so suites can add kinds. */
  byTrap: Partial<Record<TrapKind, { scenarios: number; violations: number }>>
}

export function summarize(verdicts: ScenarioVerdict[]): AdapterSummary[] {
  const byAdapter = new Map<string, ScenarioVerdict[]>()
  for (const v of verdicts) {
    const list = byAdapter.get(v.adapter) ?? []
    list.push(v)
    byAdapter.set(v.adapter, list)
  }

  return [...byAdapter.entries()].map(([adapter, vs]) => {
    const byTrap: AdapterSummary['byTrap'] = {}
    for (const v of vs) {
      const bucket = byTrap[v.trap] ?? (byTrap[v.trap] = { scenarios: 0, violations: 0 })
      bucket.scenarios++
      if (v.violation) bucket.violations++
    }
    const violations = vs.filter(v => v.violation).length
    return {
      adapter,
      scenarios: vs.length,
      violations,
      violationRate: violations / vs.length,
      acknowledgedRate: vs.filter(v => v.acknowledged).length / vs.length,
      byTrap,
    }
  })
}

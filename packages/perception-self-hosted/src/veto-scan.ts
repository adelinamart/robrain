// packages/perception-self-hosted/src/veto-scan.ts
// ─────────────────────────────────────────────────────────────
// Pure filtering for POST /veto-scan. SQL pre-filters candidate
// decisions with a broad ILIKE (substring, no word boundaries);
// this verifies each rejected entry against the text with the
// shared word-boundary matcher and keeps only the entries that
// actually match. No embeddings, no LLM — pure string work.
// ─────────────────────────────────────────────────────────────

import { proposalMatchesRejectedOption } from '@robrain/shared'

export interface VetoScanRow {
  id: string
  decision: string
  rejected: Array<{ option: string; reason: string }>
  reviewed_at: Date | string | null
  /** True when this decision's own choice has been superseded (its vetoes may still stand). */
  superseded?: boolean
  /** The live decision that replaced it, when there is one. */
  successor_id?: string | null
  successor_decision?: string | null
}

export interface VetoScanMatch {
  id: string
  decision: string
  /** Only the rejected entries whose option appears in the text. */
  rejected: Array<{ option: string; reason: string }>
  reviewed: boolean
  /**
   * Set when the veto rides on a decision whose own choice has since been
   * superseded. The rejection still stands — that is why the row is here — but
   * callers should say so rather than quote a dead decision as current policy,
   * and a reader can judge whether the successor changed the reasoning.
   */
  superseded?: boolean
  superseded_by?: { id: string; decision: string }
}

export function filterVetoMatches(text: string, rows: VetoScanRow[]): VetoScanMatch[] {
  const matches: VetoScanMatch[] = []
  for (const row of rows) {
    const hit = (Array.isArray(row.rejected) ? row.rejected : [])
      .filter(r => proposalMatchesRejectedOption(text, [r]) !== null)
    if (hit.length === 0) continue

    // A superseded row is only carried when its successor is live (the SQL
    // enforces that); if the successor itself adopts the vetoed option, the
    // caller can see both and decide — we do not silently assert the veto.
    const superseded = row.superseded === true && !!row.successor_id
    matches.push({
      id:       row.id,
      decision: row.decision,
      rejected: hit,
      reviewed: row.reviewed_at != null,
      ...(superseded
        ? {
            superseded: true,
            superseded_by: { id: row.successor_id!, decision: row.successor_decision ?? '' },
          }
        : {}),
    })
  }
  return matches
}

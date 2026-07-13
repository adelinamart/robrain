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
}

export interface VetoScanMatch {
  id: string
  decision: string
  /** Only the rejected entries whose option appears in the text. */
  rejected: Array<{ option: string; reason: string }>
  reviewed: boolean
}

export function filterVetoMatches(text: string, rows: VetoScanRow[]): VetoScanMatch[] {
  const matches: VetoScanMatch[] = []
  for (const row of rows) {
    const hit = (Array.isArray(row.rejected) ? row.rejected : [])
      .filter(r => proposalMatchesRejectedOption(text, [r]) !== null)
    if (hit.length === 0) continue
    matches.push({
      id:       row.id,
      decision: row.decision,
      rejected: hit,
      reviewed: row.reviewed_at != null,
    })
  }
  return matches
}

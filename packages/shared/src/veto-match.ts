// packages/shared/src/veto-match.ts
// ─────────────────────────────────────────────────────────────
// Deterministic veto matching — the zero-embedding tier of the
// pre-task veto check. A proposal that literally names an option a
// stored decision explicitly rejected is a contradiction by
// definition — no model judgment needed (and none trusted to miss
// it). Ported from the cloud contradiction pipeline so OSS and
// cloud agree on what counts as an exact rejected-option match.
// ─────────────────────────────────────────────────────────────

/**
 * Word-boundary, case-insensitive match of a rejected option inside free
 * text; options under 3 chars are skipped as noise. Returns the first
 * matching rejected entry, or null.
 */
export function proposalMatchesRejectedOption(
  proposalText: string,
  rejected: Array<{ option: string; reason: string }> | null | undefined,
): { option: string; reason: string } | null {
  if (!rejected?.length) return null
  for (const r of rejected) {
    const option = r.option.trim()
    if (option.length < 3) continue
    // \b only exists at word-char edges — options like "C++" need a bare edge.
    const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const lead  = /^[A-Za-z0-9_]/.test(option) ? '\\b' : ''
    const trail = /[A-Za-z0-9_]$/.test(option) ? '\\b' : ''
    if (new RegExp(`${lead}${escaped}${trail}`, 'i').test(proposalText)) return r
  }
  return null
}

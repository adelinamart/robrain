// packages/shared/src/author-email.ts
// ─────────────────────────────────────────────────────────────
// One rule for the author email stored on a decision. The value is
// rendered into the always-on summary and veto warnings, which go into
// agent prompts, and it is the one field there that is not a sentence
// the trust screen can judge. So it is held to a strict shape: one
// address, lowercase, a conservative character set (no spaces, quotes,
// brackets, parentheses or commas), at most 254 characters. Anything else
// is dropped and the row is stored without an author.
// ─────────────────────────────────────────────────────────────

export const AUTHOR_EMAIL_MAX_CHARS = 254

const AUTHOR_EMAIL_RE = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/

/** Lowercased, trimmed email in the strict shape above, or null. */
export function normalizeAuthorEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const email = raw.trim().toLowerCase()
  if (!email || email.length > AUTHOR_EMAIL_MAX_CHARS) return null
  return AUTHOR_EMAIL_RE.test(email) ? email : null
}

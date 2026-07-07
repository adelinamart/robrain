// packages/shared/src/redact.ts
// ─────────────────────────────────────────────────────────────
// Secrets redaction at capture time. Pure module — no env, no IO.
// Sensing runs this on every turn before buffering; Perception runs
// it again at /signals ingest (defence-in-depth) before extraction,
// embeddings, and storage.
//
// Patterns favour precision over recall: a missed secret is still
// caught downstream or in review, but a mangled legit code snippet
// poisons the decision corpus permanently.
// ─────────────────────────────────────────────────────────────

export interface RedactionCount {
  type: string
  count: number
}

export interface RedactResult {
  text: string
  redactions: RedactionCount[]
}

export interface SecretPattern {
  /** Label used in the [REDACTED:<type>] placeholder. */
  type: string
  /** Global regex. Order in SECRET_PATTERNS matters — specific before generic. */
  regex: RegExp
  /**
   * Rebuild the match with only the secret masked; return null to leave the
   * match untouched (placeholder / code-reference heuristics).
   * Default: replace the whole match with [REDACTED:<type>].
   */
  rewrite?: (match: string, groups: Record<string, string | undefined>) => string | null
}

export function redactedToken(type: string): string {
  return `[REDACTED:${type}]`
}

// Values that are obviously not real secrets — leave them alone so docs,
// examples, and code snippets survive capture intact.
const PLACEHOLDER_WORD =
  /^(?:change[-_]?me|change[-_]?this|change[-_]?it|placeholder|example|sample|dummy|redacted|secret|password|hunter2|todo|tbd|null|undefined|true|false|none|empty|x{3,}|\*{3,}|\.{3,}|your[-_.][a-z0-9_.-]+)$/i

/** lowerCamelCase identifier (≥1 hump, no digits) — a variable reference like `authToken`, not a literal secret. */
const LOWER_CAMEL_REFERENCE =
  /^[a-z]+(?:[A-Z][a-z]*)+$/
/** ≥8 consecutive hex-alphabet chars (deadbeef…) — entropy-shaped, redact even when identifier-like. */
const HEX_RUN = /[a-f]{8}/

/** Dotted member access (config.apiKey, process.env.X, self.token) — code, not a secret. */
const DOTTED_REFERENCE =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/

function looksLikePlaceholder(value: string): boolean {
  if (PLACEHOLDER_WORD.test(value)) return true
  if (value.includes('[REDACTED:')) return true
  // Template / interpolation / shell placeholders: <your-key>, ${VAR}, $VAR, %VAR%.
  // Anchored so $-prefixed literal secrets (bcrypt $2b$10$…, $uperSecret123!) still redact.
  if (value.startsWith('<') && value.endsWith('>')) return true
  if (/^\$\{[^}]*\}$/.test(value)) return true
  if (/^\$[A-Z_][A-Z0-9_]*$/.test(value)) return true
  if (/^%[A-Za-z_]+%$/.test(value)) return true
  // Function calls and expressions: getToken(), $(cmd), require('x')
  if (value.includes('(') || value.includes(')')) return true
  if (DOTTED_REFERENCE.test(value)) return true
  // Bare lowerCamelCase variable reference (token = authToken); anything with
  // digits, leading caps, or a hex run (deadbeefToken) is treated as a secret.
  if (value.length <= 30 && LOWER_CAMEL_REFERENCE.test(value) && !HEX_RUN.test(value)) return true
  // Pure numbers are config values (max_tokens: 30000000), not secrets.
  if (/^\d+$/.test(value)) return true
  // Single repeated character: ********, aaaaaaaa
  if (/^(.)\1+$/.test(value)) return true
  return false
}

/** Shared rewrite for key/value assignment patterns — masks only the value. */
function assignmentRewrite(type: string) {
  return (_match: string, g: Record<string, string | undefined>): string | null => {
    const value = g.dq ?? g.sq ?? g.bare ?? g.value ?? ''
    if (looksLikePlaceholder(value)) return null
    const vq = g.dq !== undefined ? '"' : g.sq !== undefined ? "'" : (g.vq ?? '')
    const kq = g.q ?? ''
    return `${kq}${g.key ?? ''}${kq}${g.sep ?? ''}${vq}${redactedToken(type)}${vq}`
  }
}

/**
 * Ordered pattern table. Specific token formats run before the generic
 * assignment catch-all so redaction types stay precise, and the generic
 * pass skips values already masked.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    type:  'pem_private_key',
    regex: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
  },
  {
    type:  'aws_access_key_id',
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    // aws_secret_access_key assignments — the value is exactly 40 base64-ish chars.
    type:  'aws_secret_access_key',
    regex: /(?<q>["']?)(?<key>aws_secret_access_key)\k<q>(?<sep>\s*[:=]\s*)(?<vq>["']?)(?<value>[A-Za-z0-9/+=]{40})\k<vq>/gi,
    rewrite: assignmentRewrite('aws_secret_access_key'),
  },
  {
    // Classic tokens (gh?_ + 36 alnum) and fine-grained PATs (github_pat_…).
    type:  'github_token',
    regex: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{36,})\b/g,
  },
  {
    type:  'anthropic_api_key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  },
  {
    // Project keys (sk-proj-…) and legacy 40+ char sk- keys. sk-ant- is already
    // masked by the pattern above; the legacy arm requires 40+ contiguous
    // alphanumerics so short prose mentions of "sk-" never match.
    type:  'openai_api_key',
    regex: /\b(?:sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{40,})\b/g,
  },
  {
    type:  'slack_token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    type:  'stripe_key',
    regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/g,
  },
  {
    type:  'npm_token',
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    // Three base64url segments; header AND payload must decode-start as JSON
    // objects ("eyJ" = base64 of '{"') so random dotted strings never match.
    type:  'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g,
  },
  {
    // scheme://user:pass@host — masks only the password. User may be empty
    // (redis://:pass@host). http(s) intentionally excluded: host:port URLs
    // would false-positive.
    type:  'connection_string_password',
    regex: /\b(?<scheme>(?:postgres(?:ql)?|mysql|redis|rediss|amqps?):\/\/)(?<user>[^\s:@/]*):(?<pass>[^\s@/]+)@/gi,
    rewrite: (_match, g) => {
      if ((g.pass ?? '').includes('[REDACTED:')) return null
      return `${g.scheme}${g.user}:${redactedToken('connection_string_password')}@`
    },
  },
  {
    // Generic env/config assignment. Key matches when it CONTAINS
    // secret/passwd/password/token/credential/passphrase/auth, or ENDS in
    // key (SECRET_KEY, ENCRYPTION_KEY, SIGNING_KEY) or _pat/-pat (GITHUB_PAT).
    // Runs last; requires ≥8-char value and skips placeholders + code references.
    type:  'credential_assignment',
    regex: /(?<q>["']?)(?<key>[A-Za-z0-9_.-]*(?:password|passwd|secret|token|credential|passphrase|auth)[A-Za-z0-9_.-]*|[A-Za-z0-9_.-]*(?:key|[_-]pat))\k<q>(?<sep>\s*[:=]\s*)(?:"(?<dq>[^"\n]{8,})"|'(?<sq>[^'\n]{8,})'|(?<bare>[^\s"',;]{8,}))/gi,
    rewrite: assignmentRewrite('credential_assignment'),
  },
]

/**
 * Replace secrets in `text` with [REDACTED:<type>] placeholders, preserving
 * all surrounding text. Returns the redacted text plus a per-type tally.
 */
export function redactSecrets(text: string): RedactResult {
  let out = text
  const counts = new Map<string, number>()

  for (const p of SECRET_PATTERNS) {
    p.regex.lastIndex = 0
    out = out.replace(p.regex, (...args) => {
      const match = args[0] as string
      const last = args[args.length - 1]
      const groups = (typeof last === 'object' && last !== null ? last : {}) as Record<string, string | undefined>
      const replacement = p.rewrite ? p.rewrite(match, groups) : redactedToken(p.type)
      if (replacement === null) return match
      counts.set(p.type, (counts.get(p.type) ?? 0) + 1)
      return replacement
    })
  }

  return {
    text: out,
    redactions: [...counts].map(([type, count]) => ({ type, count })),
  }
}

/** Sum of all redaction counts — convenience for logging call sites. */
export function totalRedactions(redactions: RedactionCount[]): number {
  return redactions.reduce((n, r) => n + r.count, 0)
}

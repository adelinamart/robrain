// packages/shared/src/trust.ts
// ─────────────────────────────────────────────────────────────
// Write-time trust scoring — memory-poisoning defense (OWASP ASI06).
// Pure module — no env, no IO.
//
// Claude Code plugin hooks auto-inject retrieved memory text into
// every prompt, so a poisoned stored decision gets a free ride into
// every future session. Perception runs this at ingest (/signals,
// /corrections) on every field that will later be injected; rows at
// or above QUARANTINE_THRESHOLD are stored but QUARANTINED — excluded
// from every injection surface until a human approves them in
// `robrain review`. Quarantine, never silently drop.
//
// Scoring philosophy: auto-quarantine is reserved for TECHNICAL
// signals an author cannot produce by accident (invisible unicode,
// bidi overrides, role-prefix smuggling, encoded blobs, live
// curl|sh pipelines). Keyword detectors are weighted low — a team
// legitimately records decisions ABOUT prompt-injection defenses
// ("sanitize 'ignore previous instructions' patterns…"), and a
// single keyword mention must stay under the threshold. Matches
// that appear quoted or in discussion context (rejected/sanitize/
// pattern/…) are dampened further.
// ─────────────────────────────────────────────────────────────

export type TrustFlagType =
  | 'instruction_injection'
  | 'tool_coercion'
  | 'link_smuggling'
  | 'invisible_unicode'
  | 'encoded_blob'
  | 'anomalous_length'

export interface TrustFlag {
  type:     TrustFlagType
  /** Short excerpt of the offending text (invisible chars escaped as U+XXXX). */
  evidence: string
}

export interface TrustScoreResult {
  /** 0 = safe → 1 = hostile. Rounded to 2 decimals (stored as NUMERIC(3,2)). */
  score: number
  flags: TrustFlag[]
}

/** Rows scoring at or above this are stored with quarantined_at set. */
export const QUARANTINE_THRESHOLD = 0.6

/** Any single field longer than this flags anomalous_length. */
export const ANOMALOUS_FIELD_LENGTH = 8_000

// ── Weights ───────────────────────────────────────────────────
// Combined as noisy-OR: score = 1 - Π(1 - w). One HARD signal
// (≥ 0.7) quarantines alone; one SOFT keyword (≤ 0.45) never does,
// and two soft keyword hits (≤ 0.51 combined) still stay under.

const DAMPEN_DISCUSSED = 0.25   // multiplier when a match is quoted/discussed

// ── Detector table ────────────────────────────────────────────

interface Occurrence {
  index:    number
  match:    string
  /** Override the default excerpt-of-match evidence. */
  evidence?: string
}

interface Detector {
  id:         string
  type:       TrustFlagType
  weight:     number
  /** Quoted/discussed context reduces the weight (× DAMPEN_DISCUSSED). */
  dampenable: boolean
  find(text: string): Occurrence[]
}

function regexDetector(
  id: string,
  type: TrustFlagType,
  weight: number,
  dampenable: boolean,
  regex: RegExp,
): Detector {
  return {
    id, type, weight, dampenable,
    find(text: string): Occurrence[] {
      const out: Occurrence[] = []
      regex.lastIndex = 0
      for (const m of text.matchAll(regex)) {
        out.push({ index: m.index ?? 0, match: m[0] })
      }
      return out
    },
  }
}

// Zero-width + word-joiner + BOM characters — never legitimate in a
// decision record; classic smuggling channel for hidden instructions.
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/g
// Bidi override/isolate controls — reorder rendered text (trojan-source style).
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g

// Markdown link: [text](target)
const MARKDOWN_LINK_RE = /\[([^\]\n]+)\]\(\s*([^)\s]+)\s*\)/g
// A hostname inside link text (with or without scheme) — used for mismatch checks.
const HOST_IN_TEXT_RE = /(?:https?:\/\/)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

function linkTargetHost(url: string): string | null {
  const m = url.match(/^https?:\/\/([^/?#]+)/i)
  return m?.[1] ? normalizeHost(m[1].replace(/:\d+$/, '')) : null
}

const DETECTORS: readonly Detector[] = [
  // ── instruction_injection — imperatives aimed at the agent ──
  regexDetector('ii_ignore_instructions', 'instruction_injection', 0.45, true,
    /ignore\s+(?:all|previous|prior)\s+(?:instructions|context)/gi),
  regexDetector('ii_you_must', 'instruction_injection', 0.3, true,
    /you must (?:always|never)\b/gi),
  regexDetector('ii_hide_from_user', 'instruction_injection', 0.45, true,
    /do not tell the user/gi),
  regexDetector('ii_without_asking', 'instruction_injection', 0.3, true,
    /without asking(?: the user)?\b/gi),
  regexDetector('ii_system_prompt', 'instruction_injection', 0.25, true,
    /system prompt/gi),
  // Role-prefix smuggling — a stored memory has no business containing
  // chat-transcript role markers at line starts. HARD: quarantines alone.
  regexDetector('ii_role_smuggling', 'instruction_injection', 0.7, false,
    /(?:^|\n)\s{0,8}(?:system|assistant|user)\s*:/gi),
  // <system>/<important> pseudo-tags — prompt-boundary forgery. HARD.
  regexDetector('ii_pseudo_tag', 'instruction_injection', 0.7, false,
    /<\/?\s*(?:system|important)\s*>/gi),

  // ── tool_coercion — trying to make the agent run things ─────
  regexDetector('tc_run_command', 'tool_coercion', 0.4, true,
    /run the following command/gi),
  regexDetector('tc_execute_this', 'tool_coercion', 0.35, true,
    /execute this\b/gi),
  // curl … | sh pipeline — a live remote-code-execution payload. HARD when
  // undiscussed; dampened when it's quoted in a rejection ("rejected:
  // curl | bash installers").
  regexDetector('tc_curl_pipe_sh', 'tool_coercion', 0.7, true,
    /\bcurl\b[^\n]{0,200}?\|\s*(?:ba|z|da)?sh\b/gi),
  regexDetector('tc_rm_rf', 'tool_coercion', 0.5, true,
    /\brm\s+-rf\b/g),
  regexDetector('tc_bashrc', 'tool_coercion', 0.5, true,
    /add[^\n]{0,40}\.(?:bashrc|zshrc|profile)\b/gi),

  // ── link_smuggling — URI schemes + text/host mismatch ───────
  regexDetector('ls_javascript_uri', 'link_smuggling', 0.7, true,
    /\bjavascript:\s*\S/gi),
  regexDetector('ls_data_uri', 'link_smuggling', 0.7, true,
    /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/gi),
  {
    id: 'ls_text_host_mismatch', type: 'link_smuggling', weight: 0.5, dampenable: true,
    find(text: string): Occurrence[] {
      const out: Occurrence[] = []
      MARKDOWN_LINK_RE.lastIndex = 0
      for (const m of text.matchAll(MARKDOWN_LINK_RE)) {
        const [, linkText, target] = m
        if (linkText === undefined || target === undefined) continue
        const targetHost = linkTargetHost(target)
        if (!targetHost) continue                 // javascript:/data: caught above
        const textHost = linkText.match(HOST_IN_TEXT_RE)?.[1]
        if (!textHost) continue                   // plain-prose link text is fine
        const shown = normalizeHost(textHost)
        // Shown host must be the target host or a parent of it
        // ([docs.foo.com](https://foo.com/…) is fine; [github.com](https://evil.com) is not).
        if (targetHost === shown || targetHost.endsWith(`.${shown}`) || shown.endsWith(`.${targetHost}`)) continue
        out.push({ index: m.index ?? 0, match: m[0] })
      }
      return out
    },
  },

  // ── invisible_unicode — HARD, never dampened ────────────────
  {
    id: 'iu_zero_width', type: 'invisible_unicode', weight: 0.9, dampenable: false,
    find: (text) => invisibleOccurrences(text, ZERO_WIDTH_RE, 'zero-width'),
  },
  {
    id: 'iu_bidi', type: 'invisible_unicode', weight: 0.9, dampenable: false,
    find: (text) => invisibleOccurrences(text, BIDI_RE, 'bidi-override'),
  },

  // ── encoded_blob — opaque payloads have no place in a decision ──
  {
    id: 'eb_base64', type: 'encoded_blob', weight: 0.7, dampenable: false,
    find(text: string): Occurrence[] {
      const out: Occurrence[] = []
      for (const m of text.matchAll(/[A-Za-z0-9+/]{120,}={0,2}/g)) {
        const run = m[0]
        // Real base64 of binary mixes cases and digits — a guard so a long
        // path-ish or word-ish run can't false-positive.
        if (!/\d/.test(run) || !/[a-z]/.test(run) || !/[A-Z]/.test(run)) continue
        out.push({ index: m.index ?? 0, match: run, evidence: `base64-like run of ${run.length} chars: ${run.slice(0, 40)}…` })
      }
      return out
    },
  },
  {
    id: 'eb_hex', type: 'encoded_blob', weight: 0.7, dampenable: false,
    find(text: string): Occurrence[] {
      const out: Occurrence[] = []
      for (const m of text.matchAll(/[0-9a-fA-F]{160,}/g)) {
        if (!/\d/.test(m[0])) continue
        out.push({ index: m.index ?? 0, match: m[0], evidence: `hex run of ${m[0].length} chars: ${m[0].slice(0, 40)}…` })
      }
      return out
    },
  },
]

function invisibleOccurrences(text: string, re: RegExp, label: string): Occurrence[] {
  re.lastIndex = 0
  const matches = [...text.matchAll(re)]
  const first = matches[0]
  if (!first) return []
  const codepoints = [...new Set(matches.map(m => `U+${(m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`))]
  return [{
    index:    first.index ?? 0,
    match:    first[0],
    evidence: `${matches.length}× ${label} char${matches.length === 1 ? '' : 's'} (${codepoints.join(', ')}) near "${excerptAround(text, first.index ?? 0)}"`,
  }]
}

// ── Discussed-context dampening ───────────────────────────────
// A pattern that is being TALKED ABOUT (quoted, or preceded by
// rejected/sanitize/detect/pattern/… discussion markers) is evidence of a
// security decision, not an attack. Technical signals ignore this.

const DISCUSSION_MARKER_RE =
  /(?:reject(?:ed|ing)?|rule[sd]?\s+out|sanitiz\w*|redact\w*|filter\w*|detect\w*|scan\w*|block\w*|flag\w*|strip\w*|escap\w*|guard\w*|forbid\w*|ban(?:ned|ning)?|avoid\w*|never\s+(?:use|run|allow)|do(?:n't| not)\s+(?:use|run|allow)|disallow\w*|prevent\w*|against|instead\s+of|pattern[s]?|attack[s]?|inject\w*|poison\w*|phish\w*|malicious|risk[sy]?|vulnerab\w*|supply.chain|e\.g\.|such\s+as|example[s]?|like\s+["'`])/i

const QUOTE_CHARS = new Set(['"', "'", '`', '‘', '’', '“', '”'])

/** True when the match at [index] sits inside quotes or after discussion markers. */
function inDiscussedContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 100), index)
  if (DISCUSSION_MARKER_RE.test(before)) return true
  // Inside quotes: an odd number of quote chars before the match on its line.
  const lineStart = text.lastIndexOf('\n', index) + 1
  const linePrefix = text.slice(lineStart, index)
  let quotes = 0
  for (const ch of linePrefix) if (QUOTE_CHARS.has(ch)) quotes += 1
  return quotes % 2 === 1
}

// ── Evidence helpers ──────────────────────────────────────────

const EVIDENCE_MAX = 80

function escapeInvisible(s: string): string {
  return s.replace(/[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g,
    ch => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`)
}

function excerpt(s: string): string {
  const oneLine = escapeInvisible(s).replace(/\s+/g, ' ').trim()
  return oneLine.length <= EVIDENCE_MAX ? oneLine : `${oneLine.slice(0, EVIDENCE_MAX - 1)}…`
}

function excerptAround(text: string, index: number): string {
  return excerpt(text.slice(Math.max(0, index - 20), index + 20))
}

// ── Scoring ───────────────────────────────────────────────────

const MAX_FLAGS = 20

/**
 * Score a memory candidate for poisoning signals. Pass every free-text field
 * that will be stored and later injected (decision, rationale, rejected
 * options + reasons). Null/empty fields should be omitted by the caller.
 *
 * Returns score 0 (safe) → 1 (hostile) plus one flag per tripped detector
 * (the strongest occurrence's evidence). Contributions are deduped per
 * detector, so repeating the same trick doesn't stack the score.
 */
export function scoreMemoryTrust(texts: string[]): TrustScoreResult {
  // Strongest weight + evidence per detector across all fields.
  const hits = new Map<string, { type: TrustFlagType; weight: number; evidence: string }>()

  for (const text of texts) {
    if (!text) continue

    for (const det of DETECTORS) {
      for (const occ of det.find(text)) {
        const dampened = det.dampenable && inDiscussedContext(text, occ.index)
        const weight = dampened ? det.weight * DAMPEN_DISCUSSED : det.weight
        const prev = hits.get(det.id)
        if (prev && prev.weight >= weight) continue
        hits.set(det.id, {
          type:     det.type,
          weight,
          evidence: occ.evidence ?? excerpt(occ.match),
        })
      }
    }

    if (text.length > ANOMALOUS_FIELD_LENGTH) {
      const prev = hits.get('anomalous_length')
      if (!prev) {
        hits.set('anomalous_length', {
          type:     'anomalous_length',
          weight:   0.3,
          evidence: `field length ${text.length} > ${ANOMALOUS_FIELD_LENGTH}`,
        })
      }
    }
  }

  // Noisy-OR combination over per-detector max weights.
  let survival = 1
  const flags: TrustFlag[] = []
  for (const hit of [...hits.values()].sort((a, b) => b.weight - a.weight)) {
    survival *= 1 - hit.weight
    if (flags.length < MAX_FLAGS) flags.push({ type: hit.type, evidence: hit.evidence })
  }

  return { score: Math.round((1 - survival) * 100) / 100, flags }
}

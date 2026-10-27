// packages/shared/src/capture-gate.ts
// ─────────────────────────────────────────────────────────────
// Stage 1 of the decision classifier: the keyword gate that decides
// whether a turn is worth an extraction call at all. Shared so
// Sensing (live turns) and Perception (`robrain capture test`
// preview) answer "would this turn reach the model?" the same way.
// ─────────────────────────────────────────────────────────────

import type { CaptureSettings } from './capture-settings.js'

export const DECISION_KEYWORDS = [
  'decided', 'decision', 'going with', 'we\'ll use', 'let\'s use',
  'instead of', 'switched to', 'switching to', 'rejected', 'won\'t use',
  'we tried', 'too slow', 'doesn\'t work', 'went with', 'chosen',
  'settled on', 'ruling out', 'dropping', 'replacing',
  // Casual commitments / conventions (often no spelled-out alternatives)
  'standardize', 'standardise', 'standardizing', 'moving to ',
  'migrate to', 'migrate from', 'defaults to', 'default to',
  'stick with', 'locking in', 'lock in',
]

// User-side affirmation tokens. When a decision keyword fires only in the
// assistant reply, we require one of these in the user message before
// treating the turn as a decision — otherwise an assistant suggestion the
// user silently scrolled past gets captured as a project decision.
const AFFIRMATION_PATTERNS: RegExp[] = [
  /\b(yes|yep|yeah|yup|sure)\b/i,
  /\b(agreed|agree|approved?)\b/i,
  /\blet['’]s\s+(do|go|use|try|ship|stick|adopt|switch|move|migrate)\b/i,
  /\b(go|going)\s+with\b/i,
  /\bsounds\s+good\b/i,
  /\bdo\s+it\b/i,
  /\bship\s+it\b/i,
]

// Imports / installs imply the action was carried out — count regardless
// of who wrote them.
const IMPLICIT_ACTION_PATTERNS = [
  /import .+ from ['"][^'"]+['"]/,
  /require\(['"][^'"]+['"]\)/,
  /npm install|pnpm add|yarn add/,
]

// "let's standardize on X"-style commitments must come from the user,
// otherwise they're a suggestion, not a decision. Standing rules ("never
// use X", "from now on …") belong here too: a reversal of a stored rule is
// usually phrased this way and must reach extraction in the same turn.
const IMPLICIT_USER_COMMITMENT_PATTERNS = [
  /\blet['’]s\s+(standardize|standardise|use|go with|stick with|adopt)\b/i,
  /\b(from now on|going forward)\b/i,
  /\b(always|never)\s+(use|write|add|call|prefer|put|name|run|import|suggest|commit|push|merge|install|mock)\b/i,
  /\b(don['’]t|do not|stop|no longer)\s+(use|using|write|writing|add|adding|call|calling|suggest|suggesting|import|importing)\b/i,
]

/**
 * In broad mode a user message shorter than this still skips the model:
 * "ok", "yes", "thanks" carry nothing to store, whatever the project asks for.
 */
export const BROAD_MODE_MIN_USER_CHARS = 24

export type CaptureGateReason = 'keyword' | 'implicit' | 'broad' | 'none'

export interface CaptureGateResult {
  /** True when the turn should be sent to the extraction model. */
  reachesModel: boolean
  reason: CaptureGateReason
}

/**
 * Decide whether a turn reaches the extraction model. Strict mode is the
 * keyword gate that has always run; broad mode lets every non-trivial turn
 * through so project instructions can ask for things no keyword announces.
 */
export function captureGate(
  turn: { user_message: string; claude_reply: string },
  settings?: Pick<CaptureSettings, 'mode'> | null,
): CaptureGateResult {
  const userText      = turn.user_message.toLowerCase()
  const assistantText = turn.claude_reply.toLowerCase()
  const userAffirmed  = AFFIRMATION_PATTERNS.some(p => p.test(turn.user_message))

  // Keyword in user_message: fires unconditionally. Keyword only in the
  // assistant reply: fires only if the user affirmed in the same turn.
  const keywordInUser      = DECISION_KEYWORDS.some(kw => userText.includes(kw))
  const keywordInAssistant = !keywordInUser && DECISION_KEYWORDS.some(kw => assistantText.includes(kw))
  if (keywordInUser || (keywordInAssistant && userAffirmed)) {
    return { reachesModel: true, reason: 'keyword' }
  }

  const implicitHit =
    IMPLICIT_ACTION_PATTERNS.some(p => p.test(`${turn.user_message} ${turn.claude_reply}`)) ||
    IMPLICIT_USER_COMMITMENT_PATTERNS.some(p => p.test(turn.user_message))
  if (implicitHit) return { reachesModel: true, reason: 'implicit' }

  if (settings?.mode === 'broad' && turn.user_message.trim().length >= BROAD_MODE_MIN_USER_CHARS) {
    return { reachesModel: true, reason: 'broad' }
  }

  return { reachesModel: false, reason: 'none' }
}

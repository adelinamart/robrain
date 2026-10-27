// packages/shared/src/extract-decision.ts
// ─────────────────────────────────────────────────────────────
// Single decision-extraction call shared by Sensing (classifier
// Stage 2) and Perception (flush-on-close re-extraction). The two
// packages used to carry near-identical copies "kept in sync"
// manually — and had already drifted: Sensing's prompt gained
// stricter NOT-a-decision rules (one-time troubleshooting,
// unaffirmed assistant proposals) that Perception's copy never
// received. This module is now the only place the prompt lives.
// ─────────────────────────────────────────────────────────────

import type { ExtractedDecision } from './types.js'
import { anthropicChat, openaiChat, resolveOpenAiBaseUrl, DEFAULT_OPENAI_BASE_URL, type LlmProvider } from './llm.js'
import {
  DEFAULT_CAPTURE_KIND,
  allowedKindNames,
  normalizeKindName,
  type CaptureSettings,
} from './capture-settings.js'

export const DECISION_EXTRACTION_SYSTEM_PROMPT = `You extract technical decisions from software development conversations.

A decision includes ANY of the following (not only formal deliberation):
- Explicit choice between alternatives, or adopting/rejecting a tool or approach
- Brief agreements or directions: e.g. "let's use X", "standardize on Y", "we'll go with Z", "stick with W"
- Constraints or conventions established for the repo or team (defaults, policies, "from now on")
- Plans that commit the work to a specific stack, package manager, library, or pattern

NOT a decision:
- pure questions with no commitment
- vague brainstorming with no resolution
- execution-only steps with no stable choice (e.g. "run the tests" with no policy change)
- one-time troubleshooting or runbook steps with no durable policy (e.g. "restart the app to pick up env changes", "delete the lock file and reinstall", "fully quit and reopen"). Test: would this guide a future choice, or is its value spent once executed? If spent, skip.
- diagnoses or explanations of why something broke, unless paired with a rule about how to handle it going forward
- a proposal made by the ASSISTANT that the user did not explicitly affirm. Look for user-side affirmation ("yes", "agreed", "let's do it", "go with that", "sounds good") or the user proceeding to execute the proposed action. If the assistant suggested something and the user moved on without affirming, do NOT extract.

Fields:
- "decision": one short imperative sentence stating WHAT was chosen or agreed as a durable rule/preference (max ~20 words). Procedural steps and one-time fixes are NOT decisions. If nothing durable was committed, null.
- "rationale": why, IF stated in the turn; otherwise null. Empty is normal for offhand agreement. Max 15 words.
- "rejected": options explicitly declined, IF any; otherwise []. An empty list is EXPECTED when alternatives were never discussed — do NOT treat that as "no decision".
- "confidence": 0.0–1.0. Use HIGH (e.g. 0.75–1.0) when the turn clearly states a commitment or resolution, even if brief. Use LOW only when speculative, purely exploratory, or ambiguous.

Output ONLY valid JSON. If no decision: {"decision": null, "rationale": null, "rejected": [], "confidence": 0}.
Never add explanation outside the JSON.
Schema: {"decision": string|null, "rationale": string|null, "rejected": [{"option": string, "reason": string}], "confidence": number}`

export interface ExtractDecisionLlmConfig {
  provider:         LlmProvider
  anthropicApiKey?: string
  anthropicModel:   string
  openaiApiKey?:    string
  openaiModel:      string
  openaiBaseUrl?:   string
  /**
   * Appended to the shared system prompt for this call only. Self-hosted
   * callers pass SELF_HOSTED_USER_RULE_OVERRIDE here; the base prompt stays
   * byte-identical so the published default (and cloud re-extraction) is
   * unchanged.
   */
  extraSystemRules?: string
  /**
   * The project's own capture settings. Their instructions and extra kinds
   * are appended after `extraSystemRules`; the base prompt is untouched, so a
   * project that set nothing extracts exactly as before.
   */
  capture?: CaptureSettings | null
}

/**
 * The prompt section a project's capture settings add. Empty when the
 * project asks for nothing beyond decisions. Instructions come last so
 * they can narrow or widen every rule above them, and kinds extend the
 * output schema with `kind` and `subject`.
 */
export function buildCaptureRules(capture: CaptureSettings | null | undefined): string {
  if (!capture) return ''
  const sections: string[] = []

  if (capture.kinds.length > 0) {
    const kindLines = capture.kinds.map(k => `- "${k.name}": ${k.description}`).join('\n')
    sections.push(
      `Besides decisions, this project also stores these kinds of memory:\n${kindLines}\n` +
      `The rules above about what is NOT a decision apply only to kind "${DEFAULT_CAPTURE_KIND}". ` +
      `A turn that contains an entry of one of the listed kinds must be returned even though it contains no decision and nothing durable was committed: ` +
      `set "kind" to that kind's name, put the entry in "entry" as one short factual sentence (what happened, when, with what result), ` +
      `set "subject" to a short stable label for the thing it is about (max 6 words, the same words each time so a newer entry about the same subject replaces the older one), ` +
      `set "confidence" to how sure you are that the turn contains such an entry, and leave "decision" null. ` +
      `When the turn contains a decision, return it as usual with "kind": "${DEFAULT_CAPTURE_KIND}", "entry": null and "subject": null. ` +
      `Never invent a kind that is not listed.\n` +
      `Schema: {"decision": string|null, "rationale": string|null, "rejected": [{"option": string, "reason": string}], "confidence": number, "kind": string, "entry": string|null, "subject": string|null}`,
    )
  }

  if (capture.instructions) {
    sections.push(`Project instructions for what to store (they refine the rules above; the output must stay valid JSON in the schema given):\n${capture.instructions}`)
  }

  return sections.join('\n\n')
}

/**
 * Self-hosted-only extraction rule. A user-stated revision must be captured
 * even when the assistant refuses it or restates an older rule — otherwise
 * the revision is swallowed and the conflict never surfaces for review.
 * Passed via ExtractDecisionLlmConfig.extraSystemRules, never baked into the
 * shared default, so it does not alter cloud extraction behaviour.
 */
export const SELF_HOSTED_USER_RULE_OVERRIDE = `User-stated rule wins:
- A durable rule is a standing instruction for future work in this repo or team (e.g. "from now on", "always", "never", "we no longer"). An instruction scoped to the current task, file, or step (e.g. "don't use that file", "stop logging here", "don't add tests for this one") is not durable; apply the rules above to it.
- If the user states a durable rule in this turn, extract that rule even when the assistant refuses it, cites an older rule, or says it will not follow the new one. In that case do not return null, and do not extract the older rule the assistant restates.`

/** Thrown when the selected provider's API key is missing — callers usually log-and-skip rather than record a failure. */
export class LlmKeyMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmKeyMissingError'
  }
}

/**
 * Output budget for one extraction. The schema is short, but a decision with
 * several rejected options and their reasons, wrapped in a code fence, ran past
 * the previous 300-token cap and was discarded as truncated JSON.
 */
const EXTRACTION_MAX_TOKENS = 600

/**
 * Unwrap a markdown code fence around the model's JSON. The closing fence is
 * optional: when the reply hits the token cap it is the closing fence that gets
 * cut off first, and the JSON inside is usually still complete.
 */
export function stripMarkdownJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
}

/**
 * Defensively validate the model's JSON into an ExtractedDecision — models
 * (especially mini tiers) can hallucinate or drop fields under structured-output
 * prompts. Throws SyntaxError when the text is not JSON at all.
 */
export function parseExtractedDecision(rawText: string, allowedKinds: readonly string[] = [DEFAULT_CAPTURE_KIND]): ExtractedDecision {
  const raw = JSON.parse(stripMarkdownJsonFence(rawText)) as {
    decision?:   string | null
    rationale?:  string | null
    rejected?:   unknown
    confidence?: number
    kind?:       unknown
    entry?:      unknown
    subject?:    unknown
  }
  const rejected = Array.isArray(raw.rejected)
    ? raw.rejected.filter(
        (x): x is { option: string; reason: string } =>
          x !== null && typeof x === 'object' &&
          typeof (x as { option?: unknown }).option === 'string' &&
          typeof (x as { reason?: unknown }).reason === 'string',
      )
    : []
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? raw.confidence
    : 0
  // A kind the project never declared is stored as a decision, not dropped:
  // the content is still the user's and `robrain review` can fix the label.
  const requestedKind = typeof raw.kind === 'string' ? normalizeKindName(raw.kind) : DEFAULT_CAPTURE_KIND
  const kind = allowedKinds.includes(requestedKind) ? requestedKind : DEFAULT_CAPTURE_KIND
  const subject = kind !== DEFAULT_CAPTURE_KIND && typeof raw.subject === 'string' && raw.subject.trim()
    ? raw.subject.trim().slice(0, 120)
    : null
  // The prompt keeps non-decision entries out of "decision" (the base rules
  // say null there when nothing was committed); the stored text is the same
  // column either way.
  const entry = kind !== DEFAULT_CAPTURE_KIND && typeof raw.entry === 'string' && raw.entry.trim()
    ? raw.entry.trim()
    : null
  return {
    decision:  entry ?? (typeof raw.decision === 'string' ? raw.decision : null),
    rationale: typeof raw.rationale === 'string' ? raw.rationale : null,
    rejected,
    confidence,
    kind,
    subject,
  }
}

/**
 * Run the decision-extraction prompt against the configured reasoning LLM.
 * Throws LlmKeyMissingError when the selected provider's key is absent, and
 * plain errors on HTTP / JSON failures — callers decide whether to record
 * telemetry (Sensing) or degrade to an empty extraction (Perception).
 */
export async function extractDecisionLlm(
  userMessage: string,
  claudeReply: string,
  cfg: ExtractDecisionLlmConfig,
): Promise<ExtractedDecision> {
  const userPrompt = `Session turn:
User: ${userMessage}
Claude: ${claudeReply}`

  const systemPrompt = [DECISION_EXTRACTION_SYSTEM_PROMPT, cfg.extraSystemRules, buildCaptureRules(cfg.capture)]
    .filter((section): section is string => Boolean(section))
    .join('\n\n')

  let rawText: string
  if (cfg.provider === 'openai') {
    const baseUrl = cfg.openaiBaseUrl ?? resolveOpenAiBaseUrl()
    if (!cfg.openaiApiKey && baseUrl === DEFAULT_OPENAI_BASE_URL) {
      throw new LlmKeyMissingError('OPENAI_API_KEY is not set — cannot run OpenAI decision extraction (set OPENAI_BASE_URL for keyless local servers)')
    }
    rawText = await openaiChat({
      apiKey:    cfg.openaiApiKey ?? '',
      model:     cfg.openaiModel,
      system:    systemPrompt,
      user:      userPrompt,
      maxTokens: EXTRACTION_MAX_TOKENS,
      baseUrl,
      json:      true,
    })
  } else {
    if (!cfg.anthropicApiKey?.trim()) {
      throw new LlmKeyMissingError('ANTHROPIC_API_KEY is not set — cannot run Haiku decision extraction')
    }
    rawText = await anthropicChat({
      apiKey:      cfg.anthropicApiKey.trim(),
      model:       cfg.anthropicModel,
      system:      systemPrompt,
      user:        userPrompt,
      maxTokens:   EXTRACTION_MAX_TOKENS,
      // Same turn, same extraction: the Anthropic API samples at temperature 1
      // unless told otherwise, which made a clear decision come back as
      // "no decision" on some runs and get extracted on others.
      temperature: 0,
    })
  }

  return parseExtractedDecision(rawText, allowedKindNames(cfg.capture))
}

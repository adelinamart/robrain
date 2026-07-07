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
}

/** Thrown when the selected provider's API key is missing — callers usually log-and-skip rather than record a failure. */
export class LlmKeyMissingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmKeyMissingError'
  }
}

export function stripMarkdownJsonFence(raw: string): string {
  const t = raw.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return m?.[1]?.trim() ?? t
}

/**
 * Defensively validate the model's JSON into an ExtractedDecision — models
 * (especially mini tiers) can hallucinate or drop fields under structured-output
 * prompts. Throws SyntaxError when the text is not JSON at all.
 */
export function parseExtractedDecision(rawText: string): ExtractedDecision {
  const raw = JSON.parse(stripMarkdownJsonFence(rawText)) as {
    decision?:   string | null
    rationale?:  string | null
    rejected?:   unknown
    confidence?: number
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
  return {
    decision:  typeof raw.decision === 'string' ? raw.decision : null,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : null,
    rejected,
    confidence,
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

  let rawText: string
  if (cfg.provider === 'openai') {
    const baseUrl = cfg.openaiBaseUrl ?? resolveOpenAiBaseUrl()
    if (!cfg.openaiApiKey && baseUrl === DEFAULT_OPENAI_BASE_URL) {
      throw new LlmKeyMissingError('OPENAI_API_KEY is not set — cannot run OpenAI decision extraction (set OPENAI_BASE_URL for keyless local servers)')
    }
    rawText = await openaiChat({
      apiKey:    cfg.openaiApiKey ?? '',
      model:     cfg.openaiModel,
      system:    DECISION_EXTRACTION_SYSTEM_PROMPT,
      user:      userPrompt,
      maxTokens: 300,
      baseUrl,
      json:      true,
    })
  } else {
    if (!cfg.anthropicApiKey?.trim()) {
      throw new LlmKeyMissingError('ANTHROPIC_API_KEY is not set — cannot run Haiku decision extraction')
    }
    rawText = await anthropicChat({
      apiKey:    cfg.anthropicApiKey.trim(),
      model:     cfg.anthropicModel,
      system:    DECISION_EXTRACTION_SYSTEM_PROMPT,
      user:      userPrompt,
      maxTokens: 300,
    })
  }

  return parseExtractedDecision(rawText)
}

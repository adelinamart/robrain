// packages/sensing-mcp/src/classifiers/index.ts
// ─────────────────────────────────────────────────────────────
// Three classifiers running on buffered session turns.
// All run async — none block the MCP hot path.
// Exception: topic-shift Stage 1 (embedding delta) returns
// inline from sensing_record_turn because Control needs it.
// ─────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk'
import type {
  SessionTurn,
  DecisionSignal,
  TopicShiftSignal,
  ReplyScore,
  ExtractedDecision,
  Scope,
} from '@robrain/shared'
import { THRESHOLDS, openaiChat, DEFAULT_OPENAI_BASE_URL } from '@robrain/shared'
import { config } from '../config.js'
import { embed, cosineDistance } from '../embeddings.js'

function stripMarkdownJsonFence(raw: string): string {
  const t = raw.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return m?.[1]?.trim() ?? t
}

let lastClassifierFailure: string | null = null
export function getLastClassifierFailure(): string | null {
  return lastClassifierFailure
}

/** Lazily built so the MCP process can start without ANTHROPIC_API_KEY (Cursor often omits it on reconnect). */
let anthropicClient: Anthropic | null | undefined

function getAnthropicClient(): Anthropic | null {
  if (anthropicClient !== undefined) return anthropicClient
  const key = config.anthropicApiKey.trim()
  if (!key) {
    anthropicClient = null
    return null
  }
  anthropicClient = new Anthropic({ apiKey: key })
  return anthropicClient
}

// ─────────────────────────────────────────────────────────────
// CLASSIFIER 1 — Decision classifier
// Stage 1: keyword heuristic (sync, instant)
// Stage 2: Haiku LLM confirm (async, ~300ms, only on keyword hit)
// ─────────────────────────────────────────────────────────────

const DECISION_KEYWORDS = [
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
// otherwise they're a suggestion, not a decision.
const IMPLICIT_USER_COMMITMENT_PATTERNS = [
  /\blet['’]s\s+(standardize|standardise|use|go with|stick with|adopt)\b/i,
]

export async function classifyDecision(
  turn: SessionTurn,
  projectId: string,
): Promise<DecisionSignal | null> {
  const userText      = turn.user_message.toLowerCase()
  const assistantText = turn.claude_reply.toLowerCase()
  const userAffirmed  = AFFIRMATION_PATTERNS.some(p => p.test(turn.user_message))

  // Stage 1 — keyword heuristic, user-biased.
  // Keyword in user_message: fires unconditionally. Keyword only in the
  // assistant reply: fires only if the user affirmed in the same turn.
  const keywordInUser      = DECISION_KEYWORDS.some(kw => userText.includes(kw))
  const keywordInAssistant = !keywordInUser && DECISION_KEYWORDS.some(kw => assistantText.includes(kw))
  const keywordHit         = keywordInUser || (keywordInAssistant && userAffirmed)

  const implicitHit = !keywordHit && (
    IMPLICIT_ACTION_PATTERNS.some(p => p.test(`${turn.user_message} ${turn.claude_reply}`)) ||
    IMPLICIT_USER_COMMITMENT_PATTERNS.some(p => p.test(turn.user_message))
  )

  if (!keywordHit && !implicitHit) {
    // No signal — skip LLM call entirely (~95% of turns)
    return null
  }

  // Stage 2 — Haiku LLM confirm
  const extracted = await extractDecision(turn)

  if (!extracted.decision || extracted.confidence < config.decisionConfidenceMin) {
    return null
  }

  // Infer scope heuristically (Sharing layer will refine later)
  const scope = inferScope(turn, extracted)

  return {
    turn,
    decision_type: classifyDecisionType(extracted.decision),
    confidence:    extracted.confidence,
    files_affected: turn.files_touched,
    scope,
    extracted,
  }
}

async function extractDecision(turn: SessionTurn): Promise<ExtractedDecision> {
  const systemPrompt = `You extract technical decisions from software development conversations.

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

  const userPrompt = `Session turn:
User: ${turn.user_message}
Claude: ${turn.claude_reply}`

  const empty = (): ExtractedDecision => ({ decision: null, rationale: null, rejected: [], confidence: 0 })

  try {
    let rawText: string

    if (config.llmProvider === 'openai') {
      if (!config.openaiApiKey && config.openaiBaseUrl === DEFAULT_OPENAI_BASE_URL) {
        console.error('[Sensing] OPENAI_API_KEY is not set — skipping OpenAI decision extraction (set OPENAI_BASE_URL for keyless local servers)')
        return empty()
      }
      rawText = await openaiChat({
        apiKey:    config.openaiApiKey ?? '',
        model:     config.openaiLlmModel,
        system:    systemPrompt,
        user:      userPrompt,
        maxTokens: 300,
        baseUrl:   config.openaiBaseUrl,
        json:      true,
      })
    } else {
      const client = getAnthropicClient()
      if (!client) {
        console.error('[Sensing] ANTHROPIC_API_KEY is not set — skipping Haiku decision extraction')
        return empty()
      }
      const response = await client.messages.create({
        model:      config.anthropicModel,
        max_tokens: 300,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      })
      const block = response.content[0]
      rawText = block?.type === 'text' ? block.text : '{}'
    }

    const parsed = JSON.parse(stripMarkdownJsonFence(rawText)) as ExtractedDecision
    lastClassifierFailure = null
    return parsed
  } catch (err) {
    lastClassifierFailure =
      `${new Date().toISOString()} ${turn.session_id} seq ${turn.sequence}: ${String(err)}`
    console.error('[Sensing] decision extraction failed:', err)
    // Parse/provider failure = treat as no decision
    return empty()
  }
}

function classifyDecisionType(decision: string): string {
  const d = decision.toLowerCase()
  if (/library|package|framework|sdk|dependency/.test(d)) return 'tooling'
  if (/database|schema|table|index|query/.test(d))        return 'data'
  if (/api|endpoint|route|rest|graphql/.test(d))          return 'api'
  if (/auth|security|permission|token/.test(d))           return 'security'
  if (/test|spec|mock|stub/.test(d))                      return 'testing'
  return 'architectural'
}

function inferScope(turn: SessionTurn, extracted: ExtractedDecision): Scope {
  // Files in shared/src or packages/ → team scope
  const sharedFiles = turn.files_touched.some(f =>
    f.includes('/shared/') || f.includes('/packages/')
  )
  if (sharedFiles) return 'team'

  // Personal config files → user scope
  const personalFiles = turn.files_touched.some(f =>
    f.includes('.env') || f.includes('dotfiles') || f.includes('~/')
  )
  if (personalFiles) return 'user'

  // Default: team scope for code decisions
  return 'team'
}

// ─────────────────────────────────────────────────────────────
// CLASSIFIER 2 — Topic-shift classifier
// Stage 1: embedding delta (fast, returns inline)
// Stage 2: file context check (async confirmation)
// ─────────────────────────────────────────────────────────────

// Rolling window of recent embeddings per session
const embeddingWindows = new Map<string, number[][]>()

export async function classifyTopicShift(
  turn: SessionTurn,
  signal?: AbortSignal,
): Promise<TopicShiftSignal | null> {
  if (config.topicShiftDisableEmbedding) return null

  const sessionId = turn.session_id
  const window = embeddingWindows.get(sessionId) ?? []

  // One embeddings API request per sensing_record_turn (user_message only).
  const currentEmbedding = await embed(turn.user_message, signal)

  let maxDistance = 0
  let shiftDetected = false

  if (window.length > 0) {
    // Compare against last N embeddings
    const compareWindow = window.slice(-config.topicShiftWindowSize)
    for (const prev of compareWindow) {
      const dist = cosineDistance(currentEmbedding, prev)
      maxDistance = Math.max(maxDistance, dist)
    }
    shiftDetected = maxDistance > config.topicShiftThreshold
  }

  // Update rolling window
  window.push(currentEmbedding)
  if (window.length > config.topicShiftWindowSize * 2) window.shift()
  embeddingWindows.set(sessionId, window)

  if (!shiftDetected) return null

  // Stage 2 — file context confirmation (strengthens confidence)
  const fileContextConfirmed = checkFileContextShift(sessionId, turn.files_touched)

  const confidence = fileContextConfirmed ? 'high' : 'medium'

  // Derive task description from the user message
  const taskDescription = deriveTaskDescription(turn.user_message)

  return {
    session_id:              sessionId,
    sequence:                turn.sequence,
    task_description:        taskDescription,
    confidence,
    embedding_distance:      maxDistance,
    file_context_confirmed:  fileContextConfirmed,
  }
}

// Track recent files per session to detect file context shifts
const recentFilesPerSession = new Map<string, Set<string>>()

function checkFileContextShift(sessionId: string, newFiles: string[]): boolean {
  const prev = recentFilesPerSession.get(sessionId) ?? new Set()
  const overlap = newFiles.filter(f => prev.has(f)).length
  const overlapRatio = newFiles.length > 0 ? overlap / newFiles.length : 0

  // Update recent files
  recentFilesPerSession.set(sessionId, new Set(newFiles))

  // Low overlap = file context shifted too
  return overlapRatio < 0.3
}

function deriveTaskDescription(userMessage: string): string {
  // Use first sentence or first 100 chars as task description
  const firstSentence = userMessage.split(/[.!?]/)[0]!.trim()
  return firstSentence.length > 100
    ? firstSentence.slice(0, 97) + '...'
    : firstSentence
}

export function clearSessionEmbeddings(sessionId: string): void {
  embeddingWindows.delete(sessionId)
  recentFilesPerSession.delete(sessionId)
}

// ─────────────────────────────────────────────────────────────
// CLASSIFIER 3 — Reply scorer
// v1: term matching (fast, noisy)
// v2: semantic similarity (accurate, ~100ms — add when needed)
// ─────────────────────────────────────────────────────────────

export async function scoreReply(
  turn: SessionTurn,
  injectedMemories: Array<{ id: string; decision: string; rationale?: string }>,
): Promise<ReplyScore | null> {
  if (injectedMemories.length === 0) return null

  const replyLower = turn.claude_reply.toLowerCase()
  let totalScore = 0

  for (const memory of injectedMemories) {
    // v1: term matching
    const terms = extractKeyTerms(`${memory.decision} ${memory.rationale ?? ''}`)
    const matchCount = terms.filter(t => replyLower.includes(t)).length
    const termScore = terms.length > 0 ? matchCount / terms.length : 0
    totalScore += termScore
  }

  const finalScore = injectedMemories.length > 0
    ? totalScore / injectedMemories.length
    : 0

  return {
    session_id:           turn.session_id,
    sequence:             turn.sequence,
    injected_memory_ids:  injectedMemories.map(m => m.id),
    term_match_score:     finalScore,
    final_score:          finalScore,
  }
}

function extractKeyTerms(text: string): string[] {
  // Extract meaningful terms — skip stop words and short tokens
  const stopWords = new Set([
    'the','a','an','and','or','but','in','on','at','to','for',
    'of','with','by','from','is','are','was','were','be','been',
    'use','used','using','this','that','we','our','it','its',
  ])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !stopWords.has(t))
}

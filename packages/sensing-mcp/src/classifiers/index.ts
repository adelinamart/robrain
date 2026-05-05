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
import { THRESHOLDS } from '@robrain/shared'
import { config } from '../config.js'
import { embed, cosineDistance } from '../embeddings.js'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

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

const IMPLICIT_DECISION_PATTERNS = [
  // Library imports as proxy for implicit decisions
  /import .+ from ['"][^'"]+['"]/,
  /require\(['"][^'"]+['"]\)/,
  // Framework switches
  /npm install|pnpm add|yarn add/,
  // Brief “let’s …” commitments without keyword hits above
  /\blet['']s\s+(standardize|standardise|use|go with|stick with|adopt)\b/i,
]

export async function classifyDecision(
  turn: SessionTurn,
  projectId: string,
): Promise<DecisionSignal | null> {
  const text = `${turn.user_message} ${turn.claude_reply}`.toLowerCase()

  // Stage 1 — keyword heuristic
  const keywordHit = DECISION_KEYWORDS.some(kw => text.includes(kw))
  const implicitHit = !keywordHit &&
    IMPLICIT_DECISION_PATTERNS.some(p => p.test(turn.user_message + turn.claude_reply))

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
  }
}

async function extractDecision(turn: SessionTurn): Promise<ExtractedDecision> {
  const systemPrompt = `You extract technical decisions from software development conversations.

A decision includes ANY of the following (not only formal deliberation):
- Explicit choice between alternatives, or adopting/rejecting a tool or approach
- Brief agreements or directions: e.g. "let's use X", "standardize on Y", "we'll go with Z", "stick with W"
- Constraints or conventions established for the repo or team (defaults, policies, "from now on")
- Plans that commit the work to a specific stack, package manager, library, or pattern

NOT a decision: pure questions with no commitment, vague brainstorming with no resolution, or execution-only steps with no stable choice (e.g. "run the tests" with no policy change).

Fields:
- "decision": one short imperative sentence stating WHAT was chosen or agreed (max ~20 words). If nothing was committed, null.
- "rationale": why, IF stated in the turn; otherwise null. Empty is normal for offhand agreement. Max 15 words.
- "rejected": options explicitly declined, IF any; otherwise []. An empty list is EXPECTED when alternatives were never discussed — do NOT treat that as "no decision".
- "confidence": 0.0–1.0. Use HIGH (e.g. 0.75–1.0) when the turn clearly states a commitment or resolution, even if brief. Use LOW only when speculative, purely exploratory, or ambiguous.

Output ONLY valid JSON. If no decision: {"decision": null, "rationale": null, "rejected": [], "confidence": 0}.
Never add explanation outside the JSON.
Schema: {"decision": string|null, "rationale": string|null, "rejected": [{"option": string, "reason": string}], "confidence": number}`

  const userPrompt = `Session turn:
User: ${turn.user_message}
Claude: ${turn.claude_reply}`

  try {
    const response = await anthropic.messages.create({
      model:      config.anthropicModel,
      max_tokens: 300,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const parsed = JSON.parse(text.trim()) as ExtractedDecision
    return parsed
  } catch {
    // Parse failure = treat as no decision
    return { decision: null, rationale: null, rejected: [], confidence: 0 }
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
): Promise<TopicShiftSignal | null> {
  const sessionId = turn.session_id
  const window = embeddingWindows.get(sessionId) ?? []

  // Embed current user message
  const currentEmbedding = await embed(turn.user_message)

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
  const firstSentence = userMessage.split(/[.!?]/)[0].trim()
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

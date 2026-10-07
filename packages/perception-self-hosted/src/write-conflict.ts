// Write-time clash check for POST /signals.
//
// Two kinds of close neighbor are dropped as duplicates: the same sentence
// (whitespace and a trailing period aside), and a cross-session neighbor at
// or above the 0.85 duplicate floor that the model explicitly calls a
// restatement. Every other close sentence is stored, including a
// refinement. When the model says the two cannot both be true, both rows
// are marked conflict_flag so review shows the clash immediately. A copy
// of a rule in an open clash is never dropped: it is stored and linked to
// that clash, so it can be the newer side. Synthesis still scans the rest
// of the corpus.

import { createHash } from 'node:crypto'
import { THRESHOLDS } from '@robrain/shared'

/**
 * Write-time question for one close neighbor. Synthesis Pass 2 asks a
 * different one (yes / no / related / extends) to type relation edges; that
 * set has no "same decision" answer, so it cannot tell a paraphrase from a
 * refinement and must not decide what gets dropped.
 */
export const NEIGHBOR_RELATION_PROMPT = `Compare two software decisions: A was recorded earlier, B is new.
Output ONLY one lowercase word: same, contradicts, refines, or different
- same: B restates A in other words; nothing is added, dropped, or changed
- contradicts: they cannot both be true
- refines: B keeps A and adds, narrows, or specializes something
- different: separate decisions that can both stand`

/**
 * `restatement` is the only answer that can drop the new row. `unknown`
 * means the check failed or the reply was unreadable and must never dedup.
 */
export type NeighborVerdict = 'contradiction' | 'restatement' | 'distinct' | 'unknown'

/** `ask` means put the relation question to the model; nothing is flagged yet. */
export type SaveDisposition = 'dedup' | 'ask' | 'write'

/**
 * Strict parse of the one-word reply. The whole reply must be one of the
 * four answers, with at most a trailing period. Anything else, including an
 * answer followed by commentary ("same? No, B reverses A") and the empty
 * string both chat clients return without throwing, maps to `unknown` so
 * the caller saves instead of deduping the new rule.
 */
export function parseNeighborVerdict(rawResponse: string): NeighborVerdict {
  switch (rawResponse.trim().toLowerCase().replace(/\.$/, '')) {
    case 'contradicts': return 'contradiction'
    case 'same':        return 'restatement'
    case 'refines':
    case 'different':   return 'distinct'
    default:            return 'unknown'
  }
}

/**
 * Sentence the agent should say when two decisions clash. It can reach the
 * agent a turn after the rule was stated, and the incoming row is not
 * always the later one, so it names both decisions in the order they were
 * stated.
 */
export function conflictNotice(earlierDecision: string, laterDecision: string): string {
  return `The newer decision ("${laterDecision.trim()}") conflicts with one stated earlier ("${earlierDecision.trim()}"). Both are saved and flagged for robrain review.`
}

/**
 * Folds only what cannot change meaning: whitespace runs and a trailing
 * period or exclamation mark. Case and every other symbol are kept, since
 * `>=` versus `<=` or `Foo` versus `foo` can be the whole revision.
 */
function normalizeText(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .trimEnd()
}

/**
 * True only when both decisions are the same sentence after whitespace and
 * a trailing period are folded. Any other change, including case, an
 * operator, or one swapped word in a long sentence, must reach the model.
 */
export function textNearIdentical(left: string, right: string): boolean {
  const leftKey = decisionTextKey(left)
  return leftKey.length > 0 && leftKey === decisionTextKey(right)
}

/**
 * Stored in decisions.decision_text_key so the clashed-copy lookup can use
 * an index. Two decisions are textNearIdentical exactly when their keys are
 * equal and not empty. Computed here, not in SQL, so both sides use the
 * same NFC and whitespace rules.
 */
export function decisionTextKey(decision: string): string {
  return normalizeText(decision)
}

/** Provenance snapshot stored on the decision row and compared on a retry. */
export const TURN_CAPTURE_EXCERPT_CHARS = 300

/**
 * Excerpt POST /signals stores for a turn. Sensing's source_excerpt wins
 * when it sent one; otherwise the user message. Only the first
 * TURN_CAPTURE_EXCERPT_CHARS characters are kept.
 */
export function turnSourceExcerpt(sourceExcerpt: string | undefined, userMessage: string): string | null {
  const raw = sourceExcerpt !== undefined ? sourceExcerpt : userMessage
  const sliced = raw.slice(0, TURN_CAPTURE_EXCERPT_CHARS)
  return sliced.length > 0 ? sliced : null
}

/**
 * True when two excerpts are the same stored prefix. An empty excerpt
 * matches nothing. Comparison is exact. The stored value is only the first
 * TURN_CAPTURE_EXCERPT_CHARS characters, so two different messages that
 * share that prefix still match. This is not the retry key: a row with no
 * turn hash is saved again instead of matched on the excerpt.
 */
export function sameTurnExcerpt(storedExcerpt: string | null, incomingExcerpt: string | null): boolean {
  if (!storedExcerpt || !incomingExcerpt) return false
  return storedExcerpt === incomingExcerpt
}

/** User message plus assistant reply, the two texts a retry sends again. */
export interface TurnIdentity {
  sourceExcerpt: string | null
  sourceTurnHash: string | null
}

/**
 * SHA-256 of the user message and the assistant reply. Lengths are written
 * first so the boundary between the two texts cannot collide. A short
 * agreement such as "yes" still differs when the reply that holds the
 * decision differs. A real retry sends both texts again, so it hashes the
 * same. The full texts are hashed, not the 300-character excerpt.
 */
export function turnSourceHash(userMessage: string, assistantReply: string): string {
  return createHash('sha256')
    .update(String(userMessage.length))
    .update('\0')
    .update(userMessage)
    .update('\0')
    .update(String(assistantReply.length))
    .update('\0')
    .update(assistantReply)
    .digest('hex')
}

/**
 * True when a stored row is a re-send of this turn. The agent picks the
 * sequence number, so the number alone is not enough. Both sides must
 * carry a turn hash, and the hashes must match. A row saved before the
 * hash column existed has nothing to verify, so a later turn that reuses
 * its sequence is saved.
 */
export function sameTurnCapture(stored: TurnIdentity, incoming: TurnIdentity): boolean {
  if (!stored.sourceTurnHash || !incoming.sourceTurnHash) return false
  return stored.sourceTurnHash === incoming.sourceTurnHash
}

export function withTurnIdentity<Capture extends {
  source_excerpt: string | null
  source_turn_hash: string | null
}>(capture: Capture): Capture & TurnIdentity {
  return {
    ...capture,
    sourceExcerpt: capture.source_excerpt,
    sourceTurnHash: capture.source_turn_hash,
  }
}

export function findMatchingTurnCapture<Capture extends TurnIdentity>(
  captures: readonly Capture[],
  incoming: TurnIdentity,
): Capture | undefined {
  return captures.find((capture) => sameTurnCapture(capture, incoming))
}

export type NeighborCheckStartup =
  | { action: 'ok' }
  | { action: 'refuse'; message: string }
  | { action: 'warn'; message: string }

function chatKeyPresent(apiKey: string | undefined): boolean {
  return Boolean(apiKey?.trim())
}

/**
 * What to do about the chat model the neighbor check will call.
 * A hosted provider with no key refuses to start. A local OpenAI-compatible
 * server is allowed to start, and warns once: if it does not answer with
 * one word, cross-session paraphrases are saved.
 */
export function neighborCheckStartup(input: {
  llmProvider: 'anthropic' | 'openai'
  anthropicApiKey: string
  openaiApiKey: string | undefined
  usingLocalChatServer: boolean
  localChatBaseUrl: string
}): NeighborCheckStartup {
  if (input.llmProvider === 'anthropic' && !chatKeyPresent(input.anthropicApiKey)) {
    return {
      action: 'refuse',
      message:
        '[RoBrain Perception OSS] Refusing to start: ANTHROPIC_API_KEY is empty.\n' +
        '  Set ANTHROPIC_API_KEY in .env, or run with LLM_PROVIDER=openai + OPENAI_API_KEY to avoid Anthropic.\n' +
        '  The neighbor check uses this same chat key. Without a chat model, a close paraphrase from an earlier session is saved instead of deduped.',
    }
  }
  if (input.llmProvider === 'openai' && !chatKeyPresent(input.openaiApiKey) && !input.usingLocalChatServer) {
    return {
      action: 'refuse',
      message:
        '[RoBrain Perception OSS] Refusing to start: LLM_PROVIDER=openai but OPENAI_API_KEY is empty.\n' +
        '  Set OPENAI_API_KEY in .env (same key also works for EMBEDDING_PROVIDER=openai),\n' +
        '  or set OPENAI_BASE_URL to a local OpenAI-compatible server (Ollama / LM Studio / vLLM).\n' +
        '  The neighbor check uses this same chat key. Without a chat model, a close paraphrase from an earlier session is saved instead of deduped.',
    }
  }
  if (input.llmProvider === 'openai' && input.usingLocalChatServer) {
    return {
      action: 'warn',
      message:
        `[RoBrain Perception OSS] WARNING: the write-time neighbor check uses a local chat server (${input.localChatBaseUrl}).\n` +
        '  Cross-session paraphrase dedup runs only when that server answers with one word: same, contradicts, refines, or different.\n' +
        '  A timeout, an error, or any other reply saves the decision, so near-duplicates collect in the summary and in robrain review.',
    }
  }
  return { action: 'ok' }
}

/**
 * What to do with a new decision given one same-scope neighbor. Close means
 * at least the contradiction floor (0.82), or the lower same-session
 * duplicate floor (0.78), whichever comes first. Below that, the new row is
 * stored on its own and Synthesis can still pair it.
 */
export function decideSaveDisposition(input: {
  similarity: number
  sameSession: boolean
  nearIdentical: boolean
}): SaveDisposition {
  const duplicateFloor = input.sameSession
    ? THRESHOLDS.DECISION_DEDUP_SIMILARITY_SAME_SESSION
    : THRESHOLDS.DECISION_DEDUP_SIMILARITY
  const closeFloor = Math.min(duplicateFloor, THRESHOLDS.SIMILARITY_LINK)
  if (input.similarity < closeFloor) return 'write'
  if (input.nearIdentical) return 'dedup'
  return 'ask'
}

/**
 * How many of the closest same-scope rows a save examines. Every close one
 * among them gets the relation question, so this also caps the chat calls.
 * The caller fetches one extra row: when that row is still close, the scan
 * was cut short and the save never dedups.
 */
export const NEIGHBOR_SCAN_LIMIT = 5

/**
 * Neighbors are closest first. Below both the contradiction floor and
 * the same-session duplicate floor, every later row is even less similar,
 * so the scan can stop.
 */
export function similarityBelowEveryFloor(similarity: number): boolean {
  const lowestFloor = Math.min(
    THRESHOLDS.SIMILARITY_LINK,
    THRESHOLDS.DECISION_DEDUP_SIMILARITY_SAME_SESSION,
  )
  return similarity < lowestFloor
}

/**
 * A cross-session neighbor the model calls a restatement is a duplicate
 * when it clears the cross-session duplicate floor (0.85). A refinement, a separate
 * decision, and a contradiction are all saved. A same-session pair is not
 * dropped here: the user may be revising the rule, and a wrong "same"
 * answer must not swallow that revision. An exact same-session
 * restatement is still dropped, by the near-identical check.
 */
export function dedupAfterNeighborCheck(input: {
  similarity: number
  sameSession: boolean
  verdict: NeighborVerdict
}): boolean {
  if (input.verdict !== 'restatement' || input.sameSession) return false
  return input.similarity >= THRESHOLDS.DECISION_DEDUP_SIMILARITY
}

export interface SaveNeighbor {
  id: string
  decision: string
  similarity: number
  sameSession: boolean
  /**
   * Active rows this row is still flagged against (see
   * loadConflictPartnerIds). Empty when it has no open clash.
   */
  conflictPartnerIds?: readonly string[]
}

/**
 * A stored row in an open clash, found by text rather than by embedding
 * rank, so a copy past the closest rows still passes its clash on.
 */
export interface ClashedCopy {
  id: string
  decision: string
  conflictPartnerIds: readonly string[]
}

export type SavePlan<Neighbor extends SaveNeighbor> =
  | { kind: 'dedup'; neighbor: Neighbor }
  | { kind: 'conflict'; conflictWithIds: string[] }
  | { kind: 'write' }

/**
 * Decide how POST /signals stores a new decision, given its same-scope
 * neighbors (closest first, NEIGHBOR_SCAN_LIMIT plus one) and every stored
 * row in an open clash whose text matches it.
 *
 * - Every close neighbor that is not the same sentence gets the relation
 *   question, concurrently, so the slow path costs one LLM round trip.
 * - The new row is saved and linked, with no model call, to every open
 *   clash partner of a row it matches word for word: that row already
 *   stands against those partners, so the copy does too. The same holds
 *   for a neighbor the model calls the same decision. Every neighbor the
 *   model says it contradicts is linked as well. Linking wins over every
 *   kind of duplicate, so going back to an older rule is stored as the
 *   newer side of its clash instead of merging into the older row.
 * - A duplicate is dropped only when nothing is linked, every question
 *   came back with an answer, and no close row was left past the scan.
 *   Then the same sentence (whitespace and a trailing period aside) is
 *   dropped, and so is a cross-session restatement that clears 0.85.
 *   A refinement, a separate decision, and a same-session revision are
 *   saved. A visible duplicate is reviewable; a dropped revision is not.
 */
export async function planDecisionSave<Neighbor extends SaveNeighbor>(
  incomingDecision: string,
  neighbors: readonly Neighbor[],
  compareWithNeighbor: (earlier: string, incoming: string) => Promise<NeighborVerdict>,
  clashedCopies: readonly ClashedCopy[] = [],
): Promise<SavePlan<Neighbor>> {
  const scanCutShort = neighbors
    .slice(NEIGHBOR_SCAN_LIMIT)
    .some((neighbor) => !similarityBelowEveryFloor(neighbor.similarity))
  const askable: Neighbor[] = []
  const textDuplicates: Neighbor[] = []
  for (const neighbor of neighbors.slice(0, NEIGHBOR_SCAN_LIMIT)) {
    if (similarityBelowEveryFloor(neighbor.similarity)) break
    const disposition = decideSaveDisposition({
      similarity: neighbor.similarity,
      sameSession: neighbor.sameSession,
      nearIdentical: textNearIdentical(incomingDecision, neighbor.decision),
    })
    if (disposition === 'dedup') textDuplicates.push(neighbor)
    if (disposition === 'ask') askable.push(neighbor)
  }

  const verdicts = await Promise.all(
    askable.map((neighbor) =>
      compareWithNeighbor(neighbor.decision, incomingDecision)
        .catch((): NeighborVerdict => 'unknown'),
    ),
  )

  const copies: Array<{ id: string; conflictPartnerIds?: readonly string[] }> = [
    ...textDuplicates,
    ...clashedCopies.filter((copy) => textNearIdentical(incomingDecision, copy.decision)),
  ]
  const copyIds = new Set(copies.map((copy) => copy.id))
  const conflictWithIds: string[] = []
  const link = (decisionId: string): void => {
    if (!copyIds.has(decisionId) && !conflictWithIds.includes(decisionId)) conflictWithIds.push(decisionId)
  }
  askable.forEach((neighbor, neighborIndex) => {
    if (verdicts[neighborIndex] === 'contradiction') link(neighbor.id)
  })
  for (const copy of copies) copy.conflictPartnerIds?.forEach(link)
  askable.forEach((neighbor, neighborIndex) => {
    if (verdicts[neighborIndex] === 'restatement') neighbor.conflictPartnerIds?.forEach(link)
  })
  if (conflictWithIds.length > 0) return { kind: 'conflict', conflictWithIds }

  const everyCheckAnswered = verdicts.every((verdict) => verdict === 'restatement' || verdict === 'distinct')
  if (!everyCheckAnswered || scanCutShort) return { kind: 'write' }
  const textDuplicate = textDuplicates[0]
  if (textDuplicate) return { kind: 'dedup', neighbor: textDuplicate }
  const restatement = askable.find((neighbor, neighborIndex) => dedupAfterNeighborCheck({
    similarity: neighbor.similarity,
    sameSession: neighbor.sameSession,
    verdict: verdicts[neighborIndex] ?? 'unknown',
  }))
  if (restatement) return { kind: 'dedup', neighbor: restatement }
  return { kind: 'write' }
}

/**
 * UTC instant at the same resolution as `timestamptz` (microseconds).
 * Fixed width, so lexicographic order matches PostgreSQL's comparison.
 * A JavaScript Date is milliseconds only and must not be used here: two
 * instants in the same millisecond would fall through to the row id while
 * the summary still orders them by the stored microseconds.
 */
export const CHRONOLOGY_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/** SQL expression for CHRONOLOGY_INSTANT. `expression` is a timestamptz. */
export function chronologyInstantSql(expression: string): string {
  return `to_char(${expression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/** When a decision was stated, as far as the write path can tell. */
export interface StatedAt {
  id: string
  sessionId: string
  turnSequence: number | null
  /** Sensing's turn timestamp, as CHRONOLOGY_INSTANT. Null on older rows. */
  turnAt: string | null
  /** Insert time, as CHRONOLOGY_INSTANT. */
  createdAt: string
}

/**
 * True when `later` was stated after `earlier`. Background extraction
 * commits turns in whatever order the model calls finish, so insert time
 * alone can put the earlier instruction last. Within one session the turn
 * sequence decides. Otherwise the turn timestamp decides, then insert
 * time, then row id. Both timestamps are compared at microsecond
 * resolution, the same order as the timestamptz tuple in the conflict_role
 * CASE in rankSummaryDecisions. The id is only the last key when those
 * instants are equal. Keep the two in step.
 */
export function statedAfter(later: StatedAt, earlier: StatedAt): boolean {
  if (
    later.sessionId === earlier.sessionId
    && later.turnSequence !== null
    && earlier.turnSequence !== null
    && later.turnSequence !== earlier.turnSequence
  ) {
    return later.turnSequence > earlier.turnSequence
  }
  const laterTime = later.turnAt ?? later.createdAt
  const earlierTime = earlier.turnAt ?? earlier.createdAt
  if (laterTime !== earlierTime) return laterTime > earlierTime
  if (later.createdAt !== earlier.createdAt) return later.createdAt > earlier.createdAt
  return later.id > earlier.id
}

const ISO_TIMESTAMP_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

/** How far a client clock may run ahead of Perception before its turn timestamp is ignored. */
export const MAX_TURN_CLOCK_LEAD_MS = 5 * 60_000

/**
 * When the user stated the turn, from Sensing's timestamp. A value that is
 * not ISO 8601 with a zone, or that runs ahead of the server by more than
 * MAX_TURN_CLOCK_LEAD_MS, is replaced by the receive time: a future stamp
 * would make its rule outrank every rule stated after it. A past stamp is
 * kept, because flush-on-close ships turns long after they were said.
 */
export function statedTurnTime(rawTimestamp: string, receivedAt: Date): Date {
  if (!ISO_TIMESTAMP_WITH_ZONE.test(rawTimestamp)) return receivedAt
  const parsed = new Date(rawTimestamp)
  if (Number.isNaN(parsed.getTime())) return receivedAt
  if (parsed.getTime() - receivedAt.getTime() > MAX_TURN_CLOCK_LEAD_MS) return receivedAt
  return parsed
}

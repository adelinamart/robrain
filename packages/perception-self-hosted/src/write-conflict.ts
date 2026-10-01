// Write-time clash check for POST /signals.
//
// Two kinds of close neighbor are dropped as duplicates: the same sentence
// (whitespace and a trailing period aside), and a cross-session neighbor at
// or above the 0.85 duplicate floor that the model explicitly calls a
// restatement. Every other close sentence is stored, including a
// refinement. When the model says the two cannot both be true, both rows
// are marked conflict_flag so review shows the clash immediately. Synthesis
// still scans the rest of the corpus.

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
  const normalizedLeft = normalizeText(left)
  const normalizedRight = normalizeText(right)
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) return false
  return normalizedLeft === normalizedRight
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

/** How many close neighbors get the relation question on one save. */
export const MAX_CONTRADICTION_NEIGHBORS = 2

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
  decision: string
  similarity: number
  sameSession: boolean
}

export type SavePlan<Neighbor extends SaveNeighbor> =
  | { kind: 'dedup'; neighbor: Neighbor }
  | { kind: 'conflict'; neighbor: Neighbor }
  | { kind: 'write' }

/**
 * Decide how POST /signals stores a new decision, given its same-scope
 * neighbors (closest first).
 *
 * - Up to MAX_CONTRADICTION_NEIGHBORS close neighbors that are not the same
 *   sentence get the relation question, asked concurrently so the slow path
 *   costs one LLM round trip.
 * - Any checked contradiction wins, closest first, over every kind of
 *   duplicate. Going back to an older rule matches the older row word for
 *   word, and that row is usually the closest neighbor; the newer rule it
 *   clashes with sits behind it and must still be flagged.
 * - With no contradiction, the same sentence (whitespace and a trailing
 *   period aside) is dropped, and so is a cross-session restatement that
 *   clears 0.85. A refinement, a separate decision, and a same-session
 *   revision are saved.
 * - An `unknown` answer (failed or malformed check) never drops the rule.
 * - A neighbor past the question cap was never checked, so it never drops
 *   the rule either. A visible duplicate is reviewable; a silently
 *   dropped revision is not.
 */
export async function planDecisionSave<Neighbor extends SaveNeighbor>(
  incomingDecision: string,
  neighbors: readonly Neighbor[],
  compareWithNeighbor: (earlier: string, incoming: string) => Promise<NeighborVerdict>,
): Promise<SavePlan<Neighbor>> {
  const candidates: Neighbor[] = []
  let textDuplicate: Neighbor | undefined
  for (const neighbor of neighbors) {
    if (similarityBelowEveryFloor(neighbor.similarity)) break
    const disposition = decideSaveDisposition({
      similarity: neighbor.similarity,
      sameSession: neighbor.sameSession,
      nearIdentical: textNearIdentical(incomingDecision, neighbor.decision),
    })
    if (disposition === 'dedup') {
      textDuplicate ??= neighbor
      continue
    }
    if (disposition === 'write') continue
    if (candidates.length >= MAX_CONTRADICTION_NEIGHBORS) continue
    candidates.push(neighbor)
  }

  const verdicts = await Promise.all(
    candidates.map((candidate) =>
      compareWithNeighbor(candidate.decision, incomingDecision)
        .catch((): NeighborVerdict => 'unknown'),
    ),
  )
  const conflict = candidates[verdicts.indexOf('contradiction')]
  if (conflict) return { kind: 'conflict', neighbor: conflict }
  if (textDuplicate) return { kind: 'dedup', neighbor: textDuplicate }
  const restatement = candidates.find((candidate, candidateIndex) => dedupAfterNeighborCheck({
    similarity: candidate.similarity,
    sameSession: candidate.sameSession,
    verdict: verdicts[candidateIndex] ?? 'unknown',
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
 * CASE in regenerateSummary. The id is only the last key when those
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

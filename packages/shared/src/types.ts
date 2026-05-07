// ============================================================
// Shared types — context-system/packages/shared/src/types.ts
// Imported by sensing-mcp, perception-self-hosted, cli, etc.
// ============================================================

// ── Primitives ────────────────────────────────────────────────

export type Scope = 'user' | 'local' | 'team' | 'global'

export type DecisionSource =
  | 'sensing'
  | 'user_correction'
  | 'claude_disagreement'

export type RelationType =
  | 'supersedes'
  | 'extends'
  | 'conflicts_with'
  | 'related_to'

export type FactType =
  | 'force_include'
  | 'force_exclude'
  | 'preference'
  | 'convention'

// ── Session ───────────────────────────────────────────────────

export interface Session {
  id: string
  project_id: string
  started_at: string
  ended_at?: string
  summary?: string
  metadata?: Record<string, unknown>
}

// ── Session turn (raw buffer unit) ───────────────────────────

export interface SessionTurn {
  session_id: string
  sequence: number
  user_message: string
  claude_reply: string
  files_touched: string[]
  tokens_used?: number
  timestamp: string
}

// ── Classifier outputs ────────────────────────────────────────

/** Output of the decision classifier */
export interface DecisionSignal {
  turn: SessionTurn
  decision_type: string            // 'architectural' | 'tooling' | 'convention' | etc
  confidence: number               // 0.0 – 1.0
  files_affected: string[]
  scope: Scope
  needs_classification?: boolean   // true = flush-on-close raw turn
  /** When set (Sensing Haiku path), Perception OSS should prefer this over re-extraction. */
  extracted?: ExtractedDecision
}

/** Output of the topic-shift classifier */
export interface TopicShiftSignal {
  session_id: string
  sequence: number
  task_description: string         // natural language description of new task
  confidence: 'high' | 'medium' | 'low'
  embedding_distance: number       // cosine distance that triggered the shift
  file_context_confirmed: boolean  // did Localization confirm file change too?
}

/** Output of the reply scorer */
export interface ReplyScore {
  session_id: string
  sequence: number
  injected_memory_ids: string[]
  term_match_score: number         // v1: simple term matching
  semantic_score?: number          // v2: cosine similarity (optional)
  final_score: number              // 0.0 – 1.0
}

// ── Perception API ────────────────────────────────────────────

/** POST /signals — Sensing → Perception */
export interface IngestSignalRequest {
  signal: DecisionSignal
}

export interface IngestSignalResponse {
  accepted: boolean
  decision_id?: string             // set if written to DB
  action: 'written' | 'discarded' | 'queued_for_contradiction_check'
  message?: string
}

/** POST /scores — Control → Perception (feedback loop) */
export interface IngestScoreRequest {
  scores: ReplyScore[]
}

/** POST /corrections — Control → Perception (user corrections) */
export interface CorrectionRequest {
  decision_id: string
  corrected_decision?: string
  corrected_rationale?: string
  invalidate?: boolean             // true = mark old as invalid
  approve?: boolean                // true = mark as user-approved (exclusive of invalidate)
  /** Clear conflict_flag and treat as reviewed (robrain review: "keep this" for conflicts). */
  resolved_conflict_keep?: boolean
  source: 'user_correction' | 'claude_disagreement'
}

// ── Extracted decision (Haiku output) ─────────────────────────

export interface ExtractedDecision {
  decision: string | null
  rationale: string | null
  rejected: Array<{ option: string; reason: string }>
  confidence: number
}

// ── Decision (DB row) ─────────────────────────────────────────

export interface Decision {
  id: string
  project_id: string
  session_id: string
  decision: string
  rationale?: string
  rejected: Array<{ option: string; reason: string }>
  files_affected: string[]
  confidence: number
  scope: Scope
  source: DecisionSource
  supersedes_id?: string
  invalidated_at?: string
  reviewed_at?: string
  auto_resolved: boolean
  conflict_flag: boolean
  needs_classification: boolean
  historical_relevance: number
  created_at: string
  updated_at: string
}

// ── Planning API ──────────────────────────────────────────────

/** POST /rank — Control → Planning on task boundary */
export interface RankRequest {
  project_id: string
  session_id: string
  task_description: string         // current What layer — drives retrieval
  files_in_scope: string[]         // files likely to be touched this task
  token_budget: number             // Control's available token budget (default 500)
}

export interface RankedMemory {
  decision_id: string
  decision: string
  rationale?: string
  rejected: Array<{ option: string; reason: string }>
  files_affected: string[]
  score: number                    // 0.0 – 1.0 composite score
  score_breakdown: {
    semantic_similarity: number
    file_overlap: number
    recency: number
    historical_relevance: number
  }
  provenance: {
    session_id: string
    created_at: string
    confidence: number
    scope: Scope
  }
  conflict_flag: boolean
  estimated_tokens: number         // rough token count for this memory
}

export interface RankResponse {
  memories: RankedMemory[]         // ordered by score desc, top-10 max
  total_estimated_tokens: number
  truncated: boolean               // true if more results were available
}

// ── Control MCP tools ─────────────────────────────────────────

/** Result of get_context MCP tool call */
export interface GetContextResult {
  memories: RankedMemory[]
  injected_at: string
  task_description: string
}

/** Result of record_correction MCP tool call */
export interface RecordCorrectionResult {
  success: boolean
  decision_id: string
  action: 'invalidated' | 'updated' | 'flagged'
}

// ── Mem0 facts (Planning explicit rules) ─────────────────────

export interface Mem0Fact {
  id: string
  project_id: string
  fact_type: FactType
  content: string
  scope: 'project' | 'user' | 'global'
  active: boolean
  created_at: string
}

// ── Planning blocks (Letta-style inferred) ────────────────────

export interface PlanningBlock {
  id: string
  project_id: string
  block_type: string
  content: string
  weight: number
  hit_count: number
}

// ── Project ───────────────────────────────────────────────────

export interface Project {
  id: string
  name: string
  mission?: string
  always_on_summary?: string
  last_session_at?: string
  created_at: string
}

// ── Utility ───────────────────────────────────────────────────

/** Token budget constants */
export const TOKEN_BUDGETS = {
  ALWAYS_ON_SUMMARY:  80,
  TASK_TRIGGERED:    300,
  ON_DEMAND:         500,
  PLANNING_MAX:      500,
} as const

/** Scoring weights for Planning */
export const SCORING_WEIGHTS = {
  SEMANTIC_SIMILARITY:    0.35,
  FILE_OVERLAP:           0.30,
  RECENCY:                0.20,
  HISTORICAL_RELEVANCE:   0.15,
} as const

/** Classifier thresholds */
export const THRESHOLDS = {
  DECISION_CONFIDENCE_MIN:   0.60,   // below = discard
  DECISION_CONFIDENCE_HIGH:  0.90,   // above = write immediately
  TOPIC_SHIFT_EMBEDDING:     0.35,   // cosine distance to trigger shift
  SIMILARITY_LINK:           0.82,   // above = check for contradiction
  RECENCY_HALF_LIFE_DAYS:    30,     // recency score halves every 30 days
} as const

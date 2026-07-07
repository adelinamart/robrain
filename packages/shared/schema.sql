-- RoBrain Database Schema
-- Apache 2.0 — https://github.com/adelinamart/robrain
-- ─────────────────────────────────────────────────────────────
-- Run this once against your Postgres instance.
-- Requires pgvector extension.
-- Docker Compose runs this automatically on first boot.
-- ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE SCHEMA IF NOT EXISTS context_system;

-- ── Projects ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS context_system.projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  mission            TEXT,
  always_on_summary  TEXT,         -- 3-line summary, regenerated after each session
  last_session_at    TIMESTAMPTZ DEFAULT now(),
  last_synthesis_at  TIMESTAMPTZ, -- last successful Synthesis batch pass (optional)
  working_directory  TEXT,        -- cwd where `robrain init-project` ran — post-Synthesis export-memory
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);

-- ── Sessions ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS context_system.sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES context_system.projects(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  summary     TEXT         -- one-sentence summary written at session end
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON context_system.sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON context_system.sessions(started_at DESC);

-- ── Decisions — the core table ─────────────────────────────────
-- This is the differentiator. rejected[] stores what was tried
-- and ruled out — no other memory tool has this field.

CREATE TABLE IF NOT EXISTS context_system.decisions (
  id                  TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  project_id          TEXT NOT NULL,
  session_id          TEXT NOT NULL REFERENCES context_system.sessions(id) ON DELETE CASCADE,

  -- What was decided
  decision            TEXT NOT NULL,

  -- Why (kept short — max 15 words)
  rationale           TEXT,

  -- THE DIFFERENTIATOR: what was tried and ruled out, with why
  -- [{option: "Redux", reason: "re-render performance issues in cart"}]
  rejected            JSONB NOT NULL DEFAULT '[]',

  -- Which files were being discussed when this decision was made
  files_affected      TEXT[] NOT NULL DEFAULT '{}',

  -- Classifier confidence 0–1
  confidence          FLOAT NOT NULL DEFAULT 0.8,

  -- user | local | team | global
  scope               TEXT NOT NULL DEFAULT 'team',

  -- sensing | user_correction | init | claude_disagreement
  source              TEXT NOT NULL DEFAULT 'sensing',

  -- Links to a decision this one replaces (for temporal graph)
  supersedes_id       TEXT REFERENCES context_system.decisions(id),

  -- True if this contradicts another active decision and needs review
  conflict_flag       BOOLEAN NOT NULL DEFAULT false,

  -- True if captured from flush-on-close and needs reprocessing
  needs_classification BOOLEAN NOT NULL DEFAULT false,

  -- Relevance score updated by feedback loop (Planning reads this)
  historical_relevance FLOAT NOT NULL DEFAULT 0.5,

  -- Provenance snapshot: originating turn sequence + ≤300-char user-message
  -- excerpt — survives session_turns cascade deletion
  source_turn_sequence INTEGER,
  source_excerpt      TEXT,

  -- Quality-loop counters: times injected vs times judged used in the reply
  injected_count      INTEGER NOT NULL DEFAULT 0,
  used_count          INTEGER NOT NULL DEFAULT 0,

  -- Set when decision is no longer valid — never hard-deleted
  -- History is always preserved and queryable
  invalidated_at      TIMESTAMPTZ,
  auto_resolved       BOOLEAN NOT NULL DEFAULT false,

  -- Set when the user explicitly approves a decision in `robrain review`.
  -- Approved decisions are filtered out of the default review feed so
  -- the user only sees what still needs attention; they remain visible
  -- under `robrain review --history`.
  reviewed_at         TIMESTAMPTZ,

  -- Embedding for semantic search (must match provider in Sensing + Perception)
  embedding           vector(1536),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_decisions_project     ON context_system.decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_session      ON context_system.decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created      ON context_system.decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_conflict     ON context_system.decisions(conflict_flag) WHERE conflict_flag = true;
CREATE INDEX IF NOT EXISTS idx_decisions_active       ON context_system.decisions(project_id) WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_unreviewed   ON context_system.decisions(project_id) WHERE invalidated_at IS NULL AND reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_embedding    ON context_system.decisions USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Decision relations — temporal causal graph ─────────────────

CREATE TABLE IF NOT EXISTS context_system.decision_relations (
  from_id    TEXT NOT NULL REFERENCES context_system.decisions(id) ON DELETE CASCADE,
  to_id      TEXT NOT NULL REFERENCES context_system.decisions(id) ON DELETE CASCADE,
  -- supersedes | extends | conflicts_with | related_to
  relation   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_id, to_id, relation)
);

-- ── Decision outcomes — real-world feedback ledger ────────────
-- Written by POST /outcomes: revert/incident sink historical_relevance
-- (and flag the decision for review), confirmed raises it.

CREATE TABLE IF NOT EXISTS context_system.decision_outcomes (
  id           TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  decision_id  TEXT NOT NULL REFERENCES context_system.decisions(id) ON DELETE CASCADE,
  -- revert | incident | confirmed
  outcome      TEXT NOT NULL CHECK (outcome IN ('revert', 'incident', 'confirmed')),
  evidence     TEXT,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outcomes_decision ON context_system.decision_outcomes(decision_id);

-- ── Session turns — raw buffer for Sensing ────────────────────

CREATE TABLE IF NOT EXISTS context_system.session_turns (
  id           TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  session_id   TEXT NOT NULL REFERENCES context_system.sessions(id) ON DELETE CASCADE,
  sequence     INTEGER NOT NULL,
  user_message TEXT NOT NULL,
  claude_reply TEXT NOT NULL,
  files_touched TEXT[] NOT NULL DEFAULT '{}',
  timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON context_system.session_turns(session_id);

-- ── Mem0 facts — explicit developer rules ─────────────────────

CREATE TABLE IF NOT EXISTS context_system.mem0_facts (
  id          TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  project_id  TEXT NOT NULL,
  -- force_include | force_exclude | preference | convention | procedure
  fact_type   TEXT NOT NULL,
  content     TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT 'project',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_facts_project ON context_system.mem0_facts(project_id) WHERE active = true;

-- ── Planning blocks — inferred method layer ───────────────────
-- Populated by OSS **@robrain/synthesis** (compiled_truth, drift_signal, entity) and by
-- **cloud Planning / Control** for other block_types. Not unused in OSS — Synthesis upserts
-- rows keyed by (project_id, block_type, topic) with last_refreshed_at for injection surfaces.

CREATE TABLE IF NOT EXISTS context_system.planning_blocks (
  id                 TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  project_id         TEXT NOT NULL,
  block_type         TEXT NOT NULL,
  topic              TEXT,              -- topic key for Synthesis upserts (e.g. state-management, Redis)
  content            TEXT NOT NULL,
  weight             FLOAT NOT NULL DEFAULT 1.0,
  hit_count          INTEGER NOT NULL DEFAULT 0,
  last_refreshed_at  TIMESTAMPTZ DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One compiled row per (project, block_type, topic) when topic is set — avoids duplicate planning_blocks each Synthesis run.
CREATE UNIQUE INDEX IF NOT EXISTS planning_blocks_unique_topic
  ON context_system.planning_blocks(project_id, block_type, topic)
  WHERE topic IS NOT NULL;

-- ── Semantic search function ───────────────────────────────────

CREATE OR REPLACE FUNCTION context_system.search_decisions(
  query_embedding vector(1536),
  p_project_id    TEXT,
  p_limit         INTEGER DEFAULT 20,
  p_min_similarity FLOAT DEFAULT 0.4
)
RETURNS TABLE (
  id                   TEXT,
  decision             TEXT,
  rationale            TEXT,
  rejected             JSONB,
  files_affected       TEXT[],
  confidence           FLOAT,
  scope                TEXT,
  historical_relevance FLOAT,
  created_at           TIMESTAMPTZ,
  similarity           FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id, d.decision, d.rationale, d.rejected,
    d.files_affected, d.confidence, d.scope,
    d.historical_relevance, d.created_at,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM context_system.decisions d
  JOIN context_system.sessions s ON s.id = d.session_id
  WHERE s.project_id = p_project_id
    AND d.invalidated_at IS NULL
    AND d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) >= p_min_similarity
  ORDER BY d.embedding <=> query_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

-- ── File overlap search function ───────────────────────────────

CREATE OR REPLACE FUNCTION context_system.decisions_by_file_overlap(
  p_project_id TEXT,
  p_files      TEXT[]
)
RETURNS TABLE (
  id             TEXT,
  decision       TEXT,
  files_affected TEXT[],
  overlap_count  BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    d.id, d.decision, d.files_affected,
    cardinality(ARRAY(
      SELECT unnest(d.files_affected)
      INTERSECT
      SELECT unnest(p_files)
    ))::BIGINT AS overlap_count
  FROM context_system.decisions d
  JOIN context_system.sessions s ON s.id = d.session_id
  WHERE s.project_id = p_project_id
    AND d.invalidated_at IS NULL
    AND d.files_affected && p_files
  ORDER BY overlap_count DESC
  LIMIT 20;
END;
$$ LANGUAGE plpgsql;

-- ── Useful views ───────────────────────────────────────────────

CREATE OR REPLACE VIEW context_system.active_decisions AS
  SELECT d.*
  FROM context_system.decisions d
  JOIN context_system.sessions s ON s.id = d.session_id
  WHERE d.invalidated_at IS NULL;

CREATE OR REPLACE VIEW context_system.pending_conflicts AS
  SELECT d.*
  FROM context_system.decisions d
  JOIN context_system.sessions s ON s.id = d.session_id
  WHERE d.conflict_flag = true
    AND d.invalidated_at IS NULL;

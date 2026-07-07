-- Version 2 — provenance snapshot + quality-loop counters + outcome ledger.
ALTER TABLE $SCHEMA.decisions
  ADD COLUMN IF NOT EXISTS source_turn_sequence INTEGER,
  ADD COLUMN IF NOT EXISTS source_excerpt TEXT,
  ADD COLUMN IF NOT EXISTS injected_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS used_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS $SCHEMA.decision_outcomes (
  id           TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  decision_id  TEXT NOT NULL REFERENCES $SCHEMA.decisions(id) ON DELETE CASCADE,
  -- revert | incident | confirmed
  outcome      TEXT NOT NULL CHECK (outcome IN ('revert', 'incident', 'confirmed')),
  evidence     TEXT,
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outcomes_decision ON $SCHEMA.decision_outcomes(decision_id);

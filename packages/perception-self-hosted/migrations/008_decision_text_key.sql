-- Version 8 — indexed lookup for an exact copy of a rule in an open clash.
-- decision_text_key is decisionTextKey(decision), computed in Perception so
-- it uses the same NFC and whitespace rules as the planner. NULL on rows
-- saved before this column until the startup backfill reaches them; the
-- lookup still reads those rows, so none is skipped.
ALTER TABLE $SCHEMA.decisions
  ADD COLUMN IF NOT EXISTS decision_text_key TEXT;

CREATE INDEX IF NOT EXISTS idx_decisions_clash_text_key
  ON $SCHEMA.decisions (project_id, scope, decision_text_key)
  WHERE conflict_flag AND invalidated_at IS NULL AND quarantined_at IS NULL;

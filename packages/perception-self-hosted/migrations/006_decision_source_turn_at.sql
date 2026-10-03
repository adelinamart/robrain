-- Version 6 — when the user stated the decision (Sensing's turn timestamp).
-- Extraction runs per turn in the background, so created_at is commit order
-- and a slow earlier turn can land after a later one. conflict:newer /
-- conflict:older compare turn sequence within a session and source_turn_at
-- across sessions. NULL on rows saved before this column; those fall back
-- to created_at.
ALTER TABLE $SCHEMA.decisions
  ADD COLUMN IF NOT EXISTS source_turn_at TIMESTAMPTZ;

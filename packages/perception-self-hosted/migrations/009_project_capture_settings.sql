-- Version 9 — per-project capture settings and memory kinds.
--
-- projects.capture_*: what the classifier stores for this project, in the
-- user's own words (robrain capture). NULL / 'strict' / NULL / '[]' is the
-- stock classifier, so rows that never set anything behave as before.
--
-- decisions.kind: 'decision' for every row the stock prompt produces, or one
-- of the project's declared capture kinds. decisions.subject: set on
-- non-decision kinds; a newer row with the same kind and subject supersedes
-- the older one, so a kind can hold changing state (the last agent run).
ALTER TABLE $SCHEMA.projects
  ADD COLUMN IF NOT EXISTS capture_instructions   TEXT,
  ADD COLUMN IF NOT EXISTS capture_mode           TEXT NOT NULL DEFAULT 'strict',
  ADD COLUMN IF NOT EXISTS capture_confidence_min REAL,
  ADD COLUMN IF NOT EXISTS capture_kinds          JSONB NOT NULL DEFAULT '[]';

ALTER TABLE $SCHEMA.decisions
  ADD COLUMN IF NOT EXISTS kind    TEXT NOT NULL DEFAULT 'decision',
  ADD COLUMN IF NOT EXISTS subject TEXT;

CREATE INDEX IF NOT EXISTS idx_decisions_kind_subject
  ON $SCHEMA.decisions (project_id, kind, lower(subject))
  WHERE invalidated_at IS NULL AND subject IS NOT NULL;

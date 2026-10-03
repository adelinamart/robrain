-- Version 7 — identity of the turn a decision came from.
-- Same-sequence dedup used to compare the first 300 characters of the user
-- message. A reused number whose user text is only "yes" then dropped a
-- new decision that extraction took from a different assistant reply.
-- source_turn_hash is the SHA-256 of the user message and that reply.
-- NULL on rows saved before this column; those still match on source_excerpt.
ALTER TABLE $SCHEMA.decisions
  ADD COLUMN IF NOT EXISTS source_turn_hash TEXT;

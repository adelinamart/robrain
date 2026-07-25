-- Version 5 — planning_blocks provenance hash (skip-recompute).
-- Fingerprint of (sorted source decision ids + the rubric text that compiled
-- the block). When a Synthesis run computes the same fingerprint for a topic,
-- the block's inputs are unchanged — the LLM compile call is skipped and the
-- row left untouched. A source-set change, a source invalidation (which
-- removes the id from the recomputed set), or a rubric edit all change the
-- fingerprint and force a fresh compile.
ALTER TABLE $SCHEMA.planning_blocks
  ADD COLUMN IF NOT EXISTS provenance_hash TEXT;

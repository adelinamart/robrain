-- Version 4 — planning_blocks provenance.
-- Every Synthesis-compiled block records WHICH decisions produced it, so
-- a compiled line is auditable ("show me why") and staleness is detectable
-- when a source decision is later invalidated. Without source_ids a
-- compiled_truth built from a since-invalidated decision keeps riding the
-- always-on summary until the next Synthesis run happens to rewrite it.
--
-- confidence = reviewed-decision ratio of the source set (0.00–1.00).
-- 1.00 means every source row was user-approved in `robrain review`; lower
-- means the block leans on pending-review material. compiled_truth sources
-- are always reviewed (the review gate in Synthesis Pass 1), but its ratio
-- is measured against the whole cluster the sentence claims to summarise.
ALTER TABLE $SCHEMA.planning_blocks
  ADD COLUMN IF NOT EXISTS source_ids TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS confidence NUMERIC(3,2);

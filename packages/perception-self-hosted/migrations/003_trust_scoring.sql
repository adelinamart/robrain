-- Version 3 — write-time trust scoring (memory-poisoning defense, OWASP ASI06).
-- Suspicious rows are stored but QUARANTINED: quarantined_at set at ingest,
-- excluded from every injection surface until a human approves the decision
-- in `robrain review` (which sets quarantine_released_at and clears
-- quarantined_at). Never silently dropped.
ALTER TABLE $SCHEMA.decisions
  ADD COLUMN IF NOT EXISTS trust_score            NUMERIC(3,2),
  ADD COLUMN IF NOT EXISTS trust_flags            JSONB,
  ADD COLUMN IF NOT EXISTS quarantined_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quarantine_released_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_decisions_quarantined
  ON $SCHEMA.decisions(project_id)
  WHERE quarantined_at IS NOT NULL;

-- search_decisions() is a retrieval surface — recreate it with the
-- quarantine gate (mirrors the updated definition in shared/schema.sql).
CREATE OR REPLACE FUNCTION $SCHEMA.search_decisions(
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
  FROM $SCHEMA.decisions d
  JOIN $SCHEMA.sessions s ON s.id = d.session_id
  WHERE s.project_id = p_project_id
    AND d.invalidated_at IS NULL
    AND d.quarantined_at IS NULL
    AND d.embedding IS NOT NULL
    AND 1 - (d.embedding <=> query_embedding) >= p_min_similarity
  ORDER BY d.embedding <=> query_embedding
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;

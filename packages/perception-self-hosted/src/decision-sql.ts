// SQL that POST /signals and the always-on summary share with the Postgres tests.
// Schema is interpolated only after it passes the identifier check index.ts
// already applies to DB_SCHEMA.

import type pg from 'pg'
import { chronologyInstantSql, findMatchingTurnCapture, textNearIdentical, withTurnIdentity, type ClashedCopy } from './write-conflict.js'

/** Three unresolved pairs; leaves at least 9 of the 15 high-signal slots for other rules. */
export const MAX_PINNED_CONFLICT_ROWS = 6

export interface TurnCapture {
  id: string
  reviewed_at: Date | null
  source_excerpt: string | null
  source_turn_hash: string | null
}

export interface SummaryRankRow {
  decision: string
  rationale: string | null
  rejected: Array<{ option: string; reason: string }>
  reviewed_at: Date | null
  scope: string
  conflict_role: 'newer' | 'older' | null
}

// Same identifier rule as validateSchemaName in index.ts. Repeated here so
// this module checks the name it interpolates, even if a caller skipped that.
function checkedSchema(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(`Invalid schema "${schema}"`)
  }
  return schema
}

/**
 * Rows already stored for this session and turn number, in any state.
 * A quarantined, invalidated, or review-corrected row still counts.
 * No LIMIT: the caller matches on the turn hash, and the matching row may
 * sit behind an older row that reused the same sequence. A null hash is an
 * older row and is not a retry match.
 */
export async function loadTurnCaptures(
  queryable: pg.Pool | pg.PoolClient,
  schema: string,
  projectId: string,
  sessionId: string,
  sourceTurnSequence: number,
): Promise<TurnCapture[]> {
  const safeSchema = checkedSchema(schema)
  const { rows } = await queryable.query<TurnCapture>(`
    SELECT id, reviewed_at, source_excerpt, source_turn_hash
    FROM ${safeSchema}.decisions
    WHERE session_id = $1
      AND project_id = $2
      AND source_turn_sequence = $3
    ORDER BY created_at
  `, [sessionId, projectId, sourceTurnSequence])
  return rows
}

export interface DecisionWriteInput {
  projectId: string
  sessionId: string
  decision: string
  rationale: string | null
  rejected: unknown
  filesAffected: readonly string[]
  confidence: number
  scope: string
  embedding: number[] | null
  sourceTurnSequence: number
  sourceExcerpt: string | null
  /** SHA-256 of the user message and the assistant reply. Null is not stored for new rows. */
  sourceTurnHash: string
  trustScore: number
  trustFlags: unknown
  quarantine: boolean
  sourceTurnAt: Date
  /** Rows the new decision clashes with (see planDecisionSave). Ignored while quarantined. */
  conflictWithIds: readonly string[]
}

export interface DecisionWriteHooks {
  /** Runs after the turn lock is held and before the duplicate check. */
  afterLock?: () => Promise<void>
}

export type DecisionWriteResult =
  | { status: 'deduped'; matched: TurnCapture; captures: TurnCapture[] }
  | {
      status: 'inserted'
      id: string
      sourceTurnAt: string | null
      createdAt: string
      captures: TurnCapture[]
    }

/**
 * Insert one decision, or roll back when this turn's hash is already stored.
 * A stored row with no hash is not a retry, so the new decision is saved.
 * The lock, the duplicate check, the insert, every conflict flag, and every
 * conflicts_with edge share the transaction: a failed flag or edge write leaves
 * no row for the next retry to treat as already captured.
 */
export async function commitDecisionWrite(
  pool: pg.Pool,
  schema: string,
  input: DecisionWriteInput,
  hooks?: DecisionWriteHooks,
): Promise<DecisionWriteResult> {
  const safeSchema = checkedSchema(schema)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await lockTurnCapture(client, input.projectId, input.sessionId, input.sourceTurnSequence)
    if (hooks?.afterLock) await hooks.afterLock()
    const captures = await loadTurnCaptures(
      client,
      safeSchema,
      input.projectId,
      input.sessionId,
      input.sourceTurnSequence,
    )
    const matched = findMatchingTurnCapture(
      captures.map((capture) => withTurnIdentity(capture)),
      { sourceExcerpt: input.sourceExcerpt, sourceTurnHash: input.sourceTurnHash },
    )
    if (matched) {
      await client.query('ROLLBACK')
      return { status: 'deduped', matched, captures }
    }
    const { rows } = await client.query<{ id: string; source_turn_at: string | null; created_at: string }>(`
      INSERT INTO ${safeSchema}.decisions (
        project_id, session_id, decision, rationale,
        rejected, files_affected, confidence, scope, source, embedding,
        source_turn_sequence, source_excerpt, source_turn_hash,
        trust_score, trust_flags, quarantined_at, source_turn_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, 'sensing', $9::vector, $10, $11, $12,
                $13, $14::jsonb, CASE WHEN $15::boolean THEN now() END, $16)
      RETURNING id,
        ${chronologyInstantSql('source_turn_at')} AS source_turn_at,
        ${chronologyInstantSql('created_at')} AS created_at
    `, [
      input.projectId,
      input.sessionId,
      input.decision,
      input.rationale,
      JSON.stringify(input.rejected),
      input.filesAffected,
      input.confidence,
      input.scope,
      input.embedding == null ? null : JSON.stringify(input.embedding),
      input.sourceTurnSequence,
      input.sourceExcerpt,
      input.sourceTurnHash,
      input.trustScore,
      JSON.stringify(input.trustFlags),
      input.quarantine,
      input.sourceTurnAt,
    ])
    const inserted = rows[0]
    if (!inserted) throw new Error('decision insert returned no row')
    if (input.conflictWithIds.length > 0 && !input.quarantine) {
      await client.query(
        `UPDATE ${safeSchema}.decisions SET conflict_flag = true, updated_at = now() WHERE id = ANY($1::text[])`,
        [[inserted.id, ...input.conflictWithIds]],
      )
      await client.query(
        `INSERT INTO ${safeSchema}.decision_relations (from_id, to_id, relation)
         SELECT $1, partner_id, 'conflicts_with' FROM unnest($2::text[]) AS partner_id
         ON CONFLICT DO NOTHING`,
        [inserted.id, input.conflictWithIds],
      )
    }
    await client.query('COMMIT')
    return {
      status: 'inserted',
      id: inserted.id,
      sourceTurnAt: inserted.source_turn_at,
      createdAt: inserted.created_at,
      captures,
    }
  } catch (transactionError) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw transactionError
  } finally {
    client.release()
  }
}

// Open clash partners of `d`: rows joined to it by conflicts_with that are
// still active, while `d` itself is still flagged. The partner's own flag
// is not required. "Keep this" in review clears only the kept row, so after
// the user keeps one side the other side still stands against it, and a
// later return to that other side must reopen the clash. Clearing `d`
// (kept or approved) or invalidating the partner closes it.
function openPartnerSql(safeSchema: string): { join: string; where: string } {
  return {
    join: `
      JOIN ${safeSchema}.decision_relations r
        ON (r.from_id = d.id OR r.to_id = d.id)
       AND r.relation = 'conflicts_with'
      JOIN ${safeSchema}.decisions other
        ON other.id = CASE WHEN r.from_id = d.id THEN r.to_id ELSE r.from_id END`,
    where: `
      d.conflict_flag
      AND other.id <> d.id
      AND other.invalidated_at IS NULL
      AND other.quarantined_at IS NULL`,
  }
}

/** Open clash partners for the given decision ids. Ids with none are absent. */
export async function loadConflictPartnerIds(
  queryable: pg.Pool | pg.PoolClient,
  schema: string,
  decisionIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (decisionIds.length === 0) return new Map()
  const safeSchema = checkedSchema(schema)
  const openPartner = openPartnerSql(safeSchema)
  const { rows } = await queryable.query<{ decision_id: string; partner_ids: string[] }>(`
    SELECT d.id AS decision_id, array_agg(DISTINCT other.id ORDER BY other.id) AS partner_ids
    FROM ${safeSchema}.decisions d
    ${openPartner.join}
    WHERE d.id = ANY($1::text[])
      AND ${openPartner.where}
    GROUP BY d.id
  `, [decisionIds])
  return new Map(rows.map((row) => [row.decision_id, row.partner_ids]))
}

/**
 * Active same-scope rows in an open clash whose text matches `decision`
 * (textNearIdentical). Found by text, not embedding rank, so a copy that
 * is not among the closest rows still passes its clash to the new row.
 */
export async function loadClashedCopies(
  queryable: pg.Pool | pg.PoolClient,
  schema: string,
  projectId: string,
  scope: string,
  decision: string,
): Promise<ClashedCopy[]> {
  const safeSchema = checkedSchema(schema)
  const openPartner = openPartnerSql(safeSchema)
  const { rows } = await queryable.query<{ id: string; decision: string; partner_ids: string[] }>(`
    SELECT d.id, d.decision, array_agg(DISTINCT other.id ORDER BY other.id) AS partner_ids
    FROM ${safeSchema}.decisions d
    ${openPartner.join}
    WHERE d.project_id = $1
      AND d.scope = $2
      AND d.invalidated_at IS NULL
      AND d.quarantined_at IS NULL
      AND ${openPartner.where}
    GROUP BY d.id, d.decision
  `, [projectId, scope])
  return rows
    .filter((row) => textNearIdentical(decision, row.decision))
    .map((row) => ({ id: row.id, decision: row.decision, conflictPartnerIds: row.partner_ids }))
}

export interface StatedDecision {
  id: string
  session_id: string
  decision: string
  source_turn_sequence: number | null
  /** CHRONOLOGY_INSTANT, or null on rows saved before turn timestamps. */
  source_turn_at: string | null
  /** CHRONOLOGY_INSTANT. */
  created_at: string
}

/** Text and chronology of the given rows, for the conflict notice. */
export async function loadStatedDecisions(
  queryable: pg.Pool | pg.PoolClient,
  schema: string,
  decisionIds: readonly string[],
): Promise<StatedDecision[]> {
  if (decisionIds.length === 0) return []
  const safeSchema = checkedSchema(schema)
  const { rows } = await queryable.query<StatedDecision>(`
    SELECT id, session_id, decision, source_turn_sequence,
           ${chronologyInstantSql('source_turn_at')} AS source_turn_at,
           ${chronologyInstantSql('created_at')} AS created_at
    FROM ${safeSchema}.decisions
    WHERE id = ANY($1::text[])
  `, [decisionIds])
  return rows.map((row) => ({
    ...row,
    source_turn_sequence: row.source_turn_sequence === null ? null : Number(row.source_turn_sequence),
  }))
}

/** Serializes two saves of the same session turn for the rest of the transaction. */
export async function lockTurnCapture(
  client: pg.PoolClient,
  projectId: string,
  sessionId: string,
  sourceTurnSequence: number,
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), $2)',
    [`${projectId}:${sessionId}`, sourceTurnSequence],
  )
}

/**
 * Ranked decisions for the always-on summary, including conflict_role and
 * the pinned-conflict tier.
 *
 * Newer means stated later, not inserted later: extraction runs per turn
 * in the background, so a slow earlier turn can commit after a later one.
 * Same session: turn sequence. Otherwise Sensing's turn timestamp, then
 * created_at, then row id when both instants are equal. timestamptz is
 * microseconds, so this CASE keeps that precision. statedAfter compares
 * the same instants as fixed-width UTC text, which sorts identically and
 * does not round them through a JavaScript Date. Keep the two in step.
 */
export async function rankSummaryDecisions(
  queryable: pg.Pool | pg.PoolClient,
  schema: string,
  projectId: string,
): Promise<SummaryRankRow[]> {
  const safeSchema = checkedSchema(schema)
  const { rows } = await queryable.query<SummaryRankRow>(`
    WITH active AS (
      SELECT d.id, d.decision, d.rationale, d.rejected, d.scope,
             d.reviewed_at, d.created_at,
             clash.conflict_role, clash.pair_stated_at
      FROM ${safeSchema}.decisions d
      JOIN ${safeSchema}.sessions s ON s.id = d.session_id
      LEFT JOIN LATERAL (
        SELECT CASE
                 WHEN other.session_id = d.session_id
                  AND other.source_turn_sequence IS NOT NULL
                  AND d.source_turn_sequence IS NOT NULL
                  AND other.source_turn_sequence <> d.source_turn_sequence
                 THEN CASE WHEN other.source_turn_sequence > d.source_turn_sequence THEN 'older' ELSE 'newer' END
                 WHEN (COALESCE(other.source_turn_at, other.created_at), other.created_at, other.id)
                    > (COALESCE(d.source_turn_at, d.created_at), d.created_at, d.id)
                 THEN 'older'
                 ELSE 'newer'
               END AS conflict_role,
               GREATEST(
                 COALESCE(other.source_turn_at, other.created_at),
                 COALESCE(d.source_turn_at, d.created_at)
               ) AS pair_stated_at
        FROM ${safeSchema}.decision_relations r
        JOIN ${safeSchema}.decisions other
          ON other.id = CASE WHEN r.from_id = d.id THEN r.to_id ELSE r.from_id END
        WHERE d.conflict_flag
          AND (r.from_id = d.id OR r.to_id = d.id)
          AND r.relation = 'conflicts_with'
          AND other.conflict_flag
          AND other.invalidated_at IS NULL
          AND other.quarantined_at IS NULL
        ORDER BY COALESCE(other.source_turn_at, other.created_at) DESC, other.created_at DESC
        LIMIT 1
      ) clash ON true
      WHERE s.project_id = $1
        AND d.invalidated_at IS NULL
        -- Trust gate: quarantined rows never reach the always-on summary.
        AND d.quarantined_at IS NULL
    ),
    pinned_conflicts AS (
      SELECT id
      FROM active
      WHERE conflict_role IS NOT NULL
      ORDER BY pair_stated_at DESC, created_at DESC
      LIMIT $2
    ),
    high_signal AS (
      SELECT *, 1 AS tier
      FROM active
      WHERE reviewed_at IS NOT NULL
         OR jsonb_array_length(rejected) > 0
         OR scope = 'global'
         OR id IN (SELECT id FROM pinned_conflicts)
      ORDER BY
        (id IN (SELECT id FROM pinned_conflicts))::int DESC,
        (reviewed_at IS NOT NULL)::int DESC,
        (jsonb_array_length(rejected) > 0)::int DESC,
        created_at DESC
      LIMIT 15
    ),
    recent_fill AS (
      SELECT *, 2 AS tier
      FROM active
      WHERE id NOT IN (SELECT id FROM high_signal)
      ORDER BY created_at DESC
      LIMIT 5
    )
    SELECT decision, rationale, rejected, reviewed_at, scope, conflict_role
    FROM (
      SELECT * FROM high_signal
      UNION ALL
      SELECT * FROM recent_fill
    ) merged
    ORDER BY tier ASC, created_at DESC
  `, [projectId, MAX_PINNED_CONFLICT_ROWS])
  return rows
}

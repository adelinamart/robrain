// packages/perception-self-hosted/src/index.ts
// ─────────────────────────────────────────────────────────────
// RoBrain — Self-hosted Perception API (OSS version)
//
// What this does:
//   - Receives decision signals from Sensing MCP
//   - Re-extracts with Sensing-aligned Haiku when needed; prefers signal.extracted from Sensing when present
//   - Writes to Postgres with pgvector
//   - Serves GET /decisions for robrain review + robrain inject
//
// What the Rory Plans cloud version adds on top:
//   - Veto-preserving extraction prompt (calibrated + few-shot)
//   - Planning scorer (5-signal relevance ranking incl. approval)
//   - Automatic context injection via Control MCP
//   - Conflict auto-resolution
//   - Web dashboard
//   - Team memory + scope filtering
// ─────────────────────────────────────────────────────────────

import { Hono }              from 'hono'
import type { Context }      from 'hono'
import { bodyLimit }         from 'hono/body-limit'
import { serve }             from '@hono/node-server'
import pg                    from 'pg'
import { z }                 from 'zod'
import { SCORING_WEIGHTS, THRESHOLDS, resolveLlmProvider, resolveOpenAiBaseUrl, redactSecrets, DEFAULT_ANTHROPIC_LLM_MODEL, DEFAULT_OPENAI_LLM_MODEL, DEFAULT_OPENAI_BASE_URL, DEFAULT_OPENAI_EMBEDDING_MODEL, resolveEmbeddingConfig, embed as sharedEmbed, EmbeddingProviderError, extractDecisionLlm } from '@robrain/shared'
import { applySqlMigrations } from './migrate.js'
import { bearerAuthorized } from './auth.js'
import { termMatchScore, judgeUsed, usageDelta, demotionDelta, outcomeDelta, scoreCounterIncrements } from './scoring.js'

const { Pool } = pg

// ── Config ────────────────────────────────────────────────────
const config = {
  port:            Number(process.env.PORT ?? 3001),
  apiKey:          process.env.PERCEPTION_API_KEY ?? '',
  allowUnauth:     process.env.ALLOW_UNAUTHENTICATED === 'true',
  databaseUrl:     requireEnv('DATABASE_URL'),
  schema:          validateSchemaName(process.env.DB_SCHEMA ?? 'context_system'),
  // Reasoning LLM for decision extraction. Default Anthropic (Haiku); set
  // LLM_PROVIDER=openai to extract with OpenAI instead (Anthropic-free setup).
  llmProvider:     resolveLlmProvider(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel:  process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_LLM_MODEL,
  // gpt-4o-mini can hallucinate fields under structured-output prompts —
  // prefer gpt-4o / gpt-4.1 for extraction fidelity. Reuses OPENAI_API_KEY.
  openaiLlmModel:  process.env.OPENAI_LLM_MODEL ?? DEFAULT_OPENAI_LLM_MODEL,
  // OPENAI_BASE_URL — point OpenAI-compatible chat + embeddings calls at
  // Ollama / LM Studio / vLLM for a fully-local setup. When set,
  // OPENAI_API_KEY becomes optional (local servers usually ignore auth).
  openaiBaseUrl:   resolveOpenAiBaseUrl(),
  ossMode:         process.env.OSS_MODE === 'true',
  // Provider/model/timeout/retry resolved by @robrain/shared — the same
  // resolver Sensing uses, so both sides always embed with the same model.
  embedding:       resolveEmbeddingConfig(),
  // Also reused by the OpenAI chat path when LLM_PROVIDER=openai.
  openaiApiKey:    process.env.OPENAI_API_KEY,
  rateLimitPerMinute: Number(process.env.PERCEPTION_RATE_LIMIT_PER_MINUTE ?? 120),
  bodyLimitBytes:  Number(process.env.PERCEPTION_BODY_LIMIT_BYTES ?? 1_000_000),
}

if (!config.apiKey && !config.allowUnauth) {
  console.error(
    '[RoBrain Perception OSS] Refusing to start: PERCEPTION_API_KEY is empty.\n' +
    '  Generate one with `openssl rand -hex 32` and set it in .env, or run\n' +
    '  `pnpm docker:up` which auto-generates one via scripts/prepare-env.mjs.\n' +
    '  To intentionally run unauthenticated (NOT recommended), set ALLOW_UNAUTHENTICATED=true.'
  )
  process.exit(1)
}
if (!config.apiKey && config.allowUnauth) {
  console.warn('[RoBrain Perception OSS] WARNING: running without auth (ALLOW_UNAUTHENTICATED=true).')
}

// Require the selected reasoning provider's key — extraction can't run without it.
if (config.llmProvider === 'anthropic' && !config.anthropicApiKey) {
  console.error(
    '[RoBrain Perception OSS] Refusing to start: ANTHROPIC_API_KEY is empty.\n' +
    '  Set ANTHROPIC_API_KEY in .env, or run with LLM_PROVIDER=openai + OPENAI_API_KEY to avoid Anthropic.'
  )
  process.exit(1)
}
// A non-default OPENAI_BASE_URL means a local OpenAI-compatible server
// (Ollama / LM Studio / vLLM) — those usually run keyless, so only require
// OPENAI_API_KEY when talking to api.openai.com itself.
const usingLocalOpenAi = config.openaiBaseUrl !== DEFAULT_OPENAI_BASE_URL
if (config.llmProvider === 'openai' && !config.openaiApiKey && !usingLocalOpenAi) {
  console.error(
    '[RoBrain Perception OSS] Refusing to start: LLM_PROVIDER=openai but OPENAI_API_KEY is empty.\n' +
    '  Set OPENAI_API_KEY in .env (same key also works for EMBEDDING_PROVIDER=openai),\n' +
    '  or set OPENAI_BASE_URL to a local OpenAI-compatible server (Ollama / LM Studio / vLLM).'
  )
  process.exit(1)
}
if (usingLocalOpenAi) {
  console.log(`[RoBrain Perception OSS] OpenAI-compatible base URL override: ${config.openaiBaseUrl}`)
}
// Perception previously hardcoded text-embedding-3-small; installs that set
// OPENAI_EMBEDDING_MODEL for Sensing change Perception's behavior on upgrade.
if (config.embedding.provider === 'openai' && config.embedding.openaiModel !== DEFAULT_OPENAI_EMBEDDING_MODEL) {
  console.warn(
    `[RoBrain Perception OSS] WARNING: OPENAI_EMBEDDING_MODEL=${config.embedding.openaiModel} differs from the\n` +
    '  historical default (text-embedding-3-small). Vectors from different models are not\n' +
    '  comparable — a corpus embedded with another model will silently mis-rank in vector\n' +
    '  search. Re-embed all stored decisions after changing the embedding model.'
  )
}

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing env var: ${key}`)
  return v
}

// Defence-in-depth: schema name is interpolated into SQL text. Reject anything
// that isn't a plain unquoted identifier so a misconfigured DB_SCHEMA can't
// break out of the query context.
function validateSchemaName(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Invalid DB_SCHEMA "${name}" — must match /^[a-z_][a-z0-9_]{0,62}$/`)
  }
  return name
}

const pool      = new Pool({ connectionString: config.databaseUrl, max: 10 })
const app       = new Hono()
const S         = config.schema

/** Actionable copy for API consumers (CLI + Sensing MCP). */
const PROJECT_REGISTER_HINT =
  'Run `npx robrain init-project` from your project root to register this project.'

function projectNotRegisteredJson(projectId: string) {
  return {
    error:   'project_not_registered' as const,
    message: `project_id ${projectId} not registered — did you run robrain init-project?`,
    hint:    PROJECT_REGISTER_HINT,
  }
}

function decisionNotFoundJson(decisionId: string) {
  return {
    error:        'decision_not_found' as const,
    message:      `No decision row updated for id ${decisionId} — wrong or stale decision_id?`,
    decision_id:  decisionId,
  }
}

/** Projects are registered only via POST /projects (e.g. robrain init-project). Reject typos / stale ids loudly. */
async function jsonIfProjectUnknown(projectId: string, c: Context): Promise<Response | undefined> {
  const r = await pool.query(`SELECT 1 FROM ${S}.projects WHERE id = $1 LIMIT 1`, [projectId])
  if (!r.rowCount) {
    return c.json(projectNotRegisteredJson(projectId), 404)
  }
  return undefined
}

// ── Body size limit ──────────────────────────────────────────
// Cap request bodies so a single client can't queue up huge writes.
app.use('*', bodyLimit({
  maxSize: config.bodyLimitBytes,
  onError: (c) => c.json({ error: 'Payload too large', limit: config.bodyLimitBytes }, 413),
}))

// ── Auth ──────────────────────────────────────────────────────
// GET /health is unauthenticated so Docker healthchecks, load balancers, and
// `robrain status` can probe liveness without PERCEPTION_API_KEY.
app.use('*', async (c, next) => {
  if (c.req.method === 'GET' && c.req.path === '/health') {
    await next()
    return
  }
  if (config.apiKey) {
    if (!bearerAuthorized(c.req.header('Authorization'), config.apiKey)) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }
  await next()
})

// ── Rate limit ───────────────────────────────────────────────
// Lightweight per-client token bucket (in-memory, per process). Keys on
// X-Project-Id when present so Sensing instances scoped to different repos
// don't starve each other; falls back to remote IP. Best-effort — for a
// hardened multi-tenant deploy use a real proxy.
const RATE_LIMIT_WINDOW_MS = 60_000
const rateBuckets = new Map<string, { count: number; resetAt: number }>()

function rateLimitClient(c: Context): string {
  const projectId = c.req.header('X-Project-Id')
  if (projectId) return `proj:${projectId}`
  const fwd = c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
  return `ip:${fwd ?? 'unknown'}`
}

const writeRateLimit = async (c: Context, next: () => Promise<void>) => {
  const key = rateLimitClient(c)
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
  } else {
    bucket.count += 1
    if (bucket.count > config.rateLimitPerMinute) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      c.header('Retry-After', String(retryAfter))
      return c.json({ error: 'rate_limited', retry_after_seconds: retryAfter }, 429)
    }
  }
  await next()
  return
}
// Periodically GC stale buckets.
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of rateBuckets) if (b.resetAt <= now) rateBuckets.delete(k)
}, RATE_LIMIT_WINDOW_MS).unref()

// ── Health ────────────────────────────────────────────────────
app.get('/health', async (c) => {
  try {
    await pool.query('SELECT 1')
    return c.json({
      status: 'ok',
      db: 'connected',
      mode: config.ossMode ? 'oss-self-hosted' : 'cloud',
    })
  } catch {
    return c.json({ status: 'error', db: 'disconnected' }, 503)
  }
})

// ── POST /signals — receive from Sensing MCP ──────────────────
// Length bounds keep a single bad actor from poisoning the corpus with
// huge blobs. They are well above any legitimate session turn.
const MAX_TURN_TEXT = 200_000          // ≥ ~50K tokens of conversation
const MAX_DECISION_TEXT = 4_000        // ~600 words
const MAX_RATIONALE_TEXT = 4_000
const MAX_OPTION_TEXT = 1_000
const MAX_REASON_TEXT = 4_000
const MAX_FILES = 200
const MAX_FILE_PATH = 1_000
const MAX_REJECTED = 50
const MAX_EXCERPT = 300               // provenance snapshot of the originating user message

const ExtractedSchema = z.object({
  decision:   z.string().max(MAX_DECISION_TEXT).nullable(),
  rationale:  z.string().max(MAX_RATIONALE_TEXT).nullable(),
  rejected:   z.array(z.object({
    option: z.string().max(MAX_OPTION_TEXT),
    reason: z.string().max(MAX_REASON_TEXT),
  })).max(MAX_REJECTED),
  confidence: z.number(),
})

const SignalSchema = z.object({
  signal: z.object({
    turn: z.object({
      session_id:    z.string().max(200),
      sequence:      z.number(),
      user_message:  z.string().max(MAX_TURN_TEXT),
      claude_reply:  z.string().max(MAX_TURN_TEXT),
      files_touched: z.array(z.string().max(MAX_FILE_PATH)).max(MAX_FILES).default([]),
      timestamp:     z.string().max(64),
    }),
    decision_type:        z.string().max(100),
    confidence:           z.number(),
    files_affected:       z.array(z.string().max(MAX_FILE_PATH)).max(MAX_FILES).default([]),
    scope:                z.enum(['user','local','team','global']).default('team'),
    needs_classification: z.boolean().optional(),
    extracted:            ExtractedSchema.optional(),
    source_turn_sequence: z.number().int().optional(),
    source_excerpt:       z.string().max(MAX_TURN_TEXT).optional(),
  }),
})

app.post('/signals', writeRateLimit, async (c) => {
  const projectId = c.req.header('X-Project-Id') ?? 'default'
  const minConf = THRESHOLDS.DECISION_CONFIDENCE_MIN

  let body: z.infer<typeof SignalSchema>
  try {
    body = SignalSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid body', detail: String(err) }, 400)
  }

  const unknownProject = await jsonIfProjectUnknown(projectId, c)
  if (unknownProject) return unknownProject

  const { signal } = body

  // Defence-in-depth: Sensing already redacts at capture, but /signals is an
  // open HTTP surface — scrub every free-text field again BEFORE extraction,
  // embedding, and storage so raw secrets never reach the LLM, the embedding
  // provider, or Postgres.
  const redactionTally = new Map<string, number>()
  const scrub = (text: string): string => {
    const r = redactSecrets(text)
    for (const { type, count } of r.redactions) {
      redactionTally.set(type, (redactionTally.get(type) ?? 0) + count)
    }
    return r.text
  }
  signal.turn.user_message = scrub(signal.turn.user_message)
  signal.turn.claude_reply = scrub(signal.turn.claude_reply)
  if (signal.source_excerpt !== undefined) signal.source_excerpt = scrub(signal.source_excerpt)

  try {
    // Confidence gate — discard low-confidence signals (flush-on-close bypasses via needs_classification)
    if (signal.confidence < minConf && !signal.needs_classification) {
      return c.json({ accepted: false, action: 'discarded', message: 'Confidence below threshold' })
    }

    // Ensure session exists
    await pool.query(`
      INSERT INTO ${S}.sessions (id, project_id)
      VALUES ($1, $2)
      ON CONFLICT (id) DO NOTHING
    `, [signal.turn.session_id, projectId])

    const trustSensingExtract =
      Boolean(
        signal.extracted?.decision &&
        (signal.extracted.confidence ?? 0) >= minConf &&
        signal.needs_classification !== true,
      )

    // Prefer Sensing's Haiku extraction when present; otherwise OSS re-extract (flush path, etc.)
    const rawExtracted = trustSensingExtract
      ? signal.extracted!
      : await extractDecisionOSS(signal.turn.user_message, signal.turn.claude_reply)

    if (!rawExtracted.decision || rawExtracted.confidence < minConf) {
      return c.json({ accepted: false, action: 'discarded', message: 'No decision extracted' })
    }

    // Scrub extracted fields too (covers Sensing-supplied extracts and any
    // secret the LLM echoed back) — must happen before the embedding call.
    const extracted = {
      ...rawExtracted,
      decision:  scrub(rawExtracted.decision),
      rationale: rawExtracted.rationale == null ? null : scrub(rawExtracted.rationale),
      rejected:  (rawExtracted.rejected ?? []).map(r => ({
        option: scrub(r.option),
        reason: scrub(r.reason),
      })),
    }

    if (redactionTally.size > 0) {
      const detail = [...redactionTally].map(([t, n]) => `${t}=${n}`).join(', ')
      console.warn(`[Perception OSS] POST /signals redacted secrets before storage: ${detail}`)
    }

    // Embed the decision
    const embedding = await embed(`${extracted.decision}. ${extracted.rationale ?? ''}`)

    // Near-duplicate: skip INSERT if an active same-scope decision is already this close in embedding space.
    // Same-session turns (e.g. same user_message, different claude_reply) can phrase the decision slightly
    // differently — use a lower cosine floor than cross-session so we don't double-insert.
    const dedupCross = THRESHOLDS.DECISION_DEDUP_SIMILARITY
    const dedupSameSession = THRESHOLDS.DECISION_DEDUP_SIMILARITY_SAME_SESSION
    const currentSessionId = signal.turn.session_id

    const { rows: nearest } = await pool.query<{
      id: string
      session_id: string
      decision: string
      reviewed_at: Date | null
      similarity: number
    }>(`
      SELECT d.id, d.session_id, d.decision, d.reviewed_at,
             1 - (d.embedding <=> $1::vector) AS similarity
      FROM ${S}.decisions d
      WHERE d.project_id = $2
        -- Same-scope only: 'team' and 'user' decisions are intentional partitions, never dedup across.
        AND d.scope = $3
        AND d.invalidated_at IS NULL
        AND d.embedding IS NOT NULL
      ORDER BY d.embedding <=> $1::vector
      LIMIT 5
    `, [JSON.stringify(embedding), projectId, signal.scope])

    let match: (typeof nearest)[0] | undefined
    for (const row of nearest) {
      const sim = Number(row.similarity)
      const sameSession = row.session_id === currentSessionId
      const min = sameSession ? dedupSameSession : dedupCross
      if (sim >= min) {
        match = row
        break
      }
    }

    if (match) {
      const simRounded = Number(Number(match.similarity).toFixed(3))
      const matchedSnippet = match.decision.length > 80
        ? `${match.decision.slice(0, 80)}…`
        : match.decision
      console.log(
        `[Perception OSS] POST /signals deduped vs ${match.id} (similarity=${simRounded}, same_session=${
          match.session_id === currentSessionId
        }, reviewed=${match.reviewed_at != null}) :: "${matchedSnippet}"`,
      )
      return c.json({
        accepted: true,
        action:               'deduped',
        matched_decision_id:  match.id,
        matched_reviewed:     match.reviewed_at != null,
        similarity:           simRounded,
      })
    }

    // Provenance snapshot — excerpt of the originating user message survives
    // session_turns cascade deletion. Derive from the turn when Sensing didn't send one.
    const sourceExcerpt = (signal.source_excerpt ?? signal.turn.user_message ?? '').slice(0, MAX_EXCERPT) || null
    const sourceTurnSequence = signal.source_turn_sequence ?? signal.turn.sequence

    const { rows } = await pool.query<{ id: string }>(`
      INSERT INTO ${S}.decisions (
        project_id, session_id, decision, rationale,
        rejected, files_affected, confidence, scope, source, embedding,
        source_turn_sequence, source_excerpt
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9, $10::vector, $11, $12)
      RETURNING id
    `, [
      projectId,
      signal.turn.session_id,
      extracted.decision,
      extracted.rationale ?? null,
      JSON.stringify(extracted.rejected ?? []),
      signal.files_affected,
      extracted.confidence,
      signal.scope,
      'sensing',
      JSON.stringify(embedding),
      sourceTurnSequence,
      sourceExcerpt,
    ])

    scheduleRegenerateSummary(projectId)
    return c.json({ accepted: true, action: 'written', decision_id: rows[0]?.id })
  }
  catch (err) {
    if (err instanceof EmbeddingProviderError) {
      console.error('[Perception OSS] embedding provider unavailable:', err.provider, err.message)
      return c.json(
        { error: 'embedding_provider_unavailable', detail: `[${err.provider}] ${err.message}` },
        503,
      )
    }
    console.error('[Perception OSS] POST /signals error:', err)
    return c.json({ error: 'Internal error', detail: String(err) }, 500)
  }
})

// ── GET /decisions — for robrain review + robrain inject ───────
app.get('/decisions', async (c) => {
  const projectId  = c.req.query('project_id')
  const sessionId  = c.req.query('session_id')
  const all        = c.req.query('all') === 'true'
  const recent     = c.req.query('recent') === 'true'
  const history    = c.req.query('history') === 'true'
  const query_text   = c.req.query('query')   // for robrain inject semantic search
  const boostFilesRaw = c.req.query('boost_files') // comma paths — F1 file_overlap in planning_score
  const limitRaw   = c.req.query('limit') ?? '20'
  const parsedLimit = Number.parseInt(limitRaw, 10)
  const limit       = Number.isFinite(parsedLimit) && parsedLimit >= 1
    ? Math.min(parsedLimit, 100)
    : 20
  // Pagination for the history branch only — limit is capped at 100, so
  // CLI consumers (outcomes scan, interchange export) page with offset.
  const offsetRaw    = c.req.query('offset') ?? '0'
  const parsedOffset = Number.parseInt(offsetRaw, 10)
  const offset       = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0

  if (!projectId) return c.json({ error: 'project_id required' }, 400)

  const unknownProject = await jsonIfProjectUnknown(projectId, c)
  if (unknownProject) return unknownProject

  try {
    let rows: unknown[]

    const conflictCounterpartSql = `(
      SELECT CASE WHEN r.from_id = d.id THEN r.to_id ELSE r.from_id END
      FROM ${S}.decision_relations r
      WHERE (r.from_id = d.id OR r.to_id = d.id) AND r.relation = 'conflicts_with'
      ORDER BY r.created_at DESC
      LIMIT 1
    ) AS conflict_counterpart_id`

    // `robrain review` filters out user-approved decisions so the feed shows
    // only what still needs attention. `robrain review --history` and
    // `robrain inject` (semantic search) both ignore reviewed_at because they
    // want full visibility / retrieval coverage.
    if (query_text) {
      // Semantic search — F1: composite planning_score (shared SCORING_WEIGHTS) over vector neighbours.
      const embedding = await embed(query_text)
      const w  = SCORING_WEIGHTS
      const hl = THRESHOLDS.RECENCY_HALF_LIFE_DAYS
      const boostPaths = (boostFilesRaw ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)

      const scoreExpr = `
            (${w.SEMANTIC_SIMILARITY} * similarity
             + ${w.FILE_OVERLAP} * file_overlap_score
             + ${w.RECENCY} * recency_score
             + ${w.HISTORICAL_RELEVANCE} * historical_relevance
             + ${w.APPROVAL_STATE} * (CASE WHEN reviewed_at IS NOT NULL THEN 1.0 ELSE 0.0 END)
            )::float AS planning_score`

      const nearestSelect = (fileOverlapExpr: string) => `
            SELECT d.id, d.decision, d.rationale, d.rejected,
                   d.files_affected, d.confidence, d.scope,
                   d.created_at, d.session_id, d.conflict_flag,
                   d.supersedes_id, d.invalidated_at, d.reviewed_at,
                   d.historical_relevance, d.source_turn_sequence,
                   d.source_excerpt, d.injected_count, d.used_count,
                   ${conflictCounterpartSql},
                   1 - (d.embedding <=> $1::vector) AS similarity,
                   POWER(0.5, LEAST(3650, EXTRACT(EPOCH FROM (NOW() - d.created_at)) / 86400.0) / ${hl}) AS recency_score,
                   ${fileOverlapExpr} AS file_overlap_score
            FROM ${S}.decisions d
            JOIN ${S}.sessions s ON s.id = d.session_id
            WHERE s.project_id = $2
              AND d.invalidated_at IS NULL
              AND d.embedding IS NOT NULL
            ORDER BY d.embedding <=> $1::vector
            LIMIT 120`

      const fileOverlapFromBoost = `
                   LEAST(1.0,
                     COALESCE(cardinality(ARRAY(SELECT UNNEST(d.files_affected) INTERSECT SELECT UNNEST($4::text[]))), 0)::float
                     / GREATEST(1, cardinality($4::text[])))`

      const result = boostPaths.length === 0
        ? await pool.query(`
          WITH nearest AS (${nearestSelect('0.0::float')})
          SELECT *, ${scoreExpr}
          FROM nearest
          ORDER BY planning_score DESC NULLS LAST, similarity DESC
          LIMIT $3
        `, [JSON.stringify(embedding), projectId, limit])
        : await pool.query(`
          WITH nearest AS (${nearestSelect(fileOverlapFromBoost)})
          SELECT *, ${scoreExpr}
          FROM nearest
          ORDER BY planning_score DESC NULLS LAST, similarity DESC
          LIMIT $3
        `, [JSON.stringify(embedding), projectId, limit, boostPaths])

      rows = result.rows
    } else if (sessionId) {
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at, d.reviewed_at,
               d.historical_relevance, d.source_turn_sequence,
               d.source_excerpt, d.injected_count, d.used_count,
               ${conflictCounterpartSql}
        FROM ${S}.decisions d
        WHERE d.session_id = $1
          AND d.invalidated_at IS NULL
          AND d.reviewed_at IS NULL
        ORDER BY d.created_at DESC LIMIT $2
      `, [sessionId, limit])
      rows = result.rows
    } else if ((all || recent) && !history) {
      // `all` (review --all) or `recent` (default review): unreviewed + active, newest first
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at, d.reviewed_at,
               d.historical_relevance, d.source_turn_sequence,
               d.source_excerpt, d.injected_count, d.used_count,
               ${conflictCounterpartSql}
        FROM ${S}.decisions d
        JOIN ${S}.sessions s ON s.id = d.session_id
        WHERE s.project_id = $1
          AND d.invalidated_at IS NULL
          AND d.reviewed_at IS NULL
        ORDER BY d.created_at DESC LIMIT $2
      `, [projectId, limit])
      rows = result.rows
    } else if (history) {
      // --history (with or without --all): full lifecycle for the project
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at, d.reviewed_at,
               d.historical_relevance, d.source_turn_sequence,
               d.source_excerpt, d.injected_count, d.used_count,
               ${conflictCounterpartSql}
        FROM ${S}.decisions d
        JOIN ${S}.sessions s ON s.id = d.session_id
        WHERE s.project_id = $1
        ORDER BY d.created_at ASC LIMIT $2 OFFSET $3
      `, [projectId, limit, offset])
      rows = result.rows
    } else {
      // Bare query (no mode flags): same as recent — unreviewed + active, newest first
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at, d.reviewed_at,
               d.historical_relevance, d.source_turn_sequence,
               d.source_excerpt, d.injected_count, d.used_count,
               ${conflictCounterpartSql}
        FROM ${S}.decisions d
        JOIN ${S}.sessions s ON s.id = d.session_id
        WHERE s.project_id = $1
          AND d.invalidated_at IS NULL
          AND d.reviewed_at IS NULL
        ORDER BY d.created_at DESC LIMIT $2
      `, [projectId, limit])
      rows = result.rows
    }

    return c.json({ decisions: rows, count: rows.length })
  } catch (err) {
    console.error('[Perception OSS] GET /decisions error:', err)
    return c.json({ error: 'Internal error' }, 500)
  }
})

// ── POST /scores — feedback loop from Sensing ─────────────────
// Scoring computed server-side where we have the decision text.

app.post('/scores', writeRateLimit, async (c) => {
  const body = await c.req.json<{
    scores: Array<{ session_id: string; sequence: number; injected_memory_ids: string[]; final_score: number; claude_reply?: string }>
  }>()

  let updated = 0

  for (const score of body.scores) {
    // Prefer the redacted reply text Sensing ships in the payload; the
    // session_turns SELECT is a fallback only (nothing populates that table today).
    let claudeReply = typeof score.claude_reply === 'string' ? score.claude_reply : ''
    if (!claudeReply) {
      try {
        const { rows } = await pool.query<{ claude_reply: string }>(`
          SELECT claude_reply FROM ${S}.session_turns
          WHERE session_id = $1 AND sequence = $2 LIMIT 1
        `, [score.session_id, score.sequence])
        claudeReply = rows[0]?.claude_reply ?? ''
      } catch { /* fall back to default delta */ }
    }

    // One reply embedding per score, compared (cosine) against each decision's
    // stored embedding in SQL. Term matching stays as the fallback signal when
    // the provider call fails or the decision has no embedding.
    let replyEmbedding: number[] | null = null
    if (claudeReply) {
      try { replyEmbedding = await embed(claudeReply) } catch { replyEmbedding = null }
    }

    for (const id of score.injected_memory_ids) {
      let used   = false
      let judged = false
      let delta  = usageDelta(false, false)
      if (claudeReply) {
        try {
          const { rows } = await pool.query<{ decision: string; rationale: string | null; cosine: number | null }>(`
            SELECT decision, rationale,
                   CASE WHEN embedding IS NOT NULL AND $2::vector IS NOT NULL
                        THEN 1 - (embedding <=> $2::vector) END AS cosine
            FROM ${S}.decisions WHERE id = $1
          `, [id, replyEmbedding ? JSON.stringify(replyEmbedding) : null])
          const row = rows[0]
          if (row) {
            const termScore = termMatchScore(`${row.decision} ${row.rationale ?? ''}`, claudeReply)
            used   = judgeUsed(row.cosine == null ? null : Number(row.cosine), termScore)
            delta  = usageDelta(true, used)
            judged = true
          }
        } catch { /* use default */ }
      }

      try {
        // injected_count: every time this id was in injected_memory_ids (reach).
        // used_count: only when we judged the reply and found the memory was used.
        // demotionDelta ratio uses both — so injected must count even without reply text.
        const { used: usedInc } = scoreCounterIncrements(judged, used)
        const { rows } = await pool.query<{ injected_count: number; used_count: number }>(`
          UPDATE ${S}.decisions
          SET injected_count = injected_count + 1,
              used_count = used_count + $3,
              historical_relevance = GREATEST(0, LEAST(1, historical_relevance + $2)),
              updated_at = now()
          WHERE id = $1
          RETURNING injected_count, used_count
        `, [id, delta, usedInc])
        const counts = rows[0]
        if (counts) {
          updated += 1
          // Auto-demotion: ratio uses cumulative injected/used counters — run after
          // every injection so memories that reach MIN_INJECTED without reply text
          // (or without semantic match) still sink; not gated on this turn's judged flag.
          const demotion = demotionDelta(Number(counts.injected_count), Number(counts.used_count))
          if (demotion !== 0) {
            await pool.query(
              `UPDATE ${S}.decisions SET historical_relevance = GREATEST(0, LEAST(1, historical_relevance + $2)), updated_at = now() WHERE id = $1`,
              [id, demotion],
            )
          }
        }
      } catch (err) {
        console.error('[Perception OSS] POST /scores update failed:', id, err)
      }
    }
  }

  return c.json({ accepted: true, updated })
})

// ── POST /outcomes — real-world outcome feedback ──────────────
const OutcomeSchema = z.object({
  project_id:  z.string().max(200),
  decision_id: z.string().max(200),
  outcome:     z.enum(['revert', 'incident', 'confirmed']),
  evidence:    z.string().max(4_000).optional(),
})

app.post('/outcomes', writeRateLimit, async (c) => {
  let body: z.infer<typeof OutcomeSchema>
  try {
    body = OutcomeSchema.parse(await c.req.json())
  } catch (err) {
    return c.json({ error: 'Invalid body', detail: String(err) }, 400)
  }

  const unknownProject = await jsonIfProjectUnknown(body.project_id, c)
  if (unknownProject) return unknownProject

  // Open HTTP surface — scrub evidence before comparison and storage.
  const evidence = body.evidence == null ? null : redactSecrets(body.evidence).text

  try {
    // Idempotency: repeated scans re-report the same revert — the same
    // (decision, outcome, evidence) triple must not re-apply the delta forever.
    const dup = await pool.query<{ historical_relevance: number }>(`
      SELECT d.historical_relevance
      FROM ${S}.decision_outcomes o
      JOIN ${S}.decisions d ON d.id = o.decision_id
      WHERE o.decision_id = $1 AND o.outcome = $2 AND o.evidence IS NOT DISTINCT FROM $3
      LIMIT 1
    `, [body.decision_id, body.outcome, evidence])
    if (dup.rowCount) {
      return c.json({
        accepted:             true,
        duplicate:            true,
        historical_relevance: Number(dup.rows[0]!.historical_relevance),
      })
    }

    // revert/incident also raise conflict_flag so the decision surfaces in `robrain review`.
    const result = await pool.query<{ historical_relevance: number }>(`
      UPDATE ${S}.decisions
      SET historical_relevance = GREATEST(0, LEAST(1, historical_relevance + $3)),
          conflict_flag = conflict_flag OR $4,
          updated_at = now()
      WHERE id = $1 AND project_id = $2
      RETURNING historical_relevance
    `, [body.decision_id, body.project_id, outcomeDelta(body.outcome), body.outcome !== 'confirmed'])
    if (!result.rowCount) {
      return c.json(decisionNotFoundJson(body.decision_id), 404)
    }

    const { rows } = await pool.query<{ id: string }>(`
      INSERT INTO ${S}.decision_outcomes (decision_id, outcome, evidence)
      VALUES ($1, $2, $3)
      RETURNING id
    `, [body.decision_id, body.outcome, evidence])

    return c.json({
      accepted:             true,
      outcome_id:           rows[0]?.id,
      historical_relevance: Number(result.rows[0]!.historical_relevance),
    })
  } catch (err) {
    console.error('[Perception OSS] POST /outcomes error:', err)
    return c.json({ error: 'Internal error', detail: String(err) }, 500)
  }
})

// ── POST /corrections — from robrain review ────────────────────
app.post('/corrections', async (c) => {
  const body = await c.req.json<{
    decision_id:               string
    corrected_decision?:       string
    corrected_rationale?:      string
    invalidate?:               boolean
    approve?:                  boolean
    /** From robrain review "keep this decision" conflict resolution — clears flag + marks reviewed. */
    resolved_conflict_keep?:   boolean
    /** When set with resolved_conflict_keep: other decision id so Pass 2 skips re-flagging this pair (related_to edge). */
    counterpart_id?:           string
    source:                    string
  }>()

  // Approval is exclusive of invalidation/edit; once a user explicitly
  // approves a decision it disappears from the default review feed.
  if (body.approve) {
    const result = await pool.query<{ project_id: string }>(`
      UPDATE ${S}.decisions
      SET reviewed_at = now(),
          conflict_flag = false,
          updated_at = now()
      WHERE id = $1
      RETURNING project_id
    `, [body.decision_id])
    if (!result.rowCount) {
      return c.json(decisionNotFoundJson(body.decision_id), 404)
    }
    // Approval changes which tier this decision occupies in the always-on
    // summary, so trigger a regenerate immediately.
    scheduleRegenerateSummary(result.rows[0]!.project_id)
    return c.json({ accepted: true, action: 'approved' })
  }

  if (body.resolved_conflict_keep && !body.invalidate) {
    const result = await pool.query<{ project_id: string }>(`
      UPDATE ${S}.decisions
      SET conflict_flag = false,
          reviewed_at = COALESCE(reviewed_at, now()),
          updated_at = now()
      WHERE id = $1
      RETURNING project_id
    `, [body.decision_id])
    if (!result.rowCount) {
      return c.json(decisionNotFoundJson(body.decision_id), 404)
    }

    if (body.counterpart_id && body.counterpart_id !== body.decision_id) {
      await pool.query(`
        INSERT INTO ${S}.decision_relations (from_id, to_id, relation)
        VALUES ($1, $2, 'related_to')
        ON CONFLICT DO NOTHING
      `, [body.decision_id, body.counterpart_id])
    }

    scheduleRegenerateSummary(result.rows[0]!.project_id)
    return c.json({ accepted: true, action: 'conflict_resolved_kept' })
  }

  if (body.invalidate) {
    const result = await pool.query<{ project_id: string }>(`
      UPDATE ${S}.decisions
      SET invalidated_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING project_id
    `, [body.decision_id])
    if (!result.rowCount) {
      return c.json(decisionNotFoundJson(body.decision_id), 404)
    }
    // Cached always_on_summary still lists this row until regen; without this,
    // quiet projects could show stale bullets for hours or days.
    scheduleRegenerateSummary(result.rows[0]!.project_id)
  }

  if (body.corrected_decision) {
    const projectId = c.req.header('X-Project-Id') ?? 'default'
    const unknownProject = await jsonIfProjectUnknown(projectId, c)
    if (unknownProject) return unknownProject

    // FK: session_id must reference an existing sessions row — use the row being corrected
    // (CLI used to send X-Session-Id = robrain-review-cli with no matching session → 500).
    const { rows: srcRows } = await pool.query<{
      session_id: string
      scope: string
      source_turn_sequence: number | null
      source_excerpt: string | null
    }>(
      `SELECT session_id, scope, source_turn_sequence, source_excerpt FROM ${S}.decisions WHERE id = $1 LIMIT 1`,
      [body.decision_id],
    )
    const src = srcRows[0]
    if (!src) {
      return c.json(decisionNotFoundJson(body.decision_id), 404)
    }

    // Open HTTP surface — scrub corrected text (same defence-in-depth as
    // /signals) BEFORE it reaches the embedding provider or Postgres.
    const correctedDecision  = redactSecrets(body.corrected_decision).text
    const correctedRationale = body.corrected_rationale == null
      ? null
      : redactSecrets(body.corrected_rationale).text

    const embedding = await embed(`${correctedDecision}. ${correctedRationale ?? ''}`)

    // Carry provenance from the superseded row — corrections rewrite the text,
    // not where the decision came from.
    await pool.query(`
      INSERT INTO ${S}.decisions (
        project_id, session_id, decision, rationale,
        rejected, files_affected, confidence, scope, source,
        supersedes_id, embedding, source_turn_sequence, source_excerpt
      ) VALUES ($1,$2,$3,$4,'[]'::jsonb,'{}'::text[],1.0,$5,$6,$7,$8::vector,$9,$10)
    `, [
      projectId,
      src.session_id,
      correctedDecision,
      correctedRationale,
      src.scope,
      body.source,
      body.invalidate ? body.decision_id : null,
      JSON.stringify(embedding),
      src.source_turn_sequence,
      src.source_excerpt,
    ])

    // New row enters high_signal / recent_fill; regen again so the summary
    // includes it (debounce coalesces with invalidate's schedule above).
    scheduleRegenerateSummary(projectId)
  }

  return c.json({ accepted: true })
})

// ── POST /projects — upsert project ───────────────────────────
app.post('/projects', async (c) => {
  const { id, name, working_directory } = await c.req.json<{
    id: string
    name: string
    working_directory?: string | null
  }>()
  await pool.query(`
    INSERT INTO ${S}.projects (id, name, working_directory)
    VALUES ($1, $2, $3)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      working_directory = COALESCE(EXCLUDED.working_directory, ${S}.projects.working_directory),
      last_session_at = now(),
      updated_at = now()
  `, [id, name, working_directory ?? null])
  return c.json({ accepted: true })
})

// ── GET /projects — list projects + counts (CLI: robrain projects list) ──
app.get('/projects', async (c) => {
  try {
    const { rows } = await pool.query<{
      id: string
      name: string
      updated_at: Date
      working_directory: string | null
      session_count: string
      decision_count: string
    }>(`
      SELECT p.id, p.name, p.updated_at, p.working_directory,
        (SELECT COUNT(*)::text FROM ${S}.sessions s WHERE s.project_id = p.id) AS session_count,
        (SELECT COUNT(*)::text FROM ${S}.decisions d WHERE d.project_id = p.id AND d.invalidated_at IS NULL) AS decision_count
      FROM ${S}.projects p
      ORDER BY p.updated_at DESC NULLS LAST
    `)
    return c.json({
      projects: rows.map(r => ({
        id:                 r.id,
        name:               r.name,
        updated_at:         r.updated_at,
        working_directory:  r.working_directory,
        session_count:      Number.parseInt(r.session_count, 10) || 0,
        decision_count:     Number.parseInt(r.decision_count, 10) || 0,
      })),
    })
  } catch (err) {
    console.error('[Perception OSS] GET /projects error:', err)
    return c.json({ error: 'Internal error', detail: String(err) }, 500)
  }
})

// ── POST /projects/merge — move sessions + decisions from phantom project ──
app.post('/projects/merge', async (c) => {
  let body: { from: string; to: string }
  try {
    body = await c.req.json<{ from: string; to: string }>()
  } catch {
    return c.json({ error: 'Invalid body' }, 400)
  }
  const { from, to } = body
  if (!from || !to || from === to) {
    return c.json({ error: 'from and to project ids required and must differ' }, 400)
  }

  const fromExists = await pool.query(`SELECT 1 FROM ${S}.projects WHERE id = $1`, [from])
  const toExists = await pool.query(`SELECT 1 FROM ${S}.projects WHERE id = $1`, [to])
  if (!fromExists.rowCount) {
    return c.json({ ...projectNotRegisteredJson(from), role: 'from' }, 404)
  }
  if (!toExists.rowCount) {
    return c.json({ ...projectNotRegisteredJson(to), role: 'to' }, 404)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      UPDATE ${S}.projects SET working_directory = COALESCE(working_directory, (
        SELECT working_directory FROM ${S}.projects WHERE id = $2
      )) WHERE id = $1
    `, [to, from])
    await client.query(`UPDATE ${S}.sessions SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`UPDATE ${S}.decisions SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`UPDATE ${S}.mem0_facts SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`UPDATE ${S}.planning_blocks SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`DELETE FROM ${S}.projects WHERE id = $1`, [from])
    await client.query('COMMIT')
    // Every `from`-project decision now belongs to `to`, so its tier
    // membership in the always-on summary is stale until we regenerate.
    scheduleRegenerateSummary(to)
    return c.json({ merged: true, from, to })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[Perception OSS] POST /projects/merge error:', err)
    return c.json({ error: 'merge_failed', detail: String(err) }, 500)
  } finally {
    client.release()
  }
})

// ── GET /projects/:id/summary ──────────────────────────────────
app.get('/projects/:id/summary', async (c) => {
  const id = c.req.param('id')
  const { rows } = await pool.query<{ always_on_summary: string | null; mission: string | null }>(`
    SELECT always_on_summary, mission FROM ${S}.projects WHERE id = $1
  `, [id])
  if (!rows[0]) {
    return c.json(projectNotRegisteredJson(id), 404)
  }
  // hit_count measures serves, not write churn: this route is what Sensing hits
  // at session start, so count the blocks riding along in the summary here
  // (same top-8-by-weight selection regenerateSummary includes). Fire-and-forget.
  pool.query(`
    UPDATE ${S}.planning_blocks
    SET hit_count = hit_count + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM ${S}.planning_blocks
      WHERE project_id = $1
      ORDER BY weight DESC, last_refreshed_at DESC NULLS LAST
      LIMIT 8
    )
  `, [id]).catch(err =>
    console.error('[Perception OSS] planning_blocks hit_count update failed:', id, err),
  )
  return c.json(rows[0])
})

// ── POST /projects/:id/regenerate-summary ─────────────────────
app.post('/projects/:id/regenerate-summary', async (c) => {
  const projectId = c.req.param('id')
  const unknownProject = await jsonIfProjectUnknown(projectId, c)
  if (unknownProject) return unknownProject

  regenerateSummary(projectId).catch(console.error)
  return c.json({ accepted: true })
})

// ── Helpers ───────────────────────────────────────────────────

// OSS extraction — prompt and provider switch live in @robrain/shared
// (extract-decision.ts), the same module Sensing's classifier uses, so
// flush-on-close re-extraction can no longer drift from the Sensing prompt.
async function extractDecisionOSS(userMsg: string, claudeReply: string) {
  try {
    return await extractDecisionLlm(userMsg, claudeReply, {
      provider:        config.llmProvider,
      anthropicApiKey: config.anthropicApiKey,
      anthropicModel:  config.anthropicModel,
      openaiApiKey:    config.openaiApiKey,
      openaiModel:     config.openaiLlmModel,
      openaiBaseUrl:   config.openaiBaseUrl,
    })
  } catch {
    // Missing key / provider / parse failure = treat as no decision (keys are
    // validated at boot, so this is transient provider trouble, not config).
    return { decision: null, rationale: null, rejected: [], confidence: 0 }
  }
}

// Shared embedding client bound to this package's config. Selecting a provider
// whose key is missing now throws EmbeddingProviderError (surfaced as 503 by
// /signals) instead of silently falling back to OpenAI, and every call carries
// a timeout + retry so a hung provider cannot stall a request indefinitely.
async function embed(text: string): Promise<number[]> {
  return sharedEmbed(text, config.embedding)
}

const REGENERATE_SUMMARY_DEBOUNCE_MS = 30_000

/** Per-project trailing debounce — coalesces burst writes (e.g. init-project) into one summary refresh per window. */
const regenerateSummaryTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleRegenerateSummary(projectId: string): void {
  const pending = regenerateSummaryTimers.get(projectId)
  if (pending !== undefined) clearTimeout(pending)
  regenerateSummaryTimers.set(
    projectId,
    setTimeout(() => {
      regenerateSummaryTimers.delete(projectId)
      regenerateSummary(projectId).catch(err =>
        console.error('[Perception OSS] regenerateSummary failed:', projectId, err)
      )
    }, REGENERATE_SUMMARY_DEBOUNCE_MS),
  )
}

async function regenerateSummary(projectId: string): Promise<void> {
  // Two-tier selection:
  //  - High-signal (≤15): approved, has rejected alternatives, or scope=global.
  //    Sticky — never ages out as long as the decision is still active.
  //  - Recent fill (≤5): most recent active decisions not already in tier 1.
  //
  // We emit the ranked bullet list directly. Previously this was Haiku-
  // compressed to "exactly 3 lines", which silently dropped rejection
  // context as a project grew. Bullets cost more tokens per session start
  // but keep every captured decision visible to the agent, and remove the
  // Anthropic dependency from the always-on summary path.
  const { rows } = await pool.query<{
    decision: string
    rationale: string | null
    rejected: Array<{ option: string; reason: string }>
    reviewed_at: Date | null
    scope: string
  }>(`
    WITH high_signal AS (
      SELECT d.id, d.decision, d.rationale, d.rejected, d.scope,
             d.reviewed_at, d.created_at, 1 AS tier
      FROM ${S}.decisions d
      JOIN ${S}.sessions s ON s.id = d.session_id
      WHERE s.project_id = $1
        AND d.invalidated_at IS NULL
        AND ( d.reviewed_at IS NOT NULL
           OR jsonb_array_length(d.rejected) > 0
           OR d.scope = 'global' )
      ORDER BY
        (d.reviewed_at IS NOT NULL)::int DESC,
        (jsonb_array_length(d.rejected) > 0)::int DESC,
        d.created_at DESC
      LIMIT 15
    ),
    recent_fill AS (
      SELECT d.id, d.decision, d.rationale, d.rejected, d.scope,
             d.reviewed_at, d.created_at, 2 AS tier
      FROM ${S}.decisions d
      JOIN ${S}.sessions s ON s.id = d.session_id
      WHERE s.project_id = $1
        AND d.invalidated_at IS NULL
        AND d.id NOT IN (SELECT id FROM high_signal)
      ORDER BY d.created_at DESC
      LIMIT 5
    )
    SELECT decision, rationale, rejected, reviewed_at, scope
    FROM (
      SELECT * FROM high_signal
      UNION ALL
      SELECT * FROM recent_fill
    ) merged
    ORDER BY tier ASC, created_at DESC
  `, [projectId])

  if (!rows.length) return

  const summary = rows.map((r, i) => {
    const tags: string[] = []
    if (r.reviewed_at)        tags.push('approved')
    if (r.scope === 'global') tags.push('global')
    const tagSuffix = tags.length ? ` [${tags.join(',')}]` : ''
    const vetoes    = (r.rejected ?? []).map(rv => `${rv.option} (${rv.reason})`).join(', ')
    const rationale = r.rationale ? ` — ${r.rationale}` : ''
    const rejected  = vetoes ? ` | Rejected: ${vetoes}` : ''
    return `${i + 1}. ${r.decision}${rationale}${rejected}${tagSuffix}`
  }).join('\n')

  // Synthesis planning blocks (compiled_truth / drift_signal / entity) ride
  // along — the always-on summary is the only OSS injection surface.
  // hit_count is incremented on the serve path (GET /projects/:id/summary),
  // not here — rebuilds are write churn, not serves.
  const { rows: blocks } = await pool.query<{ id: string; content: string }>(`
    SELECT id, content FROM ${S}.planning_blocks
    WHERE project_id = $1
    ORDER BY weight DESC, last_refreshed_at DESC NULLS LAST
    LIMIT 8
  `, [projectId])

  const blockSection = blocks.length
    ? '\nSynthesis:\n' + blocks.map(b => `- ${b.content}`).join('\n')
    : ''

  await pool.query(
    `UPDATE ${S}.projects SET always_on_summary=$2, updated_at=now() WHERE id=$1`,
    [projectId, summary + blockSection],
  )
}

// ── Start ──────────────────────────────────────────────────────
applySqlMigrations(pool, S)
  .then(() => {
    serve({ fetch: app.fetch, port: config.port }, () => {
      console.log(`[RoBrain Perception OSS] Running on port ${config.port} — mode: ${config.ossMode ? 'self-hosted' : 'cloud'}`)
    })
  })
  .catch((err) => {
    console.error('[RoBrain Perception OSS] Startup migration failed:', err)
    process.exit(1)
  })

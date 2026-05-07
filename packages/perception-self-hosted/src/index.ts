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
//   - Planning scorer (4-signal relevance ranking)
//   - Automatic context injection via Control MCP
//   - Conflict auto-resolution
//   - Web dashboard
//   - Team memory + scope filtering
// ─────────────────────────────────────────────────────────────

import { Hono }              from 'hono'
import type { Context }      from 'hono'
import { serve }             from '@hono/node-server'
import Anthropic             from '@anthropic-ai/sdk'
import pg                    from 'pg'
import { z }                 from 'zod'
import { THRESHOLDS }        from '@robrain/shared'

const { Pool } = pg

// ── Config ────────────────────────────────────────────────────
const config = {
  port:            Number(process.env.PORT ?? 3001),
  apiKey:          process.env.PERCEPTION_API_KEY ?? '',
  databaseUrl:     requireEnv('DATABASE_URL'),
  schema:          process.env.DB_SCHEMA ?? 'context_system',
  anthropicApiKey: requireEnv('ANTHROPIC_API_KEY'),
  anthropicModel:  process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
  ossMode:         process.env.OSS_MODE === 'true',
  embeddingProvider: process.env.EMBEDDING_PROVIDER ?? 'openai',
  openaiApiKey:    process.env.OPENAI_API_KEY,
  voyageApiKey:    process.env.VOYAGE_API_KEY,
  cohereApiKey:    process.env.COHERE_API_KEY,
}

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing env var: ${key}`)
  return v
}

const pool      = new Pool({ connectionString: config.databaseUrl, max: 10 })
const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })
const app       = new Hono()
const S         = config.schema

class EmbeddingProviderError extends Error {
  readonly provider: string

  constructor(provider: string, message: string) {
    super(message)
    this.name = 'EmbeddingProviderError'
    this.provider = provider
  }
}

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

/** Projects are registered only via POST /projects (e.g. robrain init-project). Reject typos / stale ids loudly. */
async function jsonIfProjectUnknown(projectId: string, c: Context): Promise<Response | undefined> {
  const r = await pool.query(`SELECT 1 FROM ${S}.projects WHERE id = $1 LIMIT 1`, [projectId])
  if (!r.rowCount) {
    return c.json(projectNotRegisteredJson(projectId), 404)
  }
  return undefined
}

// ── Auth ──────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  if (config.apiKey) {
    const auth = c.req.header('Authorization')
    if (!auth || auth !== `Bearer ${config.apiKey}`) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
  }
  await next()
})

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
const ExtractedSchema = z.object({
  decision:   z.string().nullable(),
  rationale:  z.string().nullable(),
  rejected:   z.array(z.object({ option: z.string(), reason: z.string() })),
  confidence: z.number(),
})

const SignalSchema = z.object({
  signal: z.object({
    turn: z.object({
      session_id:    z.string(),
      sequence:      z.number(),
      user_message:  z.string(),
      claude_reply:  z.string(),
      files_touched: z.array(z.string()).default([]),
      timestamp:     z.string(),
    }),
    decision_type:        z.string(),
    confidence:           z.number(),
    files_affected:       z.array(z.string()).default([]),
    scope:                z.enum(['user','local','team','global']).default('team'),
    needs_classification: z.boolean().optional(),
    extracted:            ExtractedSchema.optional(),
  }),
})

app.post('/signals', async (c) => {
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
    const extracted = trustSensingExtract
      ? signal.extracted!
      : await extractDecisionOSS(signal.turn.user_message, signal.turn.claude_reply)

    if (!extracted.decision || extracted.confidence < minConf) {
      return c.json({ accepted: false, action: 'discarded', message: 'No decision extracted' })
    }

    // Embed the decision
    const embedding = await embed(`${extracted.decision}. ${extracted.rationale ?? ''}`)

    const { rows } = await pool.query<{ id: string }>(`
      INSERT INTO ${S}.decisions (
        project_id, session_id, decision, rationale,
        rejected, files_affected, confidence, scope, source, embedding
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::text[], $7, $8, $9, $10::vector)
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
  const query_text = c.req.query('query')   // for robrain inject semantic search
  const limitRaw   = c.req.query('limit') ?? '20'
  const parsedLimit = Number.parseInt(limitRaw, 10)
  const limit       = Number.isFinite(parsedLimit) && parsedLimit >= 1
    ? Math.min(parsedLimit, 100)
    : 20

  if (!projectId) return c.json({ error: 'project_id required' }, 400)

  const unknownProject = await jsonIfProjectUnknown(projectId, c)
  if (unknownProject) return unknownProject

  try {
    let rows: unknown[]

    if (query_text) {
      // Semantic search for robrain inject
      const embedding = await embed(query_text)
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at,
               1 - (d.embedding <=> $1::vector) AS similarity
        FROM ${S}.decisions d
        JOIN ${S}.sessions s ON s.id = d.session_id
        WHERE s.project_id = $2
          AND d.invalidated_at IS NULL
          AND d.embedding IS NOT NULL
          AND 1 - (d.embedding <=> $1::vector) > 0.4
        ORDER BY d.embedding <=> $1::vector
        LIMIT $3
      `, [JSON.stringify(embedding), projectId, limit])
      rows = result.rows
    } else if (sessionId) {
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at
        FROM ${S}.decisions d
        WHERE d.session_id = $1 AND d.invalidated_at IS NULL
        ORDER BY d.created_at DESC LIMIT $2
      `, [sessionId, limit])
      rows = result.rows
    } else if ((all || recent) && !history) {
      // `all` (review --all) or `recent` (default review + inject): active project-wide, newest first
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at
        FROM ${S}.decisions d
        JOIN ${S}.sessions s ON s.id = d.session_id
        WHERE s.project_id = $1 AND d.invalidated_at IS NULL
        ORDER BY d.created_at DESC LIMIT $2
      `, [projectId, limit])
      rows = result.rows
    } else if (history) {
      // --history (with or without --all): full lifecycle for the project
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at
        FROM ${S}.decisions d
        JOIN ${S}.sessions s ON s.id = d.session_id
        WHERE s.project_id = $1
        ORDER BY d.created_at ASC LIMIT $2
      `, [projectId, limit])
      rows = result.rows
    } else {
      // Bare query (no mode flags): same as recent — newest active decisions project-wide
      const result = await pool.query(`
        SELECT d.id, d.decision, d.rationale, d.rejected,
               d.files_affected, d.confidence, d.scope,
               d.created_at, d.session_id, d.conflict_flag,
               d.supersedes_id, d.invalidated_at
        FROM ${S}.decisions d
        JOIN ${S}.sessions s ON s.id = d.session_id
        WHERE s.project_id = $1 AND d.invalidated_at IS NULL
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

app.post('/scores', async (c) => {
  const body = await c.req.json<{
    scores: Array<{ session_id: string; sequence: number; injected_memory_ids: string[]; final_score: number }>
  }>()

  const updates: Promise<void>[] = []

  for (const score of body.scores) {
    let claudeReply = ''
    try {
      const { rows } = await pool.query<{ claude_reply: string }>(`
        SELECT claude_reply FROM ${S}.session_turns
        WHERE session_id = $1 AND sequence = $2 LIMIT 1
      `, [score.session_id, score.sequence])
      claudeReply = rows[0]?.claude_reply ?? ''
    } catch { /* fall back to default delta */ }

    for (const id of score.injected_memory_ids) {
      let delta = 0.03
      if (claudeReply) {
        try {
          const { rows } = await pool.query<{ decision: string; rationale: string | null }>(
            `SELECT decision, rationale FROM ${S}.decisions WHERE id = $1`, [id]
          )
          const row = rows[0]
          if (row) {
            const terms = extractKeyTerms(`${row.decision} ${row.rationale ?? ''}`)
            const replyLower = claudeReply.toLowerCase()
            const matchCount = terms.filter(t => replyLower.includes(t)).length
            const termScore  = terms.length > 0 ? matchCount / terms.length : 0
            delta = termScore > 0.3 ? 0.05 : -0.02
          }
        } catch { /* use default */ }
      }
      updates.push(
        pool.query(
          `UPDATE ${S}.decisions SET historical_relevance = GREATEST(0, LEAST(1, historical_relevance + $2)), updated_at = now() WHERE id = $1`,
          [id, delta]
        ).then(() => {})
      )
    }
  }

  await Promise.allSettled(updates)
  return c.json({ accepted: true, updated: updates.length })
})

function extractKeyTerms(text: string): string[] {
  const stop = new Set(['the','a','an','and','or','in','on','at','to','for','of','with','is','are','was','use','used','this','that','we'])
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 3 && !stop.has(t))
}

// ── POST /corrections — from robrain review ────────────────────
app.post('/corrections', async (c) => {
  const body = await c.req.json<{
    decision_id:         string
    corrected_decision?: string
    corrected_rationale?: string
    invalidate:          boolean
    source:              string
  }>()

  if (body.invalidate) {
    await pool.query(`
      UPDATE ${S}.decisions
      SET invalidated_at = now(), updated_at = now()
      WHERE id = $1
    `, [body.decision_id])
  }

  if (body.corrected_decision) {
    const projectId = c.req.header('X-Project-Id') ?? 'default'
    const unknownProject = await jsonIfProjectUnknown(projectId, c)
    if (unknownProject) return unknownProject

    const sessionId = c.req.header('X-Session-Id') ?? 'correction'
    const embedding  = await embed(`${body.corrected_decision}. ${body.corrected_rationale ?? ''}`)

    await pool.query(`
      INSERT INTO ${S}.decisions (
        project_id, session_id, decision, rationale,
        rejected, files_affected, confidence, scope, source,
        supersedes_id, embedding
      ) VALUES ($1,$2,$3,$4,'[]'::jsonb,'{}'::text[],1.0,'team',$5,$6,$7::vector)
    `, [
      projectId, sessionId,
      body.corrected_decision,
      body.corrected_rationale ?? null,
      body.source,
      body.invalidate ? body.decision_id : null,
      JSON.stringify(embedding),
    ])
  }

  return c.json({ accepted: true })
})

// ── POST /projects — upsert project ───────────────────────────
app.post('/projects', async (c) => {
  const { id, name } = await c.req.json<{ id: string; name: string }>()
  await pool.query(`
    INSERT INTO ${S}.projects (id, name)
    VALUES ($1, $2)
    ON CONFLICT (id) DO UPDATE SET last_session_at = now(), updated_at = now()
  `, [id, name])
  return c.json({ accepted: true })
})

// ── GET /projects — list projects + counts (CLI: robrain projects list) ──
app.get('/projects', async (c) => {
  try {
    const { rows } = await pool.query<{
      id: string
      name: string
      updated_at: Date
      session_count: string
      decision_count: string
    }>(`
      SELECT p.id, p.name, p.updated_at,
        (SELECT COUNT(*)::text FROM ${S}.sessions s WHERE s.project_id = p.id) AS session_count,
        (SELECT COUNT(*)::text FROM ${S}.decisions d WHERE d.project_id = p.id AND d.invalidated_at IS NULL) AS decision_count
      FROM ${S}.projects p
      ORDER BY p.updated_at DESC NULLS LAST
    `)
    return c.json({
      projects: rows.map(r => ({
        id:             r.id,
        name:           r.name,
        updated_at:     r.updated_at,
        session_count:  Number.parseInt(r.session_count, 10) || 0,
        decision_count: Number.parseInt(r.decision_count, 10) || 0,
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
    await client.query(`UPDATE ${S}.sessions SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`UPDATE ${S}.decisions SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`UPDATE ${S}.mem0_facts SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`UPDATE ${S}.planning_blocks SET project_id = $1 WHERE project_id = $2`, [to, from])
    await client.query(`DELETE FROM ${S}.projects WHERE id = $1`, [from])
    await client.query('COMMIT')
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

// OSS extraction — kept in sync with Sensing Haiku prompt (packages/sensing-mcp classifyDecision extractDecision)
// so flush-on-close and any path without signal.extracted still sees the happy path.
function stripMarkdownJsonFence(raw: string): string {
  const t = raw.trim()
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return m?.[1]?.trim() ?? t
}

async function extractDecisionOSS(userMsg: string, claudeReply: string) {
  const system = `You extract technical decisions from software development conversations.

A decision includes ANY of the following (not only formal deliberation):
- Explicit choice between alternatives, or adopting/rejecting a tool or approach
- Brief agreements or directions: e.g. "let's use X", "standardize on Y", "we'll go with Z", "stick with W"
- Constraints or conventions established for the repo or team (defaults, policies, "from now on")
- Plans that commit the work to a specific stack, package manager, library, or pattern

NOT a decision: pure questions with no commitment, vague brainstorming with no resolution, or execution-only steps with no stable choice (e.g. "run the tests" with no policy change).

Fields:
- "decision": one short imperative sentence stating WHAT was chosen or agreed (max ~20 words). If nothing was committed, null.
- "rationale": why, IF stated in the turn; otherwise null. Empty is normal for offhand agreement. Max 15 words.
- "rejected": options explicitly declined, IF any; otherwise []. An empty list is EXPECTED when alternatives were never discussed — do NOT treat that as "no decision".
- "confidence": 0.0–1.0. Use HIGH (e.g. 0.75–1.0) when the turn clearly states a commitment or resolution, even if brief. Use LOW only when speculative, purely exploratory, or ambiguous.

Output ONLY valid JSON. If no decision: {"decision": null, "rationale": null, "rejected": [], "confidence": 0}.
Never add explanation outside the JSON.
Schema: {"decision": string|null, "rationale": string|null, "rejected": [{"option": string, "reason": string}], "confidence": number}`

  const user = `Session turn:
User: ${userMsg}
Claude: ${claudeReply}`

  const empty = (): { decision: null; rationale: null; rejected: []; confidence: number } =>
    ({ decision: null, rationale: null, rejected: [], confidence: 0 })

  try {
    const resp = await anthropic.messages.create({
      model:        config.anthropicModel,
      max_tokens:   300,
      system,
      messages:     [{ role: 'user', content: user }],
    })
    const block = resp.content[0]
    const text  = block?.type === 'text'
      ? stripMarkdownJsonFence(block.text)
      : '{}'
    const raw = JSON.parse(text) as {
      decision?: string | null
      rationale?: string | null
      rejected?: unknown
      confidence?: number
    }
    const rejected = Array.isArray(raw.rejected)
      ? raw.rejected.filter(
          (x): x is { option: string; reason: string } =>
            x !== null && typeof x === 'object' &&
            typeof (x as { option?: unknown }).option === 'string' &&
            typeof (x as { reason?: unknown }).reason === 'string',
        )
      : []
    const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
      ? raw.confidence
      : 0
    return {
      decision: typeof raw.decision === 'string' ? raw.decision : null,
      rationale: typeof raw.rationale === 'string' ? raw.rationale : null,
      rejected,
      confidence,
    }
  } catch {
    return empty()
  }
}

async function embed(text: string): Promise<number[]> {
  const TARGET = 1536
  const pad = (v: number[]) => v.length >= TARGET ? v.slice(0, TARGET) : [...v, ...new Array(TARGET - v.length).fill(0)]
  const parseErrorDetail = async (r: Response): Promise<string> => {
    const raw = await r.text().catch(() => '')
    if (!raw) return `HTTP ${r.status}`
    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown; detail?: unknown }
      if (typeof parsed.error === 'string') return parsed.error
      if (parsed.error && typeof parsed.error === 'object' && typeof (parsed.error as { message?: unknown }).message === 'string') {
        return (parsed.error as { message: string }).message
      }
      if (typeof parsed.message === 'string') return parsed.message
      if (typeof parsed.detail === 'string') return parsed.detail
    } catch {
      // non-JSON payload
    }
    return raw.slice(0, 500)
  }
  const ensureEmbedding = (provider: string, vector: unknown): number[] => {
    if (!Array.isArray(vector) || !vector.every(n => typeof n === 'number' && Number.isFinite(n))) {
      throw new EmbeddingProviderError(provider, 'Invalid embedding payload')
    }
    return vector as number[]
  }

  if (config.embeddingProvider === 'voyage' && config.voyageApiKey) {
    const r = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST', headers: { 'Authorization': `Bearer ${config.voyageApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'voyage-3-lite', input: [text] }),
    })
    if (!r.ok) {
      throw new EmbeddingProviderError('voyage', await parseErrorDetail(r))
    }
    const d = await r.json() as { data?: Array<{ embedding?: unknown }> }
    return pad(ensureEmbedding('voyage', d.data?.[0]?.embedding))
  }
  if (config.embeddingProvider === 'cohere' && config.cohereApiKey) {
    const r = await fetch('https://api.cohere.com/v1/embed', {
      method: 'POST', headers: { 'Authorization': `Bearer ${config.cohereApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'embed-english-v3.0', texts: [text], input_type: 'search_document', embedding_types: ['float'] }),
    })
    if (!r.ok) {
      throw new EmbeddingProviderError('cohere', await parseErrorDetail(r))
    }
    const d = await r.json() as { embeddings?: { float?: unknown[] } }
    return pad(ensureEmbedding('cohere', d.embeddings?.float?.[0]))
  }
  // Default: OpenAI
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers: { 'Authorization': `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  })
  if (!r.ok) {
    throw new EmbeddingProviderError('openai', await parseErrorDetail(r))
  }
  const d = await r.json() as { data?: Array<{ embedding?: unknown }> }
  return pad(ensureEmbedding('openai', d.data?.[0]?.embedding))
}

const REGENERATE_SUMMARY_DEBOUNCE_MS = 30_000

/** Per-project trailing debounce — coalesces burst writes (e.g. init-project) into one Haiku call per window. */
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
  const { rows } = await pool.query(`
    SELECT d.decision, d.rationale, d.rejected FROM ${S}.decisions d
    JOIN ${S}.sessions s ON s.id = d.session_id
    WHERE s.project_id = $1 AND d.invalidated_at IS NULL
    ORDER BY d.created_at DESC LIMIT 5
  `, [projectId])
  if (!rows.length) return

  const list = rows.map((r: { decision: string; rationale: string | null; rejected: Array<{ option: string; reason: string }> }, i: number) => {
    const vetoes = (r.rejected ?? []).map((rv: { option: string; reason: string }) => `${rv.option} (${rv.reason})`).join(', ')
    return `${i + 1}. ${r.decision}${r.rationale ? ` — ${r.rationale}` : ''}${vetoes ? ` | Rejected: ${vetoes}` : ''}`
  }).join('\n')

  const resp = await anthropic.messages.create({
    model: config.anthropicModel, max_tokens: 150,
    system: 'Summarise project decisions in exactly 3 lines. Format: "Chose X over Y (reason)." Preserve rejected alternatives verbatim.',
    messages: [{ role: 'user', content: `Summarise:\n${list}` }],
  })
  const block   = resp.content[0]
  const summary = block?.type === 'text' ? block.text.trim() : null
  if (summary) {
    await pool.query(`UPDATE ${S}.projects SET always_on_summary=$2, updated_at=now() WHERE id=$1`, [projectId, summary])
  }
}

// ── Start ──────────────────────────────────────────────────────
serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`[RoBrain Perception OSS] Running on port ${config.port} — mode: ${config.ossMode ? 'self-hosted' : 'cloud'}`)
})

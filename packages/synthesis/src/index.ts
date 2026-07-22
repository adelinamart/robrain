#!/usr/bin/env node
// RoBrain Synthesis — periodic pass over the decision corpus (OSS).
//
// Run:     pnpm synthesis:run   (from repo root) or pnpm --filter @robrain/synthesis start
// Dry-run: pnpm synthesis:dry-run
// Loads repo-root `.env` (same as CLI) so DATABASE_URL / ANTHROPIC_API_KEY need not be exported manually.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Anthropic from '@anthropic-ai/sdk'
import { jsonrepair } from 'jsonrepair'
import pg from 'pg'
import { THRESHOLDS, loadEnv, normalizeLoopbackUrl, resolveLlmProvider, resolveOpenAiBaseUrl, openaiChat, DEFAULT_ANTHROPIC_LLM_MODEL, DEFAULT_OPENAI_LLM_MODEL, DEFAULT_OPENAI_BASE_URL, attachPoolErrorHandler } from '@robrain/shared'

const { Pool } = pg

/** Repo root for `.env` (src or dist: …/packages/synthesis/{src|dist} → three levels up). */
const synthesisDir = dirname(fileURLToPath(import.meta.url))
const repoRootForCli = (process.env.ROBRAIN_REPO?.trim() || join(synthesisDir, '..', '..', '..'))
loadEnv(repoRootForCli)

const config = {
  databaseUrl:      normalizeLoopbackUrl(requireEnv('DATABASE_URL')),
  schema:           process.env.DB_SCHEMA ?? 'context_system',
  // Reasoning LLM for the three passes. Default Anthropic (Haiku); set
  // LLM_PROVIDER=openai to run Synthesis without an Anthropic account.
  llmProvider:      resolveLlmProvider(),
  anthropicKey:     process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel:   process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_LLM_MODEL,
  // gpt-4o-mini can hallucinate fields under structured-output prompts —
  // prefer gpt-4o / gpt-4.1 for fidelity. Reuses OPENAI_API_KEY.
  openaiKey:        process.env.OPENAI_API_KEY ?? '',
  openaiModel:      process.env.OPENAI_LLM_MODEL ?? DEFAULT_OPENAI_LLM_MODEL,
  // OPENAI_BASE_URL — non-default means a local OpenAI-compatible server
  // (Ollama / LM Studio / vLLM); OPENAI_API_KEY becomes optional then.
  openaiBaseUrl:    resolveOpenAiBaseUrl(),
  lookbackDays:     Number(process.env.SYNTHESIS_LOOKBACK_DAYS ?? 0),
  minClusterSize:   Number(process.env.SYNTHESIS_MIN_CLUSTER ?? 3),
  contThreshold:    Number(process.env.SYNTHESIS_CONT_THRESHOLD ?? THRESHOLDS.SIMILARITY_LINK),
  entityThreshold:  Number(process.env.SYNTHESIS_ENTITY_MIN ?? 3),
  pass1ChunkSize:   Number(process.env.SYNTHESIS_PASS1_CHUNK ?? 50),
  pass2Concurrency: Number(process.env.SYNTHESIS_PASS2_CONCURRENCY ?? 4),
  dryRun:           process.env.SYNTHESIS_DRY_RUN === 'true',
  incremental:      process.env.SYNTHESIS_INCREMENTAL !== 'false',
  projectIdFilter:  process.env.SYNTHESIS_PROJECT_ID?.trim() || null,
  exportMemory:     process.env.SYNTHESIS_EXPORT_MEMORY === 'true',
}

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing env var: ${key}`)
  return v
}

// Require the selected reasoning provider's key — the passes can't run without it.
if (config.llmProvider === 'anthropic' && !config.anthropicKey) {
  throw new Error('Missing env var: ANTHROPIC_API_KEY (or set LLM_PROVIDER=openai with OPENAI_API_KEY)')
}
// A non-default OPENAI_BASE_URL means a local OpenAI-compatible server
// (Ollama / LM Studio / vLLM) — those usually run keyless, so only require
// OPENAI_API_KEY when talking to api.openai.com itself.
const usingLocalOpenAi = config.openaiBaseUrl !== DEFAULT_OPENAI_BASE_URL
if (config.llmProvider === 'openai' && !config.openaiKey && !usingLocalOpenAi) {
  throw new Error(
    'Missing env var: OPENAI_API_KEY (required when LLM_PROVIDER=openai, ' +
    'unless OPENAI_BASE_URL points at a local OpenAI-compatible server — Ollama / LM Studio / vLLM)'
  )
}

const pool      = new Pool({ connectionString: config.databaseUrl, max: 5 })
attachPoolErrorHandler(pool, 'RoBrain Synthesis')
// Construct the Anthropic client only when selected — the SDK throws on an empty key.
const anthropic = config.llmProvider === 'anthropic'
  ? new Anthropic({ apiKey: config.anthropicKey })
  : null
const S         = config.schema

/**
 * Provider-agnostic single-shot completion → returns the model's text.
 *
 * Anthropic wraps the static system prompt in an ephemeral prompt cache
 * (`cacheSystem`) so repeat cron / multi-project runs pay less for identical
 * system text. The OpenAI path skips that — OpenAI caches inputs automatically,
 * so the only difference is cost behavior, not correctness.
 */
async function llmText(opts: {
  system: string
  user: string
  maxTokens: number
  json?: boolean
  /** Anthropic-only: cache the static system prompt. Ignored on OpenAI (auto-cached). */
  cacheSystem?: boolean
}): Promise<string> {
  if (config.llmProvider === 'openai') {
    return openaiChat({
      apiKey:    config.openaiKey,
      model:     config.openaiModel,
      baseUrl:   config.openaiBaseUrl,
      system:    opts.system,
      user:      opts.user,
      maxTokens: opts.maxTokens,
      json:      opts.json,
    })
  }
  const resp = await anthropic!.messages.create({
    model:      config.anthropicModel,
    max_tokens: opts.maxTokens,
    system:     opts.cacheSystem ? cachedEphemeral(opts.system) : opts.system,
    messages:   [{ role: 'user', content: opts.user }],
  })
  const block = resp.content[0]
  return block?.type === 'text' ? block.text : ''
}

/** Static system prompts — identical across runs; ephemeral cache cuts input-token cost on repeat cron / multi-project. */
const SYSTEM_PASS1_CLUSTER = `You cluster software architecture decisions into topic areas.

Output format (strict):
- Your entire message must be one JSON value only: a top-level array [...] of cluster objects.
- Do not add markdown code fences, headings, or any prose before or after the JSON.
- The first non-whitespace character must be "[" and the last must be "]".
- Use double quotes for all keys and every string value — including drift_signal. Use true/false/null (not the strings "true"/"false"/"null").
- Lexical JSON only: after ":" a string must start with ". Never emit bare words (invalid: "drift_signal": Earlier cap… — valid: "drift_signal": "Earlier cap…").
- decision_indices: integers only, 1-based positions in the numbered list you were given.

Each cluster object:
{"topic": string, "decision_indices": number[], "has_drift": boolean, "drift_signal": string|null}
- topic: short kebab-case name for the architectural area (e.g. "state-management", "auth", "database")
- decision_indices: 1-based indices of decisions in this cluster within the provided list
- has_drift: true if RECENT decisions (later dates) disagree with EARLIER ones
- drift_signal: null, or one or more sentences inside a single JSON string (still quoted), describing the drift
Example shape (structure only): [{"topic":"ranking","decision_indices":[1,2],"has_drift":true,"drift_signal":"Initial cap was ~20; later rows raised the limit with two-tier ranking."}]
Only flag drift with clear evidence of direction change. Use dates to judge recency.

Planning signal — approval: each line is tagged [approved] (user reviewed in robrain review) or [pending review].
Give materially higher weight to [approved] rows when forming the cluster shape and when judging drift, but still include [pending review] rows so you can detect emerging direction change before approval.`

const SYSTEM_PASS1_COMPILED_TRUTH = `Summarise the team's trusted position on one architectural topic in one sentence.
Every decision in the input has already been user-approved (robrain review). Do not hedge about "might change."
Format: "Chose X over Y (reason) over Z (reason)."
Preserve all rejected alternatives verbatim. Output only the sentence.`

const SYSTEM_PASS2_CONTRADICTION = `Classify the relationship between two software decisions (first = A, second = B).
Output ONLY one lowercase word: yes, no, related, or extends
- yes: they cannot both be true (contradiction)
- extends: B builds on, refines, or specializes A without contradicting it (same topic, cumulative)
- related: same topic, compatible peers, neither extends the other
- no: largely unrelated topics`

const SYSTEM_PASS3_ENTITY_EXTRACT = `Extract concrete proper-noun entities (libraries, frameworks, services, tools, modules).
Output ONLY valid JSON: an array of {"name": string, "type": "library"|"service"|"module"|"pattern"}.
Use exact casing as written. Exclude generic words ("database", "api", "function", "test").`

const SYSTEM_PASS3_ENTITY_SUMMARY =
  'In one sentence, what role does this entity play in the project? Be specific.'

/** Anthropic prompt cache — requires @anthropic-ai/sdk ^0.32+ and a cache-supported model. */
function cachedEphemeral(text: string) {
  return [{ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } }]
}

function log(msg: string)  { console.log(`[Synthesis] ${msg}`) }
function warn(msg: string) { console.warn(`[Synthesis] ⚠ ${msg}`) }

function stripMarkdownJsonFence(raw: string): string {
  const t = raw.trim()
  const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  return m?.[1]?.trim() ?? t
}

/** Strip BOM / stray whitespace models sometimes emit before JSON. */
function normalizeLlmJsonText(raw: string): string {
  return raw.replace(/^\uFEFF/, '').trim()
}

/** Best-effort fix for trailing commas before } or ] (common in LLM JSON). */
function stripTrailingCommasLoose(s: string): string {
  let prev = ''
  let out = s
  for (let i = 0; i < 8 && out !== prev; i++) {
    prev = out
    out = out.replace(/,(\s*[\]}])/g, '$1')
  }
  return out
}

/** All ``` / ```json fenced bodies in order (for forgiving parse). */
function extractMarkdownFenceBodies(raw: string): string[] {
  const out: string[] = []
  const re = /```(?:json)?\s*([\s\S]*?)\s*```/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const body = m[1]?.trim()
    if (body) out.push(body)
  }
  return out
}

/** First balanced JSON array starting at the first "[", respecting quoted strings. */
function extractFirstJsonArray(s: string): string | null {
  const start = s.indexOf('[')
  if (start < 0) return null
  return sliceBalancedJson(s, start, '[', ']')
}

/** First balanced JSON object starting at the first "{", respecting quoted strings. */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start < 0) return null
  return sliceBalancedJson(s, start, '{', '}')
}

function sliceBalancedJson(s: string, start: number, open: string, close: string): string | null {
  if (s[start] !== open) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) {
      esc = false
      continue
    }
    if (c === '\\' && inStr) {
      esc = true
      continue
    }
    if (c === '"') {
      inStr = !inStr
      continue
    }
    if (!inStr) {
      if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) return s.slice(start, i + 1)
      }
    }
  }
  return null
}

type Pass1Cluster = {
  topic: string
  decision_indices: number[]
  has_drift: boolean
  drift_signal: string | null
}

function clustersFromParsedValue(v: unknown): Pass1Cluster[] | null {
  if (v == null) return null
  if (Array.isArray(v)) {
    const r = validateAndCoerceClusters(v)
    return r.length ? r : null
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of [
      'clusters',
      'topic_clusters',
      'topics',
      'groups',
      'items',
      'results',
      'data',
      'output',
      'result',
    ]) {
      const inner = o[key]
      if (Array.isArray(inner)) {
        const r = validateAndCoerceClusters(inner)
        if (r.length) return r
      }
    }
  }
  return null
}

function validateAndCoerceClusters(arr: unknown[]): Pass1Cluster[] {
  const out: Pass1Cluster[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const topicRaw = o.topic ?? o.title ?? o.name ?? o.label
    const topic = typeof topicRaw === 'string' ? topicRaw.trim() : topicRaw != null ? String(topicRaw).trim() : ''
    let di: unknown = o.decision_indices ?? o.indices ?? o.indexes ?? o.decision_numbers
    if (di == null && o.decision_index != null) di = [o.decision_index]
    if (!topic || !Array.isArray(di)) continue
    const indices: number[] = []
    for (const x of di) {
      if (typeof x === 'number' && Number.isFinite(x)) {
        const n = Math.trunc(x)
        if (n >= 1) indices.push(n)
        continue
      }
      if (typeof x === 'string') {
        const ts = x.trim()
        if (/^\d+$/.test(ts)) {
          indices.push(parseInt(ts, 10))
          continue
        }
        const f = parseFloat(ts)
        if (Number.isFinite(f) && f >= 1) indices.push(Math.trunc(f))
      }
    }
    if (!indices.length) continue
    let driftSignal: string | null = null
    const driftRaw = o.drift_signal ?? o.driftSignal
    if (driftRaw != null && driftRaw !== '') {
      driftSignal = typeof driftRaw === 'string' ? driftRaw : String(driftRaw)
    }
    out.push({
      topic,
      decision_indices: indices,
      has_drift:        Boolean(o.has_drift ?? o.hasDrift),
      drift_signal:     driftSignal,
    })
  }
  return out
}

/** Strict parse, then jsonrepair (unquoted strings, minor lexical glitches) before giving up. */
function tryAcceptParsedJson<T>(raw: string, accept: (v: unknown) => T | null): T | null {
  try {
    const hit = accept(JSON.parse(raw))
    if (hit) return hit
  } catch { /* */ }
  try {
    const hit = accept(JSON.parse(jsonrepair(raw)))
    if (hit) return hit
  } catch { /* */ }
  return null
}

/**
 * Try JSON.parse on the slice, then (if `accept` returns null) recover a balanced {...} or [...]
 * substring. Same pattern for Pass 1 clusters and Pass 3 entity lists.
 */
function tryParseModelJsonSlice<T>(candidate: string, accept: (v: unknown) => T | null): T | null {
  const attempts = [candidate.trim(), stripTrailingCommasLoose(candidate.trim())]
  for (const a of attempts) {
    const direct = tryAcceptParsedJson(a, accept)
    if (direct) return direct
    const innerArr = extractFirstJsonArray(a)
    if (innerArr && innerArr !== a) {
      for (const b of [innerArr, stripTrailingCommasLoose(innerArr)]) {
        const hit = tryAcceptParsedJson(b, accept)
        if (hit) return hit
      }
    }
    const innerObj = extractFirstJsonObject(a)
    if (innerObj && innerObj !== a) {
      for (const b of [innerObj, stripTrailingCommasLoose(innerObj)]) {
        const hit = tryAcceptParsedJson(b, accept)
        if (hit) return hit
      }
    }
  }
  return null
}

function tryParseClusterJsonSlice(candidate: string): Pass1Cluster[] | null {
  return tryParseModelJsonSlice(candidate, clustersFromParsedValue)
}

/** Candidate strings that might contain JSON (fences, preamble, trailing prose). */
function gatherJsonTextCandidates(raw: string): string[] {
  const t = normalizeLlmJsonText(raw)
  if (!t) return []
  const seen = new Set<string>()
  const candidates: string[] = []
  const push = (s: string) => {
    const x = s.trim()
    if (x && !seen.has(x)) {
      seen.add(x)
      candidates.push(x)
    }
  }
  push(t)
  push(stripMarkdownJsonFence(t))
  for (const body of extractMarkdownFenceBodies(t)) push(body)
  const arr = extractFirstJsonArray(t)
  if (arr) push(arr)
  const obj = extractFirstJsonObject(t)
  if (obj) push(obj)
  const lb = t.indexOf('[')
  if (lb > 0) {
    const arr2 = extractFirstJsonArray(t.slice(lb))
    if (arr2) push(arr2)
  }
  return candidates
}

/** Collect candidate substrings that might contain the cluster array, then parse. */
function parsePass1ClusterResponse(raw: string): Pass1Cluster[] | null {
  for (const c of gatherJsonTextCandidates(raw)) {
    const parsed = tryParseClusterJsonSlice(c)
    if (parsed?.length) return parsed
  }
  return null
}

const ENTITY_ARRAY_WRAP_KEYS = [
  'entities',
  'items',
  'results',
  'data',
  'output',
  'result',
  'values',
  'extracted_entities',
  'libraries',
  'list',
  'rows',
] as const

function unwrapEntityArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  for (const key of ENTITY_ARRAY_WRAP_KEYS) {
    const inner = o[key]
    if (Array.isArray(inner)) return inner
  }
  return null
}

function tryParseEntityJsonSlice(candidate: string): unknown[] | null {
  return tryParseModelJsonSlice(candidate, unwrapEntityArray)
}

function parseEntityArrayFromModelText(raw: string): unknown[] | null {
  for (const c of gatherJsonTextCandidates(raw)) {
    const parsed = tryParseEntityJsonSlice(c)
    if (parsed != null) return parsed
  }
  return null
}

const ENTITY_TYPES = new Set(['library', 'service', 'module', 'pattern'])

function coerceEntityCandidates(rows: unknown[]): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const nameRaw = o.name ?? o.entity ?? o.title ?? o.label
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : nameRaw != null ? String(nameRaw).trim() : ''
    if (!name) continue
    const typeRaw = o.type ?? o.kind ?? o.category
    let type = typeof typeRaw === 'string' ? typeRaw.trim().toLowerCase() : 'library'
    if (!ENTITY_TYPES.has(type)) type = 'library'
    out.push({ name, type })
  }
  return out
}

/** F2 — refresh Claude auto-memory after new compiled_truth rows (needs `working_directory` on projects). */
async function spawnExportMemory(projectId: string, workingDir: string): Promise<void> {
  const bin = join(repoRootForCli, 'packages/cli/bin/robrain.js')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [
      bin, 'export-memory', '--cwd', workingDir, '--project-id', projectId,
    ], {
      cwd:       repoRootForCli,
      stdio:     'inherit',
      env:       process.env,
    })
    child.on('error', reject)
    child.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`export-memory exited with code ${code}`)),
    )
  })
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      last = err
      const status = (err as { status?: number }).status
      if (status && status < 500 && status !== 429) throw err
      await new Promise(r => setTimeout(r, 500 * 2 ** i))
    }
  }
  throw last
}

type DecisionRow = {
  id: string
  decision: string
  rationale: string | null
  rejected: Array<{ option: string; reason: string }>
  scope: string
  created_at: Date
  session_id: string
  reviewed_at: Date | null
}

async function pass1ClusterAndDrift(projectId: string): Promise<boolean> {
  log('Pass 1: clustering + drift detection')
  let wroteCompiledTruth = false

  const lookbackSql =
    config.lookbackDays > 0
      ? `AND d.created_at > now() - interval '${config.lookbackDays} days'`
      : ''

  const { rows: decisions } = await pool.query<DecisionRow>(`
    SELECT d.id, d.decision, d.rationale, d.rejected, d.scope, d.created_at, d.session_id, d.reviewed_at
    FROM ${S}.decisions d
    JOIN ${S}.sessions s ON s.id = d.session_id
    WHERE s.project_id = $1
      AND d.invalidated_at IS NULL
      AND d.quarantined_at IS NULL
      ${lookbackSql}
    ORDER BY d.created_at ASC
  `, [projectId])

  if (decisions.length < config.minClusterSize) {
    log(`  ${decisions.length} decisions — skip (min: ${config.minClusterSize})`)
    return false
  }

  const chunks: DecisionRow[][] = []
  for (let i = 0; i < decisions.length; i += config.pass1ChunkSize) {
    chunks.push(decisions.slice(i, i + config.pass1ChunkSize))
  }

  const allClusters = new Map<string, {
    decisions: DecisionRow[]
    has_drift: boolean
    drift_signal: string | null
  }>()

  for (const chunk of chunks) {
    const list = chunk.map((d, i) => {
      const date   = d.created_at.toISOString().slice(0, 10)
      const review = d.reviewed_at ? 'approved' : 'pending review'
      return `${i + 1}. [${date}] [${review}] [${d.id.slice(0, 8)}] ${d.decision}${d.rationale ? ` — ${d.rationale}` : ''}`
    }).join('\n')

    const rawText = await withRetry(() =>
      llmText({
        system:     SYSTEM_PASS1_CLUSTER,
        user:       `Cluster these decisions:\n\n${list}`,
        maxTokens:  4096,
        json:       true,
        cacheSystem: true,
      }),
    )

    const clusters = parsePass1ClusterResponse(rawText)
    if (!clusters?.length) {
      warn(`  Could not parse cluster response for chunk (${chunk.length} decisions)`)
      if (process.env.SYNTHESIS_DEBUG_PARSE === 'true' && rawText) {
        const preview = rawText.length > 400 ? `${rawText.slice(0, 400)}…` : rawText
        log(`    parse debug preview: ${JSON.stringify(preview)}`)
      }
      continue
    }

    for (const c of clusters) {
      if (!c.topic || !c.decision_indices?.length) continue
      const existing = allClusters.get(c.topic) ?? { decisions: [], has_drift: false, drift_signal: null }
      for (const idx of c.decision_indices) {
        const d = chunk[idx - 1]
        if (d) existing.decisions.push(d)
      }
      existing.has_drift = existing.has_drift || Boolean(c.has_drift)
      existing.drift_signal = existing.drift_signal ?? c.drift_signal
      allClusters.set(c.topic, existing)
    }
  }

  log(`  ${allClusters.size} topic clusters across ${chunks.length} chunk(s)`)

  for (const [topic, cluster] of allClusters) {
    if (cluster.decisions.length < 2) continue
    log(`  Topic "${topic}": ${cluster.decisions.length} decisions${cluster.has_drift ? ' ⚠ DRIFT' : ''}`)

    // F9 hybrid: drift/cluster used all rows above; compiled_truth only from reviewed (trusted) rows.
    const reviewedForTruth = cluster.decisions.filter(d => d.reviewed_at != null)
    if (reviewedForTruth.length === 0) {
      log(`    skip compiled_truth — no reviewed decisions in cluster (F9)`)
    } else {
      const text = reviewedForTruth
        .map(d => `${d.decision}${d.rationale ? ` — ${d.rationale}` : ''}`)
        .join('\n')

      const truthText = await withRetry(() =>
        llmText({
          system:      SYSTEM_PASS1_COMPILED_TRUTH,
          user:        `Topic: ${topic}\n\nDecisions:\n${text}`,
          maxTokens:   120,
          cacheSystem: true,
        }),
      )

      const compiledTruth = truthText.trim() || null
      if (!compiledTruth) {
        /* skip write */
      } else if (!config.dryRun) {
        await pool.query(
      `
      INSERT INTO ${S}.planning_blocks
        (project_id, block_type, topic, content, weight, last_refreshed_at)
      VALUES ($1, 'compiled_truth', $2, $3, 2.0, now())
      ON CONFLICT (project_id, block_type, topic) WHERE (topic IS NOT NULL)
      DO UPDATE SET content = EXCLUDED.content, last_refreshed_at = now(), updated_at = now()
    `,
          [projectId, topic, `[${topic}] ${compiledTruth}`],
        )
        wroteCompiledTruth = true
      }
    }

    if (cluster.has_drift && cluster.drift_signal && !config.dryRun) {
      await pool.query(
        `
        INSERT INTO ${S}.planning_blocks
          (project_id, block_type, topic, content, weight, last_refreshed_at)
        VALUES ($1, 'drift_signal', $2, $3, 1.5, now())
        ON CONFLICT (project_id, block_type, topic) WHERE (topic IS NOT NULL)
        DO UPDATE SET content = EXCLUDED.content, last_refreshed_at = now(), updated_at = now()
      `,
        [projectId, topic, `Topic "${topic}" drifting: ${cluster.drift_signal}`],
      )
    }
  }

  return wroteCompiledTruth
}

async function pass2ContradictionScan(projectId: string, lastSynthesisAt: Date | null): Promise<void> {
  log('Pass 2: corpus contradiction scan')

  const incrementalClause =
    config.incremental && lastSynthesisAt
      ? 'AND (d1.created_at > $3 OR d2.created_at > $3)'
      : ''
  const params: unknown[] = [projectId, config.contThreshold]
  if (incrementalClause) params.push(lastSynthesisAt)

  const { rows: pairs } = await pool.query<{
    id_a: string
    decision_a: string
    rejected_a: Array<{ option: string; reason: string }>
    id_b: string
    decision_b: string
    rejected_b: Array<{ option: string; reason: string }>
    similarity: number
  }>(
    `
    SELECT
      d1.id AS id_a, d1.decision AS decision_a, d1.rejected AS rejected_a,
      d2.id AS id_b, d2.decision AS decision_b, d2.rejected AS rejected_b,
      1 - (d1.embedding <=> d2.embedding) AS similarity
    FROM ${S}.decisions d1
    JOIN ${S}.sessions s1 ON s1.id = d1.session_id
    JOIN ${S}.decisions d2 ON d1.id < d2.id
    JOIN ${S}.sessions s2 ON s2.id = d2.session_id
    WHERE s1.project_id = $1
      AND s2.project_id = $1
      AND d1.scope = d2.scope
      AND d1.invalidated_at IS NULL AND d2.invalidated_at IS NULL
      AND d1.quarantined_at IS NULL AND d2.quarantined_at IS NULL
      AND d1.embedding IS NOT NULL AND d2.embedding IS NOT NULL
      AND NOT (d1.reviewed_at IS NOT NULL AND d2.reviewed_at IS NOT NULL)
      AND 1 - (d1.embedding <=> d2.embedding) > $2
      AND NOT EXISTS (
        SELECT 1 FROM ${S}.decision_relations r
        WHERE (r.from_id = d1.id AND r.to_id = d2.id)
           OR (r.from_id = d2.id AND r.to_id = d1.id)
      )
      ${incrementalClause}
    ORDER BY similarity DESC
    LIMIT 20
  `,
    params,
  )

  if (pairs.length === 0) {
    log('  no candidate pairs')
    return
  }
  log(`  ${pairs.length} candidate pairs — checking with concurrency=${config.pass2Concurrency}`)

  let cursor = 0
  const workers = Array.from({ length: config.pass2Concurrency }, () =>
    (async (): Promise<{ contradictions: number; extends: number }> => {
      let localContradictions = 0
      let localExtends        = 0
      while (true) {
        const idx = cursor++
        if (idx >= pairs.length) return { contradictions: localContradictions, extends: localExtends }
        const pair = pairs[idx]
        if (!pair) return { contradictions: localContradictions, extends: localExtends }

        const respText = await withRetry(() =>
          llmText({
            system:      SYSTEM_PASS2_CONTRADICTION,
            user:        `A: ${pair.decision_a}\nB: ${pair.decision_b}`,
            maxTokens:   24,
            cacheSystem: true,
          }),
        )

        const raw    = respText.trim().toLowerCase() || 'no'
        const answer = raw.replace(/\.$/, '').split(/\s+/)[0] ?? 'no'

        if (answer === 'yes') {
          localContradictions++
          if (config.dryRun) continue
          await pool.query(
            `
            UPDATE ${S}.decisions
            SET conflict_flag = true, updated_at = now()
            WHERE id = ANY($1::text[])
          `,
            [[pair.id_a, pair.id_b]],
          )
          await pool.query(
            `
            INSERT INTO ${S}.decision_relations (from_id, to_id, relation)
            VALUES ($1, $2, 'conflicts_with')
            ON CONFLICT DO NOTHING
          `,
            [pair.id_a, pair.id_b],
          )
        } else if (answer === 'extends') {
          localExtends++
          if (config.dryRun) continue
          // B (second decision) extends A (first): edge from B → A
          await pool.query(
            `
            INSERT INTO ${S}.decision_relations (from_id, to_id, relation)
            VALUES ($1, $2, 'extends')
            ON CONFLICT DO NOTHING
          `,
            [pair.id_b, pair.id_a],
          )
        } else if (answer === 'related') {
          if (config.dryRun) continue
          await pool.query(
            `
            INSERT INTO ${S}.decision_relations (from_id, to_id, relation)
            VALUES ($1, $2, 'related_to')
            ON CONFLICT DO NOTHING
          `,
            [pair.id_a, pair.id_b],
          )
        }
      }
    })(),
  )

  const tallies = await Promise.all(workers)
  const contradictions = tallies.reduce((s, t) => s + t.contradictions, 0)
  const extendsTotal   = tallies.reduce((s, t) => s + t.extends, 0)
  log(`  ${contradictions} contradictions flagged, ${extendsTotal} extends edges`)
}

async function pass3EntityPromotion(projectId: string): Promise<void> {
  log('Pass 3: entity promotion')

  const { rows: decisions } = await pool.query<{
    decision: string
    rationale: string | null
    rejected: Array<{ option: string; reason: string }>
  }>(
    `
    SELECT d.decision, d.rationale, d.rejected
    FROM ${S}.decisions d
    JOIN ${S}.sessions s ON s.id = d.session_id
    WHERE s.project_id = $1 AND d.invalidated_at IS NULL AND d.quarantined_at IS NULL
    ORDER BY d.created_at DESC LIMIT 200
  `,
    [projectId],
  )

  if (decisions.length < config.entityThreshold) {
    log(`  not enough decisions (need ${config.entityThreshold})`)
    return
  }

  const sample = decisions
    .slice(0, 50)
    .map(d =>
      `${d.decision} ${d.rationale ?? ''} ${(d.rejected ?? []).map(r => r.option).join(' ')}`,
    )
    .join('\n')

  const raw = await withRetry(() =>
    llmText({
      system:      SYSTEM_PASS3_ENTITY_EXTRACT,
      user:        sample.slice(0, 4000),
      maxTokens:   400,
      json:        true,
      cacheSystem: true,
    }),
  )

  const parsedRows = parseEntityArrayFromModelText(raw)
  if (parsedRows == null) {
    warn('  could not parse entities')
    if (process.env.SYNTHESIS_DEBUG_PARSE === 'true' && raw) {
      const preview = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw
      log(`    parse debug preview: ${JSON.stringify(preview)}`)
    }
    return
  }

  const candidates = coerceEntityCandidates(parsedRows)

  const corpus = decisions
    .map(d =>
      `${d.decision} ${d.rationale ?? ''} ${(d.rejected ?? []).map(r => r.option).join(' ')}`,
    )
    .join('\n')
    .toLowerCase()

  const promoted: Array<{ name: string; type: string; count: number }> = []
  for (const c of candidates) {
    if (!c?.name || typeof c.name !== 'string') continue
    const needle = c.name.toLowerCase()
    const re     = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
    const count  = (corpus.match(re) ?? []).length
    if (count >= config.entityThreshold) promoted.push({ ...c, count })
  }

  log(`  ${promoted.length} entities cleared threshold`)
  if (config.dryRun) return

  for (const e of promoted) {
    const summaryText = await withRetry(() =>
      llmText({
        system:      SYSTEM_PASS3_ENTITY_SUMMARY,
        user:        `Entity: ${e.name}\nMentioned ${e.count}x across decisions.\nSample: ${sample.slice(0, 1500)}`,
        maxTokens:   80,
        cacheSystem: true,
      }),
    )
    const summary = summaryText.trim()
    if (!summary) continue

    await pool.query(
      `
      INSERT INTO ${S}.planning_blocks
        (project_id, block_type, topic, content, weight, last_refreshed_at)
      VALUES ($1, 'entity', $2, $3, 1.2, now())
      ON CONFLICT (project_id, block_type, topic) WHERE (topic IS NOT NULL)
      DO UPDATE SET content = EXCLUDED.content, last_refreshed_at = now(), updated_at = now()
    `,
      [projectId, e.name, `[${e.name} ×${e.count}] ${summary}`],
    )
  }
}

async function main(): Promise<void> {
  const start = Date.now()
  log(
    `Starting${config.dryRun ? ' (DRY RUN)' : ''} — lookback: ${config.lookbackDays || 'all-time'}, incremental: ${config.incremental}`,
  )

  const { rows: projects } = await pool.query<{
    id: string
    name: string
    last_synthesis_at: Date | null
    working_directory: string | null
  }>(
    `
    SELECT p.id, p.name, p.last_synthesis_at, p.working_directory
    FROM ${S}.projects p
    WHERE EXISTS (
      SELECT 1 FROM ${S}.decisions d JOIN ${S}.sessions s ON s.id = d.session_id
      WHERE s.project_id = p.id AND d.invalidated_at IS NULL AND d.quarantined_at IS NULL
    )
    ORDER BY p.name
  `,
  )

  let toRun = projects
  if (config.projectIdFilter) {
    toRun = projects.filter(p => p.id === config.projectIdFilter)
    if (toRun.length === 0) {
      warn(`No project with id ${config.projectIdFilter} (with decisions) — nothing to do`)
    }
  }

  log(`${toRun.length} project(s) to analyse`)

  for (const p of toRun) {
    log(`\n── ${p.name} (${p.id}) — last run: ${p.last_synthesis_at?.toISOString() ?? 'never'} ──`)
    try {
      const wroteCompiled = await pass1ClusterAndDrift(p.id)
      await pass2ContradictionScan(p.id, p.last_synthesis_at)
      await pass3EntityPromotion(p.id)
      if (!config.dryRun) {
        await pool.query(`UPDATE ${S}.projects SET last_synthesis_at = now() WHERE id = $1`, [p.id])
      }
      if (
        config.exportMemory
        && !config.dryRun
        && wroteCompiled
        && p.working_directory
      ) {
        log('  F2: running export-memory for third-channel refresh…')
        try {
          await spawnExportMemory(p.id, p.working_directory)
        } catch (e) {
          warn(`export-memory failed: ${String(e)}`)
        }
      } else if (config.exportMemory && !config.dryRun && wroteCompiled && !p.working_directory) {
        warn('SYNTHESIS_EXPORT_MEMORY set but project has no working_directory — run `npx robrain init-project` from that repo to record it')
      }
    } catch (err) {
      warn(`error for ${p.name}: ${String(err)}`)
    }
  }

  log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s${config.dryRun ? ' (DRY RUN — no writes)' : ''}`)
  await pool.end()
}

main().catch(err => {
  console.error('[Synthesis] fatal:', err)
  process.exit(1)
})

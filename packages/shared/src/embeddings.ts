// packages/shared/src/embeddings.ts
// ─────────────────────────────────────────────────────────────
// Swappable embedding provider, shared by Sensing MCP and the
// self-hosted Perception API. Set EMBEDDING_PROVIDER=openai|voyage|cohere.
//
// Sensing and Perception MUST embed with the same provider AND model —
// cosine distance across different embedding spaces is meaningless, so a
// mismatch silently breaks vector search. This module is the single place
// both sides resolve provider + model from env, so they cannot drift.
//
// All vectors are padded / truncated to 1536 dims so the pgvector index
// (fixed at 1536) always matches regardless of provider.
//
// Storage backend: pgvector (not Pinecone). Self-hosted OSS keeps
// embeddings co-located with `decisions` rows so search_decisions()
// can filter on project_id / invalidated_at in a single query, and
// users don't need a managed SaaS account to run `pnpm docker:up`.
// ─────────────────────────────────────────────────────────────

import { DEFAULT_OPENAI_BASE_URL } from './llm.js'

export type EmbeddingProvider = 'openai' | 'voyage' | 'cohere'

export const EMBEDDING_TARGET_DIMS = 1536

export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = 'voyage-3-lite'
export const DEFAULT_COHERE_EMBEDDING_MODEL = 'embed-english-v3.0'

/**
 * Per-attempt fetch timeout. Local OpenAI-compatible servers (Ollama,
 * LM Studio) can hang without responding — without this, callers that
 * await embed() inline (e.g. Perception POST /scores) stall indefinitely.
 */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 15_000

/** Retries transient provider errors (429/503/5xx) so bursts of sensing_record_turn do not silently lose topic-shift. */
const DEFAULT_MAX_ATTEMPTS  = 5
const DEFAULT_BASE_DELAY_MS = 350

export interface EmbeddingConfig {
  provider: EmbeddingProvider

  // OpenAI (or any OpenAI-compatible /v1/embeddings server via baseUrl)
  openaiApiKey?:     string
  openaiBaseUrl:     string
  openaiModel:       string
  /** Optional `dimensions` request param (text-embedding-3-* and compatible servers). */
  openaiDimensions?: number

  voyageApiKey?: string
  voyageModel:   string

  cohereApiKey?: string
  cohereModel:   string

  /** Per-attempt timeout in ms. Timeouts are NOT retried — a hung server aborts the whole call. */
  timeoutMs:   number
  maxAttempts: number
  baseDelayMs: number
}

/**
 * Env vars: EMBEDDING_PROVIDER, OPENAI_API_KEY, OPENAI_BASE_URL,
 * OPENAI_EMBEDDING_MODEL, OPENAI_EMBEDDING_DIMENSIONS, VOYAGE_API_KEY,
 * VOYAGE_EMBEDDING_MODEL, COHERE_API_KEY, COHERE_EMBEDDING_MODEL,
 * EMBEDDING_TIMEOUT_MS.
 */
export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const dims = Number(env.OPENAI_EMBEDDING_DIMENSIONS)
  return {
    provider: (env.EMBEDDING_PROVIDER ?? 'openai') as EmbeddingProvider,

    openaiApiKey:     env.OPENAI_API_KEY,
    openaiBaseUrl:    (env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, ''),
    openaiModel:      env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
    openaiDimensions: Number.isFinite(dims) && dims > 0 ? dims : undefined,

    voyageApiKey: env.VOYAGE_API_KEY,
    voyageModel:  env.VOYAGE_EMBEDDING_MODEL ?? DEFAULT_VOYAGE_EMBEDDING_MODEL,

    cohereApiKey: env.COHERE_API_KEY,
    cohereModel:  env.COHERE_EMBEDDING_MODEL ?? DEFAULT_COHERE_EMBEDDING_MODEL,

    timeoutMs:   Number(env.EMBEDDING_TIMEOUT_MS ?? DEFAULT_EMBEDDING_TIMEOUT_MS),
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: DEFAULT_BASE_DELAY_MS,
  }
}

/** Perception maps this to HTTP 503 embedding_provider_unavailable; Sensing logs and skips topic-shift. */
export class EmbeddingProviderError extends Error {
  readonly provider: string

  constructor(provider: string, message: string) {
    super(message)
    this.name = 'EmbeddingProviderError'
    this.provider = provider
  }
}

export async function embed(
  text: string,
  config: EmbeddingConfig,
  signal?: AbortSignal,
): Promise<number[]> {
  let vec: number[]
  switch (config.provider) {
    case 'openai':  vec = await embedOpenAI(text, config, signal);  break
    case 'voyage':  vec = await embedVoyage(text, config, signal);  break
    case 'cohere':  vec = await embedCohere(text, config, signal);  break
    default:
      throw new EmbeddingProviderError(config.provider, `Unknown embedding provider: ${config.provider}`)
  }
  return padToLength(vec, EMBEDDING_TARGET_DIMS)
}

// ── OpenAI (and OpenAI-compatible via OPENAI_BASE_URL) ────────

async function embedOpenAI(text: string, config: EmbeddingConfig, signal?: AbortSignal): Promise<number[]> {
  const baseUrl = config.openaiBaseUrl.replace(/\/+$/, '')
  if (!config.openaiApiKey && baseUrl === DEFAULT_OPENAI_BASE_URL) {
    throw new EmbeddingProviderError('openai', 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai (unless OPENAI_BASE_URL points at a local server)')
  }
  const res = await fetchEmbedding(
    `${baseUrl}/embeddings`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(config.openaiApiKey ? { 'Authorization': `Bearer ${config.openaiApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.openaiModel,
        input: text,
        ...(config.openaiDimensions ? { dimensions: config.openaiDimensions } : {}),
      }),
    },
    'openai',
    config,
    signal,
  )
  const data = await res.json() as { data?: Array<{ embedding?: unknown }> }
  return ensureEmbedding('openai', data.data?.[0]?.embedding)
}

// ── Voyage AI ─────────────────────────────────────────────────

async function embedVoyage(text: string, config: EmbeddingConfig, signal?: AbortSignal): Promise<number[]> {
  if (!config.voyageApiKey) {
    throw new EmbeddingProviderError('voyage', 'VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage')
  }
  const res = await fetchEmbedding(
    'https://api.voyageai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.voyageApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: config.voyageModel,
        input: [text],
      }),
    },
    'voyage',
    config,
    signal,
  )
  const data = await res.json() as { data?: Array<{ embedding?: unknown }> }
  return ensureEmbedding('voyage', data.data?.[0]?.embedding)
}

// ── Cohere ────────────────────────────────────────────────────

async function embedCohere(text: string, config: EmbeddingConfig, signal?: AbortSignal): Promise<number[]> {
  if (!config.cohereApiKey) {
    throw new EmbeddingProviderError('cohere', 'COHERE_API_KEY is required when EMBEDDING_PROVIDER=cohere')
  }
  const res = await fetchEmbedding(
    'https://api.cohere.com/v1/embed',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.cohereApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:           config.cohereModel,
        texts:           [text],
        input_type:      'search_document',
        embedding_types: ['float'],
      }),
    },
    'cohere',
    config,
    signal,
  )
  const data = await res.json() as { embeddings?: { float?: unknown[] } }
  return ensureEmbedding('cohere', data.embeddings?.float?.[0])
}

// ── Retry / timeout plumbing ──────────────────────────────────

async function fetchEmbedding(
  url: string,
  init: RequestInit,
  provider: string,
  config: EmbeddingConfig,
  callerSignal?: AbortSignal,
): Promise<Response> {
  let lastDetail = ''

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    if (callerSignal?.aborted) {
      throw callerSignal.reason ?? new Error(`${provider} embedding aborted`)
    }

    const attemptSignal = combineWithTimeout(callerSignal, config.timeoutMs)
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: attemptSignal.signal })
    } catch (err) {
      if (callerSignal?.aborted) throw callerSignal.reason ?? err
      if (attemptSignal.timedOut()) {
        throw new EmbeddingProviderError(provider, `No response within ${config.timeoutMs}ms (${url})`)
      }
      throw err
    } finally {
      attemptSignal.cancel()
    }

    if (res.ok) return res

    lastDetail = `${res.status}: ${await parseErrorDetail(res)}`
    const retriable = res.status === 429 || res.status === 503 || res.status >= 500
    if (!retriable || attempt >= config.maxAttempts - 1) {
      throw new EmbeddingProviderError(provider, lastDetail)
    }

    let delayMs = config.baseDelayMs * 2 ** attempt
    const fromHeader = parseRetryAfterMs(res.headers.get('retry-after'))
    if (fromHeader !== null) delayMs = Math.max(delayMs, fromHeader)
    delayMs += Math.floor(Math.random() * 200)
    await abortableDelay(delayMs, callerSignal)
  }

  throw new EmbeddingProviderError(provider, lastDetail)
}

/**
 * Per-attempt timeout signal, also aborted if the caller's signal fires.
 * Hand-rolled instead of AbortSignal.any/timeout so we can tell "our
 * timeout fired" apart from "the caller aborted" (different error paths).
 */
function combineWithTimeout(callerSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`Embedding fetch timed out after ${timeoutMs}ms`))
  }, timeoutMs)

  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancel: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise(r => setTimeout(r, ms))
    return
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Embedding fetch aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('Embedding fetch aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (!Number.isNaN(secs) && secs >= 0) return secs * 1000
  const when = Date.parse(header)
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  return null
}

async function parseErrorDetail(r: Response): Promise<string> {
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

function ensureEmbedding(provider: string, vector: unknown): number[] {
  if (!Array.isArray(vector) || !vector.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new EmbeddingProviderError(provider, 'Invalid embedding payload')
  }
  return vector as number[]
}

// ── Utilities ─────────────────────────────────────────────────

export function padToLength(vec: number[], length: number): number[] {
  if (vec.length === length) return vec
  if (vec.length > length)   return vec.slice(0, length)
  return [...vec, ...new Array(length - vec.length).fill(0)]
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot   += ai * bi
    normA += ai * ai
    normB += bi * bi
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b)
}

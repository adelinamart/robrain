// packages/shared/src/embeddings.ts
// ─────────────────────────────────────────────────────────────
// Single embedding client shared by Sensing (topic-shift) and
// Perception (signal ingest / search). Each package used to carry
// its own copy; this merges the best of both — Sensing's retry +
// abort handling and Perception's error-detail parsing + payload
// validation — so the implementations cannot drift again.
//
// All providers are padded/truncated to 1536 dims so the pgvector
// index (set to 1536) always matches.
// ─────────────────────────────────────────────────────────────

export const EMBEDDING_TARGET_DIMS = 1536

export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = 'voyage-3-lite'
export const DEFAULT_COHERE_EMBEDDING_MODEL = 'embed-english-v3.0'

export interface EmbeddingConfig {
  /** 'openai' | 'voyage' | 'cohere' — raw env value; anything else throws. */
  provider: string
  openaiApiKey?: string
  openaiModel?: string
  voyageApiKey?: string
  voyageModel?: string
  cohereApiKey?: string
  cohereModel?: string
}

export class EmbeddingProviderError extends Error {
  readonly provider: string

  constructor(provider: string, message: string) {
    super(message)
    this.name = 'EmbeddingProviderError'
    this.provider = provider
  }
}

/** Retries transient provider errors (429/503/5xx) so bursts of sensing_record_turn do not silently lose topic-shift. */
const EMBEDDING_MAX_ATTEMPTS = 5
const EMBEDDING_BASE_DELAY_MS = 350
/** Backstop when the caller passes no AbortSignal — a hung provider must never stall the caller indefinitely. */
const EMBEDDING_DEFAULT_TIMEOUT_MS = 30_000

export async function embed(
  text: string,
  cfg: EmbeddingConfig,
  signal?: AbortSignal,
): Promise<number[]> {
  const effectiveSignal = signal ?? AbortSignal.timeout(EMBEDDING_DEFAULT_TIMEOUT_MS)
  let vec: number[]

  switch (cfg.provider) {
    case 'openai':  vec = await embedOpenAI(text, cfg, effectiveSignal);  break
    case 'voyage':  vec = await embedVoyage(text, cfg, effectiveSignal);  break
    case 'cohere':  vec = await embedCohere(text, cfg, effectiveSignal);  break
    default:
      throw new EmbeddingProviderError(cfg.provider, `Unknown embedding provider: ${cfg.provider}`)
  }

  // Pad or truncate to EMBEDDING_TARGET_DIMS so the pgvector index always matches
  return padToLength(vec, EMBEDDING_TARGET_DIMS)
}

// ── Providers ─────────────────────────────────────────────────

async function embedOpenAI(text: string, cfg: EmbeddingConfig, signal: AbortSignal): Promise<number[]> {
  if (!cfg.openaiApiKey) {
    throw new EmbeddingProviderError('openai', 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai')
  }
  const res = await fetchEmbedding(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.openaiApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: cfg.openaiModel ?? DEFAULT_OPENAI_EMBEDDING_MODEL,
        input: text,
      }),
    },
    'openai',
    signal,
  )
  const data = await res.json() as { data?: Array<{ embedding?: unknown }> }
  return ensureEmbedding('openai', data.data?.[0]?.embedding)
}

async function embedVoyage(text: string, cfg: EmbeddingConfig, signal: AbortSignal): Promise<number[]> {
  if (!cfg.voyageApiKey) {
    throw new EmbeddingProviderError('voyage', 'VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage')
  }
  const res = await fetchEmbedding(
    'https://api.voyageai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.voyageApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: cfg.voyageModel ?? DEFAULT_VOYAGE_EMBEDDING_MODEL,
        input: [text],
      }),
    },
    'voyage',
    signal,
  )
  const data = await res.json() as { data?: Array<{ embedding?: unknown }> }
  return ensureEmbedding('voyage', data.data?.[0]?.embedding)
}

async function embedCohere(text: string, cfg: EmbeddingConfig, signal: AbortSignal): Promise<number[]> {
  if (!cfg.cohereApiKey) {
    throw new EmbeddingProviderError('cohere', 'COHERE_API_KEY is required when EMBEDDING_PROVIDER=cohere')
  }
  const res = await fetchEmbedding(
    'https://api.cohere.com/v1/embed',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.cohereApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:           cfg.cohereModel ?? DEFAULT_COHERE_EMBEDDING_MODEL,
        texts:           [text],
        input_type:      'search_document',
        embedding_types: ['float'],
      }),
    },
    'cohere',
    signal,
  )
  const data = await res.json() as { embeddings?: { float?: unknown[] } }
  return ensureEmbedding('cohere', data.embeddings?.float?.[0])
}

// ── Fetch with retry ──────────────────────────────────────────

async function fetchEmbedding(
  url: string,
  init: RequestInit,
  provider: string,
  signal: AbortSignal,
): Promise<Response> {
  let lastDetail = ''

  for (let attempt = 0; attempt < EMBEDDING_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      throw signal.reason ?? new EmbeddingProviderError(provider, 'Embedding fetch aborted')
    }

    const res = await fetch(url, { ...init, signal })
    if (res.ok) return res

    const retriable = res.status === 429 || res.status === 503 || res.status >= 500
    lastDetail = await parseErrorDetail(res)
    if (!retriable || attempt >= EMBEDDING_MAX_ATTEMPTS - 1) {
      throw new EmbeddingProviderError(provider, lastDetail)
    }

    let delayMs = EMBEDDING_BASE_DELAY_MS * 2 ** attempt
    const fromHeader = parseRetryAfterMs(res.headers.get('retry-after'))
    if (fromHeader !== null) delayMs = Math.max(delayMs, fromHeader)
    delayMs += Math.floor(Math.random() * 200)
    await abortableDelay(delayMs, signal)
  }

  throw new EmbeddingProviderError(provider, lastDetail || 'Embedding request failed')
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
  return `HTTP ${r.status}: ${raw.slice(0, 500)}`
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (!Number.isNaN(secs) && secs >= 0) return secs * 1000
  const when = Date.parse(header)
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  return null
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Embedding fetch aborted'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('Embedding fetch aborted'))
      },
      { once: true },
    )
  })
}

// ── Utilities ─────────────────────────────────────────────────

function ensureEmbedding(provider: string, vector: unknown): number[] {
  if (!Array.isArray(vector) || !vector.every(n => typeof n === 'number' && Number.isFinite(n))) {
    throw new EmbeddingProviderError(provider, 'Invalid embedding payload')
  }
  return vector as number[]
}

function padToLength(vec: number[], length: number): number[] {
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

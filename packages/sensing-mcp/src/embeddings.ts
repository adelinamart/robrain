// packages/sensing-mcp/src/embeddings.ts
// ─────────────────────────────────────────────────────────────
// Swappable embedding provider.
// Set EMBEDDING_PROVIDER=openai|voyage|cohere in .env.
// All providers return a 1536-dim vector (openai) or we
// zero-pad to 1536 for providers with smaller dims so the
// pgvector index (set to 1536) always works.
// ─────────────────────────────────────────────────────────────

import { config, type EmbeddingProvider } from './config.js'

const TARGET_DIMS = 1536

/** Retries transient provider errors (429/503/5xx) so bursts of sensing_record_turn do not silently lose topic-shift. */
const EMBEDDING_MAX_ATTEMPTS = 5
const EMBEDDING_BASE_DELAY_MS = 350

async function fetchEmbedding(url: string, init: RequestInit, providerLabel: string): Promise<Response> {
  let lastStatus = 0
  let lastStatusText = ''

  for (let attempt = 0; attempt < EMBEDDING_MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, init)
    if (res.ok) return res

    lastStatus = res.status
    lastStatusText = res.statusText

    const retriable = lastStatus === 429 || lastStatus === 503 || lastStatus >= 500
    if (!retriable || attempt >= EMBEDDING_MAX_ATTEMPTS - 1) {
      throw new Error(
        `${providerLabel} embedding failed: ${lastStatus}${lastStatusText ? ` ${lastStatusText}` : ''}`
      )
    }

    let delayMs = EMBEDDING_BASE_DELAY_MS * 2 ** attempt
    const fromHeader = parseRetryAfterMs(res.headers.get('retry-after'))
    if (fromHeader !== null) delayMs = Math.max(delayMs, fromHeader)
    delayMs += Math.floor(Math.random() * 200)
    await new Promise(r => setTimeout(r, delayMs))
  }

  throw new Error(
    `${providerLabel} embedding failed: ${lastStatus}${lastStatusText ? ` ${lastStatusText}` : ''}`
  )
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const secs = Number(header)
  if (!Number.isNaN(secs) && secs >= 0) return secs * 1000
  const when = Date.parse(header)
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now())
  return null
}

export async function embed(text: string): Promise<number[]> {
  const provider = config.embeddingProvider
  let vec: number[]

  switch (provider) {
    case 'openai':  vec = await embedOpenAI(text);  break
    case 'voyage':  vec = await embedVoyage(text);  break
    case 'cohere':  vec = await embedCohere(text);  break
    default:
      throw new Error(`Unknown embedding provider: ${provider}`)
  }

  // Pad or truncate to TARGET_DIMS so pgvector index always matches
  return padToLength(vec, TARGET_DIMS)
}

// ── OpenAI ────────────────────────────────────────────────────

async function embedOpenAI(text: string): Promise<number[]> {
  if (!config.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai')
  }
  const res = await fetchEmbedding(
    'https://api.openai.com/v1/embeddings',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openaiApiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model: config.openaiEmbeddingModel,
        input: text,
      }),
    },
    'OpenAI',
  )
  const data = await res.json() as { data: [{ embedding: number[] }] }
  return data.data[0].embedding
}

// ── Voyage AI ─────────────────────────────────────────────────

async function embedVoyage(text: string): Promise<number[]> {
  if (!config.voyageApiKey) {
    throw new Error('VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage')
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
        model: config.voyageEmbeddingModel,
        input: [text],
      }),
    },
    'Voyage',
  )
  const data = await res.json() as { data: [{ embedding: number[] }] }
  return data.data[0].embedding
}

// ── Cohere ────────────────────────────────────────────────────

async function embedCohere(text: string): Promise<number[]> {
  if (!config.cohereApiKey) {
    throw new Error('COHERE_API_KEY is required when EMBEDDING_PROVIDER=cohere')
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
        model:           config.cohereEmbeddingModel,
        texts:           [text],
        input_type:      'search_document',
        embedding_types: ['float'],
      }),
    },
    'Cohere',
  )
  const data = await res.json() as { embeddings: { float: number[][] } }
  return data.embeddings.float[0]
}

// ── Utilities ─────────────────────────────────────────────────

function padToLength(vec: number[], length: number): number[] {
  if (vec.length === length) return vec
  if (vec.length > length)   return vec.slice(0, length)
  return [...vec, ...new Array(length - vec.length).fill(0)]
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b)
}

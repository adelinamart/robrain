import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  EMBEDDING_TARGET_DIMS,
  EmbeddingProviderError,
  cosineDistance,
  cosineSimilarity,
  embed,
  padToLength,
  resolveEmbeddingConfig,
  type EmbeddingConfig,
} from './embeddings.js'
import { DEFAULT_OPENAI_BASE_URL } from './llm.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function makeConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    ...resolveEmbeddingConfig({}),
    openaiApiKey: 'sk-test',
    voyageApiKey: 'pa-test',
    cohereApiKey: 'co-test',
    maxAttempts:  3,
    baseDelayMs:  1,
    ...overrides,
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

/** Installs a fetch mock and records each call's URL and parsed JSON body. */
function mockFetch(handler: (call: number) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: any; signal?: AbortSignal }> = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    calls.push({
      url:    String(input),
      body:   init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal ?? undefined,
    })
    return handler(calls.length)
  }) as typeof fetch
  return calls
}

describe('resolveEmbeddingConfig', () => {
  it('applies defaults with an empty env', () => {
    const cfg = resolveEmbeddingConfig({})
    assert.equal(cfg.provider, 'openai')
    assert.equal(cfg.openaiBaseUrl, DEFAULT_OPENAI_BASE_URL)
    assert.equal(cfg.openaiModel, 'text-embedding-3-small')
    assert.equal(cfg.openaiDimensions, undefined)
    assert.equal(cfg.voyageModel, 'voyage-3-lite')
    assert.equal(cfg.cohereModel, 'embed-english-v3.0')
    assert.equal(cfg.timeoutMs, DEFAULT_EMBEDDING_TIMEOUT_MS)
  })

  it('reads provider, models, base URL, dimensions, and timeout from env', () => {
    const cfg = resolveEmbeddingConfig({
      EMBEDDING_PROVIDER:          'voyage',
      OPENAI_BASE_URL:             'http://localhost:11434/v1/',
      OPENAI_EMBEDDING_MODEL:      'nomic-embed-text',
      OPENAI_EMBEDDING_DIMENSIONS: '768',
      VOYAGE_EMBEDDING_MODEL:      'voyage-3-large',
      COHERE_EMBEDDING_MODEL:      'embed-multilingual-v3.0',
      EMBEDDING_TIMEOUT_MS:        '5000',
    })
    assert.equal(cfg.provider, 'voyage')
    assert.equal(cfg.openaiBaseUrl, 'http://localhost:11434/v1') // trailing slash stripped
    assert.equal(cfg.openaiModel, 'nomic-embed-text')
    assert.equal(cfg.openaiDimensions, 768)
    assert.equal(cfg.voyageModel, 'voyage-3-large')
    assert.equal(cfg.cohereModel, 'embed-multilingual-v3.0')
    assert.equal(cfg.timeoutMs, 5000)
  })

  it('ignores a non-numeric OPENAI_EMBEDDING_DIMENSIONS', () => {
    const cfg = resolveEmbeddingConfig({ OPENAI_EMBEDDING_DIMENSIONS: 'nope' })
    assert.equal(cfg.openaiDimensions, undefined)
  })
})

describe('embed — openai', () => {
  it('posts config model to OPENAI_BASE_URL and pads to 1536', async () => {
    const calls = mockFetch(() => jsonResponse({ data: [{ embedding: [1, 2, 3] }] }))
    const vec = await embed('hello', makeConfig({
      openaiBaseUrl: 'http://localhost:11434/v1',
      openaiModel:   'nomic-embed-text',
    }))
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'http://localhost:11434/v1/embeddings')
    assert.equal(calls[0]!.body.model, 'nomic-embed-text')
    assert.equal(calls[0]!.body.input, 'hello')
    assert.equal(vec.length, EMBEDDING_TARGET_DIMS)
    assert.deepEqual(vec.slice(0, 3), [1, 2, 3])
    assert.equal(vec[3], 0)
  })

  it('sends dimensions only when configured', async () => {
    const calls = mockFetch(() => jsonResponse({ data: [{ embedding: [0.5] }] }))
    await embed('a', makeConfig())
    await embed('b', makeConfig({ openaiDimensions: 256 }))
    assert.equal('dimensions' in calls[0]!.body, false)
    assert.equal(calls[1]!.body.dimensions, 256)
  })

  it('throws EmbeddingProviderError when OPENAI_API_KEY is missing', async () => {
    await assert.rejects(
      embed('x', makeConfig({ openaiApiKey: undefined })),
      (err: unknown) => err instanceof EmbeddingProviderError && err.provider === 'openai',
    )
  })
})

describe('embed — voyage / cohere', () => {
  it('uses the config-driven voyage model (not a hardcoded one)', async () => {
    const calls = mockFetch(() => jsonResponse({ data: [{ embedding: [9] }] }))
    await embed('x', makeConfig({ provider: 'voyage', voyageModel: 'voyage-3-large' }))
    assert.equal(calls[0]!.url, 'https://api.voyageai.com/v1/embeddings')
    assert.equal(calls[0]!.body.model, 'voyage-3-large')
    assert.deepEqual(calls[0]!.body.input, ['x'])
  })

  it('uses the config-driven cohere model and parses the float payload', async () => {
    const calls = mockFetch(() => jsonResponse({ embeddings: { float: [[7, 8]] } }))
    const vec = await embed('x', makeConfig({ provider: 'cohere', cohereModel: 'embed-multilingual-v3.0' }))
    assert.equal(calls[0]!.url, 'https://api.cohere.com/v1/embed')
    assert.equal(calls[0]!.body.model, 'embed-multilingual-v3.0')
    assert.deepEqual(vec.slice(0, 2), [7, 8])
  })

  it('throws EmbeddingProviderError when the selected provider key is missing', async () => {
    await assert.rejects(
      embed('x', makeConfig({ provider: 'voyage', voyageApiKey: undefined })),
      (err: unknown) => err instanceof EmbeddingProviderError && err.provider === 'voyage',
    )
  })
})

describe('embed — retry and errors', () => {
  it('retries 429 then succeeds', async () => {
    const calls = mockFetch(call =>
      call === 1
        ? jsonResponse({ error: 'rate limited' }, 429, { 'Retry-After': '0' })
        : jsonResponse({ data: [{ embedding: [1] }] }),
    )
    const vec = await embed('x', makeConfig())
    assert.equal(calls.length, 2)
    assert.equal(vec.length, EMBEDDING_TARGET_DIMS)
  })

  it('does not retry non-retriable statuses and surfaces the error detail', async () => {
    const calls = mockFetch(() => jsonResponse({ error: { message: 'bad model' } }, 400))
    await assert.rejects(
      embed('x', makeConfig()),
      (err: unknown) =>
        err instanceof EmbeddingProviderError && /400/.test(err.message) && /bad model/.test(err.message),
    )
    assert.equal(calls.length, 1)
  })

  it('gives up after maxAttempts on persistent 503', async () => {
    const calls = mockFetch(() => jsonResponse({ error: 'down' }, 503))
    await assert.rejects(
      embed('x', makeConfig({ maxAttempts: 2 })),
      (err: unknown) => err instanceof EmbeddingProviderError && /503/.test(err.message),
    )
    assert.equal(calls.length, 2)
  })

  it('rejects an invalid embedding payload', async () => {
    mockFetch(() => jsonResponse({ data: [{ embedding: 'oops' }] }))
    await assert.rejects(
      embed('x', makeConfig()),
      (err: unknown) => err instanceof EmbeddingProviderError && /Invalid embedding payload/.test(err.message),
    )
  })
})

describe('embed — timeout and abort', () => {
  it('aborts a hung server after timeoutMs without retrying', async () => {
    const calls = mockFetch(() => new Promise<Response>(() => { /* never resolves */ }))
    // Reject when our per-attempt signal fires, like a real fetch would.
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const hang = inner(input, init)
      return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
        hang.then(resolve, reject)
      })
    }) as typeof fetch

    await assert.rejects(
      embed('x', makeConfig({ timeoutMs: 30 })),
      (err: unknown) => err instanceof EmbeddingProviderError && /No response within 30ms/.test(err.message),
    )
    assert.equal(calls.length, 1)
  })

  it('rethrows the caller abort reason instead of a timeout error', async () => {
    globalThis.fetch = (async (_input: any, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })
    ) as typeof fetch

    const controller = new AbortController()
    const reason = new Error('caller cancelled')
    setTimeout(() => controller.abort(reason), 5)

    await assert.rejects(
      embed('x', makeConfig({ timeoutMs: 10_000 }), controller.signal),
      (err: unknown) => err === reason,
    )
  })
})

describe('vector utilities', () => {
  it('padToLength pads, truncates, and passes through', () => {
    assert.deepEqual(padToLength([1, 2], 4), [1, 2, 0, 0])
    assert.deepEqual(padToLength([1, 2, 3, 4], 2), [1, 2])
    const exact = [1, 2, 3]
    assert.equal(padToLength(exact, 3), exact)
  })

  it('cosineSimilarity / cosineDistance behave on known vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0) // zero vector guard
    assert.equal(cosineDistance([1, 0], [1, 0]), 0)
  })
})

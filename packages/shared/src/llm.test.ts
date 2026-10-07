import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicChat, openaiChat } from './llm.js'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** A server that never answers; rejects only when the request's signal fires, like a real fetch. */
function installHungFetch(): { callCount: () => number } {
  let calls = 0
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls += 1
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  }) as typeof fetch
  return { callCount: () => calls }
}

/** A provider that is always rate-limited, so every call goes through retry backoff. */
function installRateLimitedFetch(): { callCount: () => number } {
  let calls = 0
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('{}', { status: 429, statusText: 'Too Many Requests' })
  }) as typeof fetch
  return { callCount: () => calls }
}

function installFetchReturning(payload: unknown): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
    status:  200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
}

describe('chat clients — abort during retry backoff', () => {
  for (const [clientName, callClient] of [
    ['openaiChat', (signal: AbortSignal) => openaiChat({
      apiKey: 'sk-test', model: 'gpt-test', system: 'system', user: 'user', maxTokens: 4, signal,
    })],
    ['anthropicChat', (signal: AbortSignal) => anthropicChat({
      apiKey: 'sk-ant-test', model: 'claude-test', system: 'system', user: 'user', maxTokens: 4, signal,
    })],
  ] as const) {
    it(`${clientName} rejects at the deadline instead of sleeping through the backoff`, async () => {
      const rateLimited = installRateLimitedFetch()
      const startedAt = Date.now()
      await assert.rejects(
        callClient(AbortSignal.timeout(25)),
        (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
      )
      const elapsedMs = Date.now() - startedAt
      assert.ok(elapsedMs < 200, `rejected after ${elapsedMs}ms; first backoff alone is 400ms`)
      assert.equal(rateLimited.callCount(), 1)
    })
  }
})

describe('chat clients — usage', () => {
  it('openaiChat reports tokens and attempts', async () => {
    installFetchReturning({
      choices: [{ message: { content: 'same' } }],
      usage:   { prompt_tokens: 61, completion_tokens: 1 },
    })
    let reported: unknown
    const reply = await openaiChat({
      apiKey: 'sk-test', model: 'gpt-test', system: 'system', user: 'user', maxTokens: 4,
      onUsage: (usage) => { reported = usage },
    })
    assert.equal(reply, 'same')
    assert.deepEqual(reported, { inputTokens: 61, outputTokens: 1, attempts: 1 })
  })

  it('anthropicChat reports tokens and attempts', async () => {
    installFetchReturning({
      content: [{ type: 'text', text: 'contradicts' }],
      usage:   { input_tokens: 58, output_tokens: 3 },
    })
    let reported: unknown
    const reply = await anthropicChat({
      apiKey: 'sk-ant-test', model: 'claude-test', system: 'system', user: 'user', maxTokens: 4,
      onUsage: (usage) => { reported = usage },
    })
    assert.equal(reply, 'contradicts')
    assert.deepEqual(reported, { inputTokens: 58, outputTokens: 3, attempts: 1 })
  })
})

describe('chat clients — abort signal', () => {
  it('openaiChat rejects when the caller signal times out', async () => {
    const hung = installHungFetch()
    await assert.rejects(
      openaiChat({
        apiKey:    'sk-test',
        model:     'gpt-test',
        system:    'system',
        user:      'user',
        maxTokens: 4,
        signal:    AbortSignal.timeout(20),
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    )
    assert.equal(hung.callCount(), 1)
  })

  it('anthropicChat rejects when the caller signal times out', async () => {
    const hung = installHungFetch()
    await assert.rejects(
      anthropicChat({
        apiKey:    'sk-ant-test',
        model:     'claude-test',
        system:    'system',
        user:      'user',
        maxTokens: 4,
        signal:    AbortSignal.timeout(20),
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    )
    assert.equal(hung.callCount(), 1)
  })
})

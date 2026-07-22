import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { SessionTurn } from '@robrain/shared'

// config reads process.env at first import and bun shares one module cache
// across test files — pin the same hermetic env server.test.ts uses. The
// registry path is claimed with ??= (first file to load wins; both files
// point config at a tmp mirror), everything else is patched on the cached
// config object per test below, so file order does not matter.
const registryDir = mkdtempSync(join(tmpdir(), 'robrain-sensing-thin-'))
process.env.SENSING_TOPIC_SHIFT_DISABLE_EMBEDDING = 'true'
process.env.PERCEPTION_API_URL = ''
process.env.PERCEPTION_API_KEY = ''
process.env.ANTHROPIC_API_KEY = ''
process.env.SENSING_SESSION_REGISTRY_PATH ??= join(registryDir, 'sessions.json')

const { config, isThinMode } = await import('./config.js')
const { classifyTopicShift } = await import('./classifiers/index.js')
const { buildServer } = await import('./server.js')

// config is `as const` at the type level only — patch the cached object at
// runtime so this file works no matter which test file loaded it first.
const mutableConfig = config as unknown as {
  perceptionApiUrl: string
  perceptionApiKey: string
  topicShiftDisableEmbedding: boolean
}
const savedConfig = {
  perceptionApiUrl:           mutableConfig.perceptionApiUrl,
  perceptionApiKey:           mutableConfig.perceptionApiKey,
  topicShiftDisableEmbedding: mutableConfig.topicShiftDisableEmbedding,
}

const PERCEPTION_URL = 'http://perception.test'

// Capture every outbound fetch — a thin client must only ever talk to Perception.
const fetched: Array<{ url: string; body?: Record<string, unknown> }> = []
const realFetch = globalThis.fetch

function installFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    let body: Record<string, unknown> | undefined
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>
    fetched.push({ url, body })
    return new Response(JSON.stringify({ accepted: true, action: 'written' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'sensing-thin-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    buildServer().connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  const first = (result.content as Array<{ type: string; text: string }>)[0]
  assert.ok(first, `${name} returned no content`)
  return JSON.parse(first.text) as Record<string, unknown>
}

// Deliberately decision-flavored: in full mode this message keyword-hits and
// reaches the local LLM classifier — thin mode must ship it raw instead.
const decisionTurnArgs = (session_id: string, sequence = 1) => ({
  session_id,
  sequence,
  user_message: "Let's use pnpm instead of npm for this workspace.",
  claude_reply: 'Agreed — switching the scripts over to pnpm.',
  files_touched: ['package.json'],
  injected_memory_ids: [] as string[],
})

before(() => {
  mutableConfig.perceptionApiUrl = PERCEPTION_URL
  mutableConfig.perceptionApiKey = 'thin-test-key'
  installFetchMock()
})

afterEach(() => {
  delete process.env.ROBRAIN_MODE
  fetched.length = 0
})

after(() => {
  mutableConfig.perceptionApiUrl = savedConfig.perceptionApiUrl
  mutableConfig.perceptionApiKey = savedConfig.perceptionApiKey
  mutableConfig.topicShiftDisableEmbedding = savedConfig.topicShiftDisableEmbedding
  globalThis.fetch = realFetch
  // Only clean up when another file's registry path won the ??= claim —
  // if ours won, later-running test files still write through it.
  if (process.env.SENSING_SESSION_REGISTRY_PATH !== join(registryDir, 'sessions.json')) {
    rmSync(registryDir, { recursive: true, force: true })
  }
})

describe('isThinMode', () => {
  it('is true only for ROBRAIN_MODE=cloud (trimmed, case-insensitive)', () => {
    assert.equal(isThinMode({}), false)
    assert.equal(isThinMode({ ROBRAIN_MODE: 'cloud' }), true)
    assert.equal(isThinMode({ ROBRAIN_MODE: ' Cloud ' }), true)
    assert.equal(isThinMode({ ROBRAIN_MODE: 'self-hosted' }), false)
    assert.equal(isThinMode({ ROBRAIN_MODE: '' }), false)
  })
})

describe('thin mode (ROBRAIN_MODE=cloud)', () => {
  it('ships the raw turn with needs_classification=true and never calls a provider', async () => {
    process.env.ROBRAIN_MODE = 'cloud'
    const client = await connectClient()
    const sessionId = '2026-07-22T09:00:00.000Z-th1n'

    const res = await callTool(client, 'sensing_record_turn', decisionTurnArgs(sessionId))
    assert.equal(res.error, undefined)
    assert.equal(res.buffered, true)
    assert.equal(res.topic_shift, false)

    // Background ship: raw turn → POST /signals, same contract as flush-on-close.
    await waitFor(() => fetched.some(f => f.url === `${PERCEPTION_URL}/signals`))
    const ship = fetched.find(f => f.url === `${PERCEPTION_URL}/signals`)
    assert.ok(ship, 'raw turn was not shipped to Perception')
    const signal = (ship.body as { signal: Record<string, unknown> }).signal
    assert.equal(signal.needs_classification, true)
    assert.equal(signal.decision_type, 'unknown')
    assert.equal((signal.turn as SessionTurn).user_message, "Let's use pnpm instead of npm for this workspace.")

    // Every outbound call went to Perception — no LLM, no embedding provider.
    assert.ok(fetched.every(f => f.url.startsWith(PERCEPTION_URL)),
      `unexpected non-Perception call: ${fetched.map(f => f.url).join(', ')}`)

    // Shipped turn is marked classified so end_session does not re-flush it.
    await waitFor(() => false, 20) // let markClassified settle
    const status = await callTool(client, 'sensing_get_status', { session_id: sessionId })
    assert.equal(status.mode, 'cloud-thin')
    assert.equal(status.unclassified, 0)
    assert.equal(status.buffer_size, 1)
  })

  it('never embeds for topic shift, even with embedding enabled and no key', async () => {
    process.env.ROBRAIN_MODE = 'cloud'
    mutableConfig.topicShiftDisableEmbedding = false
    try {
      const turn: SessionTurn = {
        session_id: 'thin-topic-shift',
        sequence:   1,
        user_message: 'Completely new topic: rewrite the deploy pipeline.',
        claude_reply: 'ok',
        files_touched: [],
        timestamp: new Date().toISOString(),
      }
      // A local embed() would either fetch a provider or throw for the missing
      // key — thin mode fails open with no shift and no call at all.
      assert.equal(await classifyTopicShift(turn), null)
      assert.equal(fetched.length, 0)
    } finally {
      mutableConfig.topicShiftDisableEmbedding = savedConfig.topicShiftDisableEmbedding
    }
  })
})

describe('full mode stays intact without ROBRAIN_MODE', () => {
  it('buffers without shipping raw turns inline and reports no mode field', async () => {
    const client = await connectClient()
    const sessionId = '2026-07-22T10:00:00.000Z-fu11'

    // No decision keywords — the classifier stays on its no-signal fast path.
    const res = await callTool(client, 'sensing_record_turn', {
      session_id: sessionId,
      sequence: 1,
      user_message: 'How does the stream buffer hold conversation history?',
      claude_reply: 'It keeps recent exchanges in memory, keyed by the current identifier.',
      files_touched: [],
      injected_memory_ids: [],
    })
    assert.equal(res.buffered, true)

    await waitFor(() => false, 50) // give any (wrong) background ship time to fire
    assert.equal(fetched.filter(f => f.url.endsWith('/signals')).length, 0)

    const status = await callTool(client, 'sensing_get_status', { session_id: sessionId })
    assert.equal(status.mode, undefined)
    assert.equal(status.unclassified, 1)
  })
})

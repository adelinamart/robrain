import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { DecisionSignal, SessionTurn } from '@robrain/shared'

// config reads process.env at first import and bun shares one module cache
// across test files — pin the same hermetic env server.test.ts uses, then
// patch the cached config object per test so file order does not matter.
const registryDir = mkdtempSync(join(tmpdir(), 'robrain-sensing-conflict-'))
process.env.SENSING_TOPIC_SHIFT_DISABLE_EMBEDDING = 'true'
process.env.PERCEPTION_API_URL = ''
process.env.PERCEPTION_API_KEY = ''
process.env.ANTHROPIC_API_KEY = ''
process.env.SENSING_SESSION_REGISTRY_PATH ??= join(registryDir, 'sessions.json')

const { config } = await import('./config.js')
const { classifyDecision } = await import('./classifiers/index.js')
const { routeDecisionSignal } = await import('./router.js')
const { buildServer } = await import('./server.js')

const mutableConfig = config as unknown as {
  perceptionApiUrl: string
  perceptionApiKey: string
  anthropicApiKey: string
  llmProvider: string
  topicShiftDisableEmbedding: boolean
}
const savedConfig = { ...mutableConfig }

const PERCEPTION_URL = 'http://perception.test'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const NOTICE = 'The newer decision ("Never use bubble sort.") conflicts with one stated earlier ("Use bubble sort for small arrays."). Both are saved and flagged for robrain review.'

const fetchedUrls: string[] = []
let perceptionReply: Record<string, unknown> = { accepted: true, action: 'written' }
let perceptionDelayMs = 0
let completedSignalPosts = 0
const realFetch = globalThis.fetch

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    fetchedUrls.push(url)
    if (url === ANTHROPIC_URL) {
      return jsonResponse({
        content: [{
          type: 'text',
          text: JSON.stringify({
            decision:   'Never use bubble sort.',
            rationale:  null,
            rejected:   [],
            confidence: 0.9,
          }),
        }],
      })
    }
    if (url === `${PERCEPTION_URL}/signals`) {
      if (perceptionDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, perceptionDelayMs))
      }
      completedSignalPosts += 1
      return jsonResponse(perceptionReply)
    }
    return jsonResponse({})
  }) as typeof fetch
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'sensing-conflict-test', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    buildServer().connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

function parseToolText(result: Awaited<ReturnType<Client['callTool']>>, toolName: string): Record<string, unknown> {
  const first = (result.content as Array<{ type: string; text: string }>)[0]
  assert.ok(first, `${toolName} returned no content`)
  return JSON.parse(first.text) as Record<string, unknown>
}

async function recordTurn(
  client: Client,
  sessionId: string,
  sequence: number,
  userMessage: string,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: 'sensing_record_turn',
    arguments: {
      session_id:          sessionId,
      sequence,
      user_message:        userMessage,
      claude_reply:        'Understood.',
      files_touched:       [],
      injected_memory_ids: [],
    },
  })
  return parseToolText(result, 'sensing_record_turn')
}

async function endSession(client: Client, sessionId: string): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: 'sensing_end_session',
    arguments: { session_id: sessionId },
  })
  return parseToolText(result, 'sensing_end_session')
}

/** Waits until the background save has posted and its reply has been handled. */
async function waitForSaves(postsBefore: number, expectedPosts = 1): Promise<void> {
  await waitFor(() => completedSignalPosts >= postsBefore + expectedPosts)
  await new Promise(resolve => setTimeout(resolve, 20))
}

function turnFrom(userMessage: string, claudeReply = 'Understood.'): SessionTurn {
  return {
    session_id:    'conflict-notice-unit',
    sequence:      1,
    user_message:  userMessage,
    claude_reply:  claudeReply,
    files_touched: [],
    timestamp:     new Date().toISOString(),
  }
}

function decisionSignal(): DecisionSignal {
  return {
    turn:           turnFrom('Never use bubble sort.'),
    decision_type:  'architectural',
    confidence:     0.9,
    files_affected: [],
    scope:          'team',
    extracted:      { decision: 'Never use bubble sort.', rationale: null, rejected: [], confidence: 0.9 },
  }
}

before(() => {
  delete process.env.ROBRAIN_MODE
  mutableConfig.perceptionApiUrl = PERCEPTION_URL
  mutableConfig.perceptionApiKey = 'conflict-test-key'
  mutableConfig.anthropicApiKey = 'conflict-test-anthropic-key'
  mutableConfig.llmProvider = 'anthropic'
  mutableConfig.topicShiftDisableEmbedding = true
  installFetchMock()
})

afterEach(() => {
  fetchedUrls.length = 0
  perceptionReply = { accepted: true, action: 'written' }
  perceptionDelayMs = 0
})

after(() => {
  Object.assign(mutableConfig, savedConfig)
  globalThis.fetch = realFetch
  if (process.env.SENSING_SESSION_REGISTRY_PATH !== join(registryDir, 'sessions.json')) {
    rmSync(registryDir, { recursive: true, force: true })
  }
})

describe('routeDecisionSignal', () => {
  it('passes a conflict_notice through when Perception flags a clash', async () => {
    perceptionReply = { accepted: true, action: 'conflict_flagged', conflict_notice: `  ${NOTICE}  ` }
    assert.deepEqual(await routeDecisionSignal(decisionSignal(), 'proj'), {
      persisted:      true,
      conflictNotice: NOTICE,
    })
  })

  it('counts a quarantined row as persisted so flush-on-close does not re-ship it', async () => {
    perceptionReply = { accepted: true, action: 'quarantined' }
    assert.deepEqual(await routeDecisionSignal(decisionSignal(), 'proj'), { persisted: true })
  })

  it('drops a blank notice', async () => {
    perceptionReply = { accepted: true, action: 'conflict_flagged', conflict_notice: '   ' }
    assert.deepEqual(await routeDecisionSignal(decisionSignal(), 'proj'), { persisted: true })
  })

  it('does not count an action it does not recognise as persisted', async () => {
    perceptionReply = { accepted: true, action: 'queued_for_contradiction_check' }
    const outcome = await routeDecisionSignal(decisionSignal(), 'proj')
    assert.equal(outcome.persisted, false)
    assert.equal(outcome.conflictNotice, undefined)
  })
})

describe('classifyDecision rule gate', () => {
  it('sends a user-stated standing rule to extraction', async () => {
    for (const userMessage of [
      'Never use bubble sort in this repo.',
      'From now on, name test files *.spec.ts.',
      "Don't use default exports.",
    ]) {
      fetchedUrls.length = 0
      const signal = await classifyDecision(turnFrom(userMessage), 'proj')
      assert.ok(signal, `no signal for: ${userMessage}`)
      assert.deepEqual(fetchedUrls, [ANTHROPIC_URL])
    }
  })

  it('skips the LLM for a plain remark that happens to say never', async () => {
    assert.equal(await classifyDecision(turnFrom('It never works on the first try, does it?'), 'proj'), null)
    assert.deepEqual(fetchedUrls, [])
  })

  it('skips the LLM when only the assistant states the rule', async () => {
    const assistantOnly = turnFrom('Which sort does this file use?', 'You should never use bubble sort here.')
    assert.equal(await classifyDecision(assistantOnly, 'proj'), null)
    assert.deepEqual(fetchedUrls, [])
  })
})

describe('sensing_record_turn in self-hosted mode', () => {
  it('returns the conflict_notice on the next record_turn, once', async () => {
    const sessionId = '2026-09-29T09:00:00.000Z-cf01'
    perceptionReply = { accepted: true, action: 'conflict_flagged', conflict_notice: NOTICE }
    const client = await connectClient()

    const postsBefore = completedSignalPosts
    const first = await recordTurn(client, sessionId, 1, 'Never use bubble sort.')
    assert.equal(first.buffered, true)
    assert.equal('conflict_notice' in first, false)
    await waitForSaves(postsBefore)

    perceptionReply = { accepted: true, action: 'written' }
    const second = await recordTurn(client, sessionId, 2, 'Thanks, that is all.')
    assert.equal(second.conflict_notice, NOTICE)

    const third = await recordTurn(client, sessionId, 3, 'Thanks, that is all.')
    assert.equal('conflict_notice' in third, false)
  })

  it('never hands one session the notice from another', async () => {
    perceptionReply = { accepted: true, action: 'conflict_flagged', conflict_notice: NOTICE }
    const client = await connectClient()
    const postsBefore = completedSignalPosts
    await recordTurn(client, '2026-09-29T09:02:00.000Z-cf02', 1, 'Never use bubble sort.')
    await waitForSaves(postsBefore)

    perceptionReply = { accepted: true, action: 'written' }
    const other = await recordTurn(client, '2026-09-29T09:02:30.000Z-cf09', 1, 'Thanks, that is all.')
    assert.equal('conflict_notice' in other, false)
  })

  it('omits conflict_notice when the saves are plain writes', async () => {
    const sessionId = '2026-09-29T09:05:00.000Z-cf03'
    const client = await connectClient()
    const postsBefore = completedSignalPosts
    await recordTurn(client, sessionId, 1, 'Never use bubble sort.')
    await waitForSaves(postsBefore)
    const response = await recordTurn(client, sessionId, 2, 'Thanks, that is all.')
    assert.equal(response.buffered, true)
    assert.equal('conflict_notice' in response, false)
  })

  it('returns without waiting on a slow Perception, and still delivers the notice later', async () => {
    const sessionId = '2026-09-29T09:10:00.000Z-cf04'
    perceptionReply = { accepted: true, action: 'conflict_flagged', conflict_notice: NOTICE }
    perceptionDelayMs = 400
    const postsBefore = completedSignalPosts
    const client = await connectClient()

    const startedAt = Date.now()
    const response = await recordTurn(client, sessionId, 1, 'Never use bubble sort.')
    const elapsedMs = Date.now() - startedAt

    assert.equal(response.buffered, true)
    assert.ok(elapsedMs < perceptionDelayMs, `record_turn waited ${elapsedMs}ms on the save`)

    await waitForSaves(postsBefore)
    perceptionReply = { accepted: true, action: 'written' }
    perceptionDelayMs = 0
    const next = await recordTurn(client, sessionId, 2, 'Thanks, that is all.')
    assert.equal(next.conflict_notice, NOTICE)
  })

  it('hands a notice still held at session end to sensing_end_session', async () => {
    const sessionId = '2026-09-29T09:15:00.000Z-cf05'
    perceptionReply = { accepted: true, action: 'conflict_flagged', conflict_notice: NOTICE }
    const client = await connectClient()
    const postsBefore = completedSignalPosts
    await recordTurn(client, sessionId, 1, 'Never use bubble sort.')
    await waitForSaves(postsBefore)

    const ended = await endSession(client, sessionId)
    assert.equal(ended.conflict_notice, NOTICE)
  })
})

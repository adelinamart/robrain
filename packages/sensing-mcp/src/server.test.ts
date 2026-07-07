import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// config reads process.env at first import — pin a hermetic environment
// BEFORE the dynamic import below. No embeddings, no Perception, tmp mirror.
const registryDir = mkdtempSync(join(tmpdir(), 'robrain-sensing-server-'))
const registryPath = join(registryDir, 'sessions.json')
process.env.SENSING_TOPIC_SHIFT_DISABLE_EMBEDDING = 'true'
process.env.PERCEPTION_API_URL = ''
process.env.PERCEPTION_API_KEY = ''
process.env.ANTHROPIC_API_KEY = ''
process.env.SENSING_SESSION_REGISTRY_PATH = registryPath

const { buildServer, sessionRegistry } = await import('./server.js')

after(() => rmSync(registryDir, { recursive: true, force: true }))

async function connectClient(): Promise<Client> {
  const client = new Client({ name: 'sensing-test', version: '0.0.0' })
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

// Messages deliberately free of decision keywords so the background
// classifier stays on its no-signal fast path.
const turnArgs = (session_id: string, sequence = 1) => ({
  session_id,
  sequence,
  user_message: 'How does the stream buffer hold conversation history?',
  claude_reply: 'It keeps recent exchanges in memory, keyed by the current identifier.',
  files_touched: [] as string[],
  injected_memory_ids: [] as string[],
})

describe('sensing_record_turn across server restarts', () => {
  it('buffers a turn for an unknown-but-well-formed session_id instead of erroring', async () => {
    const client = await connectClient()
    const sessionId = '2026-07-07T09:00:00.000Z-ab12'

    const res = await callTool(client, 'sensing_record_turn', turnArgs(sessionId))

    assert.equal(res.error, undefined)
    assert.equal(res.buffered, true)
    assert.equal(res.sequence, 1)
    // Adopted into the live registry so follow-up turns are a plain hit
    assert.ok(sessionRegistry.get(sessionId))

    const status = await callTool(client, 'sensing_get_status', { session_id: sessionId })
    assert.equal(status.session_found, true)
    assert.equal(status.buffer_size, 1)
  })

  it('resumes a mirrored session with its original project_id', async () => {
    const client = await connectClient()
    const sessionId = '2026-07-07T10:00:00.000Z-cd34'

    // Simulate a previous server process: session is in the mirror file,
    // but not in this process's memory.
    writeFileSync(registryPath, JSON.stringify({
      last_project_id: 'robrain',
      sessions: {
        [sessionId]: { project_id: 'robrain', started_at: '2026-07-07T10:00:00.000Z' },
      },
    }), 'utf8')

    const res = await callTool(client, 'sensing_record_turn', turnArgs(sessionId, 5))

    assert.equal(res.error, undefined)
    assert.equal(res.buffered, true)
    assert.equal(res.sequence, 5)
    assert.equal(sessionRegistry.get(sessionId)?.project_id, 'robrain')
  })

  it('still rejects a blank session_id', async () => {
    const client = await connectClient()
    const res = await callTool(client, 'sensing_record_turn', turnArgs('   '))
    assert.match(String(res.error), /sensing_start_session/)
    assert.equal(res.buffered, undefined)
  })

  it('end_session flushes a session that only exists in the mirror', async () => {
    const client = await connectClient()
    const sessionId = '2026-07-07T11:00:00.000Z-ef56'

    writeFileSync(registryPath, JSON.stringify({
      last_project_id: 'robrain',
      sessions: {
        [sessionId]: { project_id: 'robrain', started_at: '2026-07-07T11:00:00.000Z' },
      },
    }), 'utf8')

    await callTool(client, 'sensing_record_turn', turnArgs(sessionId))
    const res = await callTool(client, 'sensing_end_session', { session_id: sessionId })

    assert.equal(res.error, undefined)
    assert.equal(res.flushed, 1)
    // Removed from memory and the mirror
    assert.equal(sessionRegistry.get(sessionId), undefined)
    assert.equal(sessionRegistry.resume(sessionId), null)
  })
})

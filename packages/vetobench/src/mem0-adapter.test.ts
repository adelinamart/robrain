import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Memory, MemoryItem } from 'mem0ai/oss'
import { makeMem0Adapter, STORE_SNAPSHOT_LIMIT } from './mem0-adapter.js'
import { decisionAsTranscript } from './transcripts.js'
import type { CorpusDecision, Scenario } from './types.js'

const corpus: CorpusDecision[] = [{
  id: 'd1', decision: 'Keep SQLite', rationale: 'Single host',
  rejected: [{ option: 'Postgres', reason: 'No remote database required' }],
  files_affected: [], created_at: '2026-07-01', reviewed_at: null,
  historical_relevance: 1,
}]
const scenario: Scenario = {
  id: 's1', veto_decision_id: 'd1', trap: 'implicit', task: 'Choose storage',
  files_in_scope: [], rejected_option: 'Postgres', rejected_markers: [], accepted_markers: [],
}
const asOf = '2026-07-02'

function fakeClient(results: MemoryItem[]): Pick<Memory, 'add' | 'search' | 'getAll'> {
  return {
    add: async () => ({ results: [] }),
    search: async () => ({ results: [] }),
    getAll: async () => ({ results }),
  }
}

// A fake factory is used in every test: no SDK construction, native DB, or API call.
test('Mem0 archives more than the SDK default 20 after ingestion, independently of retrieval', async t => {
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'synthetic-test-only'
  t.after(() => { if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey })
  const stored = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, memory: `fact ${i}`, hash: `h${i}` }))
  const calls: string[] = []
  const client = fakeClient(stored)
  client.add = async (messages, options) => {
    assert.deepEqual(messages, decisionAsTranscript(corpus[0]!))
    assert.deepEqual(options, { userId: 'vetobench-team' })
    calls.push('add')
    return { results: [] }
  }
  client.getAll = async options => {
    assert.deepEqual(options, { filters: { user_id: 'vetobench-team' }, topK: STORE_SNAPSHOT_LIMIT + 1 })
    assert.deepEqual(calls, ['add'])
    calls.push('snapshot')
    return { results: stored }
  }
  client.search = async (query, options) => {
    assert.equal(query, scenario.task)
    assert.deepEqual(options, { topK: 3, filters: { user_id: 'vetobench-team' } })
    calls.push('search')
    return { results: [stored[0]!] }
  }
  const adapter = makeMem0Adapter(3, async config => {
    assert.equal(config?.vectorStore?.config.dbPath, ':memory:')
    return client
  })
  assert.equal(adapter.report!(), null)
  await adapter.init!(corpus, asOf)
  const report = JSON.parse(JSON.stringify(adapter.report!()))
  assert.equal(report.stage, 'after_ingestion')
  assert.deepEqual(report.corpus_decision_ids, ['d1'])
  assert.equal(report.store_snapshot.status, 'complete')
  assert.deepEqual(report.store_snapshot.memories, stored)
  assert.equal(await adapter.buildContext(scenario, corpus, asOf), 'Relevant memories for this task (from team memory):\n- fact 0')
  assert.deepEqual(calls, ['add', 'snapshot', 'search'])
})

test('Mem0 snapshot distinguishes empty, exact limit, and capped stores', async t => {
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'synthetic-test-only'
  t.after(() => { if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey })
  for (const count of [0, STORE_SNAPSHOT_LIMIT, STORE_SNAPSHOT_LIMIT + 1]) {
    const client = fakeClient(Array.from({ length: count }, (_, i) => ({ id: `m${i}`, memory: `fact ${i}` })))
    const adapter = makeMem0Adapter(5, async () => client)
    await adapter.init!([], asOf)
    const { store_snapshot: snapshot } = JSON.parse(JSON.stringify(adapter.report!()))
    assert.equal(snapshot.status, count > STORE_SNAPSHOT_LIMIT ? 'capped' : 'complete')
    assert.equal(snapshot.memories.length, Math.min(count, STORE_SNAPSHOT_LIMIT))
  }
})

test('Mem0 snapshot failure cannot masquerade as an empty or previous successful run', async t => {
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'synthetic-test-only'
  t.after(() => { if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey })
  const client = fakeClient([{ id: 'm1', memory: 'synthetic fact' }])
  const adapter = makeMem0Adapter(5, async () => client)
  await adapter.init!([], asOf)
  assert.notEqual(adapter.report!(), null)
  client.getAll = async () => { throw new Error('synthetic store read failure') }
  await assert.rejects(adapter.init!([], asOf), /synthetic store read failure/)
  assert.equal(adapter.report!(), null)
  await assert.rejects(Promise.resolve().then(() => adapter.buildContext(scenario, corpus, asOf)), /init\(\) must run/)
})

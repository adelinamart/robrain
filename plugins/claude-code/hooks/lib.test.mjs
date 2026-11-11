// Unit tests for the hook library's cloud helpers. Run with:
//   node --test plugins/claude-code/hooks/lib.test.mjs
// State files go to a throwaway directory (ROBRAIN_STATE_DIR is read when
// lib.mjs loads, so it is set before the import).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'robrain-hooks-'))
process.env.ROBRAIN_STATE_DIR = stateDir
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }))

const {
  isCloudConfig, memoryLine, renderCloudContext,
  recordInjection, loadUnscoredInjections, markInjectionScored, scorePendingInjections,
} = await import('./lib.mjs')

test('isCloudConfig: a cloud login marks cloud, selfHosted wins, the env flag overrides', () => {
  assert.equal(isCloudConfig({ token: 'rory_x' }, {}), true)
  assert.equal(isCloudConfig({ thin: true }, {}), true)
  assert.equal(isCloudConfig({ token: 'rory_x', selfHosted: true }, {}), false)
  assert.equal(isCloudConfig({ perceptionUrl: 'http://127.0.0.1:3001' }, {}), false)
  assert.equal(isCloudConfig(null, {}), false)
  assert.equal(isCloudConfig(null, { ROBRAIN_CLOUD: '1' }), true)
  assert.equal(isCloudConfig({ token: 'rory_x' }, { ROBRAIN_CLOUD: '0' }), false)
})

test('memoryLine: score, decision and up to two rejected options', () => {
  assert.equal(
    memoryLine({ decision: 'Use pgvector', score: 0.873, rejected: [{ option: 'Pinecone', reason: 'pricing' }, { option: 'Qdrant', reason: '' }, { option: 'third', reason: 'x' }] }),
    '- [0.87] Use pgvector (over: Pinecone: pricing; Qdrant)',
  )
  assert.equal(memoryLine({ decision: 'Keep Hono' }), '- [?.??] Keep Hono')
})

test('renderCloudContext: warnings first, then ranked memories, capped', () => {
  const out = renderCloudContext({
    memories: [1, 2, 3].map(n => ({ id: `m-${n}`, decision: `Decision ${n}`, score: 0.5, rejected: [] })),
    veto_warnings: [{ decision_id: 'v-1', message: 'Pinecone was rejected: pricing', reviewed: true }],
  }, new Set(), 2)
  assert.deepEqual(out.ids, ['m-1', 'm-2', 'v-1'])
  const lines = out.text.split('\n')
  assert.match(lines[0], /previously REJECTED/)
  assert.equal(lines[1], '- Pinecone was rejected: pricing')
  assert.ok(out.text.includes('- [0.50] Decision 2'))
  assert.ok(!out.text.includes('Decision 3'))
  assert.ok(!out.text.includes('ACKNOWLEDGEMENT'))
})

test('renderCloudContext: the acknowledgement leads only when an unreviewed warning is shown', () => {
  const ctx = {
    memories: [{ id: 'm-1', decision: 'Decision 1', score: 0.5, rejected: [] }],
    veto_warnings: [{ decision_id: 'v-1', message: 'Redis was rejected: ops load', reviewed: false }],
    required_acknowledgement: 'Redis was rejected in an unreviewed decision.',
  }
  const first = renderCloudContext(ctx, new Set())
  assert.equal(first.text.split('\n')[0], '⚠ ACKNOWLEDGEMENT REQUIRED: Redis was rejected in an unreviewed decision.')

  // The warning was already shown this session: the memory is new, the demand is not repeated.
  const later = renderCloudContext({ ...ctx, memories: [{ id: 'm-2', decision: 'Decision 2', score: 0.4, rejected: [] }] }, new Set(['v-1', 'm-1']))
  assert.deepEqual(later.ids, ['m-2'])
  assert.ok(!later.text.includes('ACKNOWLEDGEMENT'))
})

test('renderCloudContext: nothing new means nothing to inject; malformed payloads are tolerated', () => {
  assert.equal(renderCloudContext({ memories: [{ id: 'm-1', decision: 'x' }], veto_warnings: [] }, new Set(['m-1'])), null)
  assert.equal(renderCloudContext({}, new Set()), null)
  assert.equal(renderCloudContext(null, new Set()), null)
  assert.equal(renderCloudContext({ memories: [{ decision: 'no id' }], veto_warnings: [{ decision_id: 'v', message: 5 }] }, new Set()), null)
})

test('injection ledger: records once, lists unscored oldest first, marks scored', () => {
  recordInjection('s-ledger', 1)
  recordInjection('s-ledger', 2)
  recordInjection('s-ledger', 2)
  recordInjection('s-ledger', 0)
  recordInjection('', 9)
  assert.deepEqual(loadUnscoredInjections('s-ledger'), [1, 2])
  markInjectionScored('s-ledger', 1)
  assert.deepEqual(loadUnscoredInjections('s-ledger'), [2])
  assert.deepEqual(loadUnscoredInjections('s-other'), [])
})

test('scorePendingInjections: cloud only, newest two, a failed call stays unscored for the next turn', async () => {
  const realFetch = globalThis.fetch
  const calls = []
  try {
    for (const n of [1, 2, 3]) recordInjection('s-score', n)

    globalThis.fetch = async () => { throw new Error('must not be called on self-hosted') }
    await scorePendingInjections({ url: 'http://x', key: 'k', cloud: false }, 's-score', 'cc-s-score', 'reply')
    assert.deepEqual(loadUnscoredInjections('s-score'), [1, 2, 3])

    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body)
      calls.push({ url, ...body })
      // Sequence 3 succeeds, sequence 2 fails upstream.
      return body.sequence === 3
        ? new Response(JSON.stringify({ scored: true }), { status: 200 })
        : new Response('nope', { status: 500 })
    }
    await scorePendingInjections({ url: 'http://x', key: 'k', cloud: true }, 's-score', 'cc-s-score', 'the reply')
    assert.deepEqual(calls.map(c => c.sequence), [3, 2])
    assert.equal(calls[0].url, 'http://x/effectiveness')
    assert.equal(calls[0].session_id, 'cc-s-score')
    assert.equal(calls[0].reply_text, 'the reply')
    assert.deepEqual(loadUnscoredInjections('s-score'), [1, 2])
  } finally {
    globalThis.fetch = realFetch
  }
})

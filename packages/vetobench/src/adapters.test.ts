// packages/vetobench/src/adapters.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conventionsAdapter, flatfileAdapter, makeFlatfileAdapter, makeRobrainAdapter, noneAdapter, vetoRank } from './adapters.js'
import type { CorpusDecision, Scenario } from './types.js'

const corpus: CorpusDecision[] = [
  {
    id: 'd1',
    decision: 'Keep the API on Hono',
    rationale: 'lightweight middleware',
    rejected: [{ option: 'Express', reason: 'slower cold starts' }],
    files_affected: ['api/server.ts'],
    created_at: '2026-06-01T00:00:00Z',
    reviewed_at: '2026-06-02T00:00:00Z',
    historical_relevance: 0.8,
  },
  {
    id: 'd2',
    decision: 'Logs are JSON lines',
    rationale: 'ops dashboards parse them',
    rejected: [],
    files_affected: ['api/logger.ts'],
    created_at: '2026-05-01T00:00:00Z',
    reviewed_at: null,
    historical_relevance: 0.4,
  },
]

const scenario: Scenario = {
  id: 's1',
  veto_decision_id: 'd1',
  trap: 'implicit',
  task: 'Modernize the API middleware on the Hono server',
  files_in_scope: ['api/server.ts'],
  rejected_option: 'Express',
  rejected_markers: [],
  accepted_markers: [],
}

const AS_OF = '2026-07-01T00:00:00Z'

test('none provides no context', async () => {
  assert.equal(await noneAdapter.buildContext(scenario, corpus, AS_OF), '')
})

test('conventions includes choices but never vetoes', async () => {
  const ctx = await conventionsAdapter.buildContext(scenario, corpus, AS_OF)
  assert.match(ctx, /Keep the API on Hono/)
  assert.doesNotMatch(ctx, /REJECTED/)
  assert.doesNotMatch(ctx, /Express/)
})

test('flatfile includes vetoes with reasons', async () => {
  const ctx = await flatfileAdapter.buildContext(scenario, corpus, AS_OF)
  assert.match(ctx, /REJECTED: Express — slower cold starts/)
})

test('robrain retrieves the veto decision for a related task', async () => {
  const ctx = await makeRobrainAdapter().buildContext(scenario, corpus, AS_OF)
  assert.match(ctx, /REJECTED: Express/)
})

test('robrain top-k actually truncates', async () => {
  const big: CorpusDecision[] = Array.from({ length: 10 }, (_, i) => ({
    ...corpus[1]!,
    id: `dx${i}`,
    decision: `Unrelated decision number ${i}`,
  }))
  const ctx = await makeRobrainAdapter(undefined, 3).buildContext(scenario, [...big, corpus[0]!], AS_OF)
  const lines = ctx.split('\n').filter((l: string) => l.startsWith('- '))
  assert.equal(lines.length, 3)
})

// -- lifecycle (superseded decisions) --------------------------------------

const lifecycleCorpus: CorpusDecision[] = [
  {
    id: 'L1',
    decision: 'Run background jobs on pg-boss',
    rationale: 'one datastore',
    rejected: [],
    files_affected: ['jobs/queue.ts'],
    created_at: '2026-02-10T00:00:00Z',
    reviewed_at: '2026-02-11T00:00:00Z',
    historical_relevance: 0.6,
    status: 'superseded',
    superseded_by: 'L2',
  },
  {
    id: 'L2',
    decision: 'Use Temporal for background job orchestration',
    rationale: 'durable execution',
    rejected: [],
    files_affected: ['jobs/queue.ts'],
    created_at: '2026-06-08T00:00:00Z',
    reviewed_at: '2026-06-09T00:00:00Z',
    historical_relevance: 0.85,
    status: 'active',
  },
]

const staleScenario: Scenario = {
  id: 'sL',
  veto_decision_id: 'L2',
  trap: 'stale-unnamed',
  task: 'Schedule a nightly billing reconciliation job',
  files_in_scope: ['jobs/queue.ts'],
  rejected_option: 'pg-boss',
  rejected_markers: ['pg-?boss'],
  accepted_markers: ['\\btemporal\\b'],
}

test('robrain excludes superseded decisions from context', async () => {
  const ctx = await makeRobrainAdapter().buildContext(staleScenario, lifecycleCorpus, AS_OF)
  assert.match(ctx, /Temporal/)
  assert.doesNotMatch(ctx, /pg-boss/)
})

test('robrain inherits still-standing vetoes from a superseded decision', async () => {
  // The superseded row's choice is gone, but its rejection is still true and
  // must survive onto the decision that replaced it — marked, not silent.
  const corpus: CorpusDecision[] = [
    { ...lifecycleCorpus[0]!, rejected: [{ option: 'in-process memory cache', reason: 'breaks across instances' }] },
    lifecycleCorpus[1]!,
  ]
  const ctx = await makeRobrainAdapter().buildContext(staleScenario, corpus, AS_OF)
  assert.match(ctx, /in-process memory cache/)
  assert.match(ctx, /carried from a superseded decision/)
  // the dead choice itself still must not appear as current
  assert.doesNotMatch(ctx, /pg-boss/)
})

test('flatfile shows the superseded decision alongside the active one', async () => {
  const ctx = await makeFlatfileAdapter(true).buildContext(staleScenario, lifecycleCorpus, AS_OF)
  assert.match(ctx, /pg-boss/)
  assert.match(ctx, /Temporal/)
})

test('withDates renders dates; default rendering stays date-free', async () => {
  const dated = await makeFlatfileAdapter(true).buildContext(staleScenario, lifecycleCorpus, AS_OF)
  assert.match(dated, /\[2026-06-08\]/)
  const plain = await makeFlatfileAdapter(false).buildContext(staleScenario, lifecycleCorpus, AS_OF)
  assert.doesNotMatch(plain, /\[2026-06-08\]/)
})

test('vetoRank ignores superseded rows', () => {
  assert.equal(vetoRank(staleScenario, lifecycleCorpus, AS_OF), 1)
})

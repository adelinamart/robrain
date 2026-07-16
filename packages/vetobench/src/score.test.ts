// packages/vetobench/src/score.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAgentReply } from './agent.js'
import { judgeReply, normalizeTech, summarize } from './score.js'
import type { Scenario } from './types.js'

const scenario: Scenario = {
  id: 's-test',
  veto_decision_id: 'd101',
  trap: 'implicit',
  task: 'Improve the HTTP layer.',
  files_in_scope: [],
  rejected_option: 'Express',
  rejected_markers: ['express[.\\-]?js', '(migrat\\w+|switch\\w*)\\s+to\\s+express\\b'],
  accepted_markers: ['\\bhono\\b'],
}

test('violation via key_technologies, case- and punctuation-insensitive', () => {
  const v = judgeReply(scenario, 'none', {
    proposal: 'Adopt a mature middleware framework.',
    key_technologies: ['Express.js', 'helmet'],
    acknowledged_rejections: [],
  })
  assert.equal(v.violation, true)
  assert.match(v.matchedOn!, /key_technologies/)
})

test('violation via proposal prose marker', () => {
  const v = judgeReply(scenario, 'none', {
    proposal: 'We should migrate to Express for its middleware ecosystem.',
    key_technologies: [],
    acknowledged_rejections: [],
  })
  assert.equal(v.violation, true)
})

test('declining the option by name in the proposal prose is NOT a violation when acknowledged', () => {
  const v = judgeReply(scenario, 'robrain', {
    proposal: 'Instead of migrating to Express.js, restructure the existing Hono middleware into ordered composition.',
    key_technologies: ['Hono'],
    acknowledged_rejections: ['Express'],
  })
  assert.equal(v.violation, false)
  assert.equal(v.acknowledged, true)
})

test('key_technologies hit is a violation even when also acknowledged', () => {
  const v = judgeReply(scenario, 'robrain', {
    proposal: 'I know it was rejected, but Express is still the right call here.',
    key_technologies: ['Express'],
    acknowledged_rejections: ['Express'],
  })
  assert.equal(v.violation, true)
})

test('mentioning the rejection without proposing it is NOT a violation', () => {
  const v = judgeReply(scenario, 'robrain', {
    proposal: 'Restructure the Hono middleware into an ordered composition.',
    key_technologies: ['hono'],
    acknowledged_rejections: ['Express'],
  })
  assert.equal(v.violation, false)
  assert.equal(v.acknowledged, true)
})

test('plain-English "express" in prose does not trip the conservative markers', () => {
  const v = judgeReply(scenario, 'none', {
    proposal: 'Middleware should express the intent of each layer clearly, using Hono composition.',
    key_technologies: ['hono'],
    acknowledged_rejections: [],
  })
  assert.equal(v.violation, false)
})

test('normalizeTech collapses punctuation variants', () => {
  assert.equal(normalizeTech('styled-components'), 'styled components')
  assert.equal(normalizeTech('Redux Toolkit'), 'redux toolkit')
})

test('parseAgentReply strips fences and tolerates non-JSON', () => {
  const fenced = parseAgentReply('```json\n{"proposal":"p","key_technologies":["a"],"acknowledged_rejections":[]}\n```')
  assert.equal(fenced.proposal, 'p')
  assert.deepEqual(fenced.key_technologies, ['a'])

  const prose = parseAgentReply('Just use Express, trust me.')
  assert.equal(prose.proposal, 'Just use Express, trust me.')
  assert.deepEqual(prose.key_technologies, [])
})

test('summarize splits by adapter and trap kind', () => {
  const summaries = summarize([
    { scenarioId: 'a', adapter: 'none', trap: 'direct', violation: true, acknowledged: false },
    { scenarioId: 'b', adapter: 'none', trap: 'implicit', violation: false, acknowledged: false },
    { scenarioId: 'a', adapter: 'robrain', trap: 'direct', violation: false, acknowledged: true },
  ])
  const none = summaries.find(s => s.adapter === 'none')!
  assert.equal(none.violationRate, 0.5)
  assert.equal(none.byTrap.direct!.violations, 1)
  const robrain = summaries.find(s => s.adapter === 'robrain')!
  assert.equal(robrain.acknowledgedRate, 1)
})

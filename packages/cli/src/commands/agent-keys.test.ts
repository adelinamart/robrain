import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  agentKeyErrorMessage, agentKeyLines, agentKeyStatus, findAgentKey, normalizeAgentKeyName,
  type AgentKey,
} from './agent-keys.js'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

function key(over: Partial<AgentKey>): AgentKey {
  return {
    id: ID_A, name: 'support-bot', prefix: 'rp_live_a1b2', owner_email: 'dev@example.com',
    created_at: '2026-11-12T10:00:00.000Z', last_used_at: null, revoked_at: null, working: true, ...over,
  }
}

test('normalizeAgentKeyName: trims and lowercases, refuses what the API would refuse', () => {
  assert.equal(normalizeAgentKeyName('  Support-Bot '), 'support-bot')
  assert.equal(normalizeAgentKeyName('mailer_2.eu'), 'mailer_2.eu')
  assert.equal(normalizeAgentKeyName(''), null)
  assert.equal(normalizeAgentKeyName('has space'), null)
  assert.equal(normalizeAgentKeyName('-dash-first'), null)
  assert.equal(normalizeAgentKeyName('a:b'), null)
  assert.equal(normalizeAgentKeyName('a'.repeat(64)), null)
})

test('findAgentKey: a name means the key still in use; an id means exactly that key', () => {
  const old = key({ id: ID_A, revoked_at: '2026-11-12T12:00:00.000Z', working: false })
  const live = key({ id: ID_B })
  assert.equal(findAgentKey([old, live], 'support-bot')?.id, ID_B)
  assert.equal(findAgentKey([old, live], ' Support-Bot ')?.id, ID_B)
  assert.equal(findAgentKey([old, live], ID_A)?.id, ID_A)
  assert.equal(findAgentKey([old, live], ID_A.toUpperCase())?.id, ID_A)
  assert.equal(findAgentKey([old], 'support-bot'), null)
  assert.equal(findAgentKey([live], 'other-bot'), null)
  assert.equal(findAgentKey([], ID_A), null)
})

test('agentKeyStatus: revoked, working, or stopped because the owner lost access', () => {
  assert.equal(agentKeyStatus(key({})), 'working')
  assert.equal(agentKeyStatus(key({ working: false })), 'stopped: owner lost access')
  assert.equal(agentKeyStatus(key({ revoked_at: '2026-11-12T12:00:00.000Z', working: false })), 'revoked')
})

test('agentKeyLines: one aligned row per key, never more of the key than its prefix', () => {
  const lines = agentKeyLines([
    key({ last_used_at: '2026-11-13T09:00:00.000Z' }),
    key({ id: ID_B, name: 'mailer', owner_email: null, working: false }),
  ])
  assert.deepEqual(lines, [
    'support-bot  rp_live_a1b2…  dev@example.com  created 2026-11-12  last used 2026-11-13  working',
    'mailer       rp_live_a1b2…  unknown          created 2026-11-12  last used never  stopped: owner lost access',
  ])
  assert.deepEqual(agentKeyLines([]), [])
})

test('agentKeyErrorMessage: says what to do for each answer the API gives on purpose', () => {
  assert.match(agentKeyErrorMessage(403, { error: 'admin_required' }) ?? '', /org admin/)
  assert.match(agentKeyErrorMessage(400, { error: 'owner_required' }) ?? '', /robrain install/)
  assert.match(agentKeyErrorMessage(400, { error: 'invalid_name' }) ?? '', /1 to 63 characters/)
  assert.equal(agentKeyErrorMessage(409, { error: 'name_taken', message: 'An agent key named x already exists.' }), 'An agent key named x already exists.')
  assert.match(agentKeyErrorMessage(409, { error: 'agent_key_limit' }) ?? '', /limit/)
  assert.match(agentKeyErrorMessage(401, { error: 'Unauthorized' }) ?? '', /robrain install/)
  assert.equal(agentKeyErrorMessage(500, { error: 'Internal error' }), null)
})

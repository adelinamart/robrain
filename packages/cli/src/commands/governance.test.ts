import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildRuleBody, parseRejectedFlag } from './governance.js'

describe('parseRejectedFlag', () => {
  it('splits "option: reason" at the first colon', () => {
    assert.deepEqual(parseRejectedFlag('Pinecone: per-namespace pricing: too high'), {
      option: 'Pinecone', reason: 'per-namespace pricing: too high',
    })
  })
  it('accepts a bare option and rejects empty input', () => {
    assert.deepEqual(parseRejectedFlag('npm'), { option: 'npm', reason: '' })
    assert.equal(parseRejectedFlag('  '), null)
    assert.equal(parseRejectedFlag(': no option'), null)
  })
})

describe('buildRuleBody', () => {
  it('builds the POST /projects/:id/rules body from the flags', () => {
    const built = buildRuleBody('Never auto-send a plan', {
      because: 'customers must confirm', rejected: ['auto-send: trust'], kind: 'decision', subject: '',
    }, 'ade@roryplans.ai')
    assert.deepEqual(built, {
      ok: true,
      body: {
        decision: 'Never auto-send a plan',
        rejected: [{ option: 'auto-send', reason: 'trust' }],
        rationale: 'customers must confirm',
        kind: 'decision',
        author_email: 'ade@roryplans.ai',
      },
    })
  })
  it('refuses an empty rule or an unreadable --rejected flag', () => {
    assert.equal(buildRuleBody('   ', {}, null).ok, false)
    const bad = buildRuleBody('x', { rejected: [': nothing'] }, null)
    assert.equal(bad.ok, false)
  })
  it('leaves the author out when none is known', () => {
    const built = buildRuleBody('x', {}, null)
    assert.equal(built.ok && 'author_email' in built.body, false)
  })
})

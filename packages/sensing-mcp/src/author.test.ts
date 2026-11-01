import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeEmail, resetAuthorEmailCache, resolveAuthorEmail } from './author.js'

describe('normalizeEmail', () => {
  it('lowercases and trims one email', () => {
    assert.equal(normalizeEmail('  Ade@RoryPlans.ai '), 'ade@roryplans.ai')
  })

  it('rejects anything that is not one email', () => {
    assert.equal(normalizeEmail(''), null)
    assert.equal(normalizeEmail('not an email'), null)
    assert.equal(normalizeEmail('a@b'), null)
    assert.equal(normalizeEmail('two@x.io, three@x.io'), null)
    assert.equal(normalizeEmail(undefined), null)
  })
})

describe('resolveAuthorEmail', () => {
  beforeEach(() => resetAuthorEmailCache())

  it('prefers ROBRAIN_AUTHOR_EMAIL over git', async () => {
    const email = await resolveAuthorEmail({ ROBRAIN_AUTHOR_EMAIL: 'Dev@Example.com' } as NodeJS.ProcessEnv)
    assert.equal(email, 'dev@example.com')
  })

  it('falls back to git user.email, or null outside a configured checkout', async () => {
    // "/" has no git config of its own; git may still answer from the global config.
    const email = await resolveAuthorEmail({} as NodeJS.ProcessEnv, '/')
    assert.ok(email === null || /@/.test(email))
  })

  it('never sends a malformed ROBRAIN_AUTHOR_EMAIL', async () => {
    const email = await resolveAuthorEmail({ ROBRAIN_AUTHOR_EMAIL: 'nope' } as NodeJS.ProcessEnv, '/')
    assert.notEqual(email, 'nope')
    assert.ok(email === null || /@/.test(email))
  })

  it('caches the first answer for the process', async () => {
    const first  = await resolveAuthorEmail({ ROBRAIN_AUTHOR_EMAIL: 'one@example.com' } as NodeJS.ProcessEnv)
    const second = await resolveAuthorEmail({ ROBRAIN_AUTHOR_EMAIL: 'two@example.com' } as NodeJS.ProcessEnv)
    assert.equal(first, 'one@example.com')
    assert.equal(second, 'one@example.com')
  })
})

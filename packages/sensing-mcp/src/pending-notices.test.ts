import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_PENDING_CONFLICT_NOTICES, rememberConflictNotice } from './pending-notices.js'

describe('rememberConflictNotice', () => {
  it('caps the map at the production limit constant', () => {
    assert.equal(MAX_PENDING_CONFLICT_NOTICES, 1_000)
  })

  it('drops the oldest session when a new one would pass the cap', () => {
    const notices = new Map<string, string[]>()
    rememberConflictNotice(notices, 'session-oldest', 'first clash', 2)
    rememberConflictNotice(notices, 'session-middle', 'second clash', 2)
    rememberConflictNotice(notices, 'session-newest', 'third clash', 2)
    assert.equal(notices.has('session-oldest'), false)
    assert.deepEqual(notices.get('session-middle'), ['second clash'])
    assert.deepEqual(notices.get('session-newest'), ['third clash'])
    assert.equal(notices.size, 2)
  })

  it('keeps every session when the new notice is for one already held', () => {
    const notices = new Map<string, string[]>()
    rememberConflictNotice(notices, 'session-oldest', 'first clash', 2)
    rememberConflictNotice(notices, 'session-middle', 'second clash', 2)
    rememberConflictNotice(notices, 'session-oldest', 'another clash', 2)
    assert.equal(notices.size, 2)
    assert.deepEqual(notices.get('session-oldest'), ['first clash', 'another clash'])
    assert.deepEqual(notices.get('session-middle'), ['second clash'])
  })

  it('stores one copy of the same notice', () => {
    const notices = new Map<string, string[]>()
    rememberConflictNotice(notices, 'session-one', 'same clash', 2)
    rememberConflictNotice(notices, 'session-one', 'same clash', 2)
    assert.deepEqual(notices.get('session-one'), ['same clash'])
  })
})

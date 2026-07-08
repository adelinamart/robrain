import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { attachPoolErrorHandler } from './db.js'

describe('attachPoolErrorHandler', () => {
  it('a pool error is logged instead of crashing the process', () => {
    const pool = new EventEmitter()
    const logged: string[] = []
    attachPoolErrorHandler(pool, 'Test', (m) => logged.push(m))

    // Without a listener this emit would throw (unhandled 'error' event).
    pool.emit('error', new Error('terminating connection due to administrator command'))

    assert.equal(logged.length, 1)
    assert.match(logged[0]!, /\[Test\] Postgres pool error/)
    assert.match(logged[0]!, /terminating connection/)
  })

  it('an unhandled pool error would throw — the failure mode being prevented', () => {
    const pool = new EventEmitter()
    assert.throws(() => pool.emit('error', new Error('boom')))
  })
})

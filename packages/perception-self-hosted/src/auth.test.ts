import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { bearerAuthorized } from './auth.js'

describe('bearerAuthorized', () => {
  const key = 'deadbeefdeadbeefdeadbeefdeadbeef'

  it('accepts the exact Bearer header', () => {
    assert.equal(bearerAuthorized(`Bearer ${key}`, key), true)
  })

  it('rejects a wrong key of the same length', () => {
    assert.equal(bearerAuthorized(`Bearer ${'a'.repeat(key.length)}`, key), false)
  })

  it('rejects keys of different length (length guard, no throw)', () => {
    assert.equal(bearerAuthorized('Bearer short', key), false)
    assert.equal(bearerAuthorized(`Bearer ${key}extra`, key), false)
  })

  it('rejects missing / empty header', () => {
    assert.equal(bearerAuthorized(undefined, key), false)
    assert.equal(bearerAuthorized('', key), false)
  })

  it('rejects a bare key without the Bearer prefix', () => {
    assert.equal(bearerAuthorized(key, key), false)
  })

  it('rejects wrong scheme', () => {
    assert.equal(bearerAuthorized(`Basic  ${key}`, key), false)
  })

  it('rejects everything when the configured key is empty', () => {
    assert.equal(bearerAuthorized('Bearer ', ''), false)
    assert.equal(bearerAuthorized('Bearer anything', ''), false)
  })
})

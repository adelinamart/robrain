import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateReleaseGuard, manifestStatusToPublished, originHasReleaseTag } from './release-guard.js'

describe('originHasReleaseTag', () => {
  const lsRemote = [
    'aaa111\trefs/tags/v2.3.4',
    'bbb222\trefs/tags/v2.3.5',
    'ccc333\trefs/tags/v2.3.5^{}',
    '',
  ].join('\n')

  it('finds a lightweight tag ref', () => {
    assert.equal(originHasReleaseTag(lsRemote, '2.3.4'), true)
  })

  it('finds an annotated tag via its peeled ref', () => {
    assert.equal(originHasReleaseTag('ccc333\trefs/tags/v2.3.5^{}\n', '2.3.5'), true)
  })

  it('does not match prefixes of longer versions', () => {
    assert.equal(originHasReleaseTag('ddd444\trefs/tags/v2.3.45\n', '2.3.4'), false)
  })

  it('returns false when the tag is absent or output is empty', () => {
    assert.equal(originHasReleaseTag(lsRemote, '2.3.7'), false)
    assert.equal(originHasReleaseTag('', '2.3.7'), false)
  })
})

describe('manifestStatusToPublished', () => {
  it('reads 200 as published and 404 as missing', () => {
    assert.equal(manifestStatusToPublished(200), true)
    assert.equal(manifestStatusToPublished(404), false)
  })

  it('throws on auth errors and outages instead of treating them as a missing image', () => {
    assert.throws(() => manifestStatusToPublished(401))
    assert.throws(() => manifestStatusToPublished(429))
    assert.throws(() => manifestStatusToPublished(502))
  })
})

describe('evaluateReleaseGuard', () => {
  const base = {
    version: '2.3.7',
    imageRepo: 'ghcr.io/adelinamart/robrain-perception',
  }

  it('passes when the tag is on origin and the image is on GHCR', () => {
    const result = evaluateReleaseGuard({ ...base, originHasTag: true, imagePublished: true })
    assert.equal(result.ok, true)
    assert.deepEqual(result.problems, [])
  })

  it('fails with both problems when tag and image are missing (the 2.3.6/2.3.7 incident)', () => {
    const result = evaluateReleaseGuard({ ...base, originHasTag: false, imagePublished: false })
    assert.equal(result.ok, false)
    assert.equal(result.problems.length, 2)
    assert.match(result.problems[0]!, /git push origin v2\.3\.7/)
    assert.match(result.problems[1]!, /robrain-perception:2\.3\.7 is not published/)
  })

  it('fails on image-only gap when the tag is pushed but the workflow has not finished', () => {
    const result = evaluateReleaseGuard({ ...base, originHasTag: true, imagePublished: false })
    assert.equal(result.ok, false)
    assert.equal(result.problems.length, 1)
    assert.match(result.problems[0]!, /publish-perception-image\.yml/)
  })
})

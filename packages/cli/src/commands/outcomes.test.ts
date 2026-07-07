import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  MATCH_WINDOW_DAYS,
  matchRevertsToDecisions,
  parseRevertLog,
  pathsOverlap,
  type OutcomeDecision,
  type RevertCommit,
} from './outcomes.js'

const revert = (over: Partial<RevertCommit>): RevertCommit => ({
  hash:    'a'.repeat(40),
  subject: 'Revert "add feature"',
  date:    '2026-06-15T12:00:00Z',
  files:   ['src/feature.ts'],
  ...over,
})

const decision = (over: Partial<OutcomeDecision>): OutcomeDecision => ({
  id:             'dec-1',
  decision:       'Use feature flags',
  files_affected: ['src/feature.ts'],
  created_at:     '2026-06-01T12:00:00Z',
  ...over,
})

describe('parseRevertLog', () => {
  it('parses hash, date, and subject from tab-separated log output', () => {
    const raw = [
      `${'a'.repeat(40)}\t2026-06-15T12:00:00+02:00\tRevert "add feature"`,
      `${'b'.repeat(40)}\t2026-06-16T12:00:00Z\tRevert "switch db"\twith\ttabs`,
    ].join('\n')
    const parsed = parseRevertLog(raw)
    assert.equal(parsed.length, 2)
    assert.equal(parsed[0]!.hash, 'a'.repeat(40))
    assert.equal(parsed[0]!.date, '2026-06-15T12:00:00+02:00')
    assert.equal(parsed[0]!.subject, 'Revert "add feature"')
    assert.equal(parsed[1]!.subject, 'Revert "switch db"\twith\ttabs')
  })

  it('drops commits whose subject does not start with Revert', () => {
    const raw = [
      `${'a'.repeat(40)}\t2026-06-15T12:00:00Z\tfix: reverted logic in parser`,
      `${'b'.repeat(40)}\t2026-06-16T12:00:00Z\tRevert "real revert"`,
    ].join('\n')
    const parsed = parseRevertLog(raw)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]!.subject, 'Revert "real revert"')
  })

  it('handles empty output and blank lines', () => {
    assert.deepEqual(parseRevertLog(''), [])
    assert.deepEqual(parseRevertLog('\n\n'), [])
  })

  it('drops double reverts — they re-apply the original change', () => {
    const raw = [
      `${'a'.repeat(40)}\t2026-06-15T12:00:00Z\tRevert "Revert "add feature""`,
      `${'b'.repeat(40)}\t2026-06-16T12:00:00Z\tRevert "add feature"`,
    ].join('\n')
    const parsed = parseRevertLog(raw)
    assert.equal(parsed.length, 1)
    assert.equal(parsed[0]!.subject, 'Revert "add feature"')
  })
})

describe('pathsOverlap', () => {
  it('matches identical paths', () => {
    assert.ok(pathsOverlap('src/a.ts', 'src/a.ts'))
  })

  it('matches when one path is a trailing suffix of the other', () => {
    assert.ok(pathsOverlap('packages/cli/src/a.ts', 'src/a.ts'))
    assert.ok(pathsOverlap('src/a.ts', 'packages/cli/src/a.ts'))
  })

  it('ignores a leading ./', () => {
    assert.ok(pathsOverlap('./src/a.ts', 'src/a.ts'))
  })

  it('rejects partial-basename overlap', () => {
    assert.ok(!pathsOverlap('src/a.ts', 'src/extra.ts'))
    assert.ok(!pathsOverlap('a.ts', 'extra.ts'))
  })

  it('only suffix-matches when the shorter side is a multi-segment path', () => {
    assert.ok(!pathsOverlap('packages/cli/src/index.ts', 'index.ts'))
    assert.ok(!pathsOverlap('index.ts', 'packages/cli/src/index.ts'))
    assert.ok(pathsOverlap('index.ts', 'index.ts'))
    assert.ok(pathsOverlap('packages/cli/src/index.ts', 'src/index.ts'))
  })
})

describe('matchRevertsToDecisions', () => {
  it('matches when files overlap and the decision predates the revert', () => {
    const matches = matchRevertsToDecisions([revert({})], [decision({})])
    assert.equal(matches.length, 1)
    assert.equal(matches[0]!.decision.id, 'dec-1')
    assert.equal(matches[0]!.revert.hash, 'a'.repeat(40))
  })

  it('skips decisions with no file overlap', () => {
    const matches = matchRevertsToDecisions(
      [revert({ files: ['src/other.ts'] })],
      [decision({})],
    )
    assert.equal(matches.length, 0)
  })

  it('skips decisions created after the revert', () => {
    const matches = matchRevertsToDecisions(
      [revert({ date: '2026-05-01T00:00:00Z' })],
      [decision({ created_at: '2026-06-01T00:00:00Z' })],
    )
    assert.equal(matches.length, 0)
  })

  it(`skips decisions older than ${MATCH_WINDOW_DAYS} days before the revert`, () => {
    const matches = matchRevertsToDecisions(
      [revert({ date: '2026-06-15T12:00:00Z' })],
      [decision({ created_at: '2026-01-01T00:00:00Z' })],
    )
    assert.equal(matches.length, 0)
  })

  it('accepts a decision right at the window edge', () => {
    const matches = matchRevertsToDecisions(
      [revert({ date: '2026-06-15T12:00:00Z' })],
      // Exactly 90 days before the revert
      [decision({ created_at: '2026-03-17T12:00:00Z' })],
    )
    assert.equal(matches.length, 1)
  })

  it('matches each decision at most once, to the earliest qualifying revert', () => {
    const matches = matchRevertsToDecisions(
      [
        revert({ hash: 'b'.repeat(40), date: '2026-06-20T00:00:00Z' }),
        revert({ hash: 'a'.repeat(40), date: '2026-06-15T00:00:00Z' }),
      ],
      [decision({})],
    )
    assert.equal(matches.length, 1)
    assert.equal(matches[0]!.revert.hash, 'a'.repeat(40))
  })

  it('matches multiple decisions to the same revert', () => {
    const matches = matchRevertsToDecisions(
      [revert({ files: ['src/a.ts', 'src/b.ts'] })],
      [
        decision({ id: 'dec-1', files_affected: ['src/a.ts'] }),
        decision({ id: 'dec-2', files_affected: ['src/b.ts'] }),
        decision({ id: 'dec-3', files_affected: ['src/c.ts'] }),
      ],
    )
    assert.deepEqual(matches.map(m => m.decision.id), ['dec-1', 'dec-2'])
  })
})

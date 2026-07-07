import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  INTERCHANGE_FORMAT,
  toInterchangeJsonl,
  toInterchangeRecord,
  type SourceDecision,
} from './export-interchange.js'

const full: SourceDecision = {
  id:             'dec-1',
  decision:       'Use pnpm for all workspace commands',
  rationale:      'Repo is standardized on pnpm',
  rejected:       [{ option: 'npm', reason: 'lockfile drift' }],
  files_affected: ['package.json', 'pnpm-workspace.yaml'],
  scope:          'team',
  created_at:     '2026-05-01T10:00:00Z',
  invalidated_at: null,
  reviewed_at:    '2026-05-02T09:00:00Z',
  supersedes_id:  'dec-0',
  session_id:     'sess-abc',
  source_turn_sequence: 4,
  source_excerpt: 'please only ever use pnpm here',
  historical_relevance: 0.62,
  injected_count: 14,
  used_count:     11,
}

describe('toInterchangeRecord', () => {
  it('maps a full decision row into the versioned envelope', () => {
    const rec = toInterchangeRecord(full)
    assert.equal(rec.format, 'robrain-memory/v1')
    assert.equal(rec.format, INTERCHANGE_FORMAT)
    assert.equal(rec.id, 'dec-1')
    assert.equal(rec.decision, full.decision)
    assert.equal(rec.rationale, full.rationale)
    assert.deepEqual(rec.rejected, [{ option: 'npm', reason: 'lockfile drift' }])
    assert.deepEqual(rec.files_affected, ['package.json', 'pnpm-workspace.yaml'])
    assert.equal(rec.scope, 'team')
    assert.deepEqual(rec.lifecycle, {
      created_at:     '2026-05-01T10:00:00Z',
      invalidated_at: null,
      reviewed_at:    '2026-05-02T09:00:00Z',
      supersedes_id:  'dec-0',
    })
    assert.deepEqual(rec.provenance, {
      session_id:           'sess-abc',
      source_turn_sequence: 4,
      source_excerpt:       'please only ever use pnpm here',
    })
    assert.deepEqual(rec.quality, {
      historical_relevance: 0.62,
      injected_count:       14,
      used_count:           11,
    })
  })

  it('normalizes missing optional fields to nulls / empty defaults', () => {
    const rec = toInterchangeRecord({
      id:         'dec-2',
      decision:   'Bare minimum row',
      scope:      'local',
      created_at: '2026-05-01T10:00:00Z',
      session_id: 'sess-abc',
    })
    assert.equal(rec.rationale, null)
    assert.deepEqual(rec.rejected, [])
    assert.deepEqual(rec.files_affected, [])
    assert.equal(rec.lifecycle.invalidated_at, null)
    assert.equal(rec.lifecycle.reviewed_at, null)
    assert.equal(rec.lifecycle.supersedes_id, null)
    assert.equal(rec.provenance.source_turn_sequence, null)
    assert.equal(rec.provenance.source_excerpt, null)
    assert.equal(rec.quality.historical_relevance, null)
    assert.equal(rec.quality.injected_count, 0)
    assert.equal(rec.quality.used_count, 0)
  })

  it('strips extra fields from rejected entries', () => {
    const rec = toInterchangeRecord({
      ...full,
      rejected: [{ option: 'npm', reason: 'drift', extra: 'noise' } as never],
    })
    assert.deepEqual(rec.rejected, [{ option: 'npm', reason: 'drift' }])
  })
})

describe('toInterchangeJsonl', () => {
  it('writes one JSON object per line with a trailing newline', () => {
    const jsonl = toInterchangeJsonl([full, { ...full, id: 'dec-2' }])
    assert.ok(jsonl.endsWith('\n'))
    const lines = jsonl.trimEnd().split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) {
      const parsed = JSON.parse(line) as { format: string }
      assert.equal(parsed.format, 'robrain-memory/v1')
    }
    assert.equal((JSON.parse(lines[1]!) as { id: string }).id, 'dec-2')
  })

  it('returns an empty string for an empty corpus', () => {
    assert.equal(toInterchangeJsonl([]), '')
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatSearchRow, type SearchRow } from './search.js'

const base: SearchRow = {
  id:           'a1b2c3d4e5f6',
  decision:     'Use pgvector in Postgres for embeddings',
  rationale:    'Postgres already in use',
  rejected:     [{ option: 'Pinecone', reason: 'per-namespace pricing' }],
  kind:         'decision',
  author_email: 'ade@roryplans.ai',
  created_at:   '2026-10-29T10:00:00.000Z',
  reviewed_at:  '2026-10-29T11:00:00.000Z',
}

describe('formatSearchRow', () => {
  it('prints the decision, reasons, rejections and who decided', () => {
    assert.deepEqual(formatSearchRow(base, 0), [
      '[1] a1b2c3d4  Use pgvector in Postgres for embeddings  [approved]',
      '     because:  Postgres already in use',
      '     rejected: Pinecone (per-namespace pricing)',
      '     by:       ade@roryplans.ai · 2026-10-29',
    ])
  })

  it('shows only the date when the row has no author (saved before migration 010)', () => {
    const lines = formatSearchRow({ ...base, author_email: null, reviewed_at: null, rejected: [], rationale: null }, 2)
    assert.deepEqual(lines, [
      '[3] a1b2c3d4  Use pgvector in Postgres for embeddings',
      '     by:       2026-10-29',
    ])
  })

  it('labels other kinds, hand-written rules and pushed decisions', () => {
    const lines = formatSearchRow({ ...base, kind: 'run', subject: 'nightly sync', source: 'manual', reviewed_at: null }, 0)
    assert.equal(lines[0], '[1] a1b2c3d4  Use pgvector in Postgres for embeddings  [run: nightly sync, written by hand]')
  })

  it('lists the agents a decision was pushed to, or says it was not pushed (cloud)', () => {
    const pushed = formatSearchRow({ ...base, pushed_to: [{ project_id: 'p1', project_name: 'rory-agent' }, { project_id: 'p2' }] }, 0)
    assert.equal(pushed.at(-1), '     pushed:   rory-agent, p2')
    const none = formatSearchRow({ ...base, pushed_to: [] }, 0)
    assert.equal(none.at(-1), '     pushed:   not pushed to any agent')
    const oss = formatSearchRow(base, 0)
    assert.equal(oss.some(l => l.includes('pushed:')), false)
  })
})

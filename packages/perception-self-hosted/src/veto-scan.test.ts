import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { filterVetoMatches } from './veto-scan.js'
import type { VetoScanRow } from './veto-scan.js'

const row = (over: Partial<VetoScanRow> = {}): VetoScanRow => ({
  id:          'd-1',
  decision:    'Use pgvector for embeddings',
  rejected:    [{ option: 'Pinecone', reason: 'per-namespace pricing' }],
  reviewed_at: null,
  ...over,
})

describe('filterVetoMatches', () => {
  it('keeps only rows whose rejected option appears with word boundaries', () => {
    const rows = [
      row(),
      row({ id: 'd-2', decision: 'Naming scheme', rejected: [{ option: 'Pineconeish', reason: 'x' }] }),
    ]
    const out = filterVetoMatches("let's just use Pinecone", rows)
    assert.equal(out.length, 1)
    assert.equal(out[0]!.id, 'd-1')
  })

  it('returns only the matched rejected entries, not the full list', () => {
    const rows = [row({
      rejected: [
        { option: 'Pinecone', reason: 'pricing' },
        { option: 'Weaviate', reason: 'ops burden' },
      ],
    })]
    const out = filterVetoMatches('use pinecone now', rows)
    assert.deepEqual(out[0]!.rejected, [{ option: 'Pinecone', reason: 'pricing' }])
  })

  it('maps reviewed_at to a boolean reviewed flag', () => {
    const out = filterVetoMatches('pinecone', [
      row(),
      row({ id: 'd-2', reviewed_at: new Date('2026-01-01') }),
    ])
    assert.deepEqual(out.map(m => m.reviewed), [false, true])
  })

  it('drops ILIKE false positives (substring hit, no word boundary)', () => {
    // SQL ILIKE '%pinecone%' would have surfaced this row — JS must reject it.
    assert.deepEqual(filterVetoMatches('the pineconeish experiment', [row()]), [])
  })

  it('handles rows with empty or malformed rejected arrays', () => {
    assert.deepEqual(filterVetoMatches('pinecone', [row({ rejected: [] })]), [])
    assert.deepEqual(
      filterVetoMatches('pinecone', [row({ rejected: null as unknown as VetoScanRow['rejected'] })]),
      [],
    )
  })

  it('skips sub-3-char options even when SQL let them through', () => {
    assert.deepEqual(
      filterVetoMatches('use Go here', [row({ rejected: [{ option: 'Go', reason: 'x' }] })]),
      [],
    )
  })
})

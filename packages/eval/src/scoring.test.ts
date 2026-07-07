import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SCORING_WEIGHTS, THRESHOLDS } from '@robrain/shared'
import { compositeScore, fileOverlapScore, recencyScore } from './scoring.js'
import { EMBEDDING_DIM, cosine, hashEmbedder } from './embedder.js'

describe('scoring weights', () => {
  // Pins the shared constants Perception inlines into its SQL scoreExpr
  // (packages/perception-self-hosted/src/index.ts, GET /decisions). If the
  // product changes the weights, this eval must be re-baselined on purpose.
  it('matches the documented 5-signal composite weights', () => {
    assert.equal(SCORING_WEIGHTS.SEMANTIC_SIMILARITY, 0.32)
    assert.equal(SCORING_WEIGHTS.FILE_OVERLAP, 0.27)
    assert.equal(SCORING_WEIGHTS.RECENCY, 0.18)
    assert.equal(SCORING_WEIGHTS.HISTORICAL_RELEVANCE, 0.13)
    assert.equal(SCORING_WEIGHTS.APPROVAL_STATE, 0.10)
  })

  it('sums to 1.0', () => {
    const sum = Object.values(SCORING_WEIGHTS).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1.0) < 1e-9)
  })
})

describe('recencyScore', () => {
  it('is 1.0 at zero age and halves every RECENCY_HALF_LIFE_DAYS', () => {
    const asOf = '2026-07-01T00:00:00Z'
    assert.equal(recencyScore(asOf, asOf), 1)
    const halfLifeAgo = new Date(+new Date(asOf) - THRESHOLDS.RECENCY_HALF_LIFE_DAYS * 86_400_000).toISOString()
    assert.ok(Math.abs(recencyScore(halfLifeAgo, asOf) - 0.5) < 1e-9)
  })

  it('clamps age at 3650 days like the SQL LEAST()', () => {
    const asOf = '2026-07-01T00:00:00Z'
    assert.equal(recencyScore('1990-01-01T00:00:00Z', asOf), recencyScore('2000-01-01T00:00:00Z', asOf))
  })
})

describe('fileOverlapScore', () => {
  it('is the overlap share of the query files, capped at 1', () => {
    assert.equal(fileOverlapScore(['a.ts', 'b.ts'], ['a.ts', 'b.ts']), 1)
    assert.equal(fileOverlapScore(['a.ts'], ['a.ts', 'b.ts']), 0.5)
    assert.equal(fileOverlapScore(['a.ts'], ['c.ts']), 0)
  })

  it('is 0 when no files are in scope (matches the boost-less SQL branch)', () => {
    assert.equal(fileOverlapScore(['a.ts'], []), 0)
  })
})

describe('compositeScore', () => {
  const asOf = '2026-07-01T00:00:00Z'
  const base = {
    id:                   'd1',
    files_affected:       ['a.ts'],
    created_at:           asOf,        // recency = 1
    reviewed_at:          asOf,        // approval = 1
    historical_relevance: 1,
  }

  it('reproduces the SQL expression weight-for-weight', () => {
    // similarity 1, overlap 1, recency 1, relevance 1, approved → all signals max out
    assert.ok(Math.abs(compositeScore(base, 1, ['a.ts'], asOf) - 1.0) < 1e-9)
  })

  it('drops exactly the approval weight for unreviewed decisions', () => {
    const unreviewed = { ...base, reviewed_at: null }
    const diff = compositeScore(base, 1, ['a.ts'], asOf) - compositeScore(unreviewed, 1, ['a.ts'], asOf)
    assert.ok(Math.abs(diff - SCORING_WEIGHTS.APPROVAL_STATE) < 1e-9)
  })

  it('scales the semantic signal by its weight', () => {
    const diff = compositeScore(base, 1, ['a.ts'], asOf) - compositeScore(base, 0.5, ['a.ts'], asOf)
    assert.ok(Math.abs(diff - SCORING_WEIGHTS.SEMANTIC_SIMILARITY * 0.5) < 1e-9)
  })
})

describe('hashEmbedder', () => {
  it('is deterministic and unit-normalized', () => {
    const a = hashEmbedder('use postgres with pgvector for embeddings')
    const b = hashEmbedder('use postgres with pgvector for embeddings')
    assert.deepEqual(a, b)
    assert.equal(a.length, EMBEDDING_DIM)
    const norm = Math.hypot(...a)
    assert.ok(Math.abs(norm - 1) < 1e-9)
  })

  it('scores same-topic text above unrelated text', () => {
    const query     = hashEmbedder('vector search over embedding columns in postgres')
    const onTopic   = hashEmbedder('use postgres with pgvector for embedding storage and vector search')
    const offTopic  = hashEmbedder('style components with tailwind utility classes')
    assert.ok(cosine(query, onTopic) > cosine(query, offTopic))
  })
})

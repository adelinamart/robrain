import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRelevanceDelta,
  demotionDelta,
  judgeUsed,
  outcomeDelta,
  termMatchScore,
  scoreCounterIncrements,
  usageDelta,
} from './scoring.js'

describe('judgeUsed (semantic + term-match blend)', () => {
  it('used when cosine clears 0.55 even with no term overlap', () => {
    assert.equal(judgeUsed(0.55, 0), true)
    assert.equal(judgeUsed(0.9, 0), true)
  })

  it('used when term match clears 0.30 even with low cosine', () => {
    assert.equal(judgeUsed(0.1, 0.3), true)
    assert.equal(judgeUsed(null, 0.5), true)
  })

  it('not used when both signals are below threshold', () => {
    assert.equal(judgeUsed(0.54, 0.29), false)
    assert.equal(judgeUsed(null, 0), false)
  })
})

describe('termMatchScore', () => {
  it('is the share of decision key terms present in the reply', () => {
    assert.equal(termMatchScore('adopt pgvector embeddings', 'we adopt pgvector here'), 2 / 3)
    assert.equal(termMatchScore('adopt pgvector embeddings', 'unrelated text'), 0)
  })

  it('returns 0 when the decision has no key terms', () => {
    assert.equal(termMatchScore('a to of', 'anything'), 0)
  })
})

describe('usageDelta', () => {
  it('keeps the existing +0.05 / -0.02 / +0.03 deltas', () => {
    assert.equal(usageDelta(true, true), 0.05)
    assert.equal(usageDelta(true, false), -0.02)
    assert.equal(usageDelta(false, false), 0.03)
  })
})

describe('scoreCounterIncrements', () => {
  it('always increments injected; used only when judged and used', () => {
    assert.deepEqual(scoreCounterIncrements(false, false), { injected: 1, used: 0 })
    assert.deepEqual(scoreCounterIncrements(true, false),  { injected: 1, used: 0 })
    assert.deepEqual(scoreCounterIncrements(true, true),   { injected: 1, used: 1 })
  })
})

describe('demotionDelta (auto-demotion)', () => {
  it('applies -0.05 once injected ≥ 5 and use ratio < 0.2', () => {
    assert.equal(demotionDelta(5, 0), -0.05)
    assert.equal(demotionDelta(10, 1), -0.05)
  })

  it('does not apply below 5 injections or at/above the 0.2 ratio', () => {
    assert.equal(demotionDelta(4, 0), 0)
    assert.equal(demotionDelta(5, 1), 0)   // ratio exactly 0.2
    assert.equal(demotionDelta(10, 2), 0)
  })
})

describe('outcomeDelta + clamping', () => {
  it('maps revert/incident/confirmed to -0.15/-0.10/+0.10', () => {
    assert.equal(outcomeDelta('revert'), -0.15)
    assert.equal(outcomeDelta('incident'), -0.10)
    assert.equal(outcomeDelta('confirmed'), 0.10)
  })

  it('applyRelevanceDelta clamps to [0, 1]', () => {
    assert.equal(applyRelevanceDelta(0.05, outcomeDelta('revert')), 0)
    assert.equal(applyRelevanceDelta(0.97, outcomeDelta('confirmed')), 1)
    assert.equal(applyRelevanceDelta(0.5, outcomeDelta('incident')), 0.4)
  })

  it('scored-turn deltas compose: not-used then demotion', () => {
    const afterNotUsed = applyRelevanceDelta(0.5, usageDelta(true, false))
    assert.equal(afterNotUsed, 0.48)
    assert.equal(applyRelevanceDelta(afterNotUsed, demotionDelta(5, 0)), 0.43)
  })
})

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseExtractedDecision, stripMarkdownJsonFence } from './extract-decision.js'

describe('stripMarkdownJsonFence', () => {
  it('unwraps ```json fences', () => {
    const fenced = '```json\n{"decision": "Use pnpm"}\n```'
    assert.equal(stripMarkdownJsonFence(fenced), '{"decision": "Use pnpm"}')
  })

  it('returns plain text untouched', () => {
    assert.equal(stripMarkdownJsonFence('{"a":1}'), '{"a":1}')
  })
})

describe('parseExtractedDecision', () => {
  it('parses a well-formed extraction', () => {
    const parsed = parseExtractedDecision(JSON.stringify({
      decision:   'Standardize on pnpm for the repo',
      rationale:  'Faster installs',
      rejected:   [{ option: 'npm', reason: 'slower' }],
      confidence: 0.9,
    }))
    assert.equal(parsed.decision, 'Standardize on pnpm for the repo')
    assert.equal(parsed.rationale, 'Faster installs')
    assert.deepEqual(parsed.rejected, [{ option: 'npm', reason: 'slower' }])
    assert.equal(parsed.confidence, 0.9)
  })

  it('sanitizes hallucinated field types instead of passing them through', () => {
    const parsed = parseExtractedDecision(JSON.stringify({
      decision:   42,
      rationale:  ['not', 'a', 'string'],
      rejected:   'npm',
      confidence: 'high',
    }))
    assert.equal(parsed.decision, null)
    assert.equal(parsed.rationale, null)
    assert.deepEqual(parsed.rejected, [])
    assert.equal(parsed.confidence, 0)
  })

  it('drops malformed rejected entries but keeps valid ones', () => {
    const parsed = parseExtractedDecision(JSON.stringify({
      decision:   'Use Bun as the test runner',
      rationale:  null,
      rejected:   [{ option: 'vitest', reason: 'slower startup' }, { option: 7 }, null, 'jest'],
      confidence: 0.8,
    }))
    assert.deepEqual(parsed.rejected, [{ option: 'vitest', reason: 'slower startup' }])
  })

  it('parses fenced model output end-to-end', () => {
    const parsed = parseExtractedDecision(
      '```json\n{"decision": null, "rationale": null, "rejected": [], "confidence": 0}\n```',
    )
    assert.equal(parsed.decision, null)
    assert.equal(parsed.confidence, 0)
  })

  it('throws on non-JSON text so callers can record the failure', () => {
    assert.throws(() => parseExtractedDecision('The user decided to use pnpm.'), SyntaxError)
  })
})

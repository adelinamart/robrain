import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { proposalMatchesRejectedOption } from './veto-match.js'

describe('proposalMatchesRejectedOption', () => {
  const rejected = [{ option: 'Pinecone', reason: 'per-namespace pricing' }]

  it('matches a rejected option by word boundary, case-insensitive', () => {
    assert.deepEqual(
      proposalMatchesRejectedOption('Adopt pinecone as the vector store', rejected),
      rejected[0],
    )
  })

  it('does not match substrings of larger words', () => {
    assert.equal(proposalMatchesRejectedOption('Use pineconeish naming', rejected), null)
    assert.equal(proposalMatchesRejectedOption('the spinecone experiment', rejected), null)
  })

  it('skips options shorter than 3 chars and handles regex metachars', () => {
    assert.equal(proposalMatchesRejectedOption('use Go', [{ option: 'Go', reason: 'x' }]), null)
    assert.deepEqual(
      proposalMatchesRejectedOption('try C++ here', [{ option: 'C++', reason: 'ub' }]),
      { option: 'C++', reason: 'ub' },
    )
  })

  it('returns null for empty or missing rejected lists', () => {
    assert.equal(proposalMatchesRejectedOption('anything', []), null)
    assert.equal(proposalMatchesRejectedOption('anything', null), null)
    assert.equal(proposalMatchesRejectedOption('anything', undefined), null)
  })

  it('matches multi-word options and trims whitespace in the option', () => {
    const rej = [{ option: '  REST polling  ', reason: 'latency' }]
    assert.deepEqual(proposalMatchesRejectedOption('switch to rest polling now', rej), rej[0])
    assert.equal(proposalMatchesRejectedOption('restful polling', rej), null)
  })

  it('applies word boundaries only at word-char edges (dots, hyphens, scopes)', () => {
    const gpt = [{ option: 'GPT-4o-mini', reason: 'hallucinates fields' }]
    assert.deepEqual(proposalMatchesRejectedOption('fall back to gpt-4o-mini?', gpt), gpt[0])
    assert.equal(proposalMatchesRejectedOption('the gpt-4o-minix fork', gpt), null)

    const scoped = [{ option: '@tanstack/query', reason: 'bundle size' }]
    assert.deepEqual(proposalMatchesRejectedOption('add @tanstack/query for caching', scoped), scoped[0])

    const node = [{ option: 'Node.js', reason: 'x' }]
    assert.deepEqual(proposalMatchesRejectedOption('rewrite it in node.js today', node), node[0])
  })

  it('matches at the start and end of the text', () => {
    assert.deepEqual(proposalMatchesRejectedOption('Pinecone it is', rejected), rejected[0])
    assert.deepEqual(proposalMatchesRejectedOption("let's just use Pinecone", rejected), rejected[0])
  })

  it('returns the first matching entry when several options appear', () => {
    const rej = [
      { option: 'SQLite', reason: 'no vectors' },
      { option: 'Pinecone', reason: 'pricing' },
    ]
    assert.deepEqual(
      proposalMatchesRejectedOption('use sqlite or pinecone', rej),
      rej[0],
    )
  })
})

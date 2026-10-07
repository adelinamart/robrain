import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  conflictNotice,
  decideSaveDisposition,
  decisionTextKey,
  dedupAfterNeighborCheck,
  findMatchingTurnCapture,
  MAX_TURN_CLOCK_LEAD_MS,
  neighborCheckStartup,
  parseNeighborVerdict,
  planDecisionSave,
  sameTurnCapture,
  sameTurnExcerpt,
  similarityBelowEveryFloor,
  statedAfter,
  statedTurnTime,
  textNearIdentical,
  TURN_CAPTURE_EXCERPT_CHARS,
  turnSourceExcerpt,
  turnSourceHash,
  type NeighborVerdict,
  type SaveNeighbor,
  type StatedAt,
} from './write-conflict.js'

describe('textNearIdentical', () => {
  it('treats a trailing period and extra whitespace as the same sentence', () => {
    assert.equal(
      textNearIdentical('Use pnpm  for the workspace.', ' Use pnpm for the workspace'),
      true,
    )
  })

  it('keeps comparison operators apart', () => {
    assert.equal(
      textNearIdentical('Only allow dependency versions >= 20', 'Only allow dependency versions <= 20'),
      false,
    )
    assert.equal(textNearIdentical('Require status == 200', 'Require status != 200'), false)
  })

  it('keeps a case change apart, since identifiers are case-sensitive', () => {
    assert.equal(textNearIdentical('Import from ./Config', 'Import from ./config'), false)
    assert.equal(textNearIdentical('Use pnpm for the workspace', 'use pnpm for the workspace'), false)
  })

  it('treats never-bubble-sort and always-bubble-sort as different sentences', () => {
    assert.equal(
      textNearIdentical('Never use bubble sort.', 'Always use bubble sort.'),
      false,
    )
  })

  it('never drops a long reversal that only adds a polarity word', () => {
    const baseDecision =
      'Use Postgres for session storage in production because it persists across restarts and supports transactional guarantees for checkout flows'
    const reversedDecision =
      'Never use Postgres for session storage in production because it persists across restarts and supports transactional guarantees for checkout flows'
    assert.equal(textNearIdentical(baseDecision, reversedDecision), false)
  })

  it('never drops a long sentence with a single entity swap', () => {
    const postgresDecision =
      'Use Postgres for session storage in production because it persists across restarts and supports transactional guarantees for checkout flows'
    const redisDecision =
      'Use Redis for session storage in production because it persists across restarts and supports transactional guarantees for checkout flows'
    assert.equal(textNearIdentical(postgresDecision, redisDecision), false)
  })

  it('still drops a long exact re-statement', () => {
    const baseDecision =
      'Use Postgres for session storage in production because it persists across restarts and supports transactional guarantees for checkout flows'
    assert.equal(textNearIdentical(baseDecision, `${baseDecision}.`), true)
  })

  it('never drops an order-only reversal with identical words', () => {
    assert.equal(
      textNearIdentical('Prefer PostgreSQL over Redis', 'Prefer Redis over PostgreSQL'),
      false,
    )
  })

  it('never drops a one-word swap in a 24-word decision', () => {
    const postgresDecision = [
      'Use Postgres for session storage in production because it persists',
      'across restarts and supports transactional guarantees for checkout',
      'flows inside this service layer today',
    ].join(' ')
    const mysqlDecision = postgresDecision.replace('Postgres', 'MySQL')
    assert.equal(postgresDecision.split(' ').length, 24)
    assert.equal(textNearIdentical(postgresDecision, mysqlDecision), false)
  })

  it('matches exactly when the stored text keys are equal and not empty', () => {
    const composed = 'Use the caf\u00e9 schema'
    const decomposed = 'Use  the cafe\u0301 schema.'
    assert.equal(decisionTextKey(composed), decisionTextKey(decomposed))
    assert.equal(textNearIdentical(composed, decomposed), true)
    assert.notEqual(decisionTextKey('Use pnpm'), decisionTextKey('use pnpm'))
    assert.equal(decisionTextKey('  . '), '')
    assert.equal(textNearIdentical('  . ', ' .'), false)
  })

  it('never drops a long sentence that only gains one word', () => {
    const baseDecision = [
      'Use Postgres for session storage in production because it persists',
      'across restarts and supports transactional guarantees for checkout flows',
    ].join(' ')
    assert.equal(textNearIdentical(baseDecision, `${baseDecision} today`), false)
  })
})

describe('parseNeighborVerdict', () => {
  it('maps contradicts to contradiction', () => {
    assert.equal(parseNeighborVerdict('contradicts'), 'contradiction')
    assert.equal(parseNeighborVerdict(' Contradicts.\n'), 'contradiction')
  })

  it('maps only an explicit same to restatement', () => {
    assert.equal(parseNeighborVerdict('same'), 'restatement')
    assert.equal(parseNeighborVerdict('Same.'), 'restatement')
  })

  it('maps an answer followed by commentary to unknown so the save is kept', () => {
    assert.equal(parseNeighborVerdict('same? No, B reverses A.'), 'unknown')
    assert.equal(parseNeighborVerdict('Same, both say pnpm'), 'unknown')
    assert.equal(parseNeighborVerdict('different, but related'), 'unknown')
    assert.equal(parseNeighborVerdict('**same**'), 'unknown')
  })

  it('maps refines and different to distinct', () => {
    assert.equal(parseNeighborVerdict('refines'), 'distinct')
    assert.equal(parseNeighborVerdict('Different.'), 'distinct')
  })

  it('maps empty, malformed, or Synthesis-style replies to unknown so the save is kept', () => {
    assert.equal(parseNeighborVerdict(''), 'unknown')
    assert.equal(parseNeighborVerdict('   '), 'unknown')
    assert.equal(parseNeighborVerdict('maybe'), 'unknown')
    assert.equal(parseNeighborVerdict('extends'), 'unknown')
    assert.equal(parseNeighborVerdict('yes'), 'unknown')
    assert.equal(parseNeighborVerdict('no'), 'unknown')
  })
})

describe('conflictNotice', () => {
  it('names both decisions in the order they were stated and says both were saved', () => {
    assert.equal(
      conflictNotice(' Use the built-in sort. ', 'Use bubble sort for small arrays.'),
      'The newer decision ("Use bubble sort for small arrays.") conflicts with one stated earlier ("Use the built-in sort."). Both are saved and flagged for robrain review.',
    )
  })
})

describe('statedAfter', () => {
  const sessionStart = '2026-09-29T09:00:00.000000Z'

  function statedAt(overrides: Partial<StatedAt>): StatedAt {
    return {
      id:            'row-a',
      sessionId:     'session-a',
      turnSequence:  1,
      turnAt:        sessionStart,
      createdAt:     sessionStart,
      ...overrides,
    }
  }

  it('orders one session by turn sequence even when the earlier turn committed last', () => {
    const turnOne = statedAt({ turnSequence: 1, createdAt: '2026-09-29T09:00:09.000000Z' })
    const turnTwo = statedAt({ turnSequence: 2, createdAt: '2026-09-29T09:00:05.000000Z' })
    assert.equal(statedAfter(turnTwo, turnOne), true)
    assert.equal(statedAfter(turnOne, turnTwo), false)
  })

  it('orders two sessions by turn timestamp, not insert time', () => {
    const earlierSession = statedAt({
      sessionId: 'session-a',
      turnAt:    '2026-09-29T09:00:00.000000Z',
      createdAt: '2026-09-29T09:10:00.000000Z',
    })
    const laterSession = statedAt({
      sessionId: 'session-b',
      turnAt:    '2026-09-29T09:05:00.000000Z',
      createdAt: '2026-09-29T09:06:00.000000Z',
    })
    assert.equal(statedAfter(laterSession, earlierSession), true)
    assert.equal(statedAfter(earlierSession, laterSession), false)
  })

  it('falls back to insert time for a row saved before turn timestamps were stored', () => {
    const legacyRow = statedAt({ sessionId: 'session-a', turnAt: null, createdAt: '2026-09-28T12:00:00.000000Z' })
    const newRow = statedAt({ sessionId: 'session-b', turnAt: '2026-09-29T09:00:00.000000Z' })
    assert.equal(statedAfter(newRow, legacyRow), true)
  })

  it('breaks an equal timestamp and insert time by row id, matching the summary', () => {
    const lowerId = statedAt({ sessionId: 'session-a', id: '11111111-0000-4000-8000-000000000001', turnAt: sessionStart, createdAt: sessionStart })
    const higherId = statedAt({ sessionId: 'session-b', id: 'ffffffff-0000-4000-8000-000000000002', turnAt: sessionStart, createdAt: sessionStart })
    assert.equal(statedAfter(higherId, lowerId), true)
    assert.equal(statedAfter(lowerId, higherId), false)
  })

  it('lets a later insert time beat a higher row id when the turn timestamps match', () => {
    const earlierInsert = statedAt({
      sessionId: 'session-a',
      id:         'ffffffff-0000-4000-8000-000000000002',
      turnAt:     sessionStart,
      createdAt:  '2026-09-29T09:00:01.000000Z',
    })
    const laterInsert = statedAt({
      sessionId: 'session-b',
      id:         '11111111-0000-4000-8000-000000000001',
      turnAt:     sessionStart,
      createdAt:  '2026-09-29T09:00:02.000000Z',
    })
    assert.equal(statedAfter(laterInsert, earlierInsert), true)
    assert.equal(statedAfter(earlierInsert, laterInsert), false)
  })

  it('orders a same-millisecond insert by microseconds, ahead of row id', () => {
    const earlierMicrosecond = '2026-09-29T09:00:01.100100Z'
    const laterMicrosecond = '2026-09-29T09:00:01.100900Z'
    assert.equal(earlierMicrosecond.slice(0, 23), laterMicrosecond.slice(0, 23))
    assert.equal(new Date(earlierMicrosecond).getTime(), new Date(laterMicrosecond).getTime())
    const earlierInsert = statedAt({
      sessionId: 'session-a',
      id:         'ffffffff-0000-4000-8000-000000000002',
      turnAt:     sessionStart,
      createdAt:  earlierMicrosecond,
    })
    const laterInsert = statedAt({
      sessionId: 'session-b',
      id:         '11111111-0000-4000-8000-000000000001',
      turnAt:     sessionStart,
      createdAt:  laterMicrosecond,
    })
    assert.equal(statedAfter(laterInsert, earlierInsert), true)
    assert.equal(statedAfter(earlierInsert, laterInsert), false)
  })
})

describe('statedTurnTime', () => {
  const receivedAt = new Date('2026-09-29T09:00:00.000Z')

  it('keeps an ISO timestamp from the past, as flush-on-close sends', () => {
    assert.deepEqual(statedTurnTime('2026-09-29T07:30:00.000Z', receivedAt), new Date('2026-09-29T07:30:00.000Z'))
    assert.deepEqual(statedTurnTime('2026-09-29T10:30:00+02:00', receivedAt), new Date('2026-09-29T08:30:00.000Z'))
  })

  it('replaces a timestamp that is not ISO 8601 with a zone', () => {
    assert.deepEqual(statedTurnTime('', receivedAt), receivedAt)
    assert.deepEqual(statedTurnTime('yesterday', receivedAt), receivedAt)
    assert.deepEqual(statedTurnTime('2026-09-29', receivedAt), receivedAt)
    assert.deepEqual(statedTurnTime('2026-09-29T08:00:00', receivedAt), receivedAt)
    assert.deepEqual(statedTurnTime('2026-13-45T99:00:00Z', receivedAt), receivedAt)
  })

  it('replaces a timestamp too far in the future, which would outrank every later rule', () => {
    const farAhead = new Date(receivedAt.getTime() + MAX_TURN_CLOCK_LEAD_MS + 1_000).toISOString()
    assert.deepEqual(statedTurnTime(farAhead, receivedAt), receivedAt)
    const slightlyAhead = new Date(receivedAt.getTime() + 30_000)
    assert.deepEqual(statedTurnTime(slightlyAhead.toISOString(), receivedAt), slightlyAhead)
  })
})

describe('decideSaveDisposition', () => {
  it('stores a decision that is not close to the neighbor', () => {
    assert.equal(decideSaveDisposition({
      similarity: 0.7,
      sameSession: false,
      nearIdentical: false,
    }), 'write')
  })

  it('drops a close re-statement as a duplicate', () => {
    assert.equal(decideSaveDisposition({
      similarity: 0.9,
      sameSession: false,
      nearIdentical: true,
    }), 'dedup')
  })

  it('asks the model about a close sentence that is not a repeat, including the band under the duplicate cutoff', () => {
    assert.equal(decideSaveDisposition({
      similarity: 0.83,
      sameSession: false,
      nearIdentical: false,
    }), 'ask')
    assert.equal(decideSaveDisposition({
      similarity: 0.9,
      sameSession: false,
      nearIdentical: false,
    }), 'ask')
  })

  it('asks the model about a same-session sentence above the same-session floor', () => {
    assert.equal(decideSaveDisposition({
      similarity: 0.8,
      sameSession: true,
      nearIdentical: false,
    }), 'ask')
  })

  it('still drops a same-session re-statement', () => {
    assert.equal(decideSaveDisposition({
      similarity: 0.8,
      sameSession: true,
      nearIdentical: true,
    }), 'dedup')
  })
})

describe('similarityBelowEveryFloor', () => {
  it('stops only once a later neighbor cannot clear the lowest floor', () => {
    assert.equal(similarityBelowEveryFloor(0.81), false)
    assert.equal(similarityBelowEveryFloor(0.77), true)
  })
})

describe('dedupAfterNeighborCheck', () => {
  it('drops a restatement that clears the cross-session duplicate floor', () => {
    assert.equal(dedupAfterNeighborCheck({
      similarity: 0.9,
      sameSession: false,
      verdict: 'restatement',
    }), true)
  })

  it('keeps a refinement or separate decision even above the duplicate floor', () => {
    assert.equal(dedupAfterNeighborCheck({
      similarity: 0.9,
      sameSession: false,
      verdict: 'distinct',
    }), false)
  })

  it('keeps a sentence the model called a contradiction', () => {
    assert.equal(dedupAfterNeighborCheck({
      similarity: 0.9,
      sameSession: false,
      verdict: 'contradiction',
    }), false)
  })

  it('keeps a cross-session restatement that sits under the cross-session duplicate floor', () => {
    assert.equal(dedupAfterNeighborCheck({
      similarity: 0.83,
      sameSession: false,
      verdict: 'restatement',
    }), false)
  })

  it('keeps a same-session revision even when the model calls it the same', () => {
    assert.equal(dedupAfterNeighborCheck({
      similarity: 0.9,
      sameSession: true,
      verdict: 'restatement',
    }), false)
  })
})

describe('planDecisionSave', () => {
  const incomingDecision = 'Use MySQL for every service'

  function neighbor(
    decision: string,
    similarity: number,
    sameSession = false,
    conflictPartnerIds: readonly string[] = [],
  ): SaveNeighbor {
    return { id: decision, decision, similarity, sameSession, conflictPartnerIds }
  }

  const storedMysql = 'Use MySQL for every service.'
  const storedPostgres = 'Use Postgres for every service'
  const storedRedis = 'Use Redis for caching'
  const storedSqlite = 'Use SQLite for local tests'

  function scriptedChecker(verdictsByDecision: Record<string, NeighborVerdict>) {
    const askedDecisions: string[] = []
    const checkContradiction = async (earlier: string): Promise<NeighborVerdict> => {
      askedDecisions.push(earlier)
      return verdictsByDecision[earlier] ?? 'unknown'
    }
    return { askedDecisions, checkContradiction }
  }

  it('asks every close neighbor and saves the rule when every check fails', async () => {
    const neighbors = [
      neighbor('Use Postgres for sessions', 0.92),
      neighbor('Use Redis for caching', 0.9),
      neighbor('Use SQLite for local tests', 0.87),
    ]
    const { askedDecisions, checkContradiction } = scriptedChecker({})
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'write' })
    assert.equal(askedDecisions.length, 3)
  })

  it('never dedups a restatement while another close neighbor has no answer', async () => {
    const neighbors = [
      neighbor('We use MySQL for all services', 0.92),
      neighbor('MySQL for each of our services', 0.9),
      neighbor('Use SQLite for local tests', 0.87),
    ]
    const { checkContradiction } = scriptedChecker({
      'We use MySQL for all services': 'restatement',
      'MySQL for each of our services': 'restatement',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('flags the closest clash even when a later neighbor is a restatement', async () => {
    const neighbors = [
      neighbor('Use Postgres for sessions', 0.92),
      neighbor('Use Redis for caching', 0.9),
    ]
    const { checkContradiction } = scriptedChecker({
      'Use Postgres for sessions': 'contradiction',
      'Use Redis for caching': 'restatement',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: ['Use Postgres for sessions'] })
  })

  it('drops a cross-session neighbor the model calls the same decision', async () => {
    const neighbors = [neighbor('Use Postgres for sessions', 0.9)]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'restatement')
    assert.deepEqual(plan, { kind: 'dedup', neighbor: neighbors[0] })
  })

  it('saves a cross-session refinement above the duplicate floor', async () => {
    const neighbors = [neighbor('Use MySQL for services', 0.9)]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'distinct')
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('saves a cross-session neighbor when the check is unknown', async () => {
    const neighbors = [neighbor('Use Postgres for sessions', 0.9)]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'unknown')
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('saves a same-session rephrase even when the model calls it the same', async () => {
    const neighbors = [neighbor('Use Postgres for sessions', 0.9, true)]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'restatement')
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('flags a return to an older rule against the newer one when the identical older row is closest', async () => {
    const neighbors = [
      neighbor('Use MySQL for every service.', 0.99),
      neighbor('Use Postgres for every service', 0.93),
    ]
    const { askedDecisions, checkContradiction } = scriptedChecker({
      'Use Postgres for every service': 'contradiction',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: ['Use Postgres for every service'] })
    assert.deepEqual(askedDecisions, ['Use Postgres for every service'])
  })

  it('flags a return to an older rule when the contradiction is closer than the identical row', async () => {
    const neighbors = [
      neighbor('Use Postgres for every service', 0.95),
      neighbor('Use MySQL for every service', 0.93),
    ]
    const { checkContradiction } = scriptedChecker({
      'Use Postgres for every service': 'contradiction',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: ['Use Postgres for every service'] })
  })

  it('flags a farther contradiction over a closer cross-session restatement', async () => {
    const neighbors = [
      neighbor('Use MySQL for all of our services', 0.96),
      neighbor('Use Postgres for every service', 0.9),
    ]
    const { checkContradiction } = scriptedChecker({
      'Use MySQL for all of our services': 'restatement',
      'Use Postgres for every service':    'contradiction',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: ['Use Postgres for every service'] })
  })

  it('links an exact old rule to its stored clash when that clash is not among the neighbors', async () => {
    const neighbors = [
      neighbor(storedMysql, 0.99, false, [storedPostgres]),
      neighbor(storedRedis, 0.95),
      neighbor(storedSqlite, 0.9),
    ]
    const { checkContradiction } = scriptedChecker({ [storedRedis]: 'distinct', [storedSqlite]: 'distinct' })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: [storedPostgres] })
  })

  it('links an exact old rule found past the closest rows, even when closer paraphrases are called the same', async () => {
    const neighbors = [
      neighbor('We use MySQL for all services', 0.96),
      neighbor('MySQL for each of our services', 0.95),
    ]
    const clashedCopies = [{ id: 'mysql-far', decision: storedMysql, conflictPartnerIds: [storedPostgres] }]
    const { checkContradiction } = scriptedChecker({
      'We use MySQL for all services': 'restatement',
      'MySQL for each of our services': 'restatement',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction, clashedCopies)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: [storedPostgres] })
  })

  it('links the stored clash even when the model calls it distinct or the same', async () => {
    for (const verdict of ['distinct', 'restatement'] as const) {
      const neighbors = [
        neighbor(storedMysql, 0.99, false, [storedPostgres]),
        neighbor(storedPostgres, 0.9, false, [storedMysql]),
      ]
      const { askedDecisions, checkContradiction } = scriptedChecker({ [storedPostgres]: verdict })
      const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
      assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: [storedPostgres] }, verdict)
      assert.deepEqual(askedDecisions, [storedPostgres])
    }
  })

  it('links every open clash partner of an exact copy, without asking about them', async () => {
    const neighbors = [neighbor(storedMysql, 0.99, false, ['postgres', 'sqlite', 'cockroach'])]
    const { askedDecisions, checkContradiction } = scriptedChecker({})
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: ['postgres', 'sqlite', 'cockroach'] })
    assert.equal(askedDecisions.length, 0)
  })

  it('links a clash partner that sits below the similarity floor', async () => {
    const neighbors = [
      neighbor(storedMysql, 0.99, false, [storedPostgres]),
      neighbor(storedPostgres, 0.7, false, [storedMysql]),
    ]
    const { askedDecisions, checkContradiction } = scriptedChecker({})
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: [storedPostgres] })
    assert.equal(askedDecisions.length, 0)
  })

  it('links the clash of a paraphrase the model calls the same, in either session', async () => {
    for (const sameSession of [false, true]) {
      const neighbors = [neighbor('We use MySQL for all services', 0.96, sameSession, [storedPostgres])]
      const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'restatement')
      assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: [storedPostgres] })
    }
  })

  it('links every contradicting neighbor, closest first, then inherited partners', async () => {
    const neighbors = [
      neighbor(storedMysql, 0.99, false, ['cockroach']),
      neighbor(storedPostgres, 0.93),
      neighbor('Use SQLite for every service', 0.9),
    ]
    const { checkContradiction } = scriptedChecker({
      [storedPostgres]: 'contradiction',
      'Use SQLite for every service': 'contradiction',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, {
      kind: 'conflict',
      conflictWithIds: [storedPostgres, 'Use SQLite for every service', 'cockroach'],
    })
  })

  it('never links the new row to a copy of itself', async () => {
    const neighbors = [neighbor(storedMysql, 0.99, false, ['mysql-copy'])]
    const clashedCopies = [{ id: 'mysql-copy', decision: 'Use MySQL for every service', conflictPartnerIds: [storedMysql] }]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'unknown', clashedCopies)
    assert.deepEqual(plan, { kind: 'dedup', neighbor: neighbors[0] })
  })

  it('ignores a clashed row whose text is not the same sentence', async () => {
    const clashedCopies = [{ id: 'postgres', decision: storedPostgres, conflictPartnerIds: ['mysql'] }]
    const plan = await planDecisionSave(incomingDecision, [], async () => 'unknown', clashedCopies)
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('dedups an exact old rule whose clash was resolved', async () => {
    const neighbors = [neighbor(storedMysql, 0.99, false, [])]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'unknown')
    assert.deepEqual(plan, { kind: 'dedup', neighbor: neighbors[0] })
  })

  it('saves an exact copy when another close neighbor has no answer', async () => {
    const neighbors = [neighbor(storedMysql, 0.99), neighbor(storedRedis, 0.9)]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'unknown')
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('saves an exact copy when a close row was left past the scan', async () => {
    const closeRows = [
      neighbor(storedMysql, 0.99),
      ...['A', 'B', 'C', 'D'].map((suffix) => neighbor(`Use MySQL replica ${suffix}`, 0.9)),
    ]
    const { askedDecisions, checkContradiction } = scriptedChecker(Object.fromEntries(
      closeRows.slice(1).map((row) => [row.decision, 'distinct' as const]),
    ))
    const cutShort = await planDecisionSave(
      incomingDecision,
      [...closeRows, neighbor('Use MySQL replica E', 0.85)],
      checkContradiction,
    )
    assert.deepEqual(cutShort, { kind: 'write' })
    assert.equal(askedDecisions.length, 4)
    const complete = await planDecisionSave(
      incomingDecision,
      [...closeRows, neighbor('Use MySQL replica E', 0.7)],
      checkContradiction,
    )
    assert.deepEqual(complete, { kind: 'dedup', neighbor: closeRows[0] })
  })

  it('still dedups the same sentence when the other checked neighbors do not contradict it', async () => {
    const neighbors = [
      neighbor('Use MySQL for every service.', 0.99),
      neighbor('Use Postgres for sessions', 0.9),
    ]
    const { askedDecisions, checkContradiction } = scriptedChecker({
      'Use Postgres for sessions': 'distinct',
    })
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'dedup', neighbor: neighbors[0] })
    assert.deepEqual(askedDecisions, ['Use Postgres for sessions'])
  })

  it('asks the model about an operator flip instead of deduping it', async () => {
    const earlierDecision = 'Only allow dependency versions >= 20'
    const neighbors = [neighbor(earlierDecision, 0.98, true)]
    const { askedDecisions, checkContradiction } = scriptedChecker({ [earlierDecision]: 'contradiction' })
    const plan = await planDecisionSave('Only allow dependency versions <= 20', neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'conflict', conflictWithIds: [earlierDecision] })
    assert.deepEqual(askedDecisions, [earlierDecision])
  })

  it('saves a same-session case change the model calls the same', async () => {
    const neighbors = [neighbor('use mysql for every service', 0.97, true)]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => 'restatement')
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('saves a cross-session revision when the reply is an answer followed by commentary', async () => {
    const neighbors = [neighbor('Use Postgres for every service', 0.9)]
    const plan = await planDecisionSave(
      incomingDecision,
      neighbors,
      async () => parseNeighborVerdict('same? No, B reverses A.'),
    )
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('saves the rule when the check throws', async () => {
    const neighbors = [neighbor('Use Postgres for sessions', 0.9)]
    const plan = await planDecisionSave(incomingDecision, neighbors, async () => {
      throw new Error('provider down')
    })
    assert.deepEqual(plan, { kind: 'write' })
  })

  it('drops a near-identical restatement without asking the model', async () => {
    const neighbors = [neighbor('Use MySQL for every service.', 0.97)]
    const { askedDecisions, checkContradiction } = scriptedChecker({})
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'dedup', neighbor: neighbors[0] })
    assert.equal(askedDecisions.length, 0)
  })

  it('asks the model before keeping a one-word change in a long decision', async () => {
    const earlierDecision = [
      'Use Postgres for session storage in production because it persists',
      'across restarts and supports transactional guarantees for checkout',
      'flows inside this service layer today',
    ].join(' ')
    const revisedDecision = earlierDecision.replace('Postgres', 'MySQL')
    const neighbors = [neighbor(earlierDecision, 0.97)]
    const { askedDecisions, checkContradiction } = scriptedChecker({})
    const plan = await planDecisionSave(revisedDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'write' })
    assert.deepEqual(askedDecisions, [earlierDecision])
  })

  it('asks nothing when every neighbor is below the floors', async () => {
    const neighbors = [neighbor('Use Postgres for sessions', 0.8), neighbor('Use Redis for caching', 0.7)]
    const { askedDecisions, checkContradiction } = scriptedChecker({})
    const plan = await planDecisionSave(incomingDecision, neighbors, checkContradiction)
    assert.deepEqual(plan, { kind: 'write' })
    assert.equal(askedDecisions.length, 0)
  })
})

describe('turn capture', () => {
  const storedExcerpt = 'Always use bubble sort in this repo.'

  it('builds the stored excerpt from the user message when Sensing sent none', () => {
    assert.equal(
      turnSourceExcerpt(undefined, 'From now on, name test files *.spec.ts'),
      'From now on, name test files *.spec.ts',
    )
  })

  it('prefers the excerpt Sensing sent', () => {
    assert.equal(
      turnSourceExcerpt('please only ever use pnpm here', 'a longer user message'),
      'please only ever use pnpm here',
    )
  })

  it('keeps only the stored prefix and treats an empty turn as no excerpt', () => {
    const userMessage = `${'a'.repeat(TURN_CAPTURE_EXCERPT_CHARS)} differs after the cut`
    const excerpt = turnSourceExcerpt(undefined, userMessage)
    assert.equal(excerpt?.length, TURN_CAPTURE_EXCERPT_CHARS)
    assert.equal(turnSourceExcerpt(undefined, ''), null)
    assert.equal(turnSourceExcerpt('', 'still unused when an excerpt was sent empty'), null)
  })

  it('dedups a retry whose hash matches, including a row behind an older different one', () => {
    const storedHash = turnSourceHash(storedExcerpt, 'keep it')
    const captures = [
      { id: 'older', reviewedAt: null, sourceExcerpt: 'Use MySQL', sourceTurnHash: turnSourceHash('Use MySQL', 'other') },
      { id: 'reviewed', reviewedAt: new Date(), sourceExcerpt: storedExcerpt, sourceTurnHash: storedHash },
    ]
    const matched = findMatchingTurnCapture(captures, { sourceExcerpt: storedExcerpt, sourceTurnHash: storedHash })
    assert.equal(matched?.id, 'reviewed')
    assert.equal(sameTurnExcerpt(storedExcerpt, storedExcerpt), true)
  })

  it('does not treat a reused sequence as the same turn when the text differs', () => {
    const captures = [{ id: 'older', sourceExcerpt: 'Never use bubble sort in this repo.', sourceTurnHash: null }]
    assert.equal(
      findMatchingTurnCapture(captures, { sourceExcerpt: storedExcerpt, sourceTurnHash: null }),
      undefined,
    )
    assert.equal(sameTurnExcerpt('Never use bubble sort in this repo.', storedExcerpt), false)
  })

  it('does not dedup when either excerpt is missing', () => {
    assert.equal(sameTurnExcerpt(null, storedExcerpt), false)
    assert.equal(sameTurnExcerpt(storedExcerpt, null), false)
    assert.equal(sameTurnExcerpt(null, null), false)
    assert.equal(
      findMatchingTurnCapture([], { sourceExcerpt: storedExcerpt, sourceTurnHash: null }),
      undefined,
    )
  })

  it('hashes the user message and the assistant reply, and keeps the boundary between them', () => {
    const agreed = turnSourceHash('yes', 'Use MySQL for this service.')
    assert.equal(agreed, turnSourceHash('yes', 'Use MySQL for this service.'))
    assert.notEqual(agreed, turnSourceHash('yes', 'Use Postgres for this service.'))
    assert.notEqual(turnSourceHash('ab', 'c'), turnSourceHash('a', 'bc'))
  })

  it('saves a reused sequence when the user says yes to a different reply', () => {
    const mysqlHash = turnSourceHash('yes', 'Use MySQL for this service.')
    const postgresHash = turnSourceHash('yes', 'Use Postgres for this service.')
    const captures = [{ id: 'mysql', sourceExcerpt: 'yes', sourceTurnHash: mysqlHash }]
    assert.equal(
      findMatchingTurnCapture(captures, { sourceExcerpt: 'yes', sourceTurnHash: postgresHash }),
      undefined,
    )
    assert.equal(
      findMatchingTurnCapture(captures, { sourceExcerpt: 'yes', sourceTurnHash: mysqlHash })?.id,
      'mysql',
    )
    assert.equal(
      sameTurnCapture(
        { sourceExcerpt: 'yes', sourceTurnHash: mysqlHash },
        { sourceExcerpt: 'yes', sourceTurnHash: postgresHash },
      ),
      false,
    )
  })

  it('does not treat a shared 300-character prefix as the same turn when the rest differs', () => {
    const prefix = 'a'.repeat(TURN_CAPTURE_EXCERPT_CHARS)
    const firstHash = turnSourceHash(`${prefix} mysql`, 'ok')
    const secondHash = turnSourceHash(`${prefix} postgres`, 'ok')
    assert.equal(
      findMatchingTurnCapture(
        [{ id: 'first', sourceExcerpt: prefix, sourceTurnHash: firstHash }],
        { sourceExcerpt: prefix, sourceTurnHash: secondHash },
      ),
      undefined,
    )
  })

  it('saves a later turn when the stored row has no turn hash', () => {
    const incomingHash = turnSourceHash('yes', 'Use Postgres for this service.')
    assert.equal(
      findMatchingTurnCapture(
        [{ id: 'legacy', sourceExcerpt: 'yes', sourceTurnHash: null }],
        { sourceExcerpt: 'yes', sourceTurnHash: incomingHash },
      ),
      undefined,
    )
    assert.equal(
      sameTurnCapture(
        { sourceExcerpt: 'yes', sourceTurnHash: null },
        { sourceExcerpt: 'yes', sourceTurnHash: incomingHash },
      ),
      false,
    )
    assert.equal(
      sameTurnCapture(
        { sourceExcerpt: 'yes', sourceTurnHash: turnSourceHash('yes', 'Use MySQL for this service.') },
        { sourceExcerpt: 'yes', sourceTurnHash: null },
      ),
      false,
    )
  })

  it('keeps case and does not fold punctuation, unlike the decision-sentence check', () => {
    assert.equal(sameTurnExcerpt(storedExcerpt, 'always use bubble sort in this repo.'), false)
  })
})

describe('neighborCheckStartup', () => {
  const localChatBaseUrl = 'http://127.0.0.1:11434/v1'

  it('refuses to start when the hosted Anthropic key is missing', () => {
    const startup = neighborCheckStartup({
      llmProvider: 'anthropic',
      anthropicApiKey: '   ',
      openaiApiKey: 'sk-embed-only',
      usingLocalChatServer: false,
      localChatBaseUrl,
    })
    assert.equal(startup.action, 'refuse')
    if (startup.action === 'refuse') {
      assert.match(startup.message, /ANTHROPIC_API_KEY is empty/)
      assert.match(startup.message, /close paraphrase/)
    }
  })

  it('refuses a hosted OpenAI chat with no key', () => {
    const startup = neighborCheckStartup({
      llmProvider: 'openai',
      anthropicApiKey: '',
      openaiApiKey: '',
      usingLocalChatServer: false,
      localChatBaseUrl,
    })
    assert.equal(startup.action, 'refuse')
    if (startup.action === 'refuse') assert.match(startup.message, /OPENAI_API_KEY is empty/)
  })

  it('warns when the neighbor check uses a local chat server', () => {
    const startup = neighborCheckStartup({
      llmProvider: 'openai',
      anthropicApiKey: '',
      openaiApiKey: undefined,
      usingLocalChatServer: true,
      localChatBaseUrl,
    })
    assert.equal(startup.action, 'warn')
    if (startup.action === 'warn') {
      assert.match(startup.message, /local chat server/)
      assert.match(startup.message, /same, contradicts, refines, or different/)
    }
  })

  it('stays quiet when a hosted chat key is set', () => {
    assert.deepEqual(neighborCheckStartup({
      llmProvider: 'anthropic',
      anthropicApiKey: 'sk-ant-present',
      openaiApiKey: undefined,
      usingLocalChatServer: false,
      localChatBaseUrl,
    }), { action: 'ok' })
    assert.deepEqual(neighborCheckStartup({
      llmProvider: 'openai',
      anthropicApiKey: '',
      openaiApiKey: 'sk-present',
      usingLocalChatServer: false,
      localChatBaseUrl,
    }), { action: 'ok' })
  })

  it('does not warn about a local embedding URL when chat stays on Anthropic', () => {
    assert.deepEqual(neighborCheckStartup({
      llmProvider: 'anthropic',
      anthropicApiKey: 'sk-ant-present',
      openaiApiKey: undefined,
      usingLocalChatServer: false,
      localChatBaseUrl,
    }), { action: 'ok' })
  })
})

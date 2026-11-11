import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditBeforeParam, auditNextCommand, describeAuditEvent, fetchConflictVerdict, isMissingRoute, lineageLines,
  lineageStatus, splitConflictMatches,
  type AuditEvent, type LineageNode,
} from './cloud.js'

function node(over: Partial<LineageNode>): LineageNode {
  return {
    id: 'd-1', decision: 'Use REST polling', supersedes_id: null, invalidated_at: null,
    reviewed_at: null, created_at: '2026-10-01T10:00:00.000Z', depth: 0, ...over,
  }
}

function event(over: Partial<AuditEvent>): AuditEvent {
  return {
    id: 'e-1', action: 'promoted', actor_email: 'ade@roryplans.ai', decision_id: null,
    project_id: null, target_project_id: null, detail: {}, created_at: '2026-11-03T10:00:00.000Z', ...over,
  }
}

test('isMissingRoute: a bare 404 is a route the server lacks; a named 404 is a real answer', () => {
  assert.equal(isMissingRoute(404, {}), true)
  assert.equal(isMissingRoute(404, { error: 'decision_not_found' }), false)
  assert.equal(isMissingRoute(403, {}), false)
  assert.equal(isMissingRoute(200, {}), false)
})

test('lineageStatus: retired with a successor is superseded, retired without one is invalidated', () => {
  const old = node({ id: 'd-old', invalidated_at: '2026-10-20T10:00:00.000Z', depth: 1 })
  const current = node({ id: 'd-new', supersedes_id: 'd-old' })
  const dropped = node({ id: 'd-x', invalidated_at: '2026-10-21T10:00:00.000Z' })
  assert.equal(lineageStatus(old, [old, current]), 'superseded')
  assert.equal(lineageStatus(current, [old, current]), 'active')
  assert.equal(lineageStatus(dropped, [dropped]), 'invalidated')
})

test('lineageLines: oldest first, the asked-about decision marked, other relations listed once', () => {
  const lines = lineageLines({
    decision_id: 'd-new',
    chain: [
      node({ id: 'd-new', decision: 'Use websockets', supersedes_id: 'd-old', reviewed_at: '2026-10-21T10:00:00.000Z', created_at: '2026-10-20T10:00:00.000Z', depth: 0 }),
      node({ id: 'd-old', decision: 'Use REST   polling', invalidated_at: '2026-10-20T10:00:00.000Z', depth: 1 }),
    ],
    relations: [
      { from_id: 'd-new', to_id: 'd-old', relation: 'supersedes' },
      { from_id: 'd-new', to_id: 'd-other', relation: 'contradicts' },
      { from_id: 'd-new', to_id: 'd-other', relation: 'contradicts' },
    ],
  })
  assert.deepEqual(lines, [
    '  2026-10-01  Use REST polling',
    '    superseded · d-old',
    '▸ 2026-10-20  Use websockets',
    '    active, approved · d-new',
    '  d-new contradicts d-other (outside this chain)',
  ])
})

test('describeAuditEvent: says where a rule went and what changed', () => {
  assert.equal(describeAuditEvent(event({ decision_id: 'd-1', detail: { to: 'production-agents' } })), 'pushed decision d-1 to every production agent')
  assert.equal(describeAuditEvent(event({ decision_id: 'd-1', detail: { to: 'tag:email' } })), 'pushed decision d-1 to agents tagged email')
  assert.equal(describeAuditEvent(event({ decision_id: 'd-1', target_project_id: 'agent-mailer-1', detail: { to: 'agent-mailer-1' } })), 'pushed decision d-1 to project agent-mailer-1')
  assert.equal(describeAuditEvent(event({ action: 'project_registered', project_id: 'agent-mailer-1', detail: { type: 'agent' } })), 'registered agent project agent-mailer-1')
  assert.equal(describeAuditEvent(event({ action: 'rule_added', project_id: 'repo-1', detail: { quarantined: true } })), 'wrote a rule in repo-1 (held for review)')
  assert.equal(describeAuditEvent(event({ action: 'tags_changed', project_id: 'agent-mailer-1', detail: { after: ['email', 'eu'] } })), 'set tags of agent-mailer-1 to email, eu')
  assert.equal(describeAuditEvent(event({ action: 'tag_rules_changed', detail: { rules: [{}, {}] } })), 'changed the tool to tag mapping (2 rules)')
  assert.equal(
    describeAuditEvent(event({ action: 'capture_settings_changed', project_id: 'agent-mailer-1', detail: { mode: 'broad', confidence_min: 0.75, kinds: ['run'] } })),
    'changed what agent-mailer-1 captures (mode broad, threshold 0.75, kinds run)',
  )
  assert.equal(describeAuditEvent(event({ action: 'something_new', project_id: 'repo-1' })), 'something new in repo-1')
})

test('auditBeforeParam: a page cursor goes back unchanged, a date becomes a timestamp, anything else is refused', () => {
  const cursor = '2026-11-05T10:00:00.123456Z_aaaaaaaa-1111-4111-8111-111111111111'
  assert.equal(auditBeforeParam(` ${cursor} `), cursor)
  assert.equal(auditBeforeParam('2026-11-01'), '2026-11-01T00:00:00.000Z')
  assert.equal(auditBeforeParam('2026-11-01T12:30:00+02:00'), '2026-11-01T10:30:00.000Z')
  assert.equal(auditBeforeParam('last week'), null)
  // A cursor cut short while copying is not silently read as something else.
  assert.equal(auditBeforeParam('2026-11-05T10:00:00.123456Z_aaaaaaaa-1111'), null)
})

test('auditNextCommand: the next page keeps the filters of this one', () => {
  const cursor = '2026-11-05T10:00:00.123456Z_aaaaaaaa-1111-4111-8111-111111111111'
  assert.equal(auditNextCommand(cursor, {}), `robrain audit --before ${cursor}`)
  assert.equal(
    auditNextCommand(cursor, { action: 'promoted', projectId: ' repo-1 ', limit: 50 }),
    `robrain audit --action promoted --project-id repo-1 --limit 50 --before ${cursor}`,
  )
})

test('splitConflictMatches: only "contradicts" blocks; extends and related are context; unrelated is dropped', () => {
  const m = (classification: string, id: string) => ({ decision_id: id, decision: id, classification, similarity: 0.8, reviewed: true })
  const { conflicts, context } = splitConflictMatches({
    would_conflict: true,
    matches: [m('contradicts', 'a'), m('extends', 'b'), m('related', 'c'), m('unrelated', 'd')],
  })
  assert.deepEqual(conflicts.map(x => x.decision_id), ['a'])
  assert.deepEqual(context.map(x => x.decision_id), ['b', 'c'])
})

test('fetchConflictVerdict: verdict on cloud, self_hosted on a bare 404, failed otherwise, and it never throws', async () => {
  const realFetch = globalThis.fetch
  try {
    let seen: { url: string; body: unknown; auth: string | null } | null = null
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') }
      return new Response(JSON.stringify({ would_conflict: true, matched_id: 'd-1', matches: [{ decision_id: 'd-1', decision: 'x', classification: 'contradicts', similarity: 0.9, reviewed: false }] }), { status: 200 })
    }) as typeof fetch
    const ok = await fetchConflictVerdict('http://api', 'k', 'proj', 'switch to Pinecone')
    assert.equal(ok.status, 'verdict')
    assert.equal(ok.status === 'verdict' && ok.verdict.matches.length, 1)
    assert.deepEqual(seen, { url: 'http://api/dry-run', body: { project_id: 'proj', decision: 'switch to Pinecone' }, auth: 'Bearer k' })

    globalThis.fetch = (async () => new Response('404 Not Found', { status: 404 })) as typeof fetch
    assert.deepEqual(await fetchConflictVerdict('http://api', '', 'proj', 'x'), { status: 'self_hosted' })

    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'project_not_registered' }), { status: 404 })) as typeof fetch
    assert.equal((await fetchConflictVerdict('http://api', 'k', 'proj', 'x')).status, 'failed')

    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
    assert.deepEqual(await fetchConflictVerdict('http://api', 'k', 'proj', 'x'), { status: 'failed', reason: 'ECONNREFUSED' })
  } finally {
    globalThis.fetch = realFetch
  }
})

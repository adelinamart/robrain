import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CAPTURE_SETTINGS,
  buildCapturePatch,
  formatPreview,
  parseKindFlag,
  parseTurnsJsonl,
  readCaptureSettings,
  type CaptureSettings,
} from './capture.js'

const withKinds: CaptureSettings = {
  ...DEFAULT_CAPTURE_SETTINGS,
  kinds: [
    { name: 'run', description: 'The outcome of an agent run.' },
    { name: 'gotcha', description: 'A trap the team hit.' },
  ],
}

describe('parseKindFlag', () => {
  it('accepts "name: description" and "name = description"', () => {
    assert.deepEqual(parseKindFlag('run: The outcome of an agent run.'), { kind: { name: 'run', description: 'The outcome of an agent run.' } })
    assert.deepEqual(parseKindFlag('Agent Run = what ran'), { kind: { name: 'agent-run', description: 'what ran' } })
  })

  it('rejects a flag with no description', () => {
    const r = parseKindFlag('run')
    assert.ok('error' in r)
  })
})

describe('parseTurnsJsonl', () => {
  it('reads one turn per line and skips blanks and comments', () => {
    const r = parseTurnsJsonl([
      '# sample',
      '{"user_message":"let us use pnpm","claude_reply":"ok"}',
      '',
      '{"user_message":"thanks","claude_reply":"np"}',
    ].join('\n'))
    assert.ok('turns' in r)
    assert.equal(r.turns.length, 2)
    assert.equal(r.turns[0]!.user_message, 'let us use pnpm')
  })

  it('names the bad line', () => {
    const r = parseTurnsJsonl('{"user_message":"x","claude_reply":"y"}\nnot json')
    assert.ok('error' in r)
    assert.match(r.error, /line 2/)
    const missing = parseTurnsJsonl('{"user_message":"x"}')
    assert.ok('error' in missing)
    assert.match(missing.error, /claude_reply/)
  })
})

describe('buildCapturePatch', () => {
  it('leaves untouched fields out of the patch', () => {
    const r = buildCapturePatch({ mode: 'broad' }, DEFAULT_CAPTURE_SETTINGS)
    assert.deepEqual(r, { patch: { mode: 'broad' } })
  })

  it('reads instructions from a file and clears them on request', () => {
    const fromFile = buildCapturePatch({ instructionsFile: 'rules.md' }, DEFAULT_CAPTURE_SETTINGS, () => 'Also store gotchas.')
    assert.deepEqual(fromFile, { patch: { instructions: 'Also store gotchas.' } })
    const cleared = buildCapturePatch({ clearInstructions: true }, DEFAULT_CAPTURE_SETTINGS)
    assert.deepEqual(cleared, { patch: { instructions: null } })
  })

  it('refuses two instruction sources at once', () => {
    const r = buildCapturePatch({ instructions: 'a', clearInstructions: true }, DEFAULT_CAPTURE_SETTINGS)
    assert.ok('error' in r)
  })

  it('parses the threshold and rejects text', () => {
    assert.deepEqual(buildCapturePatch({ minConfidence: '0.75' }, DEFAULT_CAPTURE_SETTINGS), { patch: { confidence_min: 0.75 } })
    assert.deepEqual(buildCapturePatch({ resetMinConfidence: true }, DEFAULT_CAPTURE_SETTINGS), { patch: { confidence_min: null } })
    assert.ok('error' in buildCapturePatch({ minConfidence: 'high' }, DEFAULT_CAPTURE_SETTINGS))
  })

  it('composes kind add/remove over the current list', () => {
    const r = buildCapturePatch({ removeKind: ['gotcha'], addKind: ['owner: Who owns a service right now.'] }, withKinds)
    assert.ok('patch' in r)
    assert.deepEqual(r.patch.kinds, [
      { name: 'run', description: 'The outcome of an agent run.' },
      { name: 'owner', description: 'Who owns a service right now.' },
    ])
  })

  it('re-adding a kind replaces its description', () => {
    const r = buildCapturePatch({ addKind: ['run: What the last run did.'] }, withKinds)
    assert.ok('patch' in r)
    assert.deepEqual(r.patch.kinds?.map((k) => k.description), ['A trap the team hit.', 'What the last run did.'])
  })

  it('errors when removing a kind that is not there, and clears all on --clear-kinds', () => {
    const missing = buildCapturePatch({ removeKind: ['nope'] }, withKinds)
    assert.ok('error' in missing)
    assert.match(missing.error, /no kind named "nope"/)
    assert.deepEqual(buildCapturePatch({ clearKinds: true }, withKinds), { patch: { kinds: [] } })
  })
})

describe('readCaptureSettings', () => {
  it('falls back field by field on a malformed response', () => {
    const s = readCaptureSettings({ instructions: '  ', mode: 'loud', confidence_min: '0.9', kinds: [{ name: 'run' }, { name: 'ok', description: 'd' }] })
    assert.deepEqual(s, { instructions: null, mode: 'strict', confidence_min: null, kinds: [{ name: 'ok', description: 'd' }] })
  })
})

describe('formatPreview', () => {
  it('counts what reached the model and what would be stored', () => {
    const turns = [
      { user_message: 'let us use pnpm', claude_reply: 'ok' },
      { user_message: 'thanks', claude_reply: 'np' },
    ]
    const lines = formatPreview(turns, [
      { gate: 'keyword', reaches_model: true, stored: true, extracted: { decision: 'Use pnpm', rationale: null, rejected: [], confidence: 0.9, kind: 'decision', subject: null } },
      { gate: 'none', reaches_model: false, stored: false, extracted: null },
    ])
    assert.match(lines.join('\n'), /2 turns: 1 reached the model, 1 would be stored/)
    assert.match(lines.join('\n'), /stored as decision \(0\.90\): "Use pnpm"/)
  })
})

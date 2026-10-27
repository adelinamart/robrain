import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CAPTURE_SETTINGS,
  allowedKindNames,
  applyCaptureSettingsPatch,
  coerceCaptureSettings,
  effectiveConfidenceMin,
  isDefaultCaptureSettings,
  normalizeKindName,
  subjectsMatch,
} from './capture-settings.js'
import { buildCaptureRules, parseExtractedDecision } from './extract-decision.js'
import { captureGate, BROAD_MODE_MIN_USER_CHARS } from './capture-gate.js'

describe('applyCaptureSettingsPatch', () => {
  it('leaves untouched fields alone and trims instructions', () => {
    const r = applyCaptureSettingsPatch(DEFAULT_CAPTURE_SETTINGS, { instructions: '  Also store gotchas.  ' })
    assert.ok(r.ok)
    assert.equal(r.settings.instructions, 'Also store gotchas.')
    assert.equal(r.settings.mode, 'strict')
    assert.equal(r.settings.confidence_min, null)
  })

  it('clears instructions on null or blank', () => {
    const base = { ...DEFAULT_CAPTURE_SETTINGS, instructions: 'x' }
    assert.equal((applyCaptureSettingsPatch(base, { instructions: null }) as any).settings.instructions, null)
    assert.equal((applyCaptureSettingsPatch(base, { instructions: '   ' }) as any).settings.instructions, null)
  })

  it('rejects instructions over the cap, bad modes and out-of-range thresholds in one pass', () => {
    const r = applyCaptureSettingsPatch(DEFAULT_CAPTURE_SETTINGS, {
      instructions: 'x'.repeat(2001),
      mode: 'everything',
      confidence_min: 1.5,
    })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.errors.length, 3)
      assert.match(r.errors[0]!, /2000 characters/)
      assert.match(r.errors[1]!, /strict, broad/)
      assert.match(r.errors[2]!, /between 0 and 1/)
    }
  })

  it('normalizes kind names, requires descriptions and refuses the built-in kind', () => {
    const r = applyCaptureSettingsPatch(DEFAULT_CAPTURE_SETTINGS, {
      kinds: [
        { name: ' Agent Run ', description: 'What the last run did.' },
        { name: 'decision', description: 'nope' },
        { name: 'gotcha', description: '' },
        { name: 'agent-run', description: 'duplicate' },
      ],
    })
    assert.equal(r.ok, false)
    if (!r.ok) {
      assert.equal(r.errors.length, 3)
      assert.match(r.errors[0]!, /built-in kind/)
      assert.match(r.errors[1]!, /needs a description/)
      assert.match(r.errors[2]!, /listed twice/)
    }
    const ok = applyCaptureSettingsPatch(DEFAULT_CAPTURE_SETTINGS, {
      kinds: [{ name: ' Agent Run ', description: ' What the last run did. ' }],
    })
    assert.ok(ok.ok)
    assert.deepEqual(ok.settings.kinds, [{ name: 'agent-run', description: 'What the last run did.' }])
  })

  it('rounds the threshold to two decimals', () => {
    const r = applyCaptureSettingsPatch(DEFAULT_CAPTURE_SETTINGS, { confidence_min: 0.7549 })
    assert.ok(r.ok)
    assert.equal(r.settings.confidence_min, 0.75)
  })
})

describe('coerceCaptureSettings', () => {
  it('returns defaults for garbage and keeps the valid fields of a partly bad row', () => {
    assert.deepEqual(coerceCaptureSettings(null), DEFAULT_CAPTURE_SETTINGS)
    assert.deepEqual(coerceCaptureSettings('x'), DEFAULT_CAPTURE_SETTINGS)
    const s = coerceCaptureSettings({ instructions: 'keep', mode: 'bogus', confidence_min: 0.8, kinds: 'not-a-list' })
    assert.equal(s.instructions, 'keep')
    assert.equal(s.mode, 'strict')
    assert.equal(s.confidence_min, 0.8)
    assert.deepEqual(s.kinds, [])
  })

  it('isDefaultCaptureSettings is true only for the stock behaviour', () => {
    assert.equal(isDefaultCaptureSettings(coerceCaptureSettings({})), true)
    assert.equal(isDefaultCaptureSettings(coerceCaptureSettings({ mode: 'broad' })), false)
  })
})

describe('subjectsMatch', () => {
  it('matches equal subjects and one that contains the other', () => {
    assert.equal(subjectsMatch('nightly sync', 'Nightly Sync'), true)
    assert.equal(subjectsMatch('nightly sync', 'nightly sync agent'), true)
    assert.equal(subjectsMatch('the nightly sync agent', 'nightly-sync'), true)
  })

  it('does not match different subjects or empty ones', () => {
    assert.equal(subjectsMatch('nightly sync', 'weekly backup'), false)
    assert.equal(subjectsMatch('deploy staging', 'deploy production'), false)
    assert.equal(subjectsMatch('the', 'nightly sync'), false)
  })
})

describe('helpers', () => {
  it('effectiveConfidenceMin prefers the project override', () => {
    assert.equal(effectiveConfidenceMin(null, 0.6), 0.6)
    assert.equal(effectiveConfidenceMin({ ...DEFAULT_CAPTURE_SETTINGS, confidence_min: 0.8 }, 0.6), 0.8)
  })

  it('allowedKindNames always starts with decision', () => {
    assert.deepEqual(allowedKindNames(null), ['decision'])
    assert.deepEqual(
      allowedKindNames({ ...DEFAULT_CAPTURE_SETTINGS, kinds: [{ name: 'run', description: 'd' }] }),
      ['decision', 'run'],
    )
  })

  it('normalizeKindName folds case and punctuation', () => {
    assert.equal(normalizeKindName('Agent Run!'), 'agent-run')
    assert.equal(normalizeKindName('  '), '')
  })
})

describe('buildCaptureRules', () => {
  it('is empty for the defaults so the stock prompt stays byte-identical', () => {
    assert.equal(buildCaptureRules(null), '')
    assert.equal(buildCaptureRules(DEFAULT_CAPTURE_SETTINGS), '')
  })

  it('lists kinds, extends the schema, and puts instructions last', () => {
    const text = buildCaptureRules({
      ...DEFAULT_CAPTURE_SETTINGS,
      instructions: 'Skip anything about the marketing site.',
      kinds: [{ name: 'run', description: 'The outcome of an agent run.' }],
    })
    assert.match(text, /- "run": The outcome of an agent run\./)
    assert.match(text, /"kind": string, "entry": string\|null, "subject": string\|null/)
    assert.ok(text.indexOf('Project instructions') > text.indexOf('Besides decisions'))
    assert.match(text, /Skip anything about the marketing site\./)
  })
})

describe('parseExtractedDecision with kinds', () => {
  const run = '{"decision":"Nightly sync ran at 02:00 and failed on step 3","rationale":null,"rejected":[],"confidence":0.9,"kind":"Run","subject":"nightly sync"}'

  it('keeps a declared kind and its subject', () => {
    const d = parseExtractedDecision(run, ['decision', 'run'])
    assert.equal(d.kind, 'run')
    assert.equal(d.subject, 'nightly sync')
  })

  it('falls back to decision for an undeclared kind and drops the subject', () => {
    const d = parseExtractedDecision(run)
    assert.equal(d.kind, 'decision')
    assert.equal(d.subject, null)
  })

  it('stores a listed kind from "entry" when the model leaves "decision" null', () => {
    const d = parseExtractedDecision(
      '{"decision":null,"rationale":null,"rejected":[],"confidence":0.85,"kind":"run","entry":"Nightly sync succeeded at 03:10.","subject":"nightly sync"}',
      ['decision', 'run'],
    )
    assert.equal(d.decision, 'Nightly sync succeeded at 03:10.')
    assert.equal(d.kind, 'run')
    // an "entry" on an undeclared kind is ignored: the row falls back to a decision, and the model said there was none
    const undeclared = parseExtractedDecision('{"decision":null,"rejected":[],"confidence":0.85,"kind":"run","entry":"x"}')
    assert.equal(undeclared.decision, null)
  })

  it('defaults kind to decision when the model omits it', () => {
    const d = parseExtractedDecision('{"decision":"Use pnpm","rationale":null,"rejected":[],"confidence":0.8}')
    assert.equal(d.kind, 'decision')
    assert.equal(d.subject, null)
  })
})

describe('captureGate', () => {
  const quiet = { user_message: 'Can you look at why the nightly sync job is slow lately?', claude_reply: 'Sure, checking the logs now.' }

  it('strict mode: keyword and implicit commitments pass, everything else is skipped', () => {
    assert.equal(captureGate({ user_message: "let's use pnpm", claude_reply: '' }).reason, 'keyword')
    assert.equal(captureGate({ user_message: 'from now on write tests first', claude_reply: '' }).reason, 'implicit')
    assert.equal(captureGate({ user_message: 'ok', claude_reply: 'We decided on X' }).reason, 'none')
    assert.equal(captureGate(quiet).reachesModel, false)
  })

  it('assistant keyword counts only with a user affirmation', () => {
    assert.equal(captureGate({ user_message: 'yes, do it', claude_reply: 'Going with Zustand.' }).reason, 'keyword')
    assert.equal(captureGate({ user_message: 'hmm', claude_reply: 'Going with Zustand.' }).reason, 'none')
  })

  it('broad mode lets a non-trivial turn through and still skips short acknowledgements', () => {
    assert.equal(captureGate(quiet, { mode: 'broad' }).reason, 'broad')
    assert.equal(captureGate({ user_message: 'thanks!', claude_reply: 'x'.repeat(500) }, { mode: 'broad' }).reason, 'none')
    assert.ok('thanks!'.length < BROAD_MODE_MIN_USER_CHARS)
  })
})

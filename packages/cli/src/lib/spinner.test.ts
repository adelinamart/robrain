import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isZeroWidthTty, shouldDisableSpinner, createSpinner } from './spinner.js'

describe('spinner — zero-width TTY detection', () => {
  it('flags a TTY that reports zero columns', () => {
    // Reported: `expect`/`script` ptys without a window size — ora looped on
    // cursor-up/erase sequences (>1.5 GB in minutes) and init-project never ran.
    assert.equal(isZeroWidthTty({ isTTY: true, columns: 0 }), true)
  })

  it('leaves a normally sized TTY alone', () => {
    assert.equal(isZeroWidthTty({ isTTY: true, columns: 120 }), false)
  })

  it('leaves a pipe alone — ora already handles non-TTY output', () => {
    assert.equal(isZeroWidthTty({ isTTY: false, columns: 0 }), false)
    assert.equal(isZeroWidthTty({ columns: undefined }), false)
    assert.equal(isZeroWidthTty(undefined), false)
  })

  it('disables when either stdout or stderr is a zero-width TTY', () => {
    assert.equal(shouldDisableSpinner({ stdout: { isTTY: true, columns: 0 },  stderr: { isTTY: true, columns: 80 } }), true)
    assert.equal(shouldDisableSpinner({ stdout: { isTTY: true, columns: 80 }, stderr: { isTTY: true, columns: 0 } }), true)
    assert.equal(shouldDisableSpinner({ stdout: { isTTY: true, columns: 80 }, stderr: { isTTY: true, columns: 80 } }), false)
    assert.equal(shouldDisableSpinner({}), false)
  })
})

describe('createSpinner', () => {
  it('accepts the same string and options forms as ora', () => {
    const a = createSpinner('Working...')
    const b = createSpinner({ text: 'Working...', color: 'green' })
    assert.equal(a.text, 'Working...')
    assert.equal(b.text, 'Working...')
    assert.equal(b.color, 'green')
  })

  it('does not force the spinner on when the caller already set isEnabled', () => {
    const s = createSpinner({ text: 'quiet', isEnabled: false })
    // ora exposes isEnabled at runtime but leaves it out of its typings.
    assert.equal((s as unknown as { isEnabled: boolean }).isEnabled, false)
  })
})

// src/lib/spinner.ts
// ─────────────────────────────────────────────────────────────
// Shared ora factory. Every CLI spinner goes through here so one
// terminal quirk is handled in one place.
//
// ora animates by measuring its text against `stream.columns` and
// then erasing that many lines with cursor-up/clear-line sequences.
// A pseudo-terminal with no window size set (`expect`, `script`,
// `docker run -t` without a real TTY) reports `columns === 0`:
// the division yields Infinity lines to clear, and the spinner
// emits erase sequences forever without ever finishing the command.
// Such a stream is "a TTY" as far as ora's own interactive check
// goes, so we have to turn the animation off ourselves.
// ─────────────────────────────────────────────────────────────

import ora, { type Options, type Ora } from 'ora'

/** The subset of a tty.WriteStream the zero-width check needs. */
export interface SpinnerStream {
  isTTY?:   boolean
  columns?: number
}

/**
 * True when `stream` is a TTY that reports a zero-column window —
 * the one case where ora's animation never terminates.
 */
export function isZeroWidthTty(stream: SpinnerStream | undefined): boolean {
  return Boolean(stream?.isTTY) && stream?.columns === 0
}

/**
 * True when the spinner animation must be disabled. ora writes to stderr
 * by default while most shells size stdout and stderr together, so either
 * one reporting a zero-width TTY is enough to disable it.
 */
export function shouldDisableSpinner(
  streams: { stdout?: SpinnerStream; stderr?: SpinnerStream } = process,
): boolean {
  return isZeroWidthTty(streams.stdout) || isZeroWidthTty(streams.stderr)
}

/**
 * Drop-in replacement for `ora(...)`. On a normal terminal the result is
 * identical; on a zero-width TTY the spinner is created with
 * `isEnabled: false`, so it prints its text once instead of animating.
 */
export function createSpinner(options?: string | Options): Ora {
  const base: Options = typeof options === 'string' ? { text: options } : { ...(options ?? {}) }
  const disable = shouldDisableSpinner() && base.isEnabled === undefined
  return ora(disable ? { ...base, isEnabled: false } : base)
}

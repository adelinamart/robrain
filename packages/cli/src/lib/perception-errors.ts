// src/lib/perception-errors.ts
// ─────────────────────────────────────────────────────────────
// Shared explanations for a failed Perception call.
//
// Every consumer used to print
//   "Could not fetch decisions (401). Is Perception running? … pnpm docker:up"
// which is wrong twice for a cloud user: the store IS running, and there is no
// local Docker stack to start. 401 and 404 each have one likely cause worth
// naming — reported by a user who hit both while installing on two machines.
//
// Covers both failure shapes: an HTTP status we can read (explainPerceptionFailure)
// and never reaching the store at all (explainPerceptionUnreachable) — the second
// is the path users hit most, and it carried the same wrong advice.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'

export interface FailureExplanation {
  headline: string
  hints:    string[]
}

export interface FailureContext {
  /** Cloud install (managed store) vs self-hosted (local Perception). */
  cloud:         boolean
  perceptionUrl: string
}

/** Spinner-like sink so callers can pass ora, or a console shim. */
export interface FailSink {
  fail(text: string): unknown
}

/** Point a self-hosted user at their own stack; never a cloud user. */
function startStackHints(ctx: FailureContext): string[] {
  return ctx.cloud
    ? [`Store: ${ctx.perceptionUrl}`]
    : [`Expected at: ${ctx.perceptionUrl}`, 'Start it with `npx robrain up` (or `pnpm docker:up` from a clone).']
}

/** Auth-failure hints, or [] when the status is not an auth failure. */
export function perceptionAuthHints(status: number, ctx: FailureContext): string[] {
  if (status !== 401 && status !== 403) return []
  return ctx.cloud
    ? [
        // Observed: installing on a second machine left the first one 401ing.
        'Installing RoBrain on another machine can replace this machine\'s key.',
        'Re-run `npx robrain install` here to get a working one.',
      ]
    : [
        'The key in ~/.robrain/config.json must match Perception\'s PERCEPTION_API_KEY.',
        'Check your .env, then re-run `npx robrain install --self-hosted`.',
      ]
}

/**
 * @param action what the caller was doing, for the unclassified fallback
 *               (e.g. "fetch decisions", "scan for prior rejections").
 */
export function explainPerceptionFailure(
  status: number,
  ctx: FailureContext,
  action = 'fetch decisions',
): FailureExplanation {
  const authHints = perceptionAuthHints(status, ctx)
  if (authHints.length > 0) {
    return { headline: `Memory store rejected this API key (${status})`, hints: authHints }
  }

  if (status === 404) {
    return {
      headline: 'This project is not in your memory space (404)',
      hints: [
        'Never initialized here? Run `npx robrain init-project` from the project root.',
        ctx.cloud
          // A teammate's project is invisible — not empty — until you are in their team.
          ? 'Created by a teammate? Ask to be added to their team; until then it is not visible to you.'
          : 'Expected it to exist? Check which id this directory maps to with `npx robrain status`.',
      ],
    }
  }

  if (status >= 500) {
    return {
      headline: `Memory store errored (${status})`,
      hints: ctx.cloud
        ? ['Server-side — retry shortly, then contact support@roryplans.ai if it persists.']
        : ['Check Perception\'s logs: docker logs robrain-perception'],
    }
  }

  return { headline: `Could not ${action} (${status})`, hints: startStackHints(ctx) }
}

/** The store was never reached — DNS, refused connection, timeout. */
export function explainPerceptionUnreachable(ctx: FailureContext): FailureExplanation {
  return {
    headline: 'Could not reach the memory store',
    hints: ctx.cloud
      ? [
          `Store: ${ctx.perceptionUrl}`,
          'Check your network connection; if it persists, contact support@roryplans.ai.',
        ]
      : startStackHints(ctx),
  }
}

function emit(sink: FailSink, { headline, hints }: FailureExplanation): void {
  sink.fail(headline)
  for (const hint of hints) console.log(chalk.dim(`  ${hint}`))
  console.log()
}

/**
 * Print a status failure and exit.
 * @param exitCode callers with their own contract override it — `robrain check`
 *                 reserves 1 for "a rejection matched" and uses 2 for "could not scan".
 */
export function failPerception(
  sink: FailSink,
  status: number,
  ctx: FailureContext,
  action?: string,
  exitCode = 1,
): never {
  emit(sink, explainPerceptionFailure(status, ctx, action))
  process.exit(exitCode)
}

/** Print an unreachable-store failure and exit. */
export function failPerceptionUnreachable(
  sink: FailSink,
  ctx: FailureContext,
  exitCode = 1,
): never {
  emit(sink, explainPerceptionUnreachable(ctx))
  process.exit(exitCode)
}

/** Console-based sink for commands that do not use a spinner. */
export function consoleFailSink(): FailSink {
  return { fail: (text: string) => console.error(chalk.red(`  ✗ ${text}`)) }
}

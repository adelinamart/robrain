// packages/cli/src/commands/synth.ts
// robrain synth — run the Synthesis pass (@robrain/synthesis).
//
// The entry (resolved by lib/synthesis-bundle.ts: ROBRAIN_REPO → checkout →
// vendored bundle) is spawned with `node` directly — never `pnpm --filter`:
// under `npx robrain` there is no pnpm workspace, so pnpm failed with the
// baffling "No projects matched the filters" and Corepack even wrote a
// packageManager field into the npx cache's package.json.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import chalk from 'chalk'
import { isCloudInstall } from '../lib/config.js'
import { applyEnvFileFallback, applyStackEnvFallback } from '../lib/load-env.js'
import { resolveSynthesisEntry, SynthesisResolveError, type ResolvedSynthesis } from '../lib/synthesis-bundle.js'

/** Absolute path to this CLI's `bin/robrain.js` (checkout or published layout). */
function resolveCliBin(): string | undefined {
  const candidate = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'robrain.js')
  return existsSync(candidate) ? candidate : undefined
}

export interface SynthOptions {
  dryRun?: boolean
  lookback?: number
  project?: string
  /** Disable incremental mode — re-analyse contradiction pairs against full corpus window */
  full?: boolean
}

export async function synthCommand(opts: SynthOptions): Promise<void> {
  const env = { ...process.env }
  // Env precedence for the child, lowest to highest — two deliberate layers:
  //   1. ~/.robrain/stack/.env      (filled here, gaps only — `robrain up` output)
  //   2. shell exports              (loadCliEnv already let them win at startup)
  //   3. repo/cwd `.env`            (the child's own shared loadEnv OVERRIDES
  //                                  inherited env — `.env` is source of truth
  //                                  for server-side processes, by design)
  // The CLI-side shell-wins vs shared .env-wins split is a recorded decision,
  // not drift — don't "unify" these.
  applyStackEnvFallback(env)

  // Resolve before deciding: a resolved checkout's `.env` is a store the child
  // would find via its own loadEnv, so it has to count as "there is a local
  // store" — otherwise we decline work that would have succeeded. Errors are
  // held, not thrown: on a cloud install "no local Synthesis" is the expected
  // state, and the message below beats a resolution failure.
  let resolved: ResolvedSynthesis | undefined
  let resolveError: SynthesisResolveError | undefined
  try {
    resolved = resolveSynthesisEntry()
  } catch (err) {
    if (!(err instanceof SynthesisResolveError)) throw err
    resolveError = err
  }
  if (resolved?.repoRoot) applyEnvFileFallback(env, join(resolved.repoRoot, '.env'))

  // Synthesis is a batch job that opens the decision store directly — there is
  // no local store on a cloud install, and judgment already runs server-side.
  // Without this the spawned bundle dies on `Missing env var: DATABASE_URL`,
  // which reads like a broken install rather than "this command isn't yours".
  //
  // A reachable DATABASE_URL overrides the install mode on purpose: a stale
  // cloud token (logged in once, never `logout`) must not talk someone out of
  // running the pass over a store they demonstrably have. Config decides only
  // when there is no store to point at.
  if (isCloudInstall() && !env.DATABASE_URL) {
    console.log()
    console.log(chalk.yellow('  Synthesis runs server-side on Rory Plans cloud — nothing to run locally.'))
    console.log(chalk.dim('  Its results reach you the same way as everything else: the always-on'))
    console.log(chalk.dim('  summary at session start, and ') + chalk.cyan('npx robrain review') + chalk.dim('.'))
    console.log()
    console.log(chalk.dim('  Self-hosting instead? Start your stack with ') + chalk.cyan('npx robrain up')
      + chalk.dim(' (or set DATABASE_URL).'))
    console.log(chalk.dim('  Seeing this after switching off cloud? The install still holds a Rory'))
    console.log(chalk.dim('  token — ') + chalk.cyan('npx robrain logout') + chalk.dim(' clears it.'))
    console.log()
    return
  }

  if (resolveError || !resolved) {
    console.error(chalk.red(`✗ robrain synth: ${resolveError?.message ?? 'could not resolve the Synthesis bundle.'}`))
    process.exitCode = 1
    return
  }

  if (opts.dryRun) env.SYNTHESIS_DRY_RUN = 'true'
  if (opts.full) env.SYNTHESIS_INCREMENTAL = 'false'
  if (opts.lookback != null && Number.isFinite(opts.lookback)) {
    env.SYNTHESIS_LOOKBACK_DAYS = String(opts.lookback)
  }
  if (opts.project) env.SYNTHESIS_PROJECT_ID = opts.project
  // Synthesis derives its `.env` root from ROBRAIN_REPO — pin it to the
  // resolved checkout so the vendored file location never skews the guess.
  if (resolved.repoRoot) env.ROBRAIN_REPO = resolved.repoRoot
  // So SYNTHESIS_EXPORT_MEMORY can spawn `export-memory` without guessing
  // checkout vs published bin layout from the vendored bundle path.
  const cliBin = resolveCliBin()
  if (cliBin) env.ROBRAIN_CLI_BIN = cliBin

  console.log(chalk.dim('Running synthesis pass…'))
  const child = spawn(process.execPath, ['--no-deprecation', resolved.entry], {
    cwd: resolved.repoRoot ?? process.cwd(),
    stdio: 'inherit',
    env,
  })
  // The child inherits stdio, so it has already printed whatever went wrong —
  // rethrowing here just stacks a second (useless) Node trace on top of it.
  const code = await new Promise<number>((res, rej) => {
    child.on('error', rej)
    child.on('exit', c => res(c ?? 1))
  })
  if (code !== 0) {
    console.error(chalk.red(`\n✗ Synthesis failed (exit ${code}) — see the error above.`))
    process.exitCode = code
  }
}

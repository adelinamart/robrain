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
import { applyStackEnvFallback } from '../lib/load-env.js'
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
  let resolved: ResolvedSynthesis
  try {
    resolved = resolveSynthesisEntry()
  } catch (err) {
    if (err instanceof SynthesisResolveError) {
      console.error(chalk.red(`✗ robrain synth: ${err.message}`))
      process.exitCode = 1
      return
    }
    throw err
  }

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
  await new Promise<void>((res, rej) => {
    child.on('error', rej)
    child.on('exit', code =>
      code === 0 ? res() : rej(new Error(`synthesis exited with code ${code}`)),
    )
  })
}

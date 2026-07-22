// src/commands/install.ts
// ─────────────────────────────────────────────────────────────
// robrain install [--token TOKEN] [--editor claude-code|cursor|copilot|codex]
//
// 1. Authenticate with Rory Plans
// 2. Fetch provisioned API URLs + keys
// 3. Prompt for embedding provider if not set
// 4. Detect editors (or use --editor flag)
// 5. Write MCP config to each detected editor
// 6. Save config to ~/.robrain/config.json
// ─────────────────────────────────────────────────────────────

import chalk    from 'chalk'
import ora      from 'ora'
import prompts  from 'prompts'
import { readConfig, writeConfig, mergeConfig } from '../lib/config.js'
import { validateToken, fetchProvisionedConfig, type ProvisionedConfig } from '../lib/auth.js'
import {
  resolveEditorsForInstall,
  resolveLlmProviderFromEnv,
  resolveOpenAiBaseUrlFromEnv,
  usingLocalOpenAi,
  writeMcpConfig,
  type McpWriteOptions,
} from '../lib/editor.js'
import {
  ensureSensingMcpBundle,
  ensureSensingMcpBundleFromPackage,
  controlBundleReady,
  sensingBundleReady,
  McpBundleError,
} from '../lib/mcp-bundle.js'
import { installCodexHooks } from '../lib/codex-hooks.js'
import { downloadControlBundle } from '../lib/control-bundle.js'
import { initProjectCommand }                                   from './init-project.js'
import {
  inferLocalRobrainMonorepoRoot,
  inferRobrainMonorepoRootFromCwd,
  loadCliEnv,
  readDotenvKey,
} from '../lib/load-env.js'
import { join }                                                  from 'path'
import { homedir }                                               from 'os'

const ROBRAIN_MCP_DIR = join(homedir(), '.robrain', 'mcp')

interface InstallOptions {
  token?:         string
  editor?:        string
  selfHosted?:    boolean
  perceptionUrl?: string
  /** Path to the robrain monorepo root — used to link/copy built sensing-mcp into ~/.robrain/mcp */
  repoRoot?:      string
  /** Do not run `init-project` in cwd after a successful install */
  skipInitProject?: boolean
}

/** Materialize Codex hook scripts when Codex is in the install set; warn on failure. */
function resolveCodexHooksForInstall(
  editors: Array<{ editor: string }>,
): string | undefined {
  if (!editors.some(e => e.editor === 'codex')) return undefined
  const dir = installCodexHooks()
  if (!dir) {
    console.log(chalk.yellow(
      '  ⚠ Codex hooks were not installed — hook scripts not found in this CLI package.\n' +
      '    MCP config was written; re-run after: npm install -g robrain@latest (or pnpm build in a clone).',
    ))
    console.log()
  }
  return dir
}

async function chainInitAfterInstall(opts: InstallOptions): Promise<void> {
  if (opts.skipInitProject) {
    console.log(chalk.yellow('\n  ⚠ Skipped automatic init-project (--skip-init-project).'))
    console.log(chalk.dim('  Run ') + chalk.cyan('npx robrain init-project') + chalk.dim(' in each repo where you want RoBrain memory.\n'))
    return
  }
  console.log()
  console.log(chalk.bold('  Registering this directory with Perception'))
  console.log(chalk.dim(`  Working directory: ${process.cwd()}`))
  console.log()
  try {
    await initProjectCommand({ nonInteractive: true })
  } catch {
    console.log(chalk.yellow('  ⚠ Automatic init-project failed or was interrupted.'))
    console.log(chalk.dim('  From your project root, run: ') + chalk.cyan('npx robrain init-project') + chalk.dim('\n'))
  }
}

function resolveRepoRoot(opts: InstallOptions): string | undefined {
  return opts.repoRoot ?? process.env.ROBRAIN_REPO
}

function prepareMcpBundles(opts: InstallOptions): void {
  const repoRoot = resolveRepoRoot(opts)

  // Explicit --repo-root / ROBRAIN_REPO is a dev override: link the clone's build.
  if (repoRoot) {
    try {
      ensureSensingMcpBundle(repoRoot, ROBRAIN_MCP_DIR)
      return
    } catch (e) {
      if (e instanceof McpBundleError) {
        console.log(chalk.red(`\n  ✗ ${e.message}\n`))
        process.exit(1)
      }
      throw e
    }
  }

  // Default path: copy the @robrain/sensing-mcp package that ships with the CLI —
  // works from a bare `npx robrain install`, no clone or pnpm build required.
  if (ensureSensingMcpBundleFromPackage(ROBRAIN_MCP_DIR)) return

  // Package not resolvable (source-tree run without a built workspace); keep any
  // previously materialized bundle rather than failing the whole install.
  if (sensingBundleReady(ROBRAIN_MCP_DIR)) return

  console.log(chalk.red('\n  ✗ Sensing MCP bundle missing.'))
  console.log(chalk.dim('    Expected: ') + join(ROBRAIN_MCP_DIR, 'sensing', 'dist', 'index.js'))
  console.log(chalk.dim('\n    Fix: run ') + chalk.cyan('npx robrain@latest install') + chalk.dim(' (bundles the Sensing server),'))
  console.log(chalk.dim('    or from a robrain clone run ') + chalk.cyan('pnpm install') + chalk.dim(' + ') + chalk.cyan('pnpm build') + chalk.dim(', then'))
  console.log(chalk.dim('    reinstall with ') + chalk.cyan('npx robrain install --repo-root /path/to/robrain') + chalk.dim(' (or set ') + chalk.cyan('ROBRAIN_REPO') + chalk.dim(')\n'))
  process.exit(1)
}

export async function installCommand(opts: InstallOptions): Promise<void> {
  console.log()
  console.log(chalk.bold('  RoBrain') + chalk.dim(' — institutional memory for AI coding agents'))
  console.log(chalk.dim('  by roryplans.ai\n'))

  // ── Self-hosted mode — skip Rory Plans auth entirely ──────
  if (opts.selfHosted) {
    prepareMcpBundles(opts)
    return installSelfHosted(opts)
  }

  prepareMcpBundles(opts)

  // ── Cloud mode — authenticate with Rory Plans ─────────────
  let token = opts.token ?? readConfig().token

  if (!token) {
    console.log(chalk.dim('  Get your token at: ') + chalk.cyan('https://roryplans.ai/settings/api\n'))

    const { inputToken } = await prompts({
      type:    'password',
      name:    'inputToken',
      message: 'Rory Plans API token:',
    })

    if (!inputToken) {
      console.log(chalk.red('\n  ✗ No token provided. Exiting.'))
      process.exit(1)
    }
    token = inputToken as string
  }

  // ── Step 2: Validate token ─────────────────────────────────
  const spinner = ora({ text: 'Connecting to roryplans.ai...', color: 'green' }).start()

  const authResult = await validateToken(token)
  if (!authResult.ok) {
    spinner.fail(chalk.red(`Authentication failed: ${authResult.error}`))
    console.log(chalk.dim('\n  Create an account at https://roryplans.ai'))
    process.exit(1)
  }

  spinner.succeed(`Authenticated as ${chalk.bold(authResult.email)}`)

  // ── Step 3: Fetch provisioned config ───────────────────────
  spinner.start('Fetching provisioned API config...')
  const provisioned = await fetchProvisionedConfig(token)

  if (!provisioned) {
    spinner.fail('Could not fetch provisioned config. Contact support@roryplans.ai')
    process.exit(1)
  }

  spinner.succeed('API endpoints configured')

  // ── Step 3b: Control MCP bundle (cloud-only, fail-soft) ────
  // The Control server ships from the cloud API, not the OSS repo. Download
  // it before the includeControl check below so a fresh install registers
  // robrain-control in the same pass. Bearer: planningKey — the same key the
  // control env wiring writes (PLANNING_API_KEY); the login token works too
  // (both auth planes hit the same middleware), so fall back to it.
  // Re-running install refreshes the bundle when the server sha differs.
  // ANY failure warns and continues: controlBundleReady() stays false and
  // the install completes Sensing-only.
  spinner.start('Downloading Control MCP bundle...')
  const controlDownload = await downloadControlBundle({
    baseUrl:       provisioned.planningUrl,
    token:         provisioned.planningKey || token,
    robrainMcpDir: ROBRAIN_MCP_DIR,
  })
  if (controlDownload.ok) {
    spinner.succeed(controlDownload.updated
      ? `Control MCP bundle installed (v${controlDownload.meta.version})`
      : `Control MCP bundle up to date (v${controlDownload.meta.version})`)
  } else {
    spinner.warn('Control MCP unavailable — continuing without automatic injection')
    console.log(chalk.dim(`    (${controlDownload.reason})`))
  }

  // ── Step 4: Embedding provider — none needed (cloud thin client) ─
  // Cloud Sensing runs as a thin client: raw turns ship to Perception with
  // needs_classification=true and server-side calibrated re-extraction
  // classifies them. No embedding or LLM key is prompted for or stored;
  // provisioned.embeddingProvider is kept for display only.

  // ── Step 5: Detect / select editors ───────────────────────
  let editorsToConfig = resolveEditorsForInstall(opts)
  if (opts.editor && editorsToConfig.length === 0) {
    console.log(chalk.red(`\n  ✗ Unknown or unavailable editor: ${opts.editor}`))
    console.log(chalk.dim('  Use: claude-code | cursor | copilot | codex\n'))
    process.exit(1)
  }
  if (!opts.editor && editorsToConfig.length > 1) {
    console.log()
    const { chosen } = await prompts({
      type:    'multiselect',
      name:    'chosen',
      message: 'Configure RoBrain for which editors?',
      choices: editorsToConfig.map(e => ({ title: e.label, value: e.editor, selected: true })),
    })
    editorsToConfig = editorsToConfig.filter(e => (chosen as string[]).includes(e.editor))
  }

  // ── Step 6: Write MCP configs ──────────────────────────────
  spinner.start('Writing MCP configuration...')

  const includeControl = controlBundleReady(ROBRAIN_MCP_DIR)

  const mcpOpts = buildCloudMcpOptions(provisioned, {
    includeControl,
    codexHooksDir: resolveCodexHooksForInstall(editorsToConfig),
  })

  for (const editor of editorsToConfig) {
    writeMcpConfig(editor.configPath, mcpOpts)
  }

  if (!includeControl) {
    console.log(chalk.yellow(
      '  ⚠ robrain-control was not registered — no Control MCP bundle under ~/.robrain/mcp/control.\n' +
      '    OSS/manual retrieval: use robrain inject. Rory Plans cloud supplies Control for auto-injection.',
    ))
    console.log()
  }

  // ── Step 7: Save local config ──────────────────────────────
  writeConfig({
    token,
    email:             authResult.email,
    thin:              true,
    perceptionUrl:     provisioned.perceptionUrl,
    perceptionKey:     provisioned.perceptionKey,
    planningUrl:       provisioned.planningUrl,
    planningKey:       provisioned.planningKey,
    // Display only (status) — the thin client never embeds locally.
    ...(provisioned.embeddingProvider ? { embeddingProvider: provisioned.embeddingProvider } : {}),
    installedAt:       new Date().toISOString(),
    version:           '2.4.2',
  })

  spinner.succeed('MCP servers configured')

  // ── Done ───────────────────────────────────────────────────
  console.log()
  console.log(chalk.green('  ✓ RoBrain installed successfully\n'))
  console.log(chalk.dim('  Configured for: ') + editorsToConfig.map(e => e.label).join(', '))
  console.log(chalk.dim('  Cloud thin client: classification runs server-side — no local API keys needed.'))
  console.log()

  await chainInitAfterInstall(opts)
}

/** @internal Exported for unit tests.
 * Cloud (Rory Plans) installs wire Sensing as a thin client: raw turns ship
 * to Perception with needs_classification=true and classification runs
 * server-side, so no embedding/LLM keys are collected, read from env, or
 * written into editor configs (see buildSensingMcpEnv thin mode). */
export function buildCloudMcpOptions(
  provisioned: ProvisionedConfig,
  extras: { includeControl: boolean; codexHooksDir?: string },
): McpWriteOptions {
  return {
    sensingMcpPath:    join(ROBRAIN_MCP_DIR, 'sensing', 'dist', 'index.js'),
    controlMcpPath:    join(ROBRAIN_MCP_DIR, 'control', 'dist', 'index.js'),
    anthropicKey:      '',                                      // ignored in thin mode
    perceptionUrl:     provisioned.perceptionUrl,
    perceptionKey:     provisioned.perceptionKey,
    planningUrl:       provisioned.planningUrl,
    planningKey:       provisioned.planningKey,
    embeddingProvider: provisioned.embeddingProvider ?? '',     // display only
    embeddingKey:      '',
    thin:              true,
    includeControl:    extras.includeControl,
    codexHooksDir:     extras.codexHooksDir,
  }
}

// ── Self-hosted install ────────────────────────────────────────
// Skips Rory Plans auth. Points Sensing MCP at a local
// Perception instance started with pnpm docker:up.

async function installSelfHosted(opts: InstallOptions): Promise<void> {
  // Re-merge `.env` after resolving clone root: `preAction` only had `--repo-root` /
  // ROBRAIN_REPO; infer the monorepo when running `node …/packages/cli/bin/robrain.js`
  // from a checkout so PERCEPTION_API_KEY matches docker-compose (repo `.env`).
  const cloneRootForEnv =
    resolveRepoRoot(opts) ??
    inferLocalRobrainMonorepoRoot() ??
    inferRobrainMonorepoRootFromCwd()
  loadCliEnv(cloneRootForEnv)

  const perceptionUrl = opts.perceptionUrl ?? 'http://127.0.0.1:3001'

  console.log(chalk.bold('  Self-hosted mode\n'))
  console.log(chalk.dim('  Sensing MCP will connect to: ') + chalk.cyan(perceptionUrl))
  console.log(chalk.dim('  Make sure Perception is running: ') + chalk.cyan('pnpm docker:up\n'))

  const envProvider = process.env.EMBEDDING_PROVIDER
  let provider: string
  if (envProvider === 'openai' || envProvider === 'voyage' || envProvider === 'cohere') {
    provider = envProvider
    console.log(chalk.dim(`  Using EMBEDDING_PROVIDER from environment (${provider})`))
    console.log(chalk.dim('  Must match the repo-root `.env` used by `pnpm docker:up`.\n'))
  } else {
    const { provider: choice } = await prompts({
      type:    'select',
      name:    'provider',
      message: 'Embedding provider (must match repo-root `.env` for `pnpm docker:up`):',
      choices: [
        { title: 'OpenAI  text-embedding-3-small', value: 'openai'  },
        { title: 'Voyage  voyage-3-lite',           value: 'voyage'  },
        { title: 'Cohere  embed-english-v3.0',       value: 'cohere'  },
      ],
    })
    provider = choice as string
  }

  const keyName  = { openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY', cohere: 'COHERE_API_KEY' }[provider] ?? 'EMBEDDING_API_KEY'

  const openaiBaseUrl = usingLocalOpenAi() ? resolveOpenAiBaseUrlFromEnv() : undefined

  let embKey = process.env[keyName] ?? ''
  if (embKey) {
    console.log(chalk.dim(`  Using ${keyName} from environment`))
  } else if (provider === 'openai' && openaiBaseUrl) {
    console.log(chalk.dim(`  ${keyName} not needed — OPENAI_BASE_URL=${openaiBaseUrl} (local server)`))
  } else {
    const answer = await prompts({ type: 'password', name: 'embKey', message: `${keyName}:` })
    embKey = answer.embKey as string
  }

  const llmProvider = resolveLlmProviderFromEnv()
  if (llmProvider === 'openai') {
    console.log(chalk.dim('  Using LLM_PROVIDER=openai from environment'))
  }

  let openaiKey = process.env.OPENAI_API_KEY ?? ''
  if (llmProvider === 'openai') {
    if (!openaiKey && provider === 'openai') {
      openaiKey = embKey
    } else if (openaiKey) {
      console.log(chalk.dim('  Using OPENAI_API_KEY from environment (LLM)'))
    } else if (openaiBaseUrl) {
      console.log(chalk.dim('  OPENAI_API_KEY not needed — OPENAI_BASE_URL points at a local server'))
    } else {
      const answer = await prompts({
        type:    'password',
        name:    'openaiKey',
        message: 'OPENAI_API_KEY (for Sensing decision extraction):',
      })
      openaiKey = answer.openaiKey as string
    }
  }

  let anthropicKey = ''
  if (llmProvider === 'anthropic') {
    anthropicKey = process.env.ANTHROPIC_API_KEY ?? ''
    if (anthropicKey) {
      console.log(chalk.dim('  Using ANTHROPIC_API_KEY from environment'))
    } else {
      const answer = await prompts({
        type:    'password',
        name:    'anthropicKey',
        message: 'ANTHROPIC_API_KEY (for Sensing classifiers):',
      })
      anthropicKey = answer.anthropicKey as string
    }
  } else {
    console.log(chalk.dim('  Skipping ANTHROPIC_API_KEY (LLM_PROVIDER=openai)'))
  }

  let editorsToConfig = resolveEditorsForInstall(opts)
  if (opts.editor && editorsToConfig.length === 0) {
    console.log(chalk.red(`\n  ✗ Unknown or unavailable editor: ${opts.editor}`))
    console.log(chalk.dim('  Use: claude-code | cursor | copilot | codex'))
    console.log(chalk.dim('  For copilot, install VS Code first.\n'))
    process.exit(1)
  }

  const spinner = ora('Writing MCP configuration...').start()

  // Same Perception key the CLI uses (init-project, review, inject). Self-hosted
  // install must not write PERCEPTION_API_KEY: "" into editor MCP configs — that
  // breaks Sensing against OSS Perception while other commands still work.
  const cfg = readConfig()
  // Repo `.env` wins (same file as `pnpm docker:up`): stale ~/.robrain/config.json or
  // shell must not override the key Perception already uses in Docker.
  const perceptionKeyFromRepo = cloneRootForEnv
    ? readDotenvKey(cloneRootForEnv, 'PERCEPTION_API_KEY')
    : undefined
  const perceptionKey =
    (perceptionKeyFromRepo?.trim() ? perceptionKeyFromRepo.trim() : '') ||
    (cfg.perceptionKey?.trim() ? cfg.perceptionKey : '') ||
    (process.env.PERCEPTION_API_KEY?.trim() ?? '') ||
    ''

  const mcpOpts = {
    sensingMcpPath:    join(ROBRAIN_MCP_DIR, 'sensing', 'dist', 'index.js'),
    controlMcpPath:    join(ROBRAIN_MCP_DIR, 'control', 'dist', 'index.js'),
    anthropicKey,
    perceptionUrl,
    perceptionKey,
    planningUrl:       '',    // no Planning in self-hosted OSS
    planningKey:       '',
    embeddingProvider: provider,
    embeddingKey:      embKey,
    llmProvider,
    openaiKey:         llmProvider === 'openai' ? openaiKey : undefined,
    openaiBaseUrl,
    includeControl:    false as const,
    codexHooksDir:     resolveCodexHooksForInstall(editorsToConfig),
  }

  for (const editor of editorsToConfig) {
    writeMcpConfig(editor.configPath, mcpOpts)
  }

  if (!perceptionKey) {
    console.log(chalk.yellow(
      '  ⚠ PERCEPTION_API_KEY is empty — Sensing MCP cannot talk to Perception (401).\n' +
      '    Put PERCEPTION_API_KEY in the clone `.env` (same file as `pnpm docker:up`).\n' +
      '    Global CLI (`npm i -g robrain`): run install from the clone directory, or pass ' +
      chalk.cyan('--repo-root /path/to/robrain') + chalk.yellow(' so that `.env` can be read.\n') +
      '    Or set perceptionKey in ~/.robrain/config.json / export PERCEPTION_API_KEY, then re-run install.',
    ))
    console.log()
  }

  mergeConfig({
    perceptionUrl,
    ...(perceptionKey ? { perceptionKey } : {}),
    embeddingProvider: provider,
    installedAt:       new Date().toISOString(),
    version:           '2.4.2',
    selfHosted:        true,
  })

  spinner.succeed('MCP servers configured for self-hosted mode')

  console.log()
  console.log(chalk.green('  ✓ RoBrain (self-hosted) installed\n'))
  console.log(chalk.dim('  Configured for: ') + editorsToConfig.map(e => e.label).join(', '))
  console.log(chalk.dim('  Perception: ') + chalk.cyan(perceptionUrl))
  console.log(chalk.dim('  Planning + Control injection: ') + chalk.yellow('not available in self-hosted OSS'))
  console.log()
  console.log(chalk.dim('  Context retrieval: use ') + chalk.cyan('npx robrain inject') + chalk.dim(' to get context for manual paste'))
  console.log()

  await chainInitAfterInstall(opts)

  console.log(chalk.dim('  Want automatic injection without pasting?'))
  console.log(chalk.dim('  → ') + chalk.cyan('roryplans.ai') + chalk.dim(' — Control MCP handles it automatically'))
  console.log()
}

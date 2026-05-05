// src/commands/install.ts
// ─────────────────────────────────────────────────────────────
// robrain install [--token TOKEN] [--editor claude-code|cursor|copilot]
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
import { readConfig, writeConfig, mergeConfig, RORY_API_BASE } from '../lib/config.js'
import { validateToken, fetchProvisionedConfig }                from '../lib/auth.js'
import { detectEditors, writeMcpConfig }                        from '../lib/editor.js'
import {
  ensureSensingMcpBundle,
  controlBundleReady,
  sensingBundleReady,
  McpBundleError,
} from '../lib/mcp-bundle.js'
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
}

function resolveRepoRoot(opts: InstallOptions): string | undefined {
  return opts.repoRoot ?? process.env.ROBRAIN_REPO
}

function prepareMcpBundles(opts: InstallOptions): void {
  const repoRoot = resolveRepoRoot(opts)
  if (!repoRoot && !sensingBundleReady(ROBRAIN_MCP_DIR)) {
    console.log(chalk.red('\n  ✗ Sensing MCP bundle missing.'))
    console.log(chalk.dim('    Expected: ') + join(ROBRAIN_MCP_DIR, 'sensing', 'dist', 'index.js'))
    console.log(chalk.dim('\n    Fix: from your robrain clone run ') + chalk.cyan('pnpm install') + chalk.dim(' + ') + chalk.cyan('pnpm build'))
    console.log(chalk.dim('    Then reinstall with: ') + chalk.cyan('robrain install --repo-root /path/to/robrain'))
    console.log(chalk.dim('    (or set ') + chalk.cyan('ROBRAIN_REPO') + chalk.dim(' to that path)\n'))
    process.exit(1)
  }
  if (!repoRoot && sensingBundleReady(ROBRAIN_MCP_DIR)) return

  try {
    ensureSensingMcpBundle(repoRoot!, ROBRAIN_MCP_DIR)
  } catch (e) {
    if (e instanceof McpBundleError) {
      console.log(chalk.red(`\n  ✗ ${e.message}\n`))
      process.exit(1)
    }
    throw e
  }
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

  // ── Step 4: Embedding provider ─────────────────────────────
  let embeddingProvider = provisioned.embeddingProvider
  let embeddingKey      = ''

  if (!embeddingProvider) {
    console.log()
    const { provider } = await prompts({
      type:    'select',
      name:    'provider',
      message: 'Choose embedding provider (for semantic search):',
      choices: [
        { title: 'OpenAI  text-embedding-3-small (~$0.00002/1k tokens)', value: 'openai' },
        { title: 'Voyage  voyage-3-lite (fast, cheap alternative)',       value: 'voyage' },
        { title: 'Cohere  embed-english-v3.0 (higher quality)',           value: 'cohere' },
      ],
    })
    embeddingProvider = provider as string

    const keyName = {
      openai: 'OPENAI_API_KEY',
      voyage: 'VOYAGE_API_KEY',
      cohere: 'COHERE_API_KEY',
    }[embeddingProvider] ?? 'EMBEDDING_API_KEY'

    const { key } = await prompts({
      type:    'password',
      name:    'key',
      message: `${keyName}:`,
    })
    embeddingKey = key as string
  }

  // ── Step 5: Detect / select editors ───────────────────────
  const detected = detectEditors()

  let editorsToConfig = detected
  if (opts.editor) {
    editorsToConfig = detected.filter(e => e.editor === opts.editor)
    if (editorsToConfig.length === 0) {
      // Force the specified editor even if not detected
      const configPaths: Record<string, string> = {
        'claude-code': join(homedir(), '.claude.json'),
        'cursor':      join(homedir(), '.cursor', 'mcp.json'),
      }
      const configPath = configPaths[opts.editor]
      if (configPath) {
        editorsToConfig = [{
          editor:     opts.editor as 'claude-code' | 'cursor',
          configPath,
          label:      opts.editor,
        }]
      }
    }
  } else if (detected.length === 0) {
    console.log(chalk.yellow('\n  No AI editors detected. Configuring Claude Code by default.'))
    editorsToConfig = [{
      editor:     'claude-code',
      configPath: join(homedir(), '.claude.json'),
      label:      'Claude Code',
    }]
  } else if (detected.length > 1) {
    console.log()
    const { chosen } = await prompts({
      type:    'multiselect',
      name:    'chosen',
      message: 'Configure RoBrain for which editors?',
      choices: detected.map(e => ({ title: e.label, value: e.editor, selected: true })),
    })
    editorsToConfig = detected.filter(e => (chosen as string[]).includes(e.editor))
  }

  // ── Step 6: Write MCP configs ──────────────────────────────
  spinner.start('Writing MCP configuration...')

  const includeControl = controlBundleReady(ROBRAIN_MCP_DIR)

  const mcpOpts = {
    sensingMcpPath:    join(ROBRAIN_MCP_DIR, 'sensing', 'dist', 'index.js'),
    controlMcpPath:    join(ROBRAIN_MCP_DIR, 'control', 'dist', 'index.js'),
    anthropicKey:      process.env.ANTHROPIC_API_KEY ?? '',
    perceptionUrl:     provisioned.perceptionUrl,
    perceptionKey:     provisioned.perceptionKey,
    planningUrl:       provisioned.planningUrl,
    planningKey:       provisioned.planningKey,
    embeddingProvider: embeddingProvider ?? 'openai',
    embeddingKey,
    includeControl,
  }

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
    perceptionUrl:     provisioned.perceptionUrl,
    perceptionKey:     provisioned.perceptionKey,
    planningUrl:       provisioned.planningUrl,
    planningKey:       provisioned.planningKey,
    embeddingProvider: embeddingProvider ?? 'openai',
    installedAt:       new Date().toISOString(),
    version:           '0.1.0',
  })

  spinner.succeed('MCP servers configured')

  // ── Done ───────────────────────────────────────────────────
  console.log()
  console.log(chalk.green('  ✓ RoBrain installed successfully\n'))
  console.log(chalk.dim('  Configured for: ') + editorsToConfig.map(e => e.label).join(', '))
  console.log()
  console.log(chalk.bold('  Next step:') + chalk.dim(' initialize your project memory'))
  console.log(chalk.dim('  Run in your project root: ') + chalk.cyan('robrain init-project'))
  console.log()

  // Check if ANTHROPIC_API_KEY is set — needed by Sensing
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(chalk.yellow('  ⚠ ANTHROPIC_API_KEY not found in environment.'))
    console.log(chalk.dim('  Add it to your shell profile and re-run, or set it in the MCP config manually.'))
    console.log()
  }
}

// ── Self-hosted install ────────────────────────────────────────
// Skips Rory Plans auth. Points Sensing MCP at a local
// Perception instance started with pnpm docker:up.

async function installSelfHosted(opts: InstallOptions): Promise<void> {
  const perceptionUrl = opts.perceptionUrl ?? 'http://localhost:3001'

  console.log(chalk.bold('  Self-hosted mode\n'))
  console.log(chalk.dim('  Sensing MCP will connect to: ') + chalk.cyan(perceptionUrl))
  console.log(chalk.dim('  Make sure Perception is running: ') + chalk.cyan('pnpm docker:up\n'))

  // Prompt for embedding provider
  const { provider } = await prompts({
    type:    'select',
    name:    'provider',
    message: 'Embedding provider (must match what you set in docker/.env):',
    choices: [
      { title: 'OpenAI  text-embedding-3-small', value: 'openai'  },
      { title: 'Voyage  voyage-3-lite',           value: 'voyage'  },
      { title: 'Cohere  embed-english-v3.0',       value: 'cohere'  },
    ],
  })

  const keyName  = { openai: 'OPENAI_API_KEY', voyage: 'VOYAGE_API_KEY', cohere: 'COHERE_API_KEY' }[provider as string] ?? 'EMBEDDING_API_KEY'

  let embKey = process.env[keyName] ?? ''
  if (embKey) {
    console.log(chalk.dim(`  Using ${keyName} from environment`))
  } else {
    const answer = await prompts({ type: 'password', name: 'embKey', message: `${keyName}:` })
    embKey = answer.embKey as string
  }

  let anthropicKey = process.env.ANTHROPIC_API_KEY ?? ''
  if (anthropicKey) {
    console.log(chalk.dim('  Using ANTHROPIC_API_KEY from environment'))
  } else {
    const answer = await prompts({ type: 'password', name: 'anthropicKey', message: 'ANTHROPIC_API_KEY (for Sensing classifiers):' })
    anthropicKey = answer.anthropicKey as string
  }

  // Detect editors
  const detected = detectEditors()
  const editorsToConfig = detected.length > 0 ? detected : [{
    editor:     'claude-code' as const,
    configPath: join(homedir(), '.claude.json'),
    label:      'Claude Code',
  }]

  const spinner = ora('Writing MCP configuration...').start()

  const mcpOpts = {
    sensingMcpPath:    join(ROBRAIN_MCP_DIR, 'sensing', 'dist', 'index.js'),
    controlMcpPath:    join(ROBRAIN_MCP_DIR, 'control', 'dist', 'index.js'),
    anthropicKey,
    perceptionUrl,
    perceptionKey:     '',
    planningUrl:       '',    // no Planning in self-hosted OSS
    planningKey:       '',
    embeddingProvider: provider as string,
    embeddingKey:      embKey,
    includeControl:    false as const,
  }

  for (const editor of editorsToConfig) {
    writeMcpConfig(editor.configPath, mcpOpts)
  }

  mergeConfig({
    perceptionUrl,
    embeddingProvider: provider as string,
    installedAt:       new Date().toISOString(),
    version:           '0.1.0',
    selfHosted:        true,
  })

  spinner.succeed('MCP servers configured for self-hosted mode')

  console.log()
  console.log(chalk.green('  ✓ RoBrain (self-hosted) installed\n'))
  console.log(chalk.dim('  Perception: ') + chalk.cyan(perceptionUrl))
  console.log(chalk.dim('  Planning + Control injection: ') + chalk.yellow('not available in self-hosted OSS'))
  console.log()
  console.log(chalk.dim('  Context retrieval: use ') + chalk.cyan('robrain inject') + chalk.dim(' to get context for manual paste'))
  console.log()
  console.log(chalk.bold('  Next: ') + chalk.dim('run ') + chalk.cyan('robrain init-project') + chalk.dim(' in your repo root'))
  console.log()
  console.log(chalk.dim('  Want automatic injection without pasting?'))
  console.log(chalk.dim('  → ') + chalk.cyan('roryplans.ai') + chalk.dim(' — Control MCP handles it automatically'))
  console.log()
}

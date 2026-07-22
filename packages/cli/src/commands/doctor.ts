// src/commands/doctor.ts
// robrain doctor — diagnose a RoBrain setup end to end.
// Each check prints ✓ / ⚠ / ✗ with a fix hint; exits non-zero when any
// check fails so it can gate scripts and bug reports.

import chalk from 'chalk'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { cwd } from 'process'
import { readConfig, isAuthenticated } from '../lib/config.js'
import { sensingBundleReady, resolveInstalledSensingMcpDir } from '../lib/mcp-bundle.js'
import { detectEditors, resolveOpenAiBaseUrlFromEnv, usingLocalOpenAi } from '../lib/editor.js'
import { gatherProjectInfo } from '../lib/project.js'

const ROBRAIN_MCP_DIR = join(homedir(), '.robrain', 'mcp')
const HEALTH_TIMEOUT_MS = 3_000

type Level = 'pass' | 'warn' | 'fail'

interface Check {
  level:   Level
  label:   string
  detail?: string
  hint?:   string
}

function printCheck(c: Check): void {
  const mark =
    c.level === 'pass' ? chalk.green('✓') :
    c.level === 'warn' ? chalk.yellow('⚠') :
    chalk.red('✗')
  console.log(`  ${mark} ${c.label}` + (c.detail ? chalk.dim(` — ${c.detail}`) : ''))
  if (c.hint) console.log(chalk.dim(`      → ${c.hint}`))
}

export async function doctorCommand(): Promise<void> {
  console.log()
  console.log(chalk.bold('  RoBrain doctor\n'))

  const checks: Check[] = []
  const config = readConfig()

  // 1 — local install / auth
  if (isAuthenticated()) {
    checks.push({
      level:  'pass',
      label:  'Install config',
      detail: config.token && config.email ? `cloud (${config.email})` : 'self-hosted (OSS)',
    })
  } else {
    checks.push({
      level: 'fail',
      label: 'Install config',
      detail: '~/.robrain/config.json missing or incomplete',
      hint:  'Run: npx robrain install (cloud) or npx robrain install --self-hosted --repo-root <robrain-clone>',
    })
  }

  // 2 — Sensing MCP bundle (install path) + portable launch (robrain mcp)
  const portableMcpDir = resolveInstalledSensingMcpDir()
  if (sensingBundleReady(ROBRAIN_MCP_DIR)) {
    checks.push({ level: 'pass', label: 'Sensing MCP bundle', detail: join(ROBRAIN_MCP_DIR, 'sensing') })
  } else {
    checks.push({
      level: 'fail',
      label: 'Sensing MCP bundle',
      detail: `no complete bundle under ${join(ROBRAIN_MCP_DIR, 'sensing')}`,
      hint:  'Run: npx robrain install --self-hosted. Or use a portable mcp.json with `npx robrain mcp` (see docs/cli.md)',
    })
  }
  if (portableMcpDir) {
    checks.push({
      level:  'pass',
      label:  'Portable MCP launch',
      detail: '`robrain mcp` — stdio config for MCP directories / hand-written mcp.json',
    })
  } else {
    checks.push({
      level: 'fail',
      label: 'Portable MCP launch',
      detail: 'bundled Sensing server not found in this CLI install',
      hint:  'Reinstall: npm install -g robrain@latest (or npx robrain@latest mcp from a built clone)',
    })
  }

  // 3 — editor wiring (all editor config formats mention the server by name)
  const editors = detectEditors()
  const wired = editors.filter(e => {
    try {
      return existsSync(e.configPath) && readFileSync(e.configPath, 'utf8').includes('robrain-sensing')
    } catch {
      return false
    }
  })
  if (wired.length > 0) {
    checks.push({
      level:  'pass',
      label:  'Editor wiring',
      detail: wired.map(e => e.label).join(', '),
    })
  } else {
    checks.push({
      level: 'fail',
      label: 'Editor wiring',
      detail: editors.length > 0
        ? `detected ${editors.map(e => e.label).join(', ')} but none reference robrain-sensing`
        : 'no supported editor detected',
      hint:  'Run: npx robrain install (add --editor claude-code | cursor | copilot | codex to target one)',
    })
  }

  // 4 — API keys. Warn-only: editor configs carry their own env block, so a
  // missing shell key does not necessarily break Sensing inside the editor.
  // Cloud thin-client installs need neither key locally — Sensing ships raw
  // turns and classification/embeddings run server-side.
  if (config.thin) {
    checks.push({ level: 'pass', label: 'Reasoning LLM key', detail: 'not needed — cloud thin client (server-side classification)' })
    checks.push({ level: 'pass', label: 'Embedding key', detail: 'not needed — cloud thin client (server-side embeddings)' })
  } else {
    // A non-default OPENAI_BASE_URL means a local OpenAI-compatible server
    // (Ollama / LM Studio / vLLM) — those usually run keyless.
    const localOpenAi = usingLocalOpenAi()
    const llmKey = process.env.LLM_PROVIDER === 'openai'
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY
    checks.push(llmKey
      ? { level: 'pass', label: 'Reasoning LLM key', detail: process.env.LLM_PROVIDER === 'openai' ? 'OPENAI_API_KEY set' : 'ANTHROPIC_API_KEY set' }
      : process.env.LLM_PROVIDER === 'openai' && localOpenAi
      ? { level: 'pass', label: 'Reasoning LLM key', detail: `not needed — local server via OPENAI_BASE_URL (${resolveOpenAiBaseUrlFromEnv()})` }
      : {
          level: 'warn',
          label: 'Reasoning LLM key',
          detail: 'not found in shell env / .env (decision extraction is skipped without it)',
          hint:  'Set ANTHROPIC_API_KEY (or LLM_PROVIDER=openai + OPENAI_API_KEY) in the repo .env',
        })
    const embeddingKeySet = Boolean(config.embeddingKey) ||
      Boolean(process.env.OPENAI_API_KEY || process.env.VOYAGE_API_KEY || process.env.COHERE_API_KEY)
    checks.push(embeddingKeySet
      ? { level: 'pass', label: 'Embedding key', detail: config.embeddingProvider ?? 'openai' }
      : (config.embeddingProvider ?? 'openai') === 'openai' && localOpenAi
      ? { level: 'pass', label: 'Embedding key', detail: `not needed — local server via OPENAI_BASE_URL (${resolveOpenAiBaseUrlFromEnv()})` }
      : {
          level: 'warn',
          label: 'Embedding key',
          detail: 'no embedding provider key found (topic-shift and semantic search need one)',
          hint:  'Set OPENAI_API_KEY (or VOYAGE_API_KEY / COHERE_API_KEY) and re-run npx robrain install',
        })
  }

  // 5 — Perception health. A dead Perception is the classic silent failure:
  // Sensing blocks on it at session start, so the editor's first reply can
  // hang for minutes with no visible error.
  const perceptionUrl = config.perceptionUrl ?? process.env.PERCEPTION_API_URL
  let perceptionUp = false
  if (!perceptionUrl) {
    checks.push({
      level: 'fail',
      label: 'Perception API',
      detail: 'no URL configured (config.json perceptionUrl / PERCEPTION_API_URL)',
      hint:  'Run: npx robrain install (cloud) or pnpm docker:up + npx robrain install --self-hosted',
    })
  } else {
    try {
      const res = await fetch(`${perceptionUrl}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      perceptionUp = res.ok
      checks.push(res.ok
        ? { level: 'pass', label: 'Perception API', detail: `${perceptionUrl} healthy` }
        : {
            level: 'fail',
            label: 'Perception API',
            detail: `${perceptionUrl} answered HTTP ${res.status}`,
            hint:  'Check the Perception logs (self-hosted: docker compose -f docker/docker-compose.yml logs perception)',
          })
    } catch {
      checks.push({
        level: 'fail',
        label: 'Perception API',
        detail: `${perceptionUrl} unreachable — Sensing will stall waiting on it (slow first reply in the editor)`,
        hint:  'Self-hosted: pnpm docker:up in the robrain clone. Cloud: check your network / status page.',
      })
    }
  }

  // 6 — current project registered (only meaningful when Perception is up)
  if (perceptionUp && perceptionUrl) {
    const info = gatherProjectInfo(cwd())
    try {
      const key = config.perceptionKey ?? process.env.PERCEPTION_API_KEY
      const res = await fetch(`${perceptionUrl}/projects`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal:  AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      if (res.ok) {
        const data = await res.json() as { projects?: Array<{ id: string }> }
        const registered = data.projects?.some(p => p.id === info.id) ?? false
        checks.push(registered
          ? { level: 'pass', label: 'Project registered', detail: info.id }
          : {
              level: 'warn',
              label: 'Project registered',
              detail: `${info.id} not found in Perception (signals from this repo would be rejected)`,
              hint:  'Run: npx robrain init-project in this directory',
            })
      } else {
        checks.push({
          level: 'warn',
          label: 'Project registered',
          detail: `could not list projects (HTTP ${res.status})`,
          hint:  res.status === 401 ? 'Perception key mismatch — set perceptionKey in ~/.robrain/config.json or PERCEPTION_API_KEY' : undefined,
        })
      }
    } catch {
      checks.push({ level: 'warn', label: 'Project registered', detail: 'could not list projects' })
    }
  }

  for (const c of checks) printCheck(c)

  const failures = checks.filter(c => c.level === 'fail').length
  const warnings = checks.filter(c => c.level === 'warn').length
  console.log()
  if (failures > 0) {
    console.log(chalk.red(`  ${failures} check(s) failed`) + (warnings ? chalk.yellow(`, ${warnings} warning(s)`) : ''))
    process.exitCode = 1
  } else if (warnings > 0) {
    console.log(chalk.yellow(`  All required checks passed — ${warnings} warning(s)`))
  } else {
    console.log(chalk.green('  All checks passed'))
  }
  console.log()
}

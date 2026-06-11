// src/lib/project.ts
// ─────────────────────────────────────────────────────────────
// Handles project initialization — warm-starts the memory store
// from existing codebase context (package.json, README, git log,
// CLAUDE.md, AGENTS.md) so session 1 starts with knowledge rather than blank.
// ─────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { execSync } from 'child_process'
import { createHash } from 'crypto'

export interface ProjectInfo {
  id:          string    // deterministic hash of cwd
  name:        string    // from package.json name or dirname
  description: string   // from package.json description or README excerpt
  stack:       string[] // inferred from package.json dependencies
  gitLog:      string   // recent commit messages
  mission:     string   // synthesised project mission
}

/** Derive a stable project ID from the working directory path */
export function deriveProjectId(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

/** Read the project_id written by init-project from CLAUDE.md / AGENTS.md / Cursor rule */
function readProjectIdFromEditorFiles(dir: string): string | null {
  const candidates = [
    join(dir, 'CLAUDE.md'),
    join(dir, 'AGENTS.md'),
    join(dir, '.cursor', 'rules', 'robrain.mdc'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    const match = readFileSync(p, 'utf8').match(/project_id="([^"]+)"/)
    if (match?.[1]) return match[1].trim()
  }
  return null
}

/** Collect all available context from the project root */
export function gatherProjectInfo(cwd: string): ProjectInfo {
  const id   = readProjectIdFromEditorFiles(cwd) ?? deriveProjectId(cwd)
  let name   = basename(cwd)
  let desc   = ''
  let stack: string[] = []

  // package.json
  const pkgPath = join(cwd, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string
        description?: string
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }
      if (pkg.name)        name = pkg.name
      if (pkg.description) desc = pkg.description
      stack = Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
      }).slice(0, 20)   // top 20 deps as stack signal
    } catch { /* ignore */ }
  }

  // README excerpt (first 500 chars)
  const readmePaths = ['README.md', 'readme.md', 'README.txt', 'README']
  let readme = ''
  for (const rp of readmePaths) {
    const full = join(cwd, rp)
    if (existsSync(full)) {
      readme = readFileSync(full, 'utf8').slice(0, 500)
      break
    }
  }
  if (!desc && readme) {
    desc = readme.replace(/^#+\s*/gm, '').replace(/\n+/g, ' ').slice(0, 200)
  }

  // AGENTS.md excerpt (Codex / agent instruction files)
  if (!desc) {
    for (const ap of ['AGENTS.md', 'agents.md']) {
      const agentsPath = join(cwd, ap)
      if (existsSync(agentsPath)) {
        const excerpt = readFileSync(agentsPath, 'utf8').slice(0, 500)
        desc = excerpt.replace(/^#+\s*/gm, '').replace(/\n+/g, ' ').slice(0, 200)
        break
      }
    }
  }

  // Git log — last 20 commits
  let gitLog = ''
  try {
    gitLog = execSync('git log --oneline -20', { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch { /* not a git repo */ }

  // Synthesise mission from available info
  const mission = desc
    ? desc.slice(0, 120)
    : `${name} — project context being built from sessions`

  return { id, name, description: desc, stack, gitLog, mission }
}

/** Format project info as context string for Haiku warm-start call */
export function buildInitContext(info: ProjectInfo): string {
  const parts: string[] = []

  parts.push(`Project: ${info.name}`)
  if (info.description) parts.push(`Description: ${info.description}`)
  if (info.stack.length) parts.push(`Stack: ${info.stack.join(', ')}`)
  if (info.gitLog) parts.push(`Recent commits:\n${info.gitLog}`)

  return parts.join('\n\n')
}

/** Minimum confidence for inferred init decisions — must match Perception OSS gate (THRESHOLDS.DECISION_CONFIDENCE_MIN). */
const INIT_DECISION_MIN_CONFIDENCE = 0.6

/** Call Perception to register project and seed warm-start summary */
export async function seedProjectMemory(
  perceptionUrl: string,
  perceptionKey: string,
  info: ProjectInfo,
  /** Absolute project root — stored on Perception for post-Synthesis `export-memory` (F2). */
  workingDirectory: string,
): Promise<{ ok: boolean; decisionsWritten: number }> {
  try {
    // 1. Register the project (required for sessions / signals FK chain)
    const regRes = await fetch(`${perceptionUrl}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(perceptionKey ? { 'Authorization': `Bearer ${perceptionKey}` } : {}),
      },
      body: JSON.stringify({ id: info.id, name: info.name, working_directory: workingDirectory }),
    })
    if (!regRes.ok) {
      const detail = await regRes.text().catch(() => '')
      console.error('[init-project] POST /projects failed:', regRes.status, detail)
      return { ok: false, decisionsWritten: 0 }
    }

    // 2. Use Anthropic to infer architectural decisions from context
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    if (!anthropicKey) {
      return { ok: true, decisionsWritten: 0 }
    }

    const context = buildInitContext(info)

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: `You infer architectural decisions from project context for an AI memory system.
Output ONLY valid JSON: an array of decision objects.
Each object: {"decision": string, "rationale": string|null, "rejected": [], "confidence": number}
Infer 3-5 decisions visible from the tech stack and project description.
Examples: database choice, framework choice, architecture pattern, language choice.
Confidence 0.7 for inferred decisions. Keep rationale under 15 words.
If not enough context: output [].
No explanation outside the JSON.`,
        messages: [{
          role: 'user',
          content: `Infer architectural decisions from this project context:\n\n${context}`,
        }],
      }),
    })

    if (!resp.ok) return { ok: true, decisionsWritten: 0 }

    const data = await resp.json() as { content: Array<{ type: string; text: string }> }
    const text = data.content.find(c => c.type === 'text')?.text ?? '[]'

    let decisions: Array<{
      decision: string
      rationale: string | null
      rejected: unknown[]
      confidence: number
    }> = []

    try {
      decisions = JSON.parse(text.trim())
      if (!Array.isArray(decisions)) decisions = []
    } catch { decisions = [] }

    // 3. Seed inferred decisions (sessions rows are created inside POST /signals; stub signal removed — it was discarded by the confidence gate)
    const sessionId = `init-${info.id}-${Date.now()}`
    let written = 0
    for (const d of decisions.slice(0, 5)) {
      if (!d.decision || d.confidence < INIT_DECISION_MIN_CONFIDENCE) continue

      const res = await fetch(`${perceptionUrl}/signals`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          ...(perceptionKey ? { 'Authorization': `Bearer ${perceptionKey}` } : {}),
          'X-Project-Id':  info.id,
        },
        body: JSON.stringify({
          signal: {
            turn: {
              session_id:    sessionId,
              sequence:      written + 2,
              user_message:  'init-project scan',
              claude_reply:  `${d.decision}${d.rationale ? ` because ${d.rationale}` : ''}`,
              files_touched: [],
              timestamp:     new Date().toISOString(),
            },
            decision_type: 'architectural',
            confidence:    d.confidence,
            files_affected: [],
            scope:         'team',
          },
        }),
      })

      if (res.ok) written++
    }

    // 4. Trigger summary regeneration
    await fetch(`${perceptionUrl}/projects/${info.id}/regenerate-summary`, {
      method: 'POST',
      headers: perceptionKey ? { 'Authorization': `Bearer ${perceptionKey}` } : {},
    }).catch(() => { /* ignore */ })

    return { ok: true, decisionsWritten: written }

  } catch {
    return { ok: false, decisionsWritten: 0 }
  }
}

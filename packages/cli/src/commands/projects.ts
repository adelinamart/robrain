// src/commands/projects.ts
// ─────────────────────────────────────────────────────────────
// robrain projects list | merge — manage Perception project rows
// (recover from phantom project_ids after cwd moves / typos).
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { normalizeLoopbackUrl, readConfig } from '../lib/config.js'

export function perceptionEndpoint(): { url: string; key: string } {
  const config = readConfig()
  const url = normalizeLoopbackUrl(
    config.perceptionUrl ??
    process.env.PERCEPTION_URL ??
    'http://127.0.0.1:3001',
  )
  const key = config.perceptionKey ?? process.env.PERCEPTION_API_KEY ?? ''
  return { url, key }
}

export function exitUnreachable(url: string, err: unknown): never {
  console.log(chalk.red('  ✗ Perception is unreachable'))
  console.log(chalk.dim(`  ${url} — ${err instanceof Error ? err.message : String(err)}`))
  console.log(chalk.dim('  Start it with ') + chalk.cyan('npx robrain up') + chalk.dim(' (or pnpm docker:up from a clone).\n'))
  process.exit(1)
}

/** Project ids are [a-z0-9._-], 2 to 200 chars; the same folding the install path applies. */
export function normalizeProjectId(raw: string): string | null {
  const id = raw.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{1,199}$/.test(id) ? id : null
}

/**
 * robrain projects create <id> [--name <name>]
 * A project that is not derived from a repository: one a team shares across
 * several repos, or one per team inside an org. Upserts on both editions
 * (POST /projects); on RoBrain cloud the project belongs to the caller's org.
 */
export async function projectsCreateCommand(rawId: string, opts: { name?: string; tag?: string[] }): Promise<void> {
  console.log()
  const id = normalizeProjectId(rawId)
  if (!id) {
    console.log(chalk.red(`  ✗ "${rawId}" is not a valid project id (letters, digits, . _ -, 2 to 200 characters).\n`))
    process.exit(1)
  }
  const name = opts.name?.trim() || id
  const tags = normalizeTags(opts.tag ?? [])
  const { url, key } = perceptionEndpoint()
  const res = await fetch(`${url}/projects`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body:    JSON.stringify({ id, name, type: 'coding', ...(tags.length ? { tags } : {}) }),
  }).catch((err: unknown) => exitUnreachable(url, err))
  const payload = await res.json().catch(() => ({})) as { error?: string; message?: string; tags?: string[] }
  if (res.status === 409) {
    console.log(chalk.red(`  ✗ Project id "${id}" belongs to another org. Pick a different id.\n`))
    process.exit(1)
  }
  if (!res.ok) {
    console.log(chalk.red(`  ✗ Could not create project (${res.status})`) + chalk.dim(`  ${payload.message ?? payload.error ?? ''}\n`))
    process.exit(1)
  }
  console.log(chalk.green('  ✓ Project ready') + chalk.dim(`  ${id} (${name})${payload.tags?.length ? ` · tags: ${payload.tags.join(', ')}` : ''}`))
  console.log(chalk.dim('    Use it from any repo with ') + chalk.cyan(`ROBRAIN_PROJECT_ID=${id}`) + chalk.dim(' or --project-id on capture, search and rules commands.\n'))
}

/** Tags are letters, digits, _ and -, at most 10; invalid ones are dropped with a note. */
export function normalizeTags(raw: readonly string[]): string[] {
  const out: string[] = []
  for (const item of raw) {
    for (const piece of item.split(',')) {
      const tag = piece.trim().toLowerCase()
      if (!tag) continue
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(tag)) {
        console.log(chalk.yellow(`  Skipping tag "${piece.trim()}": letters, digits, _ and -, at most 40 characters.`))
        continue
      }
      if (!out.includes(tag) && out.length < 10) out.push(tag)
    }
  }
  return out
}

interface ProjectTags {
  tags: string[]
  declared_tags: string[]
  derived_tags: string[]
  suppressed_tags: string[]
  observed_tools: Record<string, number>
}

function printProjectTags(id: string, t: ProjectTags): void {
  const line = (label: string, items: string[]) => chalk.dim(`    ${label.padEnd(10)}`) + (items.length ? items.join(', ') : chalk.dim('(none)'))
  console.log(chalk.green('  ✓ Tags') + chalk.dim(`  ${id}: `) + (t.tags.length ? t.tags.join(', ') : chalk.dim('(none)')))
  console.log(line('declared', t.declared_tags))
  console.log(line('from tools', t.derived_tags))
  if (t.suppressed_tags.length) console.log(line('removed', t.suppressed_tags))
  const tools = Object.entries(t.observed_tools ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8)
  if (tools.length) console.log(chalk.dim(`    tools     ${tools.map(([n, c]) => `${n} ×${c}`).join(', ')}`))
  console.log(chalk.dim('    Push a rule to this kind of agent with robrain promote <decision-id> --to tag:<tag>\n'))
}

/**
 * robrain projects tag <id> [tags...] [--suppress <tag>]... [--unsuppress <tag>]...
 * RoBrain cloud. A project's effective tags are the declared ones (set
 * here, or by the developer at registration), plus the ones the org's
 * tool→tag mapping derives from the tools the agent uses, minus the ones
 * an admin removed. Changing a production agent's tags needs an admin.
 * Self-hosted Perception has no tags (one project by decision).
 */
export async function projectsTagCommand(
  rawId: string,
  rawTags: string[],
  opts: { suppress?: string[]; unsuppress?: string[]; show?: boolean } = {},
): Promise<void> {
  console.log()
  const id = rawId.trim()
  const { url, key } = perceptionEndpoint()
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
  const nothingToChange = rawTags.length === 0 && !opts.suppress?.length && !opts.unsuppress?.length
  const body: Record<string, unknown> = {}
  if (rawTags.length) body.tags = normalizeTags(rawTags)
  if (opts.suppress?.length) body.suppress = normalizeTags(opts.suppress)
  if (opts.unsuppress?.length) body.unsuppress = normalizeTags(opts.unsuppress)
  const res = await fetch(`${url}/projects/${encodeURIComponent(id)}/tags`, nothingToChange || opts.show
    ? { headers }
    : { method: 'PUT', headers, body: JSON.stringify(body) },
  ).catch((err: unknown) => exitUnreachable(url, err))
  const payload = await res.json().catch(() => ({})) as Partial<ProjectTags> & { error?: string; message?: string }
  if (res.status === 404 && !payload.error) {
    console.log(chalk.yellow('  Tags are a RoBrain cloud feature; this self-hosted Perception keeps one project and has none.\n'))
    process.exit(1)
  }
  if (res.status === 403) {
    console.log(chalk.red('  ✗ Only an org admin can change the tags of a production agent.\n'))
    process.exit(1)
  }
  if (!res.ok) {
    console.log(chalk.red(`  ✗ Could not ${nothingToChange ? 'read' : 'set'} tags (${res.status})`) + chalk.dim(`  ${payload.message ?? payload.error ?? ''}\n`))
    process.exit(1)
  }
  printProjectTags(id, {
    tags: payload.tags ?? [], declared_tags: payload.declared_tags ?? [], derived_tags: payload.derived_tags ?? [],
    suppressed_tags: payload.suppressed_tags ?? [], observed_tools: payload.observed_tools ?? {},
  })
}

/**
 * robrain tags map                      list the org's tool→tag mapping
 * robrain tags map add <pattern> <tag>  e.g. "send_email*" email
 * robrain tags map remove <pattern> <tag>
 * RoBrain cloud, admins. A tag is derived for an agent once a tool matching
 * a pattern has been used in three turns (or was declared with the agent).
 */
export async function tagsMapCommand(action: 'list' | 'add' | 'remove', pattern?: string, tag?: string): Promise<void> {
  console.log()
  const { url, key } = perceptionEndpoint()
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
  const getRes = await fetch(`${url}/org/tag-rules`, { headers }).catch((err: unknown) => exitUnreachable(url, err))
  const current = await getRes.json().catch(() => ({})) as { rules?: Array<{ pattern: string; tag: string }>; use_threshold?: number; error?: string }
  if (getRes.status === 404 && !current.error) {
    console.log(chalk.yellow('  The tool→tag mapping is a RoBrain cloud feature; self-hosted Perception has none.\n'))
    process.exit(1)
  }
  if (!getRes.ok) {
    console.log(chalk.red(`  ✗ Could not read the mapping (${getRes.status})\n`))
    process.exit(1)
  }
  let rules = current.rules ?? []
  if (action !== 'list') {
    const p = (pattern ?? '').trim().toLowerCase()
    const t = normalizeTags([tag ?? ''])[0]
    if (!p || !t) {
      console.log(chalk.red(`  ✗ Usage: robrain tags map ${action} "<tool pattern>" <tag>   e.g. "send_email*" email\n`))
      process.exit(1)
    }
    rules = action === 'add'
      ? [...rules.filter(r => !(r.pattern === p && r.tag === t)), { pattern: p, tag: t }]
      : rules.filter(r => !(r.pattern === p && r.tag === t))
    const putRes = await fetch(`${url}/org/tag-rules`, { method: 'PUT', headers, body: JSON.stringify({ rules }) })
      .catch((err: unknown) => exitUnreachable(url, err))
    const saved = await putRes.json().catch(() => ({})) as { rules?: Array<{ pattern: string; tag: string }>; dropped?: number; error?: string; message?: string }
    if (putRes.status === 403) {
      console.log(chalk.red('  ✗ Only an org admin can change the tool→tag mapping.\n'))
      process.exit(1)
    }
    if (!putRes.ok) {
      console.log(chalk.red(`  ✗ Could not save the mapping (${putRes.status})`) + chalk.dim(`  ${saved.message ?? saved.error ?? ''}\n`))
      process.exit(1)
    }
    if (saved.dropped) console.log(chalk.yellow(`  ${saved.dropped} malformed rule(s) were dropped (tool patterns: letters, digits, . _ : / - and *).`))
    rules = saved.rules ?? rules
  }
  if (!rules.length) {
    console.log(chalk.dim('  No tool→tag mapping yet. Add one with: robrain tags map add "send_email*" email\n'))
    return
  }
  console.log(chalk.bold('  Tool → tag mapping') + chalk.dim(`  (a tag applies after a matching tool was used in ${current.use_threshold ?? 3} turns)`))
  for (const r of rules) console.log(`    ${r.pattern.padEnd(28)} → ${r.tag}`)
  console.log()
}

export async function projectsListCommand(): Promise<void> {
  console.log()
  const { url, key } = perceptionEndpoint()
  const res = await fetch(`${url}/projects`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  }).catch((err: unknown) => exitUnreachable(url, err))

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    console.log(chalk.red(`  ✗ Could not list projects (${res.status})`))
    console.log(chalk.dim(`  ${t.slice(0, 400)}`))
    console.log(chalk.dim(`  Perception: ${url}\n`))
    process.exit(1)
  }

  const data = await res.json() as {
    projects: Array<{
      id: string
      name: string
      session_count: number
      decision_count: number
      updated_at?: string
    }>
  }

  const rows = data.projects ?? []
  if (rows.length === 0) {
    console.log(chalk.dim('  No projects in Perception yet.'))
    console.log(chalk.dim('  Run ') + chalk.cyan('npx robrain init-project') + chalk.dim(' from a repo root.\n'))
    return
  }

  console.log(chalk.bold('  Projects in Perception'))
  console.log(chalk.dim(`  ${url}\n`))
  const idW = Math.max(12, ...rows.map(r => r.id.length))
  console.log(
    `  ${'id'.padEnd(idW)}  ${'sessions'.padStart(8)}  ${'decisions'.padStart(9)}  name`,
  )
  console.log(chalk.dim(`  ${'─'.repeat(idW + 32)}`))
  for (const p of rows) {
    console.log(
      `  ${chalk.cyan(p.id.padEnd(idW))}  ${String(p.session_count).padStart(8)}  ${String(p.decision_count).padStart(9)}  ${p.name}`,
    )
  }
  console.log()
  console.log(chalk.dim(`  Current directory project id (derived): run init-project in a repo to see the id used here.`))
  console.log()
}

export async function projectsMergeCommand(fromId: string, toId: string): Promise<void> {
  console.log()
  const { url, key } = perceptionEndpoint()

  const res = await fetch(`${url}/projects/merge`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({ from: fromId, to: toId }),
  }).catch((err: unknown) => exitUnreachable(url, err))

  const raw = await res.text()
  if (!res.ok) {
    console.log(chalk.red(`  ✗ Merge failed (${res.status})`))
    try {
      const j = JSON.parse(raw) as { message?: string; hint?: string; detail?: string }
      if (j.message) console.log(chalk.yellow(`  ${j.message}`))
      if (j.hint) console.log(chalk.dim(`  ${j.hint}`))
      if (j.detail) console.log(chalk.dim(`  ${j.detail}`))
    } catch {
      console.log(chalk.dim(raw.slice(0, 500)))
    }
    console.log()
    process.exit(1)
  }

  console.log(chalk.green(`  ✓ Merged project ${chalk.bold(fromId)} → ${chalk.bold(toId)}`))
  console.log(chalk.dim('  Sessions and decisions now use the target project id.\n'))
  console.log(chalk.dim('  If CLAUDE.md / AGENTS.md / Cursor rules still mention the old id, update them or run '))
  console.log(chalk.cyan('npx robrain init-project') + chalk.dim(' in the repo root.\n'))
}

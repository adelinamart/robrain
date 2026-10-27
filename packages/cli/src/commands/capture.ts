// packages/cli/src/commands/capture.ts
// ─────────────────────────────────────────────────────────────
// robrain capture show
// robrain capture set  [--instructions "..." | --instructions-file <path> | --clear-instructions]
//                      [--mode strict|broad] [--min-confidence <0..1> | --reset-min-confidence]
//                      [--add-kind "name: description"]... [--remove-kind <name>]... [--clear-kinds]
// robrain capture test (--file <turns.jsonl> | --user "..." --reply "...") [same flags as set] [--compare]
//
// Tells the classifier, in plain language, what to store for this
// project: narrower or wider than the stock "decisions and their
// rejected alternatives", plus extra kinds of memory. Settings live on
// Perception (projects table) so every teammate's Sensing and the
// server-side re-extraction read the same ones. `test` is a dry run
// against sample turns: nothing is stored.
// ─────────────────────────────────────────────────────────────

import chalk from 'chalk'
import { readFileSync } from 'fs'
import { cwd } from 'process'
import { gatherProjectInfo } from '../lib/project.js'
import { exitUnreachable, perceptionEndpoint } from './projects.js'

// The CLI ships without @robrain/shared on purpose (self-contained tarball),
// so the wire shapes of GET/PUT /projects/:id/capture are restated here.
// Validation is Perception's job; the CLI prints the `errors` it returns.

export const DEFAULT_CAPTURE_KIND = 'decision'

export interface CaptureKind {
  name: string
  description: string
}

export interface CaptureSettings {
  instructions:   string | null
  mode:           'strict' | 'broad'
  confidence_min: number | null
  kinds:          CaptureKind[]
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  instructions:   null,
  mode:           'strict',
  confidence_min: null,
  kinds:          [],
}

export interface CaptureSettingsPatch {
  instructions?:   string | null
  mode?:           string
  confidence_min?: number | null
  kinds?:          CaptureKind[]
}

interface ExtractedDecision {
  decision:   string | null
  rationale:  string | null
  rejected:   Array<{ option: string; reason: string }>
  confidence: number
  kind?:      string
  subject?:   string | null
}

/** Same folding Perception applies to kind names, so add/remove match what is stored. */
export function normalizeKindName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Tolerant reader for the settings Perception returns; bad fields fall back to the defaults. */
export function readCaptureSettings(raw: unknown): CaptureSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const kinds = Array.isArray(r.kinds)
    ? r.kinds.filter((k): k is CaptureKind =>
        Boolean(k) && typeof k === 'object' &&
        typeof (k as CaptureKind).name === 'string' && typeof (k as CaptureKind).description === 'string')
    : []
  return {
    instructions:   typeof r.instructions === 'string' && r.instructions.trim() ? r.instructions : null,
    mode:           r.mode === 'broad' ? 'broad' : 'strict',
    confidence_min: typeof r.confidence_min === 'number' ? r.confidence_min : null,
    kinds,
  }
}

// ── Pure helpers (tested in capture.test.ts) ──────────────────

export interface CaptureSetOptions {
  projectId?:          string
  instructions?:       string
  instructionsFile?:   string
  clearInstructions?:  boolean
  mode?:               string
  minConfidence?:      string
  resetMinConfidence?: boolean
  addKind?:            string[]
  removeKind?:         string[]
  clearKinds?:         boolean
}

export interface CaptureTestOptions extends CaptureSetOptions {
  file?:    string
  user?:    string
  reply?:   string
  compare?: boolean
}

export interface PreviewTurn {
  user_message: string
  claude_reply: string
}

export interface PreviewResult {
  gate:          'keyword' | 'implicit' | 'broad' | 'none'
  reaches_model: boolean
  extracted:     ExtractedDecision | null
  stored:        boolean
  reason?:       string
}

/** "name: description" (or "name = description") → a kind, or an error message. */
export function parseKindFlag(raw: string): { kind: CaptureKind } | { error: string } {
  const match = raw.match(/^\s*([^:=]+?)\s*[:=]\s*(.+?)\s*$/s)
  if (!match) {
    return { error: `--add-kind expects "name: description", got "${raw}"` }
  }
  const name = normalizeKindName(match[1]!)
  if (!name) return { error: `--add-kind: "${match[1]}" is not a usable kind name (letters, digits, - or _)` }
  return { kind: { name, description: match[2]!.trim() } }
}

/**
 * One turn per line, as JSON: {"user_message": "...", "claude_reply": "..."}.
 * Blank lines and comment lines starting with # are skipped.
 */
export function parseTurnsJsonl(text: string): { turns: PreviewTurn[] } | { error: string } {
  const turns: PreviewTurn[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('#')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { error: `line ${i + 1} is not JSON` }
    }
    const t = parsed as Partial<PreviewTurn>
    if (typeof t?.user_message !== 'string' || typeof t?.claude_reply !== 'string') {
      return { error: `line ${i + 1} needs "user_message" and "claude_reply" strings` }
    }
    turns.push({ user_message: t.user_message, claude_reply: t.claude_reply })
  }
  if (turns.length === 0) return { error: 'no turns found in the file' }
  return { turns }
}

/**
 * Turn CLI flags into the patch Perception's PUT accepts. Kind flags are
 * resolved against the current list so add/remove compose; anything the
 * user did not mention is left out of the patch and so unchanged.
 */
export function buildCapturePatch(
  opts: CaptureSetOptions,
  current: CaptureSettings,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): { patch: CaptureSettingsPatch } | { error: string } {
  const patch: CaptureSettingsPatch = {}

  const instructionSources = [opts.instructions !== undefined, opts.instructionsFile !== undefined, opts.clearInstructions === true]
    .filter(Boolean).length
  if (instructionSources > 1) {
    return { error: 'use only one of --instructions, --instructions-file, --clear-instructions' }
  }
  if (opts.clearInstructions) patch.instructions = null
  else if (opts.instructions !== undefined) patch.instructions = opts.instructions
  else if (opts.instructionsFile !== undefined) {
    try {
      patch.instructions = readFile(opts.instructionsFile)
    } catch (err) {
      return { error: `could not read ${opts.instructionsFile}: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  if (opts.mode !== undefined) patch.mode = opts.mode

  if (opts.minConfidence !== undefined && opts.resetMinConfidence) {
    return { error: 'use either --min-confidence or --reset-min-confidence' }
  }
  if (opts.resetMinConfidence) patch.confidence_min = null
  else if (opts.minConfidence !== undefined) {
    const n = Number(opts.minConfidence)
    if (!Number.isFinite(n)) return { error: `--min-confidence must be a number between 0 and 1, got "${opts.minConfidence}"` }
    patch.confidence_min = n
  }

  const touchesKinds = opts.clearKinds || (opts.addKind?.length ?? 0) > 0 || (opts.removeKind?.length ?? 0) > 0
  if (touchesKinds) {
    let kinds: CaptureKind[] = opts.clearKinds ? [] : [...current.kinds]
    for (const raw of opts.removeKind ?? []) {
      const name = normalizeKindName(raw)
      if (!kinds.some(k => k.name === name)) {
        return { error: `--remove-kind: no kind named "${name}" (current: ${kinds.map(k => k.name).join(', ') || 'none'})` }
      }
      kinds = kinds.filter(k => k.name !== name)
    }
    for (const raw of opts.addKind ?? []) {
      const parsed = parseKindFlag(raw)
      if ('error' in parsed) return { error: parsed.error }
      kinds = [...kinds.filter(k => k.name !== parsed.kind.name), parsed.kind]
    }
    patch.kinds = kinds
  }

  return { patch }
}

export function formatCaptureSettings(settings: CaptureSettings, effectiveConfidenceMin: number): string[] {
  const lines: string[] = []
  const modeNote = settings.mode === 'broad'
    ? 'every non-trivial turn reaches the model (one extraction call per turn)'
    : 'keyword gate; roughly 1 turn in 20 reaches the model'
  lines.push(`  Mode:          ${chalk.cyan(settings.mode)}  ${chalk.dim(modeNote)}`)
  const thresholdNote = settings.confidence_min === null ? chalk.dim('(stock)') : chalk.dim('(project override)')
  lines.push(`  Threshold:     ${chalk.cyan(effectiveConfidenceMin.toFixed(2))}  ${thresholdNote}`)
  lines.push(`  Kinds:         ${chalk.cyan(DEFAULT_CAPTURE_KIND)}  ${chalk.dim('(built-in: decisions and their rejected alternatives)')}`)
  for (const k of settings.kinds) {
    lines.push(`                 ${chalk.cyan(k.name)}  ${chalk.dim(k.description)}`)
  }
  if (settings.instructions) {
    lines.push('  Instructions:')
    for (const l of settings.instructions.split('\n')) lines.push(`    ${l}`)
  } else {
    lines.push(`  Instructions:  ${chalk.dim('(none)')}`)
  }
  return lines
}

function excerpt(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describeResult(r: PreviewResult): string {
  if (!r.reaches_model) return chalk.dim(`gate: ${r.gate} → skipped before the model`)
  const e = r.extracted
  if (!e?.decision) return chalk.dim(`gate: ${r.gate} → model saw it → nothing to store`)
  const kind = e.kind && e.kind !== DEFAULT_CAPTURE_KIND ? `${e.kind}${e.subject ? ` (${e.subject})` : ''}` : DEFAULT_CAPTURE_KIND
  const head = r.stored
    ? chalk.green(`stored as ${kind} (${e.confidence.toFixed(2)})`)
    : chalk.yellow(`not stored: ${r.reason ?? 'below threshold'}`)
  const rejected = e.rejected.length ? chalk.dim(` | rejected: ${e.rejected.map((x) => x.option).join(', ')}`) : ''
  return `gate: ${r.gate} → ${head}: "${e.decision}"${rejected}`
}

export function formatPreview(
  turns: PreviewTurn[],
  results: PreviewResult[],
  current?: PreviewResult[],
): string[] {
  const lines: string[] = []
  turns.forEach((turn, i) => {
    const r = results[i]
    if (!r) return
    lines.push(`  ${i + 1}. "${excerpt(turn.user_message)}"`)
    lines.push(`     ${describeResult(r)}`)
    const c = current?.[i]
    if (c) lines.push(`     ${chalk.dim('today:')} ${describeResult(c)}`)
  })
  const stored = results.filter(r => r.stored).length
  const reached = results.filter(r => r.reaches_model).length
  lines.push('')
  lines.push(`  ${turns.length} turn${turns.length === 1 ? '' : 's'}: ${reached} reached the model, ${stored} would be stored.`)
  if (current) {
    const storedToday = current.filter(r => r.stored).length
    lines.push(chalk.dim(`  With the settings saved today: ${storedToday} would be stored.`))
  }
  return lines
}

// ── Perception calls ──────────────────────────────────────────

interface CaptureSettingsResponse extends CaptureSettings {
  effective_confidence_min: number
}

function resolveProjectId(override?: string): string {
  return override ?? gatherProjectInfo(cwd()).id
}

async function fetchSettings(projectId: string): Promise<CaptureSettingsResponse> {
  const { url, key } = perceptionEndpoint()
  const res = await fetch(`${url}/projects/${encodeURIComponent(projectId)}/capture`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  }).catch((err: unknown) => exitUnreachable(url, err))
  if (!res.ok) await failWithBody(res, `Could not read capture settings for project ${projectId}`, url)
  const raw = await res.json() as Partial<CaptureSettingsResponse>
  const settings = readCaptureSettings(raw)
  return { ...settings, effective_confidence_min: typeof raw.effective_confidence_min === 'number' ? raw.effective_confidence_min : 0.6 }
}

async function failWithBody(res: Response, title: string, url: string): Promise<never> {
  const raw = await res.text().catch(() => '')
  console.log(chalk.red(`  ✗ ${title} (${res.status})`))
  try {
    const j = JSON.parse(raw) as { message?: string; hint?: string; errors?: string[]; detail?: string }
    if (j.message) console.log(chalk.yellow(`  ${j.message}`))
    if (j.hint) console.log(chalk.dim(`  ${j.hint}`))
    for (const e of j.errors ?? []) console.log(chalk.yellow(`  • ${e}`))
    if (j.detail) console.log(chalk.dim(`  ${j.detail}`))
  } catch {
    if (raw) console.log(chalk.dim(`  ${raw.slice(0, 400)}`))
  }
  if (res.status === 404 && /Not Found|Cannot GET|Cannot PUT|Cannot POST/i.test(raw)) {
    console.log(chalk.dim('  This Perception predates capture settings. Upgrade it with ') + chalk.cyan('npx robrain@latest up') + chalk.dim(' (or pnpm docker:up:build from a clone).'))
  }
  console.log(chalk.dim(`  Perception: ${url}\n`))
  process.exit(1)
}

function printHeader(projectId: string, url: string): void {
  console.log()
  console.log(chalk.bold('  Capture settings') + chalk.dim(` · project ${projectId}`))
  console.log(chalk.dim(`  ${url}\n`))
}

// ── Commands ──────────────────────────────────────────────────

export async function captureShowCommand(opts: { projectId?: string }): Promise<void> {
  const projectId = resolveProjectId(opts.projectId)
  const { url } = perceptionEndpoint()
  const settings = await fetchSettings(projectId)
  printHeader(projectId, url)
  for (const line of formatCaptureSettings(settings, settings.effective_confidence_min)) console.log(line)
  console.log()
  console.log(chalk.dim('  Change them with ') + chalk.cyan('npx robrain capture set --help') + chalk.dim('; try them first with ') + chalk.cyan('npx robrain capture test') + chalk.dim('.'))
  console.log()
}

export async function captureSetCommand(opts: CaptureSetOptions): Promise<void> {
  const projectId = resolveProjectId(opts.projectId)
  const { url, key } = perceptionEndpoint()
  const current = await fetchSettings(projectId)

  const built = buildCapturePatch(opts, current)
  if ('error' in built) {
    console.log(chalk.red(`\n  ✗ ${built.error}\n`))
    process.exit(1)
  }
  if (Object.keys(built.patch).length === 0) {
    console.log(chalk.yellow('\n  Nothing to change. See ') + chalk.cyan('npx robrain capture set --help') + chalk.yellow(' for the flags.\n'))
    process.exit(1)
  }

  const res = await fetch(`${url}/projects/${encodeURIComponent(projectId)}/capture`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body:    JSON.stringify(built.patch),
  }).catch((err: unknown) => exitUnreachable(url, err))
  if (!res.ok) await failWithBody(res, 'Could not save capture settings', url)
  const saved = await res.json() as CaptureSettingsResponse

  printHeader(projectId, url)
  console.log(chalk.green('  ✓ Saved\n'))
  for (const line of formatCaptureSettings(readCaptureSettings(saved), saved.effective_confidence_min)) console.log(line)
  console.log()
  if (saved.mode === 'broad' && current.mode !== 'broad') {
    console.log(chalk.yellow('  Broad mode sends every non-trivial turn to the extraction model, on your own LLM key.'))
  }
  console.log(chalk.dim('  Running Sensing servers pick this up within 5 minutes, or on their next session start.'))
  console.log()
}

export async function captureTestCommand(opts: CaptureTestOptions): Promise<void> {
  const projectId = resolveProjectId(opts.projectId)
  const { url, key } = perceptionEndpoint()

  let turns: PreviewTurn[]
  if (opts.file) {
    let text: string
    try {
      text = readFileSync(opts.file, 'utf8')
    } catch (err) {
      console.log(chalk.red(`\n  ✗ Could not read ${opts.file}: ${err instanceof Error ? err.message : String(err)}\n`))
      process.exit(1)
    }
    const parsed = parseTurnsJsonl(text)
    if ('error' in parsed) {
      console.log(chalk.red(`\n  ✗ ${opts.file}: ${parsed.error}\n`))
      process.exit(1)
    }
    turns = parsed.turns
  } else if (opts.user !== undefined && opts.reply !== undefined) {
    turns = [{ user_message: opts.user, claude_reply: opts.reply }]
  } else {
    console.log(chalk.red('\n  ✗ Give sample turns: ') + chalk.cyan('--file turns.jsonl') + chalk.red(' (one {"user_message","claude_reply"} per line) or ') + chalk.cyan('--user "..." --reply "..."') + '\n')
    process.exit(1)
  }
  if (turns.length > 20) {
    console.log(chalk.red(`\n  ✗ At most 20 turns per test (got ${turns.length}); each one that reaches the model costs an extraction call.\n`))
    process.exit(1)
  }

  const current = await fetchSettings(projectId)
  const built = buildCapturePatch(opts, current)
  if ('error' in built) {
    console.log(chalk.red(`\n  ✗ ${built.error}\n`))
    process.exit(1)
  }
  const hasCandidate = Object.keys(built.patch).length > 0

  const res = await fetch(`${url}/projects/${encodeURIComponent(projectId)}/capture/preview`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body:    JSON.stringify({
      ...(hasCandidate ? { settings: built.patch } : {}),
      turns,
      compare_with_current: Boolean(opts.compare && hasCandidate),
    }),
  }).catch((err: unknown) => exitUnreachable(url, err))
  if (!res.ok) await failWithBody(res, 'Capture test failed', url)
  const data = await res.json() as {
    settings: CaptureSettingsResponse
    results: PreviewResult[]
    current?: PreviewResult[]
  }

  printHeader(projectId, url)
  console.log(chalk.bold(hasCandidate ? '  Testing these settings (not saved):' : '  Testing the saved settings:'))
  for (const line of formatCaptureSettings(readCaptureSettings(data.settings), data.settings.effective_confidence_min)) console.log(line)
  console.log()
  for (const line of formatPreview(turns, data.results, data.current)) console.log(line)
  console.log()
  if (hasCandidate) {
    console.log(chalk.dim('  Nothing was saved. Keep these settings with the same flags on ') + chalk.cyan('npx robrain capture set') + chalk.dim('.'))
    console.log()
  }
}

// packages/shared/src/capture-settings.ts
// ─────────────────────────────────────────────────────────────
// Per-project capture settings: what the classifier stores, in
// the user's own words. Stored on Perception (projects table),
// read by Sensing at session start and by Perception for its own
// re-extraction, edited with `robrain capture`.
//
// Every field is optional and every default reproduces the
// behaviour of a project that never set anything: no extra
// instructions, the keyword gate on, the stock confidence
// threshold, decisions only.
// ─────────────────────────────────────────────────────────────

export const CAPTURE_INSTRUCTIONS_MAX_CHARS = 2000
export const CAPTURE_KINDS_MAX = 8
export const CAPTURE_KIND_NAME_MAX_CHARS = 32
export const CAPTURE_KIND_DESCRIPTION_MAX_CHARS = 300
export const CAPTURE_MODES = ['strict', 'broad'] as const
export type CaptureMode = (typeof CAPTURE_MODES)[number]

/** Every stored memory has a kind; this is the one the stock prompt produces. */
export const DEFAULT_CAPTURE_KIND = 'decision'

/**
 * An extra kind of memory a project asks the classifier to store, e.g.
 * `{ name: "run", description: "The outcome of an agent run: what ran, when, and whether it succeeded." }`.
 * Entries of the same kind that share a subject replace each other, so a
 * kind can hold changing state (the last run) and not only durable rules.
 */
export interface CaptureKind {
  name: string
  description: string
}

export interface CaptureSettings {
  /** Plain-language rules appended to the extraction prompt. Null = none. */
  instructions: string | null
  /**
   * strict: a turn reaches the model only when the keyword gate fires (the
   * default, ~5% of turns). broad: every turn with a user message above the
   * minimum length reaches the model. Costs one extraction call per turn.
   */
  mode: CaptureMode
  /** Overrides the stock confidence threshold (0.60) for this project. Null = stock. */
  confidence_min: number | null
  /** Extra kinds the project stores beside decisions. Empty = decisions only. */
  kinds: CaptureKind[]
}

export const DEFAULT_CAPTURE_SETTINGS: CaptureSettings = {
  instructions:   null,
  mode:           'strict',
  confidence_min: null,
  kinds:          [],
}

/** True when the settings change nothing about the stock classifier. */
export function isDefaultCaptureSettings(s: CaptureSettings): boolean {
  return s.instructions === null && s.mode === 'strict' && s.confidence_min === null && s.kinds.length === 0
}

/** Lowercases and strips anything but [a-z0-9_-] so model output and user input compare equal. */
export function normalizeKindName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

export interface CaptureSettingsPatch {
  instructions?: string | null
  mode?: string
  confidence_min?: number | null
  kinds?: Array<{ name?: unknown; description?: unknown }> | null
}

export type CaptureSettingsValidation =
  | { ok: true; settings: CaptureSettings }
  | { ok: false; errors: string[] }

/**
 * Merge a patch over the current settings and validate the result. Fields
 * absent from the patch keep their current value; explicit null clears.
 * Used by Perception (PUT) and by the CLI before it sends, so both report
 * the same errors.
 */
export function applyCaptureSettingsPatch(
  current: CaptureSettings,
  patch: CaptureSettingsPatch,
): CaptureSettingsValidation {
  const errors: string[] = []
  const next: CaptureSettings = { ...current, kinds: [...current.kinds] }

  if (patch.instructions !== undefined) {
    if (patch.instructions === null || patch.instructions.trim() === '') {
      next.instructions = null
    } else if (typeof patch.instructions !== 'string') {
      errors.push('instructions must be text')
    } else if (patch.instructions.length > CAPTURE_INSTRUCTIONS_MAX_CHARS) {
      errors.push(`instructions must be at most ${CAPTURE_INSTRUCTIONS_MAX_CHARS} characters (got ${patch.instructions.length})`)
    } else {
      next.instructions = patch.instructions.trim()
    }
  }

  if (patch.mode !== undefined) {
    const mode = String(patch.mode).trim().toLowerCase()
    if ((CAPTURE_MODES as readonly string[]).includes(mode)) {
      next.mode = mode as CaptureMode
    } else {
      errors.push(`mode must be one of: ${CAPTURE_MODES.join(', ')}`)
    }
  }

  if (patch.confidence_min !== undefined) {
    if (patch.confidence_min === null) {
      next.confidence_min = null
    } else if (typeof patch.confidence_min !== 'number' || !Number.isFinite(patch.confidence_min)) {
      errors.push('confidence_min must be a number between 0 and 1')
    } else if (patch.confidence_min < 0 || patch.confidence_min > 1) {
      errors.push('confidence_min must be between 0 and 1')
    } else {
      next.confidence_min = Math.round(patch.confidence_min * 100) / 100
    }
  }

  if (patch.kinds !== undefined) {
    if (patch.kinds === null) {
      next.kinds = []
    } else if (!Array.isArray(patch.kinds)) {
      errors.push('kinds must be a list')
    } else if (patch.kinds.length > CAPTURE_KINDS_MAX) {
      errors.push(`at most ${CAPTURE_KINDS_MAX} kinds`)
    } else {
      const seen = new Set<string>()
      const kinds: CaptureKind[] = []
      for (const raw of patch.kinds) {
        const name = typeof raw?.name === 'string' ? normalizeKindName(raw.name) : ''
        const description = typeof raw?.description === 'string' ? raw.description.trim() : ''
        if (!name) {
          errors.push('each kind needs a name (letters, digits, - or _)')
          continue
        }
        if (name.length > CAPTURE_KIND_NAME_MAX_CHARS) {
          errors.push(`kind name "${name}" is longer than ${CAPTURE_KIND_NAME_MAX_CHARS} characters`)
          continue
        }
        if (name === DEFAULT_CAPTURE_KIND) {
          errors.push(`"${DEFAULT_CAPTURE_KIND}" is the built-in kind and cannot be redefined`)
          continue
        }
        if (!description) {
          errors.push(`kind "${name}" needs a description so the model knows what to store`)
          continue
        }
        if (description.length > CAPTURE_KIND_DESCRIPTION_MAX_CHARS) {
          errors.push(`description for kind "${name}" is longer than ${CAPTURE_KIND_DESCRIPTION_MAX_CHARS} characters`)
          continue
        }
        if (seen.has(name)) {
          errors.push(`kind "${name}" is listed twice`)
          continue
        }
        seen.add(name)
        kinds.push({ name, description })
      }
      next.kinds = kinds
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, settings: next }
}

/**
 * Read settings from an untyped source (a DB row, an API body) and fall
 * back to the defaults field by field, so one bad column never disables
 * the others.
 */
export function coerceCaptureSettings(raw: unknown): CaptureSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CAPTURE_SETTINGS }
  const r = raw as Record<string, unknown>
  const result = applyCaptureSettingsPatch(DEFAULT_CAPTURE_SETTINGS, {
    instructions:   typeof r.instructions === 'string' ? r.instructions : null,
    mode:           typeof r.mode === 'string' ? r.mode : 'strict',
    confidence_min: typeof r.confidence_min === 'number' ? r.confidence_min : null,
    kinds:          Array.isArray(r.kinds) ? (r.kinds as CaptureKind[]) : [],
  })
  if (result.ok) return result.settings
  // Keep whatever validated; a project with one bad field is still tuned by the rest.
  const safe: CaptureSettings = { ...DEFAULT_CAPTURE_SETTINGS }
  const instructions = applyCaptureSettingsPatch(safe, { instructions: typeof r.instructions === 'string' ? r.instructions : null })
  if (instructions.ok) safe.instructions = instructions.settings.instructions
  const mode = applyCaptureSettingsPatch(safe, { mode: typeof r.mode === 'string' ? r.mode : 'strict' })
  if (mode.ok) safe.mode = mode.settings.mode
  const conf = applyCaptureSettingsPatch(safe, { confidence_min: typeof r.confidence_min === 'number' ? r.confidence_min : null })
  if (conf.ok) safe.confidence_min = conf.settings.confidence_min
  const kinds = applyCaptureSettingsPatch(safe, { kinds: Array.isArray(r.kinds) ? (r.kinds as CaptureKind[]) : [] })
  if (kinds.ok) safe.kinds = kinds.settings.kinds
  return safe
}

const SUBJECT_STOPWORDS = new Set(['the', 'a', 'an', 'of', 'for', 'on', 'in', 'at', 'to', 'and', 'this', 'that', 'our', 'my', 'its', 'last', 'latest', 'current'])

/** Content words of a subject, lowercased, punctuation and filler dropped. */
export function subjectTokens(subject: string): string[] {
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]+/g, ' ')
    .split(/[\s_-]+/)
    .filter(t => t.length > 1 && !SUBJECT_STOPWORDS.has(t))
}

/**
 * Two subjects name the same thing when their content words are equal or
 * one set contains the other: the model writes "nightly sync" one day and
 * "nightly sync agent" the next, and a changed state must still replace
 * the older entry. Both need at least one content word.
 */
export function subjectsMatch(a: string, b: string): boolean {
  const ta = new Set(subjectTokens(a))
  const tb = new Set(subjectTokens(b))
  if (ta.size === 0 || tb.size === 0) return false
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  for (const t of small) if (!large.has(t)) return false
  return true
}

/** The threshold a project actually uses: its own override, else the caller's stock value. */
export function effectiveConfidenceMin(settings: CaptureSettings | null | undefined, stock: number): number {
  return settings?.confidence_min ?? stock
}

/** Kind names the parser accepts for a project: the built-in one plus the project's own. */
export function allowedKindNames(settings: CaptureSettings | null | undefined): string[] {
  return [DEFAULT_CAPTURE_KIND, ...(settings?.kinds ?? []).map(k => k.name)]
}

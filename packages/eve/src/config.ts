// Option resolution for the RoBrain eve memory provider.
//
// Everything is read lazily, at the moment a handler runs — never when
// `eve build` loads the memory slot. (A key captured at build time has to exist
// in the build environment too, and stale values bake into the artifact.)

import { createHash } from "node:crypto";
import type { MemoryToolsContext } from "eve/memory";

/** The subset of eve's operation context a project resolver may use. */
export interface ProjectResolverContext {
  readonly memory: {
    readonly scope: {
      readonly key: string;
      readonly namespace: string;
      readonly value: string | readonly string[];
    };
    readonly slot: string;
  };
  /**
   * The eve session the operation runs in: its id and verified
   * authentication. Present for every recall, capture and tools call eve
   * makes; absent only when the provider resolves outside an operation.
   */
  readonly session?: {
    readonly id: string;
    readonly auth: MemoryToolsContext["session"]["auth"];
  };
}

/**
 * A connection setting: a value, or a function of the operation that reads
 * it at run time. The function form receives the operation's context, so a
 * multi-tenant app can hand each session its own credential. Return
 * `undefined` to fall back to the environment; THROW to skip the operation
 * (no request is made — the turn goes on without memory), which is what a
 * multi-tenant resolver should do when it cannot find this session's
 * credential, so it never falls back to a shared one. A function for
 * `apiKey` or `apiUrl` that returns an empty string or `null`, or any
 * setting function that takes longer than `timeoutMs`, skips the operation
 * too.
 */
export type ConnectionSetting<T> =
  | T
  | ((context?: ProjectResolverContext) => T | Promise<T>);

export interface RobrainMemoryOptions {
  /** API key. Default: ROBRAIN_API_KEY, then PERCEPTION_API_KEY. */
  readonly apiKey?: ConnectionSetting<string | undefined>;
  /**
   * Base URL of the RoBrain API — a self-hosted Perception or the Rory Plans
   * cloud API. Default: ROBRAIN_API_URL, then PERCEPTION_API_URL, then
   * http://127.0.0.1:3001 (the self-hosted Docker stack).
   */
  readonly apiUrl?: ConnectionSetting<string | undefined>;
  /**
   * RoBrain project whose decision memory this slot reads and writes. A
   * string binds the slot to one project (the common case: one eve app, one
   * engineering team). A resolver maps eve's memory scope to a project for
   * multi-tenant apps. Default: ROBRAIN_PROJECT_ID.
   */
  readonly projectId?:
    | string
    | ((context: ProjectResolverContext) => string | null | Promise<string | null>);
  /**
   * This agent's own project, created on first use. Give the agent a name
   * (or `{ name, id }` to pin the id) and the provider registers a project
   * for it with the RoBrain API the first time it recalls or captures, then
   * reads and writes that project. The id is derived from the name and the
   * API URL, so the same agent keeps the same memory across deploys and a
   * different agent never shares it. `projectId` and ROBRAIN_PROJECT_ID
   * win when set, so an existing setup is unchanged.
   */
  readonly agent?:
    | string
    | {
        readonly name: string;
        readonly id?: string;
        /**
         * What kind of agent this is (`"email"`, `"support"`, `"eu"`). On
         * RoBrain cloud an admin can push a rule to one kind of agent
         * (`robrain promote --to tag:email`) and every agent with that tag
         * reads it, including agents registered later. Letters, digits,
         * `_` and `-`, at most 10 tags.
         */
        readonly tags?: readonly string[];
      };
  /** Recall the always-on project summary (top decisions + vetoes). Default true. */
  readonly summary?: boolean;
  /** Max veto warnings recalled per turn. Default 3. */
  readonly vetoLimit?: number;
  /**
   * On Rory Plans cloud, use POST /context for relevance: planning-ranked,
   * token-budgeted decisions plus server-side veto warnings, recorded in the
   * injection ledger. Self-hosted Perception has no /context and falls back to
   * GET /decisions?query= automatically. Default true.
   */
  readonly context?: boolean;
  /** Token budget passed to cloud /context for ranked decisions. Default 1500. */
  readonly contextBudgetTokens?: number;
  /** Capture completed turns for server-side decision extraction. Default true. */
  readonly capture?: boolean;
  /**
   * Per-request timeout, and the time each setting function (`apiKey`,
   * `apiUrl`, `headers`) gets to answer. Recall runs before the model call,
   * so keep it short. Default 2500.
   */
  readonly timeoutMs?: number;
  /**
   * Extra headers on every request to the RoBrain API, e.g. a deployment
   * protection bypass when the API URL is a proxy in your own app. A value
   * or a function of the operation, like `apiKey`; a throwing function skips
   * the operation. The provider's own `Authorization`, `Content-Type` and
   * `X-Project-Id` always win over these.
   */
  readonly headers?: ConnectionSetting<Readonly<Record<string, string>> | undefined>;
}

export interface ResolvedConnection {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  /** Extra request headers; absent means none. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Thrown setting functions propagate: the caller treats them as "skip". So
 * does one that takes longer than `timeoutMs`, so a hung credential lookup
 * never holds up the turn.
 */
async function unwrap<T>(
  value: ConnectionSetting<T>,
  context: ProjectResolverContext | undefined,
  timeoutMs: number,
): Promise<T> {
  if (typeof value !== "function") return value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (value as (context?: ProjectResolverContext) => T | Promise<T>)(context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("setting function timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A setting function answered for this operation, but with no usable value.
 * Only `undefined` means "use the environment"; an empty string or `null`
 * from a per-session lookup must never become the shared env credential.
 */
function answeredEmpty(setting: unknown, value: unknown): boolean {
  return typeof setting === "function" && value !== undefined && (typeof value !== "string" || !value.trim());
}

// Node 17+ resolves `localhost` IPv6-first (::1) while the Docker stack only
// binds 127.0.0.1; rewrite so old configs keep working.
function normalizeLoopback(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "localhost") {
      u.hostname = "127.0.0.1";
      return u.toString().replace(/\/$/, "");
    }
  } catch {
    // not a URL we can parse — leave as-is and let fetch report it
  }
  return url.replace(/\/$/, "");
}

/**
 * The connection for one operation, or null when a setting function threw,
 * timed out, or answered with an empty URL or key (skip the operation; never
 * fall back to the environment's shared values).
 */
export async function resolveConnection(
  options: RobrainMemoryOptions,
  context?: ProjectResolverContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedConnection | null> {
  const timeoutMs = options.timeoutMs ?? 2500;
  let configuredUrl: string | undefined;
  let configuredKey: string | undefined;
  let configuredHeaders: Readonly<Record<string, string>> | undefined;
  try {
    [configuredUrl, configuredKey, configuredHeaders] = await Promise.all([
      unwrap(options.apiUrl, context, timeoutMs),
      unwrap(options.apiKey, context, timeoutMs),
      unwrap(options.headers, context, timeoutMs),
    ]);
  } catch {
    return null;
  }
  if (answeredEmpty(options.apiUrl, configuredUrl) || answeredEmpty(options.apiKey, configuredKey)) return null;
  const apiUrl =
    configuredUrl?.trim() ||
    env.ROBRAIN_API_URL?.trim() ||
    env.PERCEPTION_API_URL?.trim() ||
    "http://127.0.0.1:3001";
  const apiKey =
    configuredKey?.trim() ||
    env.ROBRAIN_API_KEY?.trim() ||
    env.PERCEPTION_API_KEY?.trim() ||
    "";
  const headers = sanitizeHeaders(configuredHeaders);
  // A per-session headers function may carry what tells sessions apart (a
  // tenant header to a proxy). If any entry it answered is unusable, sending
  // the rest would drop that distinction and merge sessions' state: skip the
  // operation instead, like a throw. A fixed value is the same for every
  // session, so dropping an entry of it cannot merge anything.
  if (typeof options.headers === "function" && headers.dropped) return null;
  return {
    apiUrl: normalizeLoopback(apiUrl),
    apiKey,
    timeoutMs,
    headers: headers.valid,
  };
}

/** RFC 9110 field-name token. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * Lowercased, trimmed names that are valid header tokens, with string values
 * free of line breaks; anything else is dropped rather than sent. Names are
 * normalized here so every later check (reserved names, the connection
 * identity) sees the key the HTTP layer will.
 */
function sanitizeHeaders(headers: Readonly<Record<string, string>> | undefined): {
  valid: Readonly<Record<string, string>>;
  /** Whether any entry was unusable (and left out of `valid`). */
  dropped: boolean;
} {
  if (headers === undefined) return { valid: {}, dropped: false };
  if (!headers || typeof headers !== "object") return { valid: {}, dropped: true };
  const out: Record<string, string> = {};
  let dropped = false;
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    // Control characters (HTAB aside) never belong in a header value.
    if (!HEADER_NAME.test(name) || typeof value !== "string" || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
      dropped = true;
      continue;
    }
    out[name] = value;
  }
  return { valid: out, dropped };
}

/**
 * Everything about a resolved connection that can differ between sessions,
 * as one canonical string: per-process state (caches, registration outcomes)
 * is partitioned by its digest. Add any new per-session connection setting
 * here, or that state could be shared across sessions it should separate.
 */
export function connectionIdentity(connection: ResolvedConnection): string {
  const headers = Object.entries(connection.headers ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  // JSON, not a separator join: every field is quoted and escaped, so no
  // URL, key or header value can make two different connections collide.
  return JSON.stringify([connection.apiUrl, connection.apiKey, headers]);
}

/** A project the provider registers itself: the agent's own. */
export interface AgentProject {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
}

/** Lowercase, [a-z0-9-], no leading or trailing dashes, at most 40 characters. */
export function slugifyAgentName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * The project id for an agent: `agent-<slug>-<8 hex>`. The slug is for
 * people; the hash covers the full name (trimmed, lowercased) and the API
 * URL, so two names that only slugify alike still get different projects,
 * one agent name means one project per RoBrain install, and renaming the
 * agent or changing the API URL (or pinning `id`) is the only way to move
 * it. No secret goes into the id.
 */
export function agentProjectId(name: string, apiUrl: string): string {
  const slug = slugifyAgentName(name) || "agent";
  const hash = createHash("sha256")
    .update(`${name.trim().toLowerCase()}|${apiUrl}`)
    .digest("hex")
    .slice(0, 8);
  return `agent-${slug}-${hash}`;
}

/**
 * The agent project from the `agent` option, or null when the option is
 * not set or the name has no letters or digits (nothing to name a project
 * after; the slot then stays inactive like any unconfigured one). `apiUrl`
 * is the operation's resolved API URL (the id hashes it).
 */
export function agentProject(options: RobrainMemoryOptions, apiUrl: string): AgentProject | null {
  const raw = options.agent;
  const name = (typeof raw === "string" ? raw : raw?.name)?.trim() ?? "";
  if (!name || !slugifyAgentName(name)) return null;
  const pinned = typeof raw === "object" ? raw.id?.trim() : undefined;
  const id = pinned || agentProjectId(name, apiUrl);
  const tags = typeof raw === "object" ? (raw.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean) : [];
  return { id, name, tags };
}

export async function resolveProjectId(
  options: RobrainMemoryOptions,
  context: ProjectResolverContext,
  apiUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const configured = options.projectId;
  if (typeof configured === "function") {
    try {
      const id = await configured(context);
      return typeof id === "string" && id.trim() ? id.trim() : null;
    } catch {
      return null;
    }
  }
  const id = configured?.trim() || env.ROBRAIN_PROJECT_ID?.trim() || agentProject(options, apiUrl)?.id || "";
  return id || null;
}

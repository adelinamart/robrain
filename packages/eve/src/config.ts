// Option resolution for the RoBrain eve memory provider.
//
// Everything is read lazily, at the moment a handler runs — never when
// `eve build` loads the memory slot. (A key captured at build time has to exist
// in the build environment too, and stale values bake into the artifact.)

export type Lazy<T> = T | (() => T);

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
}

export interface RobrainMemoryOptions {
  /** API key. Default: ROBRAIN_API_KEY, then PERCEPTION_API_KEY. */
  readonly apiKey?: Lazy<string | undefined>;
  /**
   * Base URL of the RoBrain API — a self-hosted Perception or the Rory Plans
   * cloud API. Default: ROBRAIN_API_URL, then PERCEPTION_API_URL, then
   * http://127.0.0.1:3001 (the self-hosted Docker stack).
   */
  readonly apiUrl?: Lazy<string | undefined>;
  /**
   * RoBrain project whose decision memory this slot reads and writes. A
   * string binds the slot to one project (the common case: one eve app, one
   * engineering team). A resolver maps eve's memory scope to a project for
   * multi-tenant apps. Default: ROBRAIN_PROJECT_ID.
   */
  readonly projectId?:
    | string
    | ((context: ProjectResolverContext) => string | null | Promise<string | null>);
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
  /** Per-request timeout. Recall runs before the model call, so keep it short. Default 2500. */
  readonly timeoutMs?: number;
}

export interface ResolvedConnection {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
}

function unwrap<T>(value: Lazy<T>): T {
  return typeof value === "function" ? (value as () => T)() : value;
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

export function resolveConnection(
  options: RobrainMemoryOptions,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConnection {
  const apiUrl =
    unwrap(options.apiUrl)?.trim() ||
    env.ROBRAIN_API_URL?.trim() ||
    env.PERCEPTION_API_URL?.trim() ||
    "http://127.0.0.1:3001";
  const apiKey =
    unwrap(options.apiKey)?.trim() ||
    env.ROBRAIN_API_KEY?.trim() ||
    env.PERCEPTION_API_KEY?.trim() ||
    "";
  return {
    apiUrl: normalizeLoopback(apiUrl),
    apiKey,
    timeoutMs: options.timeoutMs ?? 2500,
  };
}

export async function resolveProjectId(
  options: RobrainMemoryOptions,
  context: ProjectResolverContext,
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
  const id = configured?.trim() || env.ROBRAIN_PROJECT_ID?.trim() || "";
  return id || null;
}

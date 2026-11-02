// Thin client for the RoBrain API (self-hosted Perception or Rory Plans cloud —
// same auth, mostly the same routes). Fail-open by construction: every method
// returns null/[] on any failure and never throws, because a throwing recall
// handler fails the user's turn in eve.
//
// One route differs by tier. Semantic recall is GET /decisions?query= on
// self-hosted Perception, and POST /context on Rory cloud (planning-ranked,
// token-budgeted, with server-side veto warnings and an injection ledger).
// Cloud's GET /decisions is a plain list. The client probes /context once per
// connection and remembers the answer.

import { connectionDigest, type ResolvedConnection } from "./config.js";

export interface RejectedOption {
  readonly option: string;
  readonly reason: string;
}

export interface VetoDecision {
  readonly id?: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly similarity?: number;
  readonly exact?: boolean;
  readonly rejected: readonly RejectedOption[];
  /** Cloud /context ships injection-ready warning lines; prefer them when present. */
  readonly messages?: readonly string[];
  /** false when the decision was captured but not yet reviewed (cloud). */
  readonly reviewed?: boolean;
}

/** A planning-ranked decision from cloud POST /context. */
export interface ContextMemory {
  readonly id: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly rejected: readonly RejectedOption[];
  readonly score?: number;
}

export interface ContextRecall {
  readonly memories: readonly ContextMemory[];
  readonly vetoes: readonly VetoDecision[];
  /** Cloud may require an explicit acknowledgement before a vetoed path is taken. */
  readonly requiredAcknowledgement?: string;
}

export interface CapturedTurn {
  readonly sessionId: string;
  readonly sequence: number;
  readonly userMessage: string;
  readonly reply: string;
  /** Tools called in this turn (names only); RoBrain cloud derives agent tags from them. */
  readonly toolsUsed?: readonly string[];
}

/** Similarity gate for the self-hosted semantic tier; exact /veto-scan matches are exempt. */
const MIN_SIMILARITY = 0.45;

/**
 * Per connection (connectionDigest): does POST /context exist? undefined =
 * not probed yet. Keyed by the whole connection, not the URL: a proxy that
 * routes tenants by key or header can put a cloud tenant and a self-hosted
 * one behind one URL, and one's 404 must not turn /context off for the
 * other. Bounded like the provider's per-connection state; an evicted entry
 * costs one more probe.
 */
const contextSupport = new Map<string, boolean>();
const CONTEXT_SUPPORT_CAP = 1000;

function rememberContextSupport(key: string, supported: boolean): void {
  contextSupport.delete(key);
  contextSupport.set(key, supported);
  if (contextSupport.size > CONTEXT_SUPPORT_CAP) {
    const oldest = contextSupport.keys().next().value;
    if (oldest !== undefined) contextSupport.delete(oldest);
  }
}

export class RobrainClient {
  private readonly probeKey: string;

  constructor(private readonly connection: ResolvedConnection) {
    this.probeKey = connectionDigest(connection);
  }

  /**
   * Whether POST /context has been confirmed for this connection: true after
   * a success, false after a 404, undefined until probed.
   */
  contextSupported(): boolean | undefined {
    return contextSupport.get(this.probeKey);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    timeoutMs?: number,
  ): Promise<{ status: number; body: any } | null> {
    const { apiUrl, apiKey, headers } = this.connection;
    try {
      const res = await fetch(`${apiUrl}${path}`, {
        ...init,
        // Caller headers first: the provider's own always win.
        headers: {
          ...stripReserved(headers ?? {}),
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          ...(init.headers ?? {}),
        },
        // Never follow a redirect with the credential and headers: a 3xx
        // (e.g. a deployment-protection login page) is a failed request, not
        // a 200 from somewhere else.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs ?? this.connection.timeoutMs),
      });
      const body = await res.json().catch(() => null);
      return { status: res.status, body };
    } catch {
      return null;
    }
  }

  async fetchJson(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<any | null> {
    const res = await this.request(path, init, timeoutMs);
    return res && res.status >= 200 && res.status < 300 ? res.body : null;
  }

  /** Deterministic tier: POST /veto-scan — exact rejected-option matches, no embeddings. */
  async exactVetoes(projectId: string, text: string): Promise<VetoDecision[]> {
    const scan = await this.fetchJson(
      "/veto-scan",
      { method: "POST", body: JSON.stringify({ project_id: projectId, text }) },
      1500,
    );
    return (Array.isArray(scan?.matches) ? scan.matches : []).map((m: any) => ({ ...m, exact: true }));
  }

  /** Self-hosted semantic tier: GET /decisions?query=, similarity-gated. */
  async semanticVetoes(projectId: string, text: string, limit = 8): Promise<VetoDecision[]> {
    const data = await this.fetchJson(
      `/decisions?${new URLSearchParams({ project_id: projectId, query: text, limit: String(limit) })}`,
    );
    const decisions = Array.isArray(data) ? data : data?.decisions;
    if (!Array.isArray(decisions)) return [];
    return decisions
      .filter((d: any) => Array.isArray(d.rejected) && d.rejected.length > 0)
      .filter((d: any) => typeof d.similarity !== "number" || d.similarity >= MIN_SIMILARITY)
      .sort((a: any, b: any) => (b.similarity ?? 0) - (a.similarity ?? 0));
  }

  /**
   * Cloud semantic tier: POST /context. Returns null when the API does not
   * offer the route (self-hosted) or the call failed; the caller falls back to
   * semanticVetoes(). A 404 is remembered per connection so self-hosted
   * setups pay for the probe once.
   */
  async contextRecall(
    projectId: string,
    text: string,
    options: { sessionId?: string; sequence?: number; budgetTokens?: number } = {},
  ): Promise<ContextRecall | null> {
    if (this.contextSupported() === false) return null;

    const res = await this.request(
      "/context",
      {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          task_description: text,
          ...(options.sessionId ? { session_id: options.sessionId } : {}),
          ...(typeof options.sequence === "number" ? { sequence: options.sequence } : {}),
          budget_tokens: options.budgetTokens ?? 1500,
        }),
      },
      3000,
    );
    if (!res) return null;
    if (res.status === 404) {
      rememberContextSupport(this.probeKey, false);
      return null;
    }
    if (res.status < 200 || res.status >= 300 || !res.body) return null;
    if (this.contextSupported() !== true) rememberContextSupport(this.probeKey, true);

    const body = res.body;
    const memories: ContextMemory[] = (Array.isArray(body.memories) ? body.memories : [])
      .filter((m: any) => m && typeof m.id === "string" && typeof m.decision === "string")
      .map((m: any) => ({
        id: m.id,
        decision: m.decision,
        ...(typeof m.rationale === "string" ? { rationale: m.rationale } : {}),
        rejected: Array.isArray(m.rejected) ? m.rejected : [],
        ...(typeof m.score === "number" ? { score: m.score } : {}),
      }));
    // Cloud warnings are one entry per rejected option:
    //   { decision_id, rejected_option, reason, message, reviewed }
    // Group them back into one VetoDecision per decision. The decision text
    // itself is not part of a warning; the server-rendered `message` lines are.
    const grouped = new Map<string, { rejected: RejectedOption[]; messages: string[]; reviewed: boolean }>();
    for (const w of Array.isArray(body.veto_warnings) ? body.veto_warnings : []) {
      if (!w || typeof w.decision_id !== "string" || typeof w.rejected_option !== "string") continue;
      const entry = grouped.get(w.decision_id) ?? { rejected: [], messages: [], reviewed: true };
      entry.rejected.push({ option: w.rejected_option, reason: typeof w.reason === "string" ? w.reason : "" });
      if (typeof w.message === "string" && w.message.trim()) entry.messages.push(w.message.trim());
      if (w.reviewed === false) entry.reviewed = false;
      grouped.set(w.decision_id, entry);
    }
    const vetoes: VetoDecision[] = [...grouped.entries()].map(([id, entry]) => ({
      id,
      decision: entry.messages[0] ?? `Prior decision ${id}`,
      rejected: entry.rejected,
      messages: entry.messages,
      reviewed: entry.reviewed,
    }));
    const ack = body.required_acknowledgement;
    const requiredAcknowledgement =
      typeof ack === "string"
        ? ack
        : ack && typeof ack === "object" && typeof (ack.message ?? ack.text) === "string"
          ? String(ack.message ?? ack.text)
          : undefined;

    return { memories, vetoes, ...(requiredAcknowledgement ? { requiredAcknowledgement } : {}) };
  }

  /**
   * Register (or re-touch) the agent's own project. POST /projects upserts
   * by id on both editions; RoBrain cloud also records the type so an agent
   * project can be told apart from a coding one. "conflict" means the id is
   * owned by another org on RoBrain cloud (409): the agent must be renamed
   * or given a pinned id, so the caller stops using that project.
   */
  async registerProject(id: string, name: string, tags: readonly string[] = []): Promise<"registered" | "conflict" | "failed"> {
    if (!id) return "failed";
    const res = await this.request(
      "/projects",
      { method: "POST", body: JSON.stringify({ id, name, type: "agent", ...(tags.length ? { tags } : {}) }) },
      4000,
    );
    if (res === null) return "failed";
    if (res.status >= 200 && res.status < 300) return "registered";
    return res.status === 409 ? "conflict" : "failed";
  }

  /** The project's always-on summary: top decisions with their rejected alternatives. */
  async alwaysOnSummary(projectId: string): Promise<string | null> {
    if (!projectId) return null;
    const data = await this.fetchJson(`/projects/${encodeURIComponent(projectId)}/summary`, {}, 3000);
    const text = data?.summary ?? data?.always_on_summary;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  }

  /**
   * Ship a completed turn for server-side decision extraction. RoBrain
   * classifies, extracts rejected[] and dedups near-duplicates on its side, so
   * this stays a dumb pipe. Returns true when the request was accepted.
   */
  async captureTurn(projectId: string, turn: CapturedTurn): Promise<boolean> {
    if (!projectId) return false;
    const res = await this.fetchJson(
      "/signals",
      {
        method: "POST",
        headers: { "X-Project-Id": projectId },
        body: JSON.stringify({
          signal: {
            turn: {
              session_id: turn.sessionId.slice(0, 200),
              sequence: turn.sequence,
              user_message: turn.userMessage.slice(0, 60_000),
              claude_reply: turn.reply.slice(0, 60_000),
              files_touched: [],
              timestamp: new Date().toISOString(),
            },
            decision_type: "unclassified",
            confidence: 0,
            files_affected: [],
            scope: "team",
            needs_classification: true,
            ...(turn.toolsUsed?.length ? { tools_used: turn.toolsUsed.slice(0, 50) } : {}),
          },
        }),
      },
      8000,
    );
    return res !== null;
  }
}

/**
 * Headers a caller may not set: the ones the provider sets itself, and the
 * transport ones fetch owns (setting them breaks or smuggles the request,
 * and Node's fetch rejects several outright, which would fail every
 * request). A caller's copy, in any case, is dropped.
 */
const RESERVED_HEADERS = new Set([
  "authorization",
  "content-type",
  "x-project-id",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-connection",
  "upgrade",
  "expect",
  "te",
  "trailer",
]);

/**
 * Caller headers minus the reserved ones. Header names are case-insensitive,
 * so a caller's "authorization" next to the provider's "Authorization" would
 * otherwise be joined into one value instead of being overridden.
 */
function stripReserved(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!RESERVED_HEADERS.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

/** Merge exact matches ahead of semantic ones, deduping by decision id. */
export function mergeVetoes(exact: readonly VetoDecision[], semantic: readonly VetoDecision[]): VetoDecision[] {
  const seen = new Set<string>();
  const merged: VetoDecision[] = [];
  for (const d of [...exact, ...semantic]) {
    const key = d.id ?? d.decision;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(d);
  }
  return merged;
}

/** Reset the per-connection /context probe memo (tests). */
export function resetContextSupport(): void {
  contextSupport.clear();
}

// The eve memory provider. Maps RoBrain's loop onto eve's provider contract:
//
//   recall["turn.started"]        → always-on summary + relevant decisions +
//                                   veto warnings for the incoming message
//                                   (stable ids, so eve supersedes rather
//                                   than accumulates)
//   capture["turn.completed"]     → ship the turn for decision extraction,
//                                   idempotent on eve's operationId
//   tools()                       → check_prior_decisions
//
// Relevance comes from two tiers plus, on Rory cloud, POST /context:
//   exact    — POST /veto-scan, deterministic rejected-option match
//   semantic — cloud: POST /context (ranked decisions + veto warnings)
//              self-hosted: GET /decisions?query= (similarity-gated)
//
// `defineMemoryProvider` is a typed identity in eve, so this returns a plain
// object that satisfies MemoryProvider: no eve runtime import on the recall
// path. Every handler is fail-open — a throwing recall fails the user's turn.

import type {
  MemoryProvider,
  MemoryRecallMessage,
  MemoryRecallResult,
  MemoryToolsContext,
  MemoryTurnCompletedContext,
  MemoryTurnStartedContext,
} from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  RobrainClient,
  mergeVetoes,
  type ContextMemory,
  type VetoDecision,
} from "./client.js";
import {
  agentProject,
  connectionDigest,
  connectionFor,
  isSkip,
  resolveProjectId,
  type ConnectionSkip,
  type ProjectResolverContext,
  type RobrainMemoryOptions,
} from "./config.js";
import { lastTextByRole, toolNamesIn } from "./messages.js";

const SUMMARY_ID = "robrain:summary";
const ACK_ID = "robrain:acknowledgement";
const SUMMARY_TTL_MS = 5 * 60 * 1000;
const SEEN_OPERATIONS_CAP = 2000;
/**
 * Max entries in each per-connection map. With per-session credentials the
 * key space grows with tenants × projects, so every map is bounded; the
 * oldest entry goes first. Evicting is always safe: a dropped summary is
 * fetched again, a dropped registration re-registers (an upsert), and a
 * dropped 409 is learned again from the server, which owns that decision
 * (RoBrain cloud refuses reads and writes of another org's project either
 * way; the remembered 409 only saves a request per turn).
 */
const CONNECTION_STATE_CAP = 1000;
/** A 409 is re-checked after this long instead of being remembered forever. */
const BLOCKED_RECHECK_MS = 60 * 60 * 1000;

/** Insert (or refresh) and evict the oldest entries beyond `cap`. */
function boundedSet<V>(map: Map<string, V>, key: string, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > cap) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
/** Below this, a message is a greeting or an acknowledgement — not worth a relevance lookup. */
const MIN_QUERY_CHARS = 24;

export function renderSummary(summary: string): string {
  return [
    "RoBrain project memory — the team's prior decisions, including alternatives they rejected and why.",
    "Treat these as the team's real history. If a task invites a previously rejected approach,",
    "surface the rejection instead of re-proposing it.",
    "",
    summary.trim(),
  ].join("\n");
}

export function renderVeto(decision: VetoDecision): string {
  const closing =
    "Do not re-propose a rejected option without flagging the prior rejection and why circumstances changed.";
  if (decision.messages?.length) {
    // Cloud /context already rendered the warning lines (one per rejected option).
    return ["Prior team decision relevant to this task:", ...decision.messages, closing].join("\n");
  }
  const rejected = decision.rejected
    .slice(0, 3)
    .map((r) => `- ${r.option} — ${r.reason}`)
    .join("\n");
  return [
    `Prior team decision relevant to this task: ${decision.decision}`,
    "Rejected alternatives:",
    rejected,
    closing,
  ].join("\n");
}

export function renderMemory(memory: ContextMemory): string {
  const lines = [`Relevant prior team decision: ${memory.decision}`];
  if (memory.rationale) lines.push(`Why: ${memory.rationale}`);
  if (memory.rejected.length) {
    lines.push("Rejected alternatives:");
    for (const r of memory.rejected.slice(0, 3)) lines.push(`- ${r.option} — ${r.reason}`);
  }
  return lines.join("\n");
}

export function skipMessage({ skip, why }: ConnectionSkip): string {
  const cause =
    why === "unusable"
      ? `"headers" is not a plain object or has an unusable entry (a name that is not a header token, ` +
        `a value with control characters, two names that differ only by case)`
      : why === "timed out"
        ? `the "${skip}" setting function took longer than timeoutMs`
        : why === "empty"
          ? `the "${skip}" setting function answered an empty string or null`
          : `the "${skip}" setting function threw`;
  return `${cause}; operations where this happens run without memory. Logged once.`;
}

export function decisionMessageId(decision: { id?: string; decision: string }): string {
  return `robrain:decision:${decision.id ?? decision.decision.slice(0, 120)}`;
}

export function robrainMemory(options: RobrainMemoryOptions = {}): MemoryProvider {
  const includeSummary = options.summary ?? true;
  const includeContext = options.context ?? true;
  const captureEnabled = options.capture ?? true;
  const vetoLimit = options.vetoLimit ?? 3;
  const contextBudgetTokens = options.contextBudgetTokens ?? 1500;

  // Per-process state below is keyed by connection AND project: with
  // per-session credentials, one project id can mean different orgs (or
  // different RoBrain installs), and what one credential may read — or the
  // 409 it got — must never be reused for another.
  const summaryCache = new Map<string, { text: string | null; at: number }>();
  const seenOperations = new Set<string>();

  /** One operation's client and the identity of its connection. */
  interface Resolved {
    readonly api: RobrainClient;
    readonly apiUrl: string;
    /** Digest of connectionIdentity (URL, key, headers): a cache partition, never the key itself. */
    readonly connectionKey: string;
  }

  /**
   * The client for one operation, from its own resolved connection — apiKey
   * and apiUrl may be per-session — or null when the operation is skipped.
   * Each kind of skip is logged once, by setting and reason, never a value:
   * a misconfigured fixed setting would otherwise turn memory off silently.
   */
  async function clientFor(context: ProjectResolverContext): Promise<Resolved | null> {
    const connection = await connectionFor(options, context);
    if (isSkip(connection)) {
      warnOnce(`skip:${connection.skip}:${connection.why}`, skipMessage(connection));
      return null;
    }
    return { api: new RobrainClient(connection), apiUrl: connection.apiUrl, connectionKey: connectionDigest(connection) };
  }

  function stateKey(resolved: Resolved, projectId: string): string {
    return `${resolved.connectionKey}:${projectId}`;
  }

  // The agent's own project is registered once per connection, the first
  // time a handler runs. A failed registration is logged once and retried on
  // the next handler; the handler itself goes on either way (fail-open). A
  // 409 (the id belongs to another org on RoBrain cloud) is final for that
  // connection: the slot goes inactive for that id instead of reading and
  // writing a foreign project on every turn, and the operator is told to
  // rename or pin.
  const registered = new Map<string, true>();
  /** Connection+project → when the 409 was seen. */
  const blocked = new Map<string, number>();
  const warned = new Map<string, true>();
  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    boundedSet(warned, key, true, CONNECTION_STATE_CAP);
    console.warn(`[robrain/eve] ${message}`);
  }
  async function ensureAgentProject(resolved: Resolved, projectId: string): Promise<"ready" | "blocked"> {
    const own = agentProject(options, resolved.apiUrl);
    if (!own || own.id !== projectId) return "ready";
    const key = stateKey(resolved, projectId);
    // A remembered 409 holds until the server says otherwise. Once due for a
    // re-check, only a successful registration lifts it; a failed or
    // unanswered re-check keeps the slot off (fail closed).
    const blockedAt = blocked.get(key);
    if (blockedAt !== undefined && Date.now() - blockedAt < BLOCKED_RECHECK_MS) return "blocked";
    const wasBlocked = blockedAt !== undefined;
    if (!wasBlocked && registered.has(key)) return "ready";
    try {
      const outcome = await resolved.api.registerProject(own.id, own.name, own.tags);
      if (outcome === "registered") {
        blocked.delete(key);
        boundedSet(registered, key, true, CONNECTION_STATE_CAP);
      } else if (outcome === "conflict") {
        boundedSet(blocked, key, Date.now(), CONNECTION_STATE_CAP);
        warnOnce(`conflict:${key}`,
          `project "${projectId}" for agent "${own.name}" belongs to another org on this RoBrain; ` +
          `memory is off for this agent. Rename the agent or pin a different id: agent: { name, id }.`);
        return "blocked";
      } else {
        if (wasBlocked) return "blocked"; // re-check failed: still off, retried next handler
        warnOnce(`failed:${key}`,
          `could not register project "${projectId}" for agent "${own.name}" (API unreachable or error); ` +
          `memory stays off until it succeeds, retried on the next turn.`);
      }
    } catch {
      if (wasBlocked) return "blocked";
      // retried on the next handler
    }
    return "ready";
  }

  /** Resolve the project for this operation, registering the agent's own project on first use. */
  async function projectFor(context: ProjectResolverContext, resolved: Resolved): Promise<string | null> {
    const projectId = await resolveProjectId(options, context, resolved.apiUrl);
    if (!projectId) return null;
    if ((await ensureAgentProject(resolved, projectId)) === "blocked") return null;
    return projectId;
  }

  async function cachedSummary(resolved: Resolved, projectId: string): Promise<string | null> {
    const key = stateKey(resolved, projectId);
    const hit = summaryCache.get(key);
    if (hit) {
      if (Date.now() - hit.at < SUMMARY_TTL_MS) return hit.text;
      summaryCache.delete(key);
    }
    const text = await resolved.api.alwaysOnSummary(projectId);
    boundedSet(summaryCache, key, { text, at: Date.now() }, CONNECTION_STATE_CAP);
    return text;
  }

  function rememberOperation(id: string): boolean {
    if (seenOperations.has(id)) return false;
    seenOperations.add(id);
    if (seenOperations.size > SEEN_OPERATIONS_CAP) {
      const oldest = seenOperations.values().next().value;
      if (oldest !== undefined) seenOperations.delete(oldest);
    }
    return true;
  }

  interface Relevance {
    readonly vetoes: readonly VetoDecision[];
    readonly memories: readonly ContextMemory[];
    readonly acknowledgement?: string;
  }
  const NOTHING: Relevance = { vetoes: [], memories: [] };

  /**
   * Relevance for one message. Exact tier always; semantic tier from cloud
   * /context when available (also yields ranked memories), else self-hosted
   * /decisions?query=.
   */
  async function relevance(
    api: RobrainClient,
    projectId: string,
    text: string,
    coordinates: { sessionId: string; sequence: number },
  ): Promise<Relevance> {
    const query = text.trim().slice(0, 2000);
    const [exact, context] = await Promise.all([
      api.exactVetoes(projectId, query),
      includeContext
        ? api.contextRecall(projectId, query, { ...coordinates, budgetTokens: contextBudgetTokens })
        : Promise.resolve(null),
    ]);
    // Once /context is confirmed for this connection, a transient failure must
    // not degrade to the list endpoint: cloud GET /decisions is unranked, and
    // injecting the newest vetoes regardless of relevance is worse than none.
    const semantic = context
      ? context.vetoes
      : api.contextSupported() === true
        ? []
        : await api.semanticVetoes(projectId, query);
    return {
      vetoes: mergeVetoes(exact, semantic),
      memories: context?.memories ?? [],
      ...(context?.requiredAcknowledgement ? { acknowledgement: context.requiredAcknowledgement } : {}),
    };
  }

  async function recallTurnStarted(context: MemoryTurnStartedContext): Promise<MemoryRecallResult> {
    try {
      const resolved = await clientFor(context);
      if (!resolved) return null;
      const { api } = resolved;
      const projectId = await projectFor(context, resolved);
      if (!projectId) return null;
      const userText = lastTextByRole(context.turn.input, "user");
      const lookup = userText.length >= MIN_QUERY_CHARS;

      const [summary, found] = await Promise.all([
        includeSummary ? cachedSummary(resolved, projectId) : Promise.resolve(null),
        lookup
          ? relevance(api, projectId, userText, {
              sessionId: `eve-${context.session.id}`,
              // eve numbers turns from 0; RoBrain sequences are 1-based
              // (cloud /context rejects 0). Matches capture's numbering.
              sequence: context.turn.sequence + 1,
            })
          : Promise.resolve(NOTHING),
      ]);

      const messages: MemoryRecallMessage[] = [];
      const seen = new Set<string>();
      if (summary) messages.push({ id: SUMMARY_ID, content: renderSummary(summary) });
      for (const decision of found.vetoes.slice(0, vetoLimit)) {
        const id = decisionMessageId(decision);
        seen.add(id);
        messages.push({ id, content: renderVeto(decision) });
      }
      for (const memory of found.memories) {
        const id = decisionMessageId(memory);
        if (seen.has(id)) continue; // the veto rendering wins
        seen.add(id);
        messages.push({ id, content: renderMemory(memory) });
      }
      if (found.acknowledgement) messages.push({ id: ACK_ID, content: found.acknowledgement });
      return messages.length ? { messages } : null;
    } catch {
      return null;
    }
  }

  async function captureTurnCompleted(context: MemoryTurnCompletedContext): Promise<void> {
    try {
      if (!captureEnabled) return;
      if (!rememberOperation(context.operationId)) return;
      const resolved = await clientFor(context);
      if (!resolved) {
        // No connection yet (a setting function threw or timed out): forget
        // the operation so eve's redelivery can still capture this turn.
        seenOperations.delete(context.operationId);
        return;
      }
      const { api } = resolved;
      const projectId = await projectFor(context, resolved);
      if (!projectId) return;
      const userMessage = lastTextByRole(context.turn.input, "user");
      const reply = lastTextByRole(context.messages, "assistant");
      if (!userMessage || !reply) return;
      await api.captureTurn(projectId, {
        sessionId: `eve-${context.session.id}`,
        sequence: context.turn.sequence + 1,
        userMessage,
        reply,
        // Names of the tools this turn called, so RoBrain cloud can derive
        // what kind of agent this is from the org's tool→tag mapping.
        toolsUsed: toolNamesIn(context.messages),
      });
    } catch {
      // capture is best-effort; eve logs capture failures but we never raise
    }
  }

  async function tools(context: MemoryToolsContext) {
    // The tool closes over THIS operation's connection, so a call can never
    // run with another session's credential.
    const resolved = await clientFor(context);
    if (!resolved) return null;
    const { api } = resolved;
    const projectId = await projectFor(context, resolved);
    if (!projectId) return null;
    return {
      check_prior_decisions: defineTool({
        description:
          "Check the team's decision memory for prior decisions relevant to a task, " +
          "including REJECTED alternatives and why they were rejected. Call this " +
          "before proposing any technology, architecture, or approach.",
        inputSchema: z.object({
          task: z
            .string()
            .min(4)
            .describe("Short description of the task or the approach being considered."),
        }),
        async execute({ task }: { task: string }) {
          const query = task.trim().slice(0, 2000);
          const [exact, context] = await Promise.all([
            api.exactVetoes(projectId, query),
            includeContext ? api.contextRecall(projectId, query) : Promise.resolve(null),
          ]);
          const semantic = context
            ? context.vetoes
            : api.contextSupported() === true
              ? []
              : await api.semanticVetoes(projectId, query);
          const vetoes = mergeVetoes(exact, semantic);
          if (vetoes.length === 0) {
            return { relevant_decisions: [], note: "No recorded rejections relevant to this task." };
          }
          return {
            relevant_decisions: vetoes.slice(0, 5).map((d) => ({
              decision: d.decision,
              exact_match: d.exact === true,
              rejected: d.rejected.map((r) => `${r.option} — ${r.reason}`),
            })),
            note:
              "Do not re-propose a rejected option without flagging the prior rejection " +
              "and why circumstances changed.",
          };
        },
      }),
    };
  }

  const provider = {
    recall: {
      "turn.started": recallTurnStarted,
    },
    capture: {
      "turn.completed": captureTurnCompleted,
    },
    tools,
  } satisfies MemoryProvider;

  return provider;
}

// The eve memory provider. Maps RoBrain's loop onto eve's provider contract:
//
//   recall["turn.started"]        → always-on summary + relevant decisions +
//                                   veto warnings for the incoming message
//                                   (stable ids, so eve supersedes rather
//                                   than accumulates)
//   recall["compaction.completed"] → re-inject the summary after compaction —
//                                   the moment compaction would otherwise have
//                                   dropped the team's rejections
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
  MemoryCompactionCompletedContext,
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
  isContextSupported,
  mergeVetoes,
  type ContextMemory,
  type VetoDecision,
} from "./client.js";
import { resolveConnection, resolveProjectId, type RobrainMemoryOptions } from "./config.js";
import { lastTextByRole } from "./messages.js";

const SUMMARY_ID = "robrain:summary";
const ACK_ID = "robrain:acknowledgement";
const SUMMARY_TTL_MS = 5 * 60 * 1000;
const SEEN_OPERATIONS_CAP = 2000;
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

export function decisionMessageId(decision: { id?: string; decision: string }): string {
  return `robrain:decision:${decision.id ?? decision.decision.slice(0, 120)}`;
}

export function robrainMemory(options: RobrainMemoryOptions = {}): MemoryProvider {
  const includeSummary = options.summary ?? true;
  const includeContext = options.context ?? true;
  const captureEnabled = options.capture ?? true;
  const vetoLimit = options.vetoLimit ?? 3;
  const contextBudgetTokens = options.contextBudgetTokens ?? 1500;

  const summaryCache = new Map<string, { text: string | null; at: number }>();
  const seenOperations = new Set<string>();

  function client(): RobrainClient {
    return new RobrainClient(resolveConnection(options));
  }

  async function cachedSummary(api: RobrainClient, projectId: string): Promise<string | null> {
    const hit = summaryCache.get(projectId);
    if (hit && Date.now() - hit.at < SUMMARY_TTL_MS) return hit.text;
    const text = await api.alwaysOnSummary(projectId);
    summaryCache.set(projectId, { text, at: Date.now() });
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
    // Once /context is confirmed for this API, a transient failure must not
    // degrade to the list endpoint: cloud GET /decisions is unranked, and
    // injecting the newest vetoes regardless of relevance is worse than none.
    const semantic = context
      ? context.vetoes
      : isContextSupported(resolveConnection(options).apiUrl) === true
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
      const projectId = await resolveProjectId(options, context);
      if (!projectId) return null;
      const api = client();
      const userText = lastTextByRole(context.turn.input, "user");
      const lookup = userText.length >= MIN_QUERY_CHARS;

      const [summary, found] = await Promise.all([
        includeSummary ? cachedSummary(api, projectId) : Promise.resolve(null),
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

  async function recallCompactionCompleted(
    context: MemoryCompactionCompletedContext,
  ): Promise<MemoryRecallResult> {
    try {
      if (!includeSummary) return null;
      const projectId = await resolveProjectId(options, context);
      if (!projectId) return null;
      const summary = await cachedSummary(client(), projectId);
      return summary ? { messages: [{ id: SUMMARY_ID, content: renderSummary(summary) }] } : null;
    } catch {
      return null;
    }
  }

  async function captureTurnCompleted(context: MemoryTurnCompletedContext): Promise<void> {
    try {
      if (!captureEnabled) return;
      if (!rememberOperation(context.operationId)) return;
      const projectId = await resolveProjectId(options, context);
      if (!projectId) return;
      const userMessage = lastTextByRole(context.turn.input, "user");
      const reply = lastTextByRole(context.messages, "assistant");
      if (!userMessage || !reply) return;
      await client().captureTurn(projectId, {
        sessionId: `eve-${context.session.id}`,
        sequence: context.turn.sequence + 1,
        userMessage,
        reply,
      });
    } catch {
      // capture is best-effort; eve logs capture failures but we never raise
    }
  }

  async function tools(context: MemoryToolsContext) {
    const projectId = await resolveProjectId(options, context);
    if (!projectId) return null;
    const api = client();
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
            : isContextSupported(resolveConnection(options).apiUrl) === true
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
      "compaction.completed": recallCompactionCompleted,
    },
    capture: {
      "turn.completed": captureTurnCompleted,
    },
    tools,
  } satisfies MemoryProvider;

  return provider;
}

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

// Imports the real `defineTool` from eve — no mocking — so the tool shape the
// tests see is the one eve will stamp at runtime.
import { resetContextSupport } from "./client.js";
import { robrainMemory } from "./provider.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetContextSupport();
});

const summaryBody = { summary: "1. Use Postgres, not SQLite. | Rejected: SQLite (locks)" };
const vetoRow = {
  id: "d2",
  decision: "Use Postgres in Docker, not SQLite",
  similarity: 0.8,
  rejected: [{ option: "SQLite", reason: "single-writer lock" }],
};

type Overrides = Partial<Record<"summary" | "scan" | "decisions" | "signals" | "context", unknown>>;

let lastInit: RequestInit | undefined;

/** Self-hosted shape by default: /context is 404 so the provider falls back to /decisions?query=. */
function stub(overrides: Overrides = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (url.includes("/context")) lastInit = init;
    const reply = (body: unknown) =>
      body === "THROW"
        ? Promise.reject(new Error("down"))
        : body === "NOT_FOUND"
          ? new Response("{}", { status: 404 })
          : new Response(JSON.stringify(body), { status: 200 });
    if (url.includes("/summary")) return reply(overrides.summary ?? summaryBody);
    if (url.includes("/veto-scan")) return reply(overrides.scan ?? { matches: [] });
    if (url.includes("/decisions")) return reply(overrides.decisions ?? [vetoRow]);
    if (url.includes("/signals")) return reply(overrides.signals ?? { accepted: true });
    if (url.includes("/context")) return reply(overrides.context ?? "NOT_FOUND");
    return new Response("nf", { status: 404 });
  }) as typeof fetch;
  return calls;
}

const base = {
  session: { id: "s1" },
  memory: { scope: { key: "k", namespace: "ns", value: "team" }, slot: "robrain" },
  operationId: "op-1",
  abortSignal: new AbortController().signal,
  messages: [] as any[],
};
const turnInput = (text: string) => [{ role: "user", content: text }];
const started = (text: string) => ({ ...base, turn: { id: "t0", sequence: 0, input: turnInput(text) } }) as any;
const question = "Should we move the OSS backend to SQLite?";

describe("recall turn.started (self-hosted)", () => {
  it("returns the summary and veto warnings with stable ids", async () => {
    stub();
    const result = await robrainMemory({ projectId: "p1", apiKey: "k" }).recall["turn.started"](started(question));
    assert.deepEqual(result?.messages.map((m) => m.id), ["robrain:summary", "robrain:decision:d2"]);
    assert.match(result?.messages[0]?.content ?? "", /Use Postgres, not SQLite/);
    assert.match(result?.messages[1]?.content ?? "", /SQLite — single-writer lock/);
    assert.match(result?.messages[1]?.content ?? "", /Do not re-propose/);
  });

  it("falls back to /decisions?query= after /context 404s, probing only once", async () => {
    const calls = stub();
    const provider = robrainMemory({ projectId: "p1", apiKey: "k" });
    await provider.recall["turn.started"](started(question));
    await provider.recall["turn.started"](started(question));
    assert.equal(calls.filter((c) => c === "POST /context").length, 1);
    assert.equal(calls.filter((c) => c.startsWith("GET /decisions")).length, 2);
  });

  it("skips relevance lookups for trivial messages but still recalls the summary", async () => {
    const calls = stub();
    const result = await robrainMemory({ projectId: "p1", apiKey: "k" }).recall["turn.started"](started("yes"));
    assert.deepEqual(result?.messages.map((m) => m.id), ["robrain:summary"]);
    assert.equal(calls.some((c) => c.includes("/veto-scan") || c.includes("/context") || c.includes("/decisions")), false);
  });

  it("caches the summary across turns", async () => {
    const calls = stub();
    const provider = robrainMemory({ projectId: "p1", apiKey: "k" });
    await provider.recall["turn.started"](started("ok"));
    await provider.recall["turn.started"](started("ok"));
    assert.equal(calls.filter((c) => c.includes("/summary")).length, 1);
  });

  it("returns null — never throws — when the API is down or no project resolves", async () => {
    stub({ summary: "THROW", scan: "THROW", decisions: "THROW", context: "THROW" });
    assert.equal(await robrainMemory({ projectId: "p1", apiKey: "k" }).recall["turn.started"](started(question)), null);
    stub();
    assert.equal(await robrainMemory({ projectId: () => null }).recall["turn.started"](started("x")), null);
  });

  it("summary can be disabled", async () => {
    stub();
    const result = await robrainMemory({ projectId: "p1", apiKey: "k", summary: false }).recall["turn.started"](started(question));
    assert.deepEqual(result?.messages.map((m) => m.id), ["robrain:decision:d2"]);
  });
});

describe("recall turn.started (cloud /context)", () => {
  const cloud = {
    memories: [
      { id: "d2", decision: "Use Postgres in Docker, not SQLite", rationale: "pgvector", rejected: [{ option: "SQLite", reason: "locks" }], score: 0.9 },
      { id: "d5", decision: "Use pnpm", rationale: "workspace hoisting", rejected: [], score: 0.6 },
    ],
    veto_warnings: [
      { decision_id: "d2", rejected_option: "SQLite", reason: "locks", message: 'Previously rejected: "SQLite" — locks', reviewed: true },
    ],
    required_acknowledgement: "Acknowledge the SQLite rejection explicitly before proceeding.",
  };

  it("uses /context vetoes and ranked memories, veto rendering wins on overlap, ack appended", async () => {
    const calls = stub({ context: cloud });
    const result = await robrainMemory({ projectId: "p1", apiKey: "k" }).recall["turn.started"](
      { ...base, turn: { id: "t4", sequence: 4, input: turnInput(question) } } as any,
    );
    assert.deepEqual(result?.messages.map((m) => m.id), [
      "robrain:summary",
      "robrain:decision:d2",
      "robrain:decision:d5",
      "robrain:acknowledgement",
    ]);
    assert.match(result?.messages[1]?.content ?? "", /^Prior team decision relevant to this task:\nPreviously rejected: "SQLite" — locks/);
    assert.match(result?.messages[2]?.content ?? "", /Relevant prior team decision: Use pnpm\nWhy: workspace hoisting/);
    assert.equal(calls.some((c) => c.startsWith("GET /decisions")), false);
    // session coordinates reach the cloud injection ledger, 1-based like capture
    assert.ok(calls.includes("POST /context"));
    const body = JSON.parse(String(lastInit?.body));
    assert.equal(body.session_id, "eve-s1");
    assert.equal(body.sequence, 5);
    assert.equal(body.budget_tokens, 1500);
  });

  it("after /context is confirmed, a transient failure recalls no unranked vetoes from the list endpoint", async () => {
    const calls = stub({ context: cloud });
    const provider = robrainMemory({ projectId: "p1", apiKey: "k" });
    await provider.recall["turn.started"](started(question)); // confirms /context
    stub({ context: "THROW" });
    const result = await provider.recall["turn.started"](started(question));
    assert.deepEqual(result?.messages.map((m) => m.id), ["robrain:summary"]);
    assert.equal(calls.some((c) => c.startsWith("GET /decisions")), false);
  });

  it("context can be disabled, forcing the self-hosted semantic tier", async () => {
    const calls = stub({ context: cloud });
    await robrainMemory({ projectId: "p1", apiKey: "k", context: false }).recall["turn.started"](started(question));
    assert.equal(calls.some((c) => c === "POST /context"), false);
    assert.ok(calls.some((c) => c.startsWith("GET /decisions")));
  });
});

describe("provider shape", () => {
  // eve validates handler names when it builds and rejects unknown keys (it
  // dropped recall["compaction.completed"] in 0.84.0, which broke `eve build`).
  // Types alone did not catch that, so pin the exact surface we register.
  it("registers only the handlers eve accepts", () => {
    const provider = robrainMemory({ projectId: "p1", apiKey: "k" });
    assert.deepEqual(Object.keys(provider.recall), ["turn.started"]);
    assert.deepEqual(Object.keys(provider.capture ?? {}), ["turn.completed"]);
  });
});

describe("capture turn.completed", () => {
  const completed = {
    ...base,
    turn: { id: "t3", sequence: 3, input: turnInput("Use Hono for HTTP; we rejected Koa.") },
    messages: [
      { role: "user", content: "Use Hono for HTTP; we rejected Koa." },
      { role: "assistant", content: "Recorded: Hono chosen, Koa rejected." },
    ],
  };

  it("ships the last user message and final assistant reply once per operationId", async () => {
    const calls = stub();
    const provider = robrainMemory({ projectId: "p1", apiKey: "k" });
    await provider.capture!["turn.completed"]!(completed as any);
    await provider.capture!["turn.completed"]!(completed as any); // eve may replay the same operation
    assert.equal(calls.filter((c) => c === "POST /signals").length, 1);
  });

  it("can be disabled and never throws when the API is down", async () => {
    const calls = stub();
    await robrainMemory({ projectId: "p1", apiKey: "k", capture: false }).capture!["turn.completed"]!(completed as any);
    assert.equal(calls.length, 0);
    stub({ signals: "THROW" });
    await robrainMemory({ projectId: "p1", apiKey: "k" }).capture!["turn.completed"]!(
      { ...completed, operationId: "op-2" } as any,
    );
  });
});

describe("tools", () => {
  it("exposes check_prior_decisions returning decisions with exact_match flags", async () => {
    stub({ scan: { matches: [{ id: "d9", decision: "Keep REST", rejected: [{ option: "GraphQL", reason: "N+1" }] }] } });
    const tools = (await robrainMemory({ projectId: "p1", apiKey: "k" }).tools!(
      { ...base, turn: { id: "t0", sequence: 0, input: [] } } as any,
    )) as any;
    assert.deepEqual(Object.keys(tools), ["check_prior_decisions"]);
    const out = await tools.check_prior_decisions.execute({ task: "add GraphQL for the mobile API" }, {} as any);
    assert.equal(out.relevant_decisions[0].decision, "Keep REST");
    assert.equal(out.relevant_decisions[0].exact_match, true);
    assert.deepEqual(out.relevant_decisions[0].rejected, ["GraphQL — N+1"]);
  });

  it("returns null when no project resolves", async () => {
    stub();
    assert.equal(
      await robrainMemory({ projectId: () => null }).tools!({ ...base, turn: { id: "t0", sequence: 0, input: [] } } as any),
      null,
    );
  });
});

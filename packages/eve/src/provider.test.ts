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

describe("agent project registration", () => {
  const agentOpts = { agent: "Rory Planner", apiUrl: "http://127.0.0.1:3001", apiKey: "k" };
  const expectedId = "agent-rory-planner-";

  let lastSignalsProject: string | undefined;
  function stubWithProjects(projectsReply: unknown = { accepted: true }) {
    const calls = stub();
    const inner = globalThis.fetch;
    const bodies: unknown[] = [];
    lastSignalsProject = undefined;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (new URL(url).pathname === "/projects" && init?.method === "POST") {
        calls.push("POST /projects");
        bodies.push(JSON.parse(String(init.body)));
        if (projectsReply === "THROW") throw new Error("down");
        const status = projectsReply === "FAIL" ? 500 : projectsReply === "CONFLICT" ? 409 : 200;
        return new Response(JSON.stringify(status === 200 ? projectsReply : { error: String(projectsReply) }), { status });
      }
      if (url.includes("/signals")) lastSignalsProject = (init?.headers as Record<string, string> | undefined)?.["X-Project-Id"];
      return inner(input, init);
    }) as typeof fetch;
    return { calls, bodies };
  }

  it("registers the agent's project before the first recall, once per process", async () => {
    const { calls, bodies } = stubWithProjects();
    const provider = robrainMemory(agentOpts);
    await provider.recall["turn.started"](started(question));
    await provider.recall["turn.started"](started(question));
    assert.equal(calls.filter((c) => c === "POST /projects").length, 1);
    assert.equal(calls[0], "POST /projects");
    const body = bodies[0] as { id: string; name: string; type: string };
    assert.ok(body.id.startsWith(expectedId));
    assert.equal(body.name, "Rory Planner");
    assert.equal(body.type, "agent");
    assert.equal("tags" in body, false);
    assert.ok(calls.some((c) => c.startsWith("GET /projects/") && c.endsWith("/summary")));
  });

  it("does not register when projectId or ROBRAIN_PROJECT_ID is set", async () => {
    const { calls } = stubWithProjects();
    await robrainMemory({ ...agentOpts, projectId: "p1" }).recall["turn.started"](started(question));
    assert.equal(calls.filter((c) => c === "POST /projects").length, 0);
  });

  it("captures into the agent's project and retries registration after a failure", async () => {
    const { calls } = stubWithProjects("FAIL");
    const provider = robrainMemory(agentOpts);
    const completed = {
      ...base,
      turn: { id: "t0", sequence: 0, input: turnInput("Plan my week") },
      messages: [{ role: "assistant", content: "Here is a plan." }],
    } as any;
    await provider.capture!["turn.completed"]!(completed);
    await provider.capture!["turn.completed"]!({ ...completed, operationId: "op-9" });
    assert.equal(calls.filter((c) => c === "POST /projects").length, 2);
    assert.equal(calls.filter((c) => c === "POST /signals").length, 2);
    assert.ok(lastSignalsProject?.startsWith(expectedId), `captured into ${lastSignalsProject}`);
  });

  it("a 409 (id owned by another org) turns the slot off for that agent instead of hammering a foreign project", async () => {
    const { calls } = stubWithProjects("CONFLICT");
    const provider = robrainMemory(agentOpts);
    assert.equal(await provider.recall["turn.started"](started(question)), null);
    assert.equal(await provider.recall["turn.started"](started(question)), null);
    assert.equal(calls.filter((c) => c === "POST /projects").length, 1);
    assert.equal(calls.some((c) => c.includes("/summary") || c === "POST /signals" || c === "POST /veto-scan"), false);
  });

  it("recalls the summary of the agent project, not another", async () => {
    const { calls } = stubWithProjects();
    await robrainMemory(agentOpts).recall["turn.started"](started(question));
    const summaryCall = calls.find((c) => c.endsWith("/summary"));
    assert.ok(summaryCall?.includes(`/projects/${expectedId}`), summaryCall);
  });
});

describe("agent tags", () => {
  it("sends the agent's tags with the registration", async () => {
    const calls: string[] = [];
    let body: any;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (new URL(url).pathname === "/projects") body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(url.includes("/summary") ? { summary: "" } : { accepted: true }), { status: 200 });
    }) as typeof fetch;
    await robrainMemory({ agent: { name: "Mailer", tags: ["Email", "eu"] }, apiKey: "k", apiUrl: "http://127.0.0.1:3001" })
      .recall["turn.started"](started(question));
    assert.deepEqual(body.tags, ["email", "eu"]);
    assert.equal(body.type, "agent");
  });
});

describe("tools used", () => {
  it("sends the names of the tools the turn called with the capture", async () => {
    let signal: any;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/signals")) signal = JSON.parse(String(init?.body)).signal;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }) as typeof fetch;
    const completed = {
      ...base,
      operationId: "op-tools",
      turn: { id: "t0", sequence: 0, input: turnInput("Send the digest") },
      messages: [
        { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "send_email", input: {} }] },
        { role: "assistant", content: "Sent." },
      ],
    } as any;
    await robrainMemory({ projectId: "p1", apiKey: "k" }).capture!["turn.completed"]!(completed);
    assert.deepEqual(signal.tools_used, ["send_email"]);
  });
});

describe("per-session connection (multi-tenant apps)", () => {
  /** Records the API URL and bearer of every request. */
  function recordAuth() {
    const seen: Array<{ url: string; auth: string | undefined }> = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(input), auth: headers.Authorization });
      if (String(input).includes("/context")) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ summary: "s", matches: [], decisions: [] }), { status: 200 });
    }) as typeof fetch;
    return seen;
  }
  const tenantOf = (c: any) => c?.session?.auth?.current?.attributes?.tenant as string | undefined;
  const KEYS: Record<string, string> = { acme: "key-acme", globex: "key-globex" };
  const sessionOf = (id: string, tenant: string) => ({
    id,
    auth: { current: { principalId: `u-${tenant}`, attributes: { tenant } } },
  });
  const options = {
    apiUrl: (c: any) => `https://${tenantOf(c)}.robrain.test`,
    apiKey: async (c: any) => {
      const key = KEYS[tenantOf(c) ?? ""];
      if (!key) throw new Error("no credential for this session");
      return key;
    },
    projectId: (c: any) => `proj-${tenantOf(c)}`,
  };

  it("each session's recall uses its own URL and key", async () => {
    const seen = recordAuth();
    const provider = robrainMemory(options);
    await provider.recall["turn.started"]({ ...started(question), session: sessionOf("s1", "acme") });
    await provider.recall["turn.started"]({ ...started(question), session: sessionOf("s2", "globex") });
    const acme = seen.filter((r) => r.url.startsWith("https://acme.robrain.test"));
    const globex = seen.filter((r) => r.url.startsWith("https://globex.robrain.test"));
    assert.ok(acme.length > 0 && globex.length > 0);
    assert.ok(acme.every((r) => r.auth === "Bearer key-acme"));
    assert.ok(globex.every((r) => r.auth === "Bearer key-globex"));
  });

  it("a tool keeps the connection of the operation that made it", async () => {
    const seen = recordAuth();
    const provider = robrainMemory(options);
    const acmeTools = (await provider.tools!({
      ...base,
      session: sessionOf("s1", "acme"),
      turn: { id: "t0", sequence: 0, input: [] },
    } as any)) as any;
    await provider.tools!({ ...base, session: sessionOf("s2", "globex"), turn: { id: "t0", sequence: 0, input: [] } } as any);
    seen.length = 0;
    await acmeTools.check_prior_decisions.execute({ task: "add GraphQL for the mobile API" }, {} as any);
    assert.ok(seen.length > 0);
    assert.ok(seen.every((r) => r.url.startsWith("https://acme.robrain.test") && r.auth === "Bearer key-acme"));
  });

  it("a throwing key resolver skips the operation without any request", async () => {
    const seen = recordAuth();
    const provider = robrainMemory(options);
    const session = sessionOf("s3", "initech");
    assert.equal(await provider.recall["turn.started"]({ ...started(question), session }), null);
    await provider.capture!["turn.completed"]!({
      ...base,
      session,
      operationId: "op-x",
      turn: { id: "t1", sequence: 1, input: turnInput("We chose Hono; rejected Koa.") },
      messages: [{ role: "assistant", content: "Noted." }],
    } as any);
    assert.equal(await provider.tools!({ ...base, session, turn: { id: "t0", sequence: 0, input: [] } } as any), null);
    assert.equal(seen.length, 0);
  });
});

describe("per-process state is partitioned by connection", () => {
  const sessionFor = (tenant: string) => ({ id: `s-${tenant}`, auth: { current: { attributes: { tenant } } } });
  const tenantOf = (c: any) => c?.session?.auth?.current?.attributes?.tenant as string;

  it("never serves one credential's cached summary to another for the same project id", async () => {
    const summaries: Record<string, string> = { "Bearer key-a": "A's private rules", "Bearer key-b": "B's rules" };
    const summaryCalls: string[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      if (String(input).includes("/summary")) {
        summaryCalls.push(auth);
        return new Response(JSON.stringify({ summary: summaries[auth] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    // Same project id string for both tenants (e.g. "default" in two orgs).
    const provider = robrainMemory({
      apiKey: (c: any) => `key-${tenantOf(c)}`,
      apiUrl: "https://robrain.test",
      projectId: "default",
    });
    const a = await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("a") });
    const b = await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("b") });
    assert.match(a?.messages[0]?.content ?? "", /A's private rules/);
    assert.match(b?.messages[0]?.content ?? "", /B's rules/);
    assert.doesNotMatch(b?.messages[0]?.content ?? "", /A's private rules/);
    assert.deepEqual(summaryCalls, ["Bearer key-a", "Bearer key-b"]);
    // Still cached per connection.
    await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("a") });
    assert.equal(summaryCalls.length, 2);
  });

  it("one credential's 409 or registration never decides for another", async () => {
    const registrations: string[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? "";
      const url = String(input);
      if (url.endsWith("/projects") && init?.method === "POST") {
        registrations.push(auth);
        return new Response("{}", { status: auth === "Bearer key-a" ? 409 : 200 });
      }
      if (url.includes("/summary")) return new Response(JSON.stringify({ summary: "s" }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const warn = console.warn;
    console.warn = () => {};
    try {
      const provider = robrainMemory({
        apiKey: (c: any) => `key-${tenantOf(c)}`,
        apiUrl: "https://robrain.test",
        agent: "Shared Name",
      });
      // a gets 409 → blocked for a only.
      assert.equal(await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("a") }), null);
      // b registers on its own and gets memory.
      const b = await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("b") });
      assert.deepEqual(b?.messages.map((m) => m.id), ["robrain:summary"]);
      // c registers on its own too: b's success is not reused for c.
      await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("c") });
      assert.deepEqual(registrations, ["Bearer key-a", "Bearer key-b", "Bearer key-c"]);
    } finally {
      console.warn = warn;
    }
  });
});

describe("per-connection state is bounded", () => {
  const sessionFor = (tenant: string) => ({ id: `s-${tenant}`, auth: { current: { attributes: { tenant } } } });
  const tenantOf = (c: any) => c?.session?.auth?.current?.attributes?.tenant as string;

  it("evicts the oldest cached summary past the cap (re-fetched, never stale-served)", async () => {
    const summaryCalls: string[] = [];
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (String(input).includes("/summary")) {
        summaryCalls.push(((init?.headers ?? {}) as Record<string, string>).Authorization ?? "");
        return new Response(JSON.stringify({ summary: "s" }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const provider = robrainMemory({
      apiKey: (c: any) => `key-${tenantOf(c)}`,
      apiUrl: "https://robrain.test",
      projectId: "p",
    });
    for (let i = 0; i <= 1000; i++) {
      await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor(`t${i}`) });
    }
    assert.equal(summaryCalls.length, 1001);
    // t0 was the oldest of 1001 entries with a cap of 1000: fetched again.
    await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("t0") });
    assert.equal(summaryCalls.length, 1002);
    // The newest is still cached.
    await provider.recall["turn.started"]({ ...started("ok"), session: sessionFor("t1000") });
    assert.equal(summaryCalls.length, 1002);
  });

  it("re-checks a 409 after an hour instead of remembering it forever", async () => {
    let registrations = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      if (String(input).endsWith("/projects") && init?.method === "POST") {
        registrations += 1;
        return new Response("{}", { status: 409 });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const realNow = Date.now;
    const warn = console.warn;
    console.warn = () => {};
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const provider = robrainMemory({ apiKey: "k", apiUrl: "https://robrain.test", agent: "Taken Name" });
      await provider.recall["turn.started"](started("ok"));
      await provider.recall["turn.started"](started("ok"));
      assert.equal(registrations, 1); // still blocked: no new request
      now += 61 * 60 * 1000;
      assert.equal(await provider.recall["turn.started"](started("ok")), null);
      assert.equal(registrations, 2); // asked the server again, got 409 again
    } finally {
      Date.now = realNow;
      console.warn = warn;
    }
  });
});

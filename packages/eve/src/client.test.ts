import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { RobrainClient, mergeVetoes, resetContextSupport } from "./client.js";

const conn = { apiUrl: "http://127.0.0.1:3001", apiKey: "k", timeoutMs: 1000 };

type Route = (url: string, init?: RequestInit) => unknown;
const realFetch = globalThis.fetch;

function stubFetch(routes: Record<string, Route>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.includes(prefix)) {
        const body = handler(url, init);
        if (body === "FAIL") return new Response("nope", { status: 500 });
        if (body === "NOT_FOUND") return new Response("{}", { status: 404 });
        if (body === "THROW") throw new Error("network down");
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  resetContextSupport();
});

describe("exactVetoes + semanticVetoes + mergeVetoes", () => {
  it("merges exact matches first, dedups by id, gates semantic on similarity", async () => {
    stubFetch({
      "/veto-scan": () => ({ matches: [{ id: "d1", decision: "Use Postgres", rejected: [{ option: "SQLite", reason: "locks" }] }] }),
      "/decisions": () => [
        { id: "d1", decision: "Use Postgres", similarity: 0.9, rejected: [{ option: "SQLite", reason: "locks" }] },
        { id: "d2", decision: "Use pgvector", similarity: 0.7, rejected: [{ option: "Pinecone", reason: "cost" }] },
        { id: "d3", decision: "Low sim", similarity: 0.1, rejected: [{ option: "X", reason: "y" }] },
        { id: "d4", decision: "No rejections", similarity: 0.95, rejected: [] },
      ],
    });
    const api = new RobrainClient(conn);
    const [exact, semantic] = await Promise.all([
      api.exactVetoes("p1", "should we use sqlite"),
      api.semanticVetoes("p1", "should we use sqlite"),
    ]);
    const result = mergeVetoes(exact, semantic);
    assert.deepEqual(result.map((d) => d.id), ["d1", "d2"]);
    assert.equal(result[0]?.exact, true);
    assert.equal(result[1]?.exact, undefined);
  });

  it("sends project_id and the Bearer key on both tiers", async () => {
    const calls = stubFetch({ "/veto-scan": () => ({ matches: [] }), "/decisions": () => [] });
    const api = new RobrainClient(conn);
    await api.exactVetoes("p1", "a long enough query text here");
    await api.semanticVetoes("p1", "a long enough query text here");
    const scan = calls.find((c) => c.url.includes("/veto-scan"))!;
    assert.deepEqual(JSON.parse(String(scan.init?.body)), { project_id: "p1", text: "a long enough query text here" });
    assert.equal((scan.init?.headers as Record<string, string>).Authorization, "Bearer k");
    assert.ok(calls.find((c) => c.url.includes("/decisions"))!.url.includes("project_id=p1"));
  });

  it("is fail-open: server errors and thrown fetches yield []", async () => {
    stubFetch({ "/veto-scan": () => "THROW", "/decisions": () => "FAIL" });
    const api = new RobrainClient(conn);
    assert.deepEqual(await api.exactVetoes("p1", "anything"), []);
    assert.deepEqual(await api.semanticVetoes("p1", "anything"), []);
  });
});

describe("contextRecall (cloud POST /context)", () => {
  it("maps memories and veto_warnings, passes session coordinates and budget", async () => {
    const calls = stubFetch({
      "/context": () => ({
        memories: [{ id: "m1", decision: "Keep REST", rationale: "caching", rejected: [], score: 0.8, signals: {} }],
        // real cloud shape: one warning per rejected option, server-rendered message
        veto_warnings: [
          { decision_id: "d7", rejected_option: "GraphQL", reason: "N+1", message: 'Previously rejected: "GraphQL" — N+1', reviewed: true },
          { decision_id: "d7", rejected_option: "tRPC", reason: "TS-only", message: 'Previously rejected: "tRPC" — TS-only [unreviewed — needs acknowledgement]', reviewed: false },
        ],
        required_acknowledgement: "One or more veto warnings come from unreviewed decisions.",
        injected_at: "now",
      }),
    });
    const result = await new RobrainClient(conn).contextRecall("p1", "add graphql", { sessionId: "eve-s1", sequence: 2, budgetTokens: 900 });
    assert.deepEqual(result?.memories.map((m) => m.id), ["m1"]);
    assert.equal(result?.memories[0]?.rationale, "caching");
    assert.deepEqual(result?.vetoes.map((v) => v.id), ["d7"]);
    assert.deepEqual(result?.vetoes[0]?.rejected, [{ option: "GraphQL", reason: "N+1" }, { option: "tRPC", reason: "TS-only" }]);
    assert.equal(result?.vetoes[0]?.messages?.length, 2);
    assert.equal(result?.vetoes[0]?.reviewed, false);
    assert.equal(result?.requiredAcknowledgement, "One or more veto warnings come from unreviewed decisions.");
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.deepEqual(body, { project_id: "p1", task_description: "add graphql", session_id: "eve-s1", sequence: 2, budget_tokens: 900 });
  });

  it("remembers a 404 per API URL so self-hosted pays for the probe once", async () => {
    const calls = stubFetch({ "/context": () => "NOT_FOUND" });
    const api = new RobrainClient(conn);
    assert.equal(await api.contextRecall("p1", "q"), null);
    assert.equal(await api.contextRecall("p1", "q"), null);
    assert.equal(calls.filter((c) => c.url.includes("/context")).length, 1);
  });

  it("treats transient failures as null without disabling the route", async () => {
    const calls = stubFetch({ "/context": () => "FAIL" });
    const api = new RobrainClient(conn);
    assert.equal(await api.contextRecall("p1", "q"), null);
    assert.equal(await api.contextRecall("p1", "q"), null);
    assert.equal(calls.filter((c) => c.url.includes("/context")).length, 2);
  });
});

describe("alwaysOnSummary", () => {
  it("accepts either summary field name", async () => {
    stubFetch({ "/projects/p1/summary": () => ({ always_on_summary: " decisions… " }) });
    assert.equal(await new RobrainClient(conn).alwaysOnSummary("p1"), "decisions…");
  });

  it("null on failure or blank", async () => {
    stubFetch({ "/projects/p1/summary": () => "FAIL" });
    assert.equal(await new RobrainClient(conn).alwaysOnSummary("p1"), null);
    stubFetch({ "/projects/p1/summary": () => ({ summary: "   " }) });
    assert.equal(await new RobrainClient(conn).alwaysOnSummary("p1"), null);
  });
});

describe("captureTurn", () => {
  it("posts the signal shape Perception expects, with X-Project-Id", async () => {
    const calls = stubFetch({ "/signals": () => ({ accepted: true, action: "written" }) });
    const ok = await new RobrainClient(conn).captureTurn("p1", {
      sessionId: "eve-s1",
      sequence: 1,
      userMessage: "use sqlite?",
      reply: "no — rejected",
    });
    assert.equal(ok, true);
    const call = calls[0]!;
    assert.equal((call.init?.headers as Record<string, string>)["X-Project-Id"], "p1");
    const body = JSON.parse(String(call.init?.body));
    assert.equal(body.signal.needs_classification, true);
    assert.equal(body.signal.turn.session_id, "eve-s1");
    assert.equal(body.signal.turn.sequence, 1);
    assert.equal(body.signal.turn.user_message, "use sqlite?");
    assert.equal(body.signal.turn.claude_reply, "no — rejected");
  });

  it("false (not throw) when the API is down", async () => {
    stubFetch({ "/signals": () => "THROW" });
    assert.equal(
      await new RobrainClient(conn).captureTurn("p1", { sessionId: "s", sequence: 1, userMessage: "u", reply: "r" }),
      false,
    );
  });
});

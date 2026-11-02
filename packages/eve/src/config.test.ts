import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  agentProject,
  agentProjectId,
  resolveConnection,
  resolveProjectId,
  slugifyAgentName,
  type ProjectResolverContext,
} from "./config.js";

const ctx = { memory: { scope: { key: "k", namespace: "ns", value: "team" }, slot: "robrain" } };
const URL = "https://api.example.com";

function sessionCtx(id: string, tenant: string): ProjectResolverContext {
  return {
    ...ctx,
    session: { id, auth: { current: { attributes: { tenant } } } } as unknown as ProjectResolverContext["session"],
  };
}

describe("resolveConnection", () => {
  it("explicit options win, read lazily", async () => {
    const c = await resolveConnection({ apiKey: () => "fn-key", apiUrl: "https://api.example.com/" }, ctx, {});
    assert.deepEqual(c, { apiUrl: "https://api.example.com", apiKey: "fn-key", timeoutMs: 2500, headers: {} });
  });

  it("falls back ROBRAIN_* → PERCEPTION_* → self-hosted default", async () => {
    const a = await resolveConnection({}, ctx, { ROBRAIN_API_URL: "https://r", ROBRAIN_API_KEY: "a", PERCEPTION_API_KEY: "b" });
    assert.equal(a?.apiUrl, "https://r");
    assert.equal(a?.apiKey, "a");
    const b = await resolveConnection({}, ctx, { PERCEPTION_API_URL: "http://host:3001", PERCEPTION_API_KEY: "b" });
    assert.equal(b?.apiUrl, "http://host:3001");
    assert.equal(b?.apiKey, "b");
    const c = await resolveConnection({}, ctx, {});
    assert.equal(c?.apiUrl, "http://127.0.0.1:3001");
    assert.equal(c?.apiKey, "");
  });

  it("rewrites localhost to 127.0.0.1 (IPv6-first resolution vs IPv4-only Docker bind)", async () => {
    assert.equal((await resolveConnection({ apiUrl: "http://localhost:3001/" }, ctx, {}))?.apiUrl, "http://127.0.0.1:3001");
  });

  it("setting functions receive the operation context and may be async (per-session credentials)", async () => {
    const keys: Record<string, string> = { acme: "key-acme", globex: "key-globex" };
    const options = {
      apiKey: async (c?: ProjectResolverContext) => {
        const tenant = (c?.session?.auth as { current?: { attributes?: { tenant?: string } } } | undefined)
          ?.current?.attributes?.tenant;
        return tenant ? keys[tenant] : undefined;
      },
      apiUrl: (c?: ProjectResolverContext) => (c?.session ? `https://robrain.test/${c.session.id}` : undefined),
    };
    const a = await resolveConnection(options, sessionCtx("s1", "acme"), {});
    const b = await resolveConnection(options, sessionCtx("s2", "globex"), {});
    assert.deepEqual(a, { apiUrl: "https://robrain.test/s1", apiKey: "key-acme", timeoutMs: 2500, headers: {} });
    assert.deepEqual(b, { apiUrl: "https://robrain.test/s2", apiKey: "key-globex", timeoutMs: 2500, headers: {} });
  });

  it("a setting function returning undefined falls back to the environment", async () => {
    const c = await resolveConnection({ apiKey: () => undefined }, ctx, { ROBRAIN_API_KEY: "env-key" });
    assert.equal(c?.apiKey, "env-key");
  });

  it("a throwing setting function skips the operation — never the shared env credential", async () => {
    const env = { ROBRAIN_API_URL: "https://shared", ROBRAIN_API_KEY: "shared-key" };
    assert.equal(
      await resolveConnection({ apiKey: () => { throw new Error("no credential for this session"); } }, ctx, env),
      null,
    );
    assert.equal(
      await resolveConnection({ apiUrl: async () => { throw new Error("down"); } }, ctx, env),
      null,
    );
  });

  it("a setting function answering empty or null skips the operation — only undefined falls back", async () => {
    const env = { ROBRAIN_API_URL: "https://shared", ROBRAIN_API_KEY: "shared-key" };
    for (const answer of ["", "   ", null]) {
      assert.equal(await resolveConnection({ apiKey: async () => answer as string }, ctx, env), null);
      assert.equal(await resolveConnection({ apiUrl: () => answer as string }, ctx, env), null);
    }
    // A plain empty value is still "not configured": the environment fills it in.
    assert.equal((await resolveConnection({ apiKey: "" }, ctx, env))?.apiKey, "shared-key");
  });

  it("a setting function that does not answer within timeoutMs skips the operation", async () => {
    const env = { ROBRAIN_API_KEY: "shared-key" };
    const started = Date.now();
    assert.equal(
      await resolveConnection({ apiKey: () => new Promise<string>(() => {}), timeoutMs: 30 }, ctx, env),
      null,
    );
    assert.ok(Date.now() - started < 1000);
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve("tenant-key"), 5));
    assert.equal((await resolveConnection({ apiKey: slow, timeoutMs: 200 }, ctx, env))?.apiKey, "tenant-key");
  });
});

describe("resolveProjectId", () => {
  it("string option, then env", async () => {
    assert.equal(await resolveProjectId({ projectId: " p1 " }, ctx, URL, {}), "p1");
    assert.equal(await resolveProjectId({}, ctx, URL, { ROBRAIN_PROJECT_ID: "p2" }), "p2");
    assert.equal(await resolveProjectId({}, ctx, URL, {}), null);
  });

  it("resolver receives the scope and may return null; a throwing resolver is null, not an error", async () => {
    assert.equal(await resolveProjectId({ projectId: (c) => `proj-${c.memory.scope.value}` }, ctx, URL, {}), "proj-team");
    assert.equal(await resolveProjectId({ projectId: () => null }, ctx, URL, {}), null);
    assert.equal(
      await resolveProjectId({ projectId: () => { throw new Error("boom"); } }, ctx, URL, {}),
      null,
    );
  });

  it("resolver receives the session", async () => {
    assert.equal(
      await resolveProjectId({ projectId: (c) => `proj-${c.session?.id}` }, sessionCtx("s9", "acme"), URL, {}),
      "proj-s9",
    );
  });
});

describe("agent project", () => {

  it("slugifies the agent name", () => {
    assert.equal(slugifyAgentName("  Rory Planner v2! "), "rory-planner-v2");
    assert.equal(slugifyAgentName("---"), "");
    assert.equal(slugifyAgentName("a".repeat(60)).length, 40);
  });

  it("derives a stable id from the name and the API URL, never from the key", () => {
    const a = agentProjectId("Rory Planner", "https://api.example.com");
    assert.match(a, /^agent-rory-planner-[0-9a-f]{8}$/);
    assert.equal(a, agentProjectId("rory planner", "https://api.example.com"));
    assert.notEqual(a, agentProjectId("Rory Planner", "https://other.example.com"));
    assert.notEqual(a, agentProjectId("Support Bot", "https://api.example.com"));
    // The hash covers the full name, not the slug: names that only slugify alike stay apart.
    assert.notEqual(agentProjectId("rory planner", "https://x"), agentProjectId("rory_planner!", "https://x"));
    assert.equal(agentProjectId("rory_planner!", "https://x").startsWith("agent-rory-planner-"), true);
    assert.equal(agentProject({ agent: "---" }, URL), null);
  });

  it("agentProject reads the option; a pinned id wins; no option means null", () => {
    assert.equal(agentProject({}, URL), null);
    const own = agentProject({ agent: "Rory Planner" }, URL);
    assert.equal(own?.name, "Rory Planner");
    assert.equal(own?.id, agentProjectId("Rory Planner", URL));
    assert.deepEqual(agentProject({ agent: { name: "x", id: "proj-42" } }, URL), { id: "proj-42", name: "x", tags: [] });
    assert.deepEqual(agentProject({ agent: { name: "x", tags: [" Email", "eu"] } }, URL)?.tags, ["email", "eu"]);
  });

  it("resolveProjectId: projectId and ROBRAIN_PROJECT_ID win over agent, agent beats nothing", async () => {
    const opts = { agent: "Rory Planner" };
    assert.equal(await resolveProjectId({ ...opts, projectId: "p1" }, ctx, URL, {}), "p1");
    assert.equal(await resolveProjectId(opts, ctx, URL, { ROBRAIN_PROJECT_ID: "p2" }), "p2");
    assert.equal(await resolveProjectId(opts, ctx, URL, {}), agentProjectId("Rory Planner", URL));
  });
});

describe("headers option", () => {
  it("resolves a value or a function of the operation, keeping string entries only", async () => {
    const fixed = await resolveConnection({ headers: { "x-bypass": "s3cret" } }, ctx, {});
    assert.deepEqual(fixed?.headers, { "x-bypass": "s3cret" });
    const normalized = await resolveConnection(
      { headers: { " X-Tenant ": "acme", "bad name": "x", "x-ok": "a\r\nInjected: 1" } },
      ctx,
      {},
    );
    assert.deepEqual(normalized?.headers, { "x-tenant": "acme" });
    const perSession = await resolveConnection(
      { headers: (c) => ({ "x-session": c?.session?.id ?? "none", bad: 1 as unknown as string }) },
      sessionCtx("s7", "acme"),
      {},
    );
    assert.deepEqual(perSession?.headers, { "x-session": "s7" });
  });

  it("a throwing headers function skips the operation", async () => {
    assert.equal(await resolveConnection({ headers: () => { throw new Error("no"); } }, ctx, {}), null);
  });
});

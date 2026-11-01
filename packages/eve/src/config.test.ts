import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agentProject, agentProjectId, resolveConnection, resolveProjectId, slugifyAgentName } from "./config.js";

const ctx = { memory: { scope: { key: "k", namespace: "ns", value: "team" }, slot: "robrain" } };

describe("resolveConnection", () => {
  it("explicit options win, read lazily", () => {
    const c = resolveConnection({ apiKey: () => "fn-key", apiUrl: "https://api.example.com/" }, {});
    assert.deepEqual(c, { apiUrl: "https://api.example.com", apiKey: "fn-key", timeoutMs: 2500 });
  });

  it("falls back ROBRAIN_* → PERCEPTION_* → self-hosted default", () => {
    const a = resolveConnection({}, { ROBRAIN_API_URL: "https://r", ROBRAIN_API_KEY: "a", PERCEPTION_API_KEY: "b" });
    assert.equal(a.apiUrl, "https://r");
    assert.equal(a.apiKey, "a");
    const b = resolveConnection({}, { PERCEPTION_API_URL: "http://host:3001", PERCEPTION_API_KEY: "b" });
    assert.equal(b.apiUrl, "http://host:3001");
    assert.equal(b.apiKey, "b");
    const c = resolveConnection({}, {});
    assert.equal(c.apiUrl, "http://127.0.0.1:3001");
    assert.equal(c.apiKey, "");
  });

  it("rewrites localhost to 127.0.0.1 (IPv6-first resolution vs IPv4-only Docker bind)", () => {
    assert.equal(resolveConnection({ apiUrl: "http://localhost:3001/" }, {}).apiUrl, "http://127.0.0.1:3001");
  });
});

describe("resolveProjectId", () => {
  it("string option, then env", async () => {
    assert.equal(await resolveProjectId({ projectId: " p1 " }, ctx, {}), "p1");
    assert.equal(await resolveProjectId({}, ctx, { ROBRAIN_PROJECT_ID: "p2" }), "p2");
    assert.equal(await resolveProjectId({}, ctx, {}), null);
  });

  it("resolver receives the scope and may return null; a throwing resolver is null, not an error", async () => {
    assert.equal(await resolveProjectId({ projectId: (c) => `proj-${c.memory.scope.value}` }, ctx, {}), "proj-team");
    assert.equal(await resolveProjectId({ projectId: () => null }, ctx, {}), null);
    assert.equal(
      await resolveProjectId({ projectId: () => { throw new Error("boom"); } }, ctx, {}),
      null,
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
    assert.equal(agentProject({ agent: "---" }, {}), null);
  });

  it("agentProject reads the option; a pinned id wins; no option means null", () => {
    assert.equal(agentProject({}, {}), null);
    const own = agentProject({ agent: "Rory Planner", apiUrl: "https://api.example.com" }, {});
    assert.equal(own?.name, "Rory Planner");
    assert.equal(own?.id, agentProjectId("Rory Planner", "https://api.example.com"));
    assert.deepEqual(agentProject({ agent: { name: "x", id: "proj-42" } }, {}), { id: "proj-42", name: "x", tags: [] });
    assert.deepEqual(agentProject({ agent: { name: "x", tags: [" Email", "eu"] } }, {})?.tags, ["email", "eu"]);
  });

  it("resolveProjectId: projectId and ROBRAIN_PROJECT_ID win over agent, agent beats nothing", async () => {
    const opts = { agent: "Rory Planner", apiUrl: "https://api.example.com" };
    assert.equal(await resolveProjectId({ ...opts, projectId: "p1" }, ctx, {}), "p1");
    assert.equal(await resolveProjectId(opts, ctx, { ROBRAIN_PROJECT_ID: "p2" }), "p2");
    assert.equal(await resolveProjectId(opts, ctx, {}), agentProjectId("Rory Planner", "https://api.example.com"));
  });
});

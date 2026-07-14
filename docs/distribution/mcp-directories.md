# MCP directory submissions — ready-to-execute

Submissions for listing RoBrain's Sensing MCP server across the main
directories. Live status is tracked in the priority table below; the repo is
public and `robrain@2.3.7` (with the `robrain mcp` launch command and registry
`mcpName`) is on npm.

## The one thing to decide first: how do people *connect* the server?

RoBrain's Sensing server needs a running Perception backend (`npx robrain up`).
It ships **inside** the `robrain` CLI (vendored, not a separate npm package), and
as of **robrain ≥2.3.6** the CLI exposes a portable launch command — **`robrain mcp`** — so
any directory or hand-written `mcp.json` can use a clean, copy-paste config:

```json
{ "mcpServers": { "robrain-sensing": {
    "command": "npx", "args": ["-y", "robrain", "mcp"]
} } }
```

`robrain mcp` reads the Perception URL + key from `~/.robrain/config.json`
(written by `npx robrain up` / `npx robrain install`), so **no `env` block is
needed** in the mcp.json. To point at a non-default backend, pass them
explicitly and they win:

```json
{ "mcpServers": { "robrain-sensing": {
    "command": "npx", "args": ["-y", "robrain", "mcp"],
    "env": { "PERCEPTION_API_URL": "http://localhost:3001", "PERCEPTION_API_KEY": "..." }
} } }
```

Full setup a first-time user still runs once:

```bash
npx robrain@latest up            # start Postgres + Perception (Docker)
npx robrain install              # (optional) auto-wire editors + write config.json
```

## Consistent copy (reuse verbatim)

**Name:** RoBrain
**Repo:** https://github.com/adelinamart/robrain
**License:** Apache-2.0 · **Language:** TypeScript · **Scope:** local (self-hosted Postgres + pgvector)

**One-liner:**
> Self-hosted decision memory for AI coding agents. Passively captures the
> architectural decisions you make *and the alternatives you rejected*, then
> warns the agent before it re-proposes a rejected approach. Cross-tool across
> Claude Code, Cursor, Copilot, and Codex.

**Longer blurb (for form fields that allow it):**
> RoBrain is Apache-2.0 institutional memory for AI coding agents. Sensing (the
> MCP server) passively captures session turns; Perception extracts each
> decision into Postgres with a structured `rejected[]` field. At task time it
> surfaces the recorded rationale — including *why* an approach was rejected —
> before an agent steers down a path your team already ruled out. Runs entirely
> on your own machine (`npx robrain up`); nothing leaves your infrastructure.
> Benchmarked with VetoBench: 0/50 re-proposals of rejected approaches, receipts
> in-repo.

---

## Priority order (by leverage × fit)

| # | Target | Action | Status | Note |
|---|--------|--------|--------|------|
| 1 | **Glama** | Submit repo w/ root `Dockerfile` | ⬜ next | Prerequisite for awesome-mcp (§1a); introspection check proven locally |
| 2 | **awesome-mcp-servers** | GitHub PR with Glama badge | ⬜ blocked on #1 | Maintainers now require a passing Glama listing + score badge (§1b) |
| 3 | **Official MCP Registry** | `mcp-publisher publish` | ✅ **live** (2.3.7) | Feeds **PulseMCP** + others automatically |
| 4 | **PulseMCP** | Auto from registry | ✅ handled | `hello@pulsemcp.com` only if you want it faster |
| 5 | **mcp.so** | Web form (GitHub URL) | ⬜ optional | Crawls GitHub; may also auto-ingest the registry |
| 6 | **Smithery** | `smithery.yaml` + dashboard | ⚪ skip | Hosts servers in its cloud; RoBrain needs a user-run backend — near-zero payoff (see §5) |

---

## 1. awesome-mcp-servers (→ Glama, now Glama-gated)

**Updated requirement (per maintainer reply):** awesome-mcp now requires the
server to first pass **Glama's** checks, and the PR line must carry a Glama
**score badge**. So the order is now **Glama first, then the awesome-mcp PR**.

### 1a. Glama listing (prerequisite)

Glama builds a Dockerfile and runs MCP introspection (`initialize` +
`tools/list`) — "we only need the server to start and respond to introspection".

- The repo ships a root **[`Dockerfile`](../../Dockerfile)** for exactly this:
  installs the published `robrain` CLI (pnpm, pinned) and runs `robrain mcp`.
  **Verified locally** — the container returns `serverInfo: sensing-mcp 2.3.7`
  and all four `sensing_*` tools with no backend/config/env, which is all Glama
  needs. (Bump the pinned version in the Dockerfile on each release.)
- Submit at **https://glama.ai/mcp/servers**, point it at
  `github.com/adelinamart/robrain`, and let its checks run against the Dockerfile.
- After it passes, note your Glama path (expected `adelinamart/robrain`).

### 1b. awesome-mcp PR

- Fork `punkpeye/awesome-mcp-servers`, edit `README.md`, section **🧠 Knowledge & Memory**, alphabetical (just after `a2cr/a2cr`). One server per line. No `🤖🤖🤖` suffix (that's for automated-agent PRs only).

**Exact line to add** (badge inserted right after the repo link, per the maintainer's format):

```markdown
- [adelinamart/robrain](https://github.com/adelinamart/robrain) [![adelinamart/robrain MCP server](https://glama.ai/mcp/servers/adelinamart/robrain/badges/score.svg)](https://glama.ai/mcp/servers/adelinamart/robrain) 📇 🏠 🍎 🪟 🐧 - Self-hosted decision memory for AI coding agents. Passively captures architectural decisions with the alternatives you rejected (structured `rejected[]`), then warns the agent before it re-proposes a rejected approach. Postgres + pgvector; cross-tool across Claude Code, Cursor, Copilot, and Codex. Install: `npx robrain up && npx robrain install`.
```

(If Glama assigns a path other than `adelinamart/robrain`, swap both badge URLs to match.) Legend: 📇 TypeScript · 🏠 local · 🍎🪟🐧 all OS; no 🎖️ (that's for third-party-API wrappers).

PR description: paste the longer blurb above + "Apache-2.0, self-hosted, receipts in `packages/vetobench/`."

## 2. Official MCP Registry (modelcontextprotocol/registry) → feeds PulseMCP

The registry is the canonical index many directories ingest. The manifest lives
at repo root — **[`server.json`](../../server.json)** (already committed, schema
`2025-12-11`) — pointing at the published `robrain` npm package + the `robrain mcp`
launch command.

**✅ DONE (2026-07-10):** `io.github.adelinamart/robrain` v2.3.7 is live in the
registry and queryable. For future releases, the flow is:

1. Keep `"mcpName": "io.github.adelinamart/robrain"` in `packages/cli/package.json`
   (the registry's ownership check reads it from the **published** npm package).
2. Set both `version` fields in `server.json` to the npm release you publish.
   Keep `description` ≤ **100 chars** (the API rejects longer).
3. Tag and push the release: `git tag v<version> && git push origin v<version>`,
   then wait for the `publish-perception-image` workflow to go green — `robrain up`
   defaults to the GHCR image matching the CLI version, so the image must exist
   before npm does. (The `prepublishOnly` release guard blocks publishing until it does.)
4. `pnpm --filter robrain publish`, then `mcp-publisher login github` +
   `mcp-publisher publish` from the repo root.

PulseMCP ingests registry entries automatically (§4).

## 3. mcp.so

- Submit at https://mcp.so/submit (web form; sign in with GitHub).
- Field it wants: the GitHub repo URL → `https://github.com/adelinamart/robrain`.
- Paste the one-liner as the description; category "Memory" / "Knowledge".
- It crawls the repo README, so the README's plugin + install sections carry the weight — those are already in good shape.

## 4. PulseMCP

- **Passive:** once #2 lands in the Official MCP Registry, PulseMCP ingests it (daily crawl, weekly processing). No separate action.
- **Active (faster / custom blurb):** email `hello@pulsemcp.com` with the repo URL + longer blurb if you want a listing before the registry crawl catches up.

## 5. Smithery (lowest priority)

Smithery is optimized for self-contained or hosted MCP servers; RoBrain's
"stdio server + separate Postgres/Perception backend" shape fits awkwardly, and
a Smithery-hosted deployment can't run our backend for the user. Options:

- **List-only** (if ever pursued): the config lives at the repo root —
  **[`smithery.yaml`](../../smithery.yaml)** (stdio `npx -y robrain mcp`, both
  Perception settings optional with the `~/.robrain/config.json` fallback).
  Connecting the repo in Smithery's dashboard is still required; the yaml alone
  does not list it. Decision on record: **skip** — Smithery hosts servers in its
  cloud, RoBrain needs a user-run backend, so a listing there can't actually
  launch. Revisit only if users ask for it.

---

## Suggested execution sequence (state as of 2026-07-10)

1. ~~`git push` + publish robrain@2.3.7~~ ✅ done — on npm with `mcpName` + `robrain mcp`.
2. ~~Official MCP Registry~~ ✅ **live** — `io.github.adelinamart/robrain` 2.3.7; PulseMCP ingests automatically.
3. **Commit + push the root `Dockerfile`** (Glama builds it from the repo).
4. **Glama** — submit at glama.ai/mcp/servers, wait for checks to pass (§1a).
5. **awesome-mcp-servers PR** with the Glama score badge (§1b).
6. **mcp.so form** — optional speed-up; may also auto-ingest the registry.
7. **Smithery** — skip (see §5).

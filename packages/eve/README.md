# @robrain/eve

RoBrain memory provider for [eve](https://eve.dev) agents. It gives a production agent the same memory your coding agents use: **the team's engineering decisions, including the alternatives you rejected and why** — so the agent stops re-proposing approaches your team already ruled out.

Other eve memory providers remember things about each *user* of the agent. RoBrain remembers what the *team that builds and runs the agent* decided. Because it's the same store your Claude Code, Cursor, and Codex sessions write to, a rejection recorded while building the agent reaches it in production, and a decision made while operating it reaches the engineer's next coding session.

## What the provider does

eve drives every memory provider through one lifecycle. RoBrain fills it like this:

| eve hook | RoBrain behavior |
|---|---|
| `recall` at turn start | Injects the project's always-on summary (top decisions with their rejected alternatives) and, for the incoming message, up to three **veto warnings** — prior decisions whose rejected options the message is drifting toward. Two-tier: deterministic exact match on rejected options, then semantic search. |
| `capture` at turn end | Ships the completed turn for server-side decision extraction. RoBrain extracts decisions *and their rejections* as structured fields and dedups near-duplicates; the provider stays a dumb pipe. |
| tools | `<slot>__check_prior_decisions` — lets the model check decision memory before committing to an approach. |

Recalled messages carry stable ids (`robrain:summary`, `robrain:decision:<id>`), so eve supersedes them in place instead of accumulating copies.

## Install

```bash
npm install @robrain/eve
```

(Once listed in eve's registry: `eve add memory/robrain`.)

Declare a slot. The scope is **shared**, not per-user — this memory belongs to the team:

```ts
// agent/memory/robrain.ts
import { robrainMemory } from "@robrain/eve";
import { defineMemory } from "eve/memory";

export default defineMemory({
  description: "The team's engineering decisions, including rejected alternatives and why.",
  provider: robrainMemory({
    apiKey: () => process.env.ROBRAIN_API_KEY,
  }),
  scope: "team",
});
```

Pass `apiKey` as a function so it's read when the agent runs, not when `eve build` loads the slot.

Add to `agent/instructions.md` so the model uses the tool before proposing approaches:

```md
Before proposing any technology, architecture, or approach, call
`robrain__check_prior_decisions` with a short description of the task. Do not
re-propose a rejected approach without flagging the prior rejection and why
circumstances changed.
```

## Connect it to RoBrain

The provider talks to the RoBrain API. Point it at either:

- **Rory Plans cloud** (hosted; reachable from deployed agents on Vercel): set `ROBRAIN_API_URL` to your Rory Plans API URL and `ROBRAIN_API_KEY` to an org API key (`rp_live_…`). On cloud, relevance comes from `POST /context` — planning-ranked, token-budgeted decisions plus server-side veto warnings, recorded in the injection ledger so effectiveness can be measured per session — in addition to the deterministic veto scan.
- **Self-hosted RoBrain** (open source): `ROBRAIN_API_URL=http://127.0.0.1:3001` for `eve dev` (the default), or the public URL of your own Perception for deployed agents. `PERCEPTION_API_URL` / `PERCEPTION_API_KEY` are honored as fallbacks, so an existing self-hosted setup needs no new variables. Relevance uses `GET /decisions?query=` (similarity-gated); the provider detects the missing `/context` route once and falls back automatically.

Either way, the agent needs a project. Give it a name and the provider creates one for it on first use:

```ts
provider: robrainMemory({
  apiKey: () => process.env.ROBRAIN_API_KEY,
  agent: "rory-planner",
}),
```

The first recall or capture registers project `agent-rory-planner-<hash>`: the slug is for people, the hash covers the full name and the API URL, so the same agent keeps the same memory across deploys and two differently named agents never share one. Everything the agent decides, every run it records and every rule an admin pushes to it lives there. On RoBrain cloud the project is typed as an agent project: only org admins can change what it captures (`robrain capture set --project-id …`), and admins can push decisions into it from the coding memory with `robrain promote` (cloud only). To share an existing project instead, set `projectId` or `ROBRAIN_PROJECT_ID`; they win over `agent`. Start a self-hosted stack with `npx robrain@latest up`.

Give the agent tags for what kind of agent it is, and an admin can push a rule to just that kind:

```ts
agent: { name: "rory-mailer", tags: ["email", "eu"] },
```

`robrain promote <id> --to tag:email` then reaches every agent tagged `email`, including ones registered later; `--to production-agents` reaches all of them. Tags are letters, digits, `_` and `-`, at most 10. On cloud, changing the tags of an existing agent is an admin action.

Two things to know before production:

- **Changing the API URL moves the memory.** The id includes the URL, so pointing the agent at a new RoBrain (a migration, `http` to `https`, a new host) starts an empty project. Pin the id for anything that must survive that: `agent: { name: "rory-planner", id: "agent-rory-planner-prod" }`.
- **One name per org on cloud.** If the id already belongs to another org, the API answers 409; the provider logs one warning, keeps the slot inactive for that agent (no memory read or written, the turn continues) and does not retry. Rename the agent or pin an id.

| Option | Env fallback | Default |
|---|---|---|
| `apiUrl` | `ROBRAIN_API_URL`, `PERCEPTION_API_URL` | `http://127.0.0.1:3001` |
| `apiKey` | `ROBRAIN_API_KEY`, `PERCEPTION_API_KEY` | — (a value or a function of the operation, see [Multi-tenant apps](#multi-tenant-apps)) |
| `agent` | | — (the agent's own project, created on first use) |
| `projectId` | `ROBRAIN_PROJECT_ID` | — (slot is inactive without `agent` or a project id) |
| `summary` | | `true` |
| `vetoLimit` | | `3` |
| `capture` | | `true` |
| `timeoutMs` | | `2500` |
| `headers` | | — (extra request headers; a value or a function of the operation) |

### Multi-tenant apps

`projectId` also accepts a resolver that maps eve's memory scope to a RoBrain project, for apps where different scopes should read different teams' memory:

```ts
provider: robrainMemory({
  projectId: ({ memory }) => tenantToProject[String(memory.scope.value)] ?? null,
}),
scope: (ctx) => ctx.session.auth.current?.attributes.tenantId ?? null,
```

Returning `null` leaves the slot inactive for that operation.

On RoBrain cloud a project belongs to one org, and so does a credential. When different sessions belong to different orgs, give each its own credential too: `apiKey` and `apiUrl` also accept a function of the operation, which receives the same context as the `projectId` resolver, including `session` (its id and verified `auth`). The function may be async:

```ts
provider: robrainMemory({
  apiKey: async (ctx) => {
    const credential = await credentialFor(ctx?.session); // your app's lookup
    if (!credential) throw new Error("no RoBrain credential for this session");
    return credential.apiKey;
  },
  apiUrl: () => process.env.ROBRAIN_API_URL,
  projectId: ({ session }) => projectFor(session),
}),
```

A setting function that returns `undefined` falls back to the environment (`ROBRAIN_API_KEY`, …). One that **throws** skips the operation: no request is made and the turn continues without memory. So does an `apiKey` or `apiUrl` function that returns an empty string or `null`, and any setting function that takes longer than `timeoutMs` (default 2500 ms) to answer. A multi-tenant resolver should throw when it cannot find the session's credential, so it never falls back to a shared one. Each tool call uses the connection of the operation that created the tool.

Setting functions run for every recall, capture and tools call, each one separately, so a turn can call `credentialFor` several times. Cache its lookup per session in your app if it is not cheap.

With per-session credentials, prefer `projectId` over `agent`. An `agent` name maps to the same project id for every org on one API URL, so the first org to use it owns the project and every other org gets a 409 and no memory for that agent. If you do use `agent` here, pin a per-org id: `agent: { name, id }`.

If `apiUrl` points at a proxy in your own app rather than at RoBrain itself (so the RoBrain credential never leaves your server), `headers` adds what that hop needs, for example a deployment-protection bypass: `headers: () => ({ "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "" })`. Like `apiKey`, it may be a function of the operation, and throwing skips the operation. The provider's own `Authorization`, `Content-Type` and `X-Project-Id` headers always win over yours, whatever their case. Headers are all-or-nothing: if any entry is unusable (a name that is not a header token, a value with control characters, two names that differ only by case) or the value is not a plain object, the operation is skipped rather than sent without it.

Keep header values stable for a given tenant. Per-process state (the cached summary, the `agent` project's registration, the `/context` probe) is keyed by URL, key and headers together, so a value that changes on every request, such as a request id or a nonce, gives every operation a fresh key: the summary is fetched again each turn and an `agent` project is registered again on every call. Put per-request values in your proxy instead.

## Cloud-specific behavior

- Veto warnings from `/context` arrive one per rejected option with a server-rendered line; the provider groups them per decision and recalls those lines verbatim.
- Decisions that were **captured but not yet reviewed** still produce veto warnings, and the cloud attaches a `required_acknowledgement`. The provider recalls it as its own message (`robrain:acknowledgement`) so the agent surfaces the warning and gets an explicit acknowledgement before proceeding against the option — the cloud's pre-task veto acknowledgement, carried into eve.
- Only **reviewed** decisions are eligible as ranked memories; unreviewed ones surface via warnings only.
- Turn sequences sent to the cloud are 1-based (eve counts from 0), matching how capture numbers turns.
- Once `/context` has succeeded for an API URL, a transient failure recalls no semantic vetoes for that turn rather than falling back to the unranked list endpoint.

## Behavior under failure

eve fails a turn if a recall handler throws, so this provider never throws: an unreachable or misconfigured API means "recall nothing" and "capture nothing," and the agent continues without memory. Requests carry hard timeouts (`timeoutMs`; recall runs before the model call, so keep it short) and never follow redirects: a 3xx (an `http` → `https` hop, a login page in front of a protected deployment) is a failed request, so set `apiUrl` to the final URL. eve delivers capture at least once; the provider skips repeated `operationId`s in-process, and RoBrain dedups near-identical decisions server-side.

## Notes

- Requires Node ≥ 24 (eve's floor). Builds on eve 0.82.0 through 0.84.0; 0.1.0 does not build on eve 0.84.0 or later, so use 0.1.1+.
- Recalled content enters model context as user-role messages attributed to the slot, per eve's trust model — never as system instructions. (That placement is the one RoBrain's public benchmark, [VetoBench](../vetobench/README.md), measures; with rejections in context, 0 re-proposals in 159 of 159 tasks across six models.)
- The provider partitions by RoBrain project; a slot bound to one `agent` or `projectId` shares memory across all scopes that reach it. Use the resolver form when scopes must not share.
- Registration is fail-open: if the API is down on the first turn, the handler continues without memory and the next handler registers the project.
- Prefer this package over the raw-surfaces integration in [plugins/eve](../../plugins/eve/README.md), which predates eve's memory subsystem and remains as a reference.

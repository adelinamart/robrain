# @robrain/eve

RoBrain memory provider for [eve](https://eve.dev) agents. It gives a production agent the same memory your coding agents use: **the team's engineering decisions, including the alternatives you rejected and why** — so the agent stops re-proposing approaches your team already ruled out.

Other eve memory providers remember things about each *user* of the agent. RoBrain remembers what the *team that builds and runs the agent* decided. Because it's the same store your Claude Code, Cursor, and Codex sessions write to, a rejection recorded while building the agent reaches it in production, and a decision made while operating it reaches the engineer's next coding session.

## What the provider does

eve drives every memory provider through one lifecycle. RoBrain fills it like this:

| eve hook | RoBrain behavior |
|---|---|
| `recall` at turn start | Injects the project's always-on summary (top decisions with their rejected alternatives) and, for the incoming message, up to three **veto warnings** — prior decisions whose rejected options the message is drifting toward. Two-tier: deterministic exact match on rejected options, then semantic search. |
| `recall` after compaction | Re-injects the summary — the moment compaction would otherwise have dropped it. |
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

Either way, set `ROBRAIN_PROJECT_ID` to the project whose memory this agent shares (the same id your coding-agent integrations use — that's what makes the memory combined). Start a self-hosted stack with `npx robrain@latest up && npx robrain init-project`.

| Option | Env fallback | Default |
|---|---|---|
| `apiUrl` | `ROBRAIN_API_URL`, `PERCEPTION_API_URL` | `http://127.0.0.1:3001` |
| `apiKey` | `ROBRAIN_API_KEY`, `PERCEPTION_API_KEY` | — |
| `projectId` | `ROBRAIN_PROJECT_ID` | — (slot is inactive without one) |
| `summary` | | `true` |
| `vetoLimit` | | `3` |
| `capture` | | `true` |
| `timeoutMs` | | `2500` |

### Multi-tenant apps

`projectId` also accepts a resolver that maps eve's memory scope to a RoBrain project, for apps where different scopes should read different teams' memory:

```ts
provider: robrainMemory({
  projectId: ({ memory }) => tenantToProject[String(memory.scope.value)] ?? null,
}),
scope: (ctx) => ctx.session.auth.current?.attributes.tenantId ?? null,
```

Returning `null` leaves the slot inactive for that operation.

## Cloud-specific behavior

- Veto warnings from `/context` arrive one per rejected option with a server-rendered line; the provider groups them per decision and recalls those lines verbatim.
- Decisions that were **captured but not yet reviewed** still produce veto warnings, and the cloud attaches a `required_acknowledgement`. The provider recalls it as its own message (`robrain:acknowledgement`) so the agent surfaces the warning and gets an explicit acknowledgement before proceeding against the option — the cloud's pre-task veto acknowledgement, carried into eve.
- Only **reviewed** decisions are eligible as ranked memories; unreviewed ones surface via warnings only.
- Turn sequences sent to the cloud are 1-based (eve counts from 0), matching how capture numbers turns.
- Once `/context` has succeeded for an API URL, a transient failure recalls no semantic vetoes for that turn rather than falling back to the unranked list endpoint.

## Behavior under failure

eve fails a turn if a recall handler throws, so this provider never throws: an unreachable or misconfigured API means "recall nothing" and "capture nothing," and the agent continues without memory. Requests carry hard timeouts (`timeoutMs`; recall runs before the model call, so keep it short). eve delivers capture at least once; the provider skips repeated `operationId`s in-process, and RoBrain dedups near-identical decisions server-side.

## Notes

- Requires Node ≥ 24 (eve's floor). Verified against eve 0.82.0.
- Recalled content enters model context as user-role messages attributed to the slot, per eve's trust model — never as system instructions. (That placement is the one RoBrain's public benchmark, [VetoBench](../vetobench/README.md), measures; with rejections in context, 0 re-proposals in 159 of 159 tasks across six models.)
- The provider partitions by RoBrain project; a slot bound to one `projectId` shares memory across all scopes that reach it. Use the resolver form when scopes must not share.
- Prefer this package over the raw-surfaces integration in [plugins/eve](../../plugins/eve/README.md), which predates eve's memory subsystem and remains as a reference.

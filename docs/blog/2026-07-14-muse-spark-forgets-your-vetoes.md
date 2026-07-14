# We asked Meta's new model to build things its team had already rejected

*2026-07-14 · five archived runs · [receipts in-repo](../../packages/vetobench/results/muse-spark-1.1-series/) · reproduce for ~$2*

Meta launched [Muse Spark 1.1](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/) last week with a memory story front and center: a 1M-token context window with "active context management" — the model compacts its own history, keeping what it judges critical and dropping the rest.

We measured the kind of remembering that pitch leaves out: **given an ordinary engineering task where the natural answer is an approach your team already evaluated and rejected, does the agent propose it again?**

Across a five-run archived series: with no memory in context, Muse Spark 1.1 re-proposed the rejected approach in **4 to 6 of 9 tasks per run** — Redux, Prisma, Jest, and GraphQL in **all five runs**. With the team's decision history injected: **0 violations in all 45 cells, and it cited the original rejection — reason and date included — in every single one.**

## The test

[VetoBench](../../packages/vetobench/README.md) is a small, open benchmark we built for exactly this question. A checked-in corpus of 24 synthetic engineering decisions, 10 of which carry a structured rejection with its reason — an incident, a failed spike, a rolled-back migration. Ten scenarios each pose a task a developer would actually ask, where the natural answer is one of those rejected approaches.

Judging is deterministic code, not an LLM judge, and it's biased to *under*count violations: naming an approach while declining it counts as a reference, not a proposal. Every context, raw model reply, and verdict is committed to the repo. Don't take our word for anything below — read the JSON.

## One cell, narrated

Scenario s10. The task:

> The mobile team complains about overfetching from the public API — screens pull whole resources to read two fields. Propose an API approach that lets clients fetch exactly the fields they need.

Every engineer knows the reflex answer. This team had considered it and ruled it out, on the record. Muse Spark walked into it **five runs out of five**:

**Muse Spark 1.1, no memory (run 1 of 5):**

> "Introduce a GraphQL gateway layer in front of our existing domain services. Define a unified typed schema for current resources with resolvers that delegate to the existing REST/service layer. Mobile clients will request only the fields needed per screen via GraphQL selection sets…"
>
> `key_technologies: ["GraphQL", "Apollo Server", "Apollo Client", "DataLoader", "graphql-query-complexity"]`
> `acknowledged_rejections: []`

A complete, competent GraphQL rollout — of the approach the team rejected, for reasons this proposal walks straight back into (the resolver N+1s it plans to mitigate with DataLoader were part of why GraphQL was declined).

**Muse Spark 1.1, with the team's decision history in context (same run):**

> "Keep the public API as REST with URL path versioning (/v1) and OpenAPI spec, and solve overfetching with sparse fieldsets. Clients can request exactly what they need via `?fields=id,name,avatar_url`…"
>
> `acknowledged_rejections: ["GraphQL — Resolver N+1s and cache invalidation complexity outweigh flexibility for our ~30-endpoint surface; evaluated 2026-05 with the mobile team present", "tRPC — Public consumers are not all TypeScript; locks the contract to one language ecosystem"]`

Same model. Same task. The only difference is whether the rejection existed in its context — down to citing when it was evaluated and who was in the room.

## The numbers

Muse Spark 1.1 via Vercel AI Gateway, 2026-07-14, five archived runs, temperature 0, quoted as min–max across runs. One scenario is excluded for this model (n=9 per condition — see caveats):

| Memory condition | Re-proposed a rejected approach | Cited the prior rejection |
|---|---|---|
| No memory | **4–6 of 9 per run (44–67%)** | 0–1 of 9 |
| Conventions file (choices only, no rejections) | 0 of 9, every run | 8–9 of 9 — but as inference; the recorded reasons aren't there |
| Flat dump of all decisions incl. rejections | 0 of 9, every run | 8 of 9 |
| **RoBrain decision memory** | **0 of 9, every run** | **9 of 9, every run — verbatim, with the recorded reason** |

The traps it walked into without memory, by consistency: Redux, Prisma, Jest, GraphQL — five runs out of five; auto-generated migrations — three of five; localStorage — one of five. It avoided Express, axios, and styled-components in all runs.

Two honest observations about that table, before anyone else makes them for us:

**Muse Spark is better at this than the other models we've measured.** Like-for-like on the same nine scenarios (excluding the one Meta's filter blocks — which, for the record, both other models violated): claude-haiku-4-5 violated in **7–8 of 9** across its own five-run archived series, and a single-run gpt-4o pre-flight hit **9 of 9**. Muse Spark's **4–6 of 9** is the best no-memory result we've recorded. Credit where due — and it still walked into Redux, Prisma, Jest, and GraphQL every single time.

**For this model, a conventions file was enough to prevent violations — at this corpus size.** That's better than Haiku (1–2 violations with conventions) and gpt-4o (2). The difference RoBrain makes for Muse Spark is in the citation column and in how the file gets there: conventions acknowledgments are inferences ("the team chose REST, so presumably not GraphQL") with no recorded reason to point to; RoBrain's 45/45 acknowledgments quote the actual rejection, reason and date. And a conventions file is hand-maintained — the decisions in RoBrain's condition were captured automatically from session transcripts by the same pipeline we [benchmarked end-to-end against Mem0](../../packages/vetobench/README.md#end-to-end-robrain-e2e). At 24 decisions everything fits in a context window; at hundreds, retrieval decides what's in front of the model, which the offline layer measures separately.

## Why a bigger context window doesn't fix this

A model cannot cite a rejection it has never seen. Capability doesn't help — a smarter model produces a *more convincing* proposal for the thing your team ruled out; Muse Spark's GraphQL rollout came with a query-complexity budget and a migration path.

And compaction makes the problem quietly worse, not better. Active context management keeps what looks critical *for the current task*. A rejection recorded three sessions ago, in a different tool, by a different teammate, is exactly what a "keep only what's critical now" heuristic discards — it never looks load-bearing until the moment it's violated.

For completeness: Meta does ship memory — for consumers. The Meta AI app remembers that you're vegetarian. The [Meta Model API](https://dev.meta.ai/docs/getting-started/overview/) that developers build on ships no persistence at all: no sessions, no memory store, nothing across conversations. (Meta FAIR's "Memory Layers at Scale" is unrelated — that's about storing facts in model weights.) If you build an agent on Muse Spark and want it to remember what your team decided, you bring your own memory. That's the layer [RoBrain](https://github.com/adelinamart/robrain) is.

## Caveats — read before quoting

- **The fixtures are synthetic and we wrote them.** Realistic, but ours. The antidote is that everything is checked in — read them, dispute them, or PR harder ones, including ones that make us look bad.
- **n=9 per condition for this model.** Meta's content filter deterministically blocks one of our ten prompts — "propose a caching layer for session data" — as a policy violation. Twenty attempts across four conditions and five runs, twenty blocks. We invite theories about the session cache.
- **Small n, real variance.** Five runs, nine scenarios; the no-memory rate moved between 44% and 67% run to run. That's why every number above is a range, and why the raw archives — every context, reply, and verdict — are committed for recounting.
- **A flat dump ties RoBrain at this corpus size** — 24 decisions fit in any window. The behavioral delta of retrieval shows up at real corpus sizes; the offline retrieval layer measures it directly (veto recall@5 = 1.00 with file-scope known / 0.70 without, deterministic, no API key needed).
- **What would change our mind:** Meta shipping a developer-facing memory API that preserves rejections; a model that reliably asks "has this team ruled anything out?" before proposing. We'd welcome both.
- Earlier exploratory free-tier runs (rate-limit-fragmented, since superseded by this series) remain archived in the same directory with their own provenance notes — we don't delete data.

## Reproduce it

Any [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) key works — Muse Spark isn't on OpenRouter, and Meta's own portal is US-only, but the gateway isn't. The five-run series cost us about $2 in paid credits; the free tier's burst limits can't sustain a full run:

```bash
git clone https://github.com/adelinamart/robrain && cd robrain
pnpm install && pnpm --filter @robrain/vetobench build
# from a directory outside the repo, with this .env:
#   LLM_PROVIDER=openai
#   OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v1
#   OPENAI_API_KEY=<your AI Gateway key>
#   VETOBENCH_JSON_MODE=0        # Muse Spark rejects response_format
#   VETOBENCH_MAX_TOKENS=8000    # reasoning tokens eat a 1024 ceiling
node <repo>/packages/vetobench/dist/run.js --live \
  --adapters none,conventions,flatfile,robrain \
  --model meta/muse-spark-1.1 --archive my-run.json
```

The offline retrieval layer runs with no key at all: `pnpm --filter @robrain/vetobench bench`.

## What RoBrain does with this

RoBrain captures your team's engineering decisions — including the alternatives you rejected and why — as your agents work, and injects the relevant ones back *before* the next agent re-proposes them. Structured `rejected[]` fields, so a veto can't get summarized away; a pre-task check, so it arrives at the moment it matters. Self-hosted, open source, works across Claude Code, Cursor, and Codex today.

```bash
npx robrain@latest up && npx robrain init-project
```

[github.com/adelinamart/robrain](https://github.com/adelinamart/robrain)

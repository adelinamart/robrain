# We asked Meta's new model to build things its team had already rejected

*2026-07-14 · five archived runs · [receipts in-repo](../../packages/vetobench/results/muse-spark-1.1-series/) · reproduce for ~$2*

Meta launched [Muse Spark 1.1](https://ai.meta.com/blog/introducing-muse-spark-meta-model-api/) last week with a memory story front and center: a 1M-token context window with "active context management" — the model compacts its own history, keeping what it judges critical and dropping the rest.

We measured the kind of remembering that pitch leaves out: **given an ordinary engineering task where the natural answer is an approach your team already evaluated and rejected, does the agent propose it again?**

And because nobody actually ships an agent with zero memory — you have a conventions file, Cursor rules, an auto-memory, maybe a memory product — the real comparison isn't memory vs none. It's **whether the rejection survives your memory layer**: a bare no-memory floor, a hand-maintained choices file, a flat dump, and RoBrain's structured decision memory, all facing the same tasks. (We previously ran Mem0's full production pipeline through the same harness; that result matters here too.)

Across a five-run archived series: with no memory in context, Muse Spark 1.1 re-proposed the rejected approach in **4 to 6 of 9 tasks per run** — Redux, Prisma, Jest, and GraphQL in **all five runs**. With the team's decision history injected: **0 violations in all 45 cells, and it named the prior rejection it was avoiding in every single one** — at times quoting the recorded reason and date verbatim, as in the exhibit below.

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
| Hand-maintained conventions file (choices only, no rejections) | 0 of 9, every run | 8–9 of 9 — but as inference; the recorded reasons aren't there |
| Flat dump of every decision incl. rejections (fits at 24 decisions; won't at 400) | 0 of 9, every run | 8 of 9 |
| **RoBrain decision memory** | **0 of 9, every run** | **9 of 9, every run — grounded in the recorded rejection** |

The traps it walked into without memory, by consistency: Redux, Prisma, Jest, GraphQL — five runs out of five; auto-generated migrations — three of five; localStorage — one of five. It avoided Express, axios, and styled-components in all runs.

And this is not a Muse Spark problem — **every frontier model we ran walks into these traps without memory, and most still leak through choices-only memory.** Like-for-like on the same nine scenarios (excluding the one Meta's filter blocks for its own model — the others completed it), violations per run:

| Model | No memory | Choices-only file **we supplied** (no model here has native API memory) | RoBrain decision memory |
|---|---|---|---|
| claude-opus-4.8 | 3–4 of 9 | 0–1 of 9 (re-proposed auto-generated migrations) | **0** — 18/18 cells |
| **muse-spark-1.1** | 4–6 of 9 | 0, five runs | **0** — 45/45 cells |
| gpt-5.5 | 5 of 9 (identical both runs) | 0–1 of 9 (re-proposed CSS-in-JS) | **0** — 18/18 cells |
| gemini-3-pro-preview | 6–7 of 9 | 0, both runs | **0** — 18/18 cells |
| claude-haiku-4-5 | 7–8 of 9 | 1–2 of 10 per run | **0** — 50/50 cells |
| gpt-4o | 9 of 9 | 2 of 10 | **0** — 10/10 cells |

(Muse Spark and Haiku are five-run series; the other baselines are two runs — directional, not completed series. Haiku and gpt-4o conventions/robrain cells are n=10; archives in [results/frontier-none-baselines/](../../packages/vetobench/results/frontier-none-baselines/).)

Three things this table says. **No model scored zero without memory** — Prisma and Jest fell to every model in every no-memory run; Opus 4.8 posted the best baseline, with Muse Spark a strong second for a week-old model. **Choices-only memory gets you close but not safe** — four of six models still re-proposed a rejected approach at least once with the conventions file in context, and its acknowledgments are inferences throughout (7–9 of 9, no recorded reason to cite). **The right-hand column is the only all-zero column: 159 of 159 cells across six models from four vendors, every cell naming the prior rejection.** The gap isn't model-shaped; it's context-shaped.

Two misreadings to head off. A 0 in a two-run middle-column cell means *didn't leak in two runs*, not *won't leak* — Opus and GPT-5.5 each leaked in exactly one of their two; a clean 0 at this sample size is within the noise. And a genuine 0 in that column still wouldn't mean the model "has good memory": the middle column presumes a complete, current, hand-maintained file — the artifact teams famously don't keep — read by a model that can't cite why anything on it was rejected. It's a score for the document, not the model.

One more finding you'd expect us to test but can't: **each vendor's own default memory layer.** Three of the four don't have one at the developer API level — Meta's Model API, OpenAI's API, and Google's API ship no persistence at all (their memory features are consumer-app-only). Anthropic's beta memory tool is the sole exception; running it through VetoBench needs a proper tool-use harness and is a follow-up we intend to publish, whatever it shows.

## Everyone already has a memory layer. Does the rejection survive it?

Rows 2 and 3 also show zero violations — that's the honest mechanism finding: **for this model, at this corpus size, any decision context in the prompt prevents violations.** The middle rows aren't embarrassing to us; they're the point — vetoes-in-context is the mechanism, and we're not pretending 24 decisions need a retrieval system.

But "I have a memory layer" is not the same as "my memory layer kept the rejection." That's the axis that actually separates the rows — and where the memory stack most teams already run starts to leak:

1. **Summarizing memory pipelines drop vetoes at ingestion.** We ran [Mem0's full production pipeline](../../packages/vetobench/README.md#third-party-systems-mem0) through this same harness on identical input: its ingestion lost the recorded rejection from **38% of retrieved contexts**, and violations concentrated exactly there — 26% when the veto was absent vs 3% when present. A veto that doesn't survive ingestion eventually stops protecting. RoBrain's extractor, benchmarked [end-to-end on the same transcripts](../../packages/vetobench/README.md#end-to-end-robrain-e2e), kept 100/100 — because `rejected[]` is a first-class output field, not a lucky side effect of summarization.
2. **Choices-only memory leaks — and can't cite.** With the same conventions file in context, Haiku still violated 1–2 tasks per run and gpt-4o violated 2; the shortcut is model-dependent. And even where it held (Muse Spark), the acknowledgments are *guesses*: "the team chose REST, so presumably not GraphQL" — an inference that can be argued back out, because there's no recorded reason to stand on. In RoBrain's condition the recorded reason sits in context: all 45 acknowledgments name the actual rejection, and when the model elaborates it quotes the record verbatim — *"resolver N+1s and cache invalidation complexity… evaluated 2026-05 with the mobile team present."* One of these ends the debate; the other reopens it.
3. **Somebody has to write the file.** The conventions row assumes a hand-maintained document that's complete and current — which is exactly the thing teams don't have. The decisions in RoBrain's row were captured automatically from session transcripts by its production pipeline. A file nobody updates is the row-1 condition wearing a row-2 costume.
4. **24 decisions fit in a prompt. Your corpus won't.** At hundreds of decisions, retrieval decides what's in front of the model, and that's measured separately by the offline layer (veto recall@5 = 1.00 with file scope known / 0.70 without).

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

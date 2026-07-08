# Your memory says the retrieval was right. Git says the decision was wrong.


Every AI memory benchmark measures the same thing: did the right item come
back? Recall, precision, needle-in-a-haystack scores. All of them assume that
if the memory was retrieved, the job is done.

Here is what none of them can see: the memory came back perfectly, and it was
wrong. Not wrong when it was stored — wrong *now*, because the codebase moved
on and the memory didn't.

## Three memories from our own repo

We ran `robrain outcomes` on the RoBrain repo itself — 101 commits, 92
recorded decisions, two months of real development history. Three examples of
what the feedback loop found, none of them synthetic:

**1. The architecture PDF.** On May 8 we recorded a decision to keep
`robrain_architecture.pdf` updated as the reference for the OSS
implementation. Three days later, commit `8c1c9f1` deleted the PDF — 620
lines gone, `docs/architecture.md` became the single source of truth. The
decision sat in memory at full relevance for two months. Any retrieval system
would have served it proudly: semantically on-topic, recently created,
explicitly recorded. Recording the revert outcome demoted it from 0.50 to
0.35.

**2. The Bun test runner.** On May 6 we decided: "Adopt Bun as the project
test runner." Reality drifted — commit `5df43ef` on May 28 quietly added
`node --test` scripts, and today half the workspace's packages test with
`node --test`, not Bun. Nobody wrote "we are walking back the Bun decision"
anywhere. It just stopped being true, one package.json at a time. Recorded as
a revert: 0.50 → 0.35.

**3. The one git confirmed.** The loop moves both directions. A May 13
decision — repo `.env` wins as the key source during self-hosted install —
is still exactly what the shipped code does today
(`packages/cli/src/commands/install.ts`). Recording the confirmation promoted
it from 0.50 to 0.60. Memories that survive contact with the codebase should
outrank memories that didn't.

One honest detail: robrain's history contains **zero literal `git revert`
commits**. In a small team, walk-backs don't arrive with a `Revert "..."`
subject line — they arrive as a delete commit, a new script, a quiet
migration. `robrain outcomes` scans for the formal reverts automatically
(matching them to decisions by file overlap inside a 90-day window), and
`robrain outcomes record` is the manual path for everything git can't label
for you. In our repo, the manual path is where all three links above came
from. On a larger team with revert discipline, the scan does it unattended.

## Why retrieval metrics can't see this

A retrieval benchmark scores the question "given a query, did the stored item
come back?" All three memories above would ace that test. The PDF decision
*was* retrieved correctly — that's precisely the problem. It was retrieved
correctly for two months after the PDF ceased to exist.

Retrieval accuracy measures the distance between a query and a stored
answer. It cannot measure the distance between the stored answer and the
current state of the world, because the benchmark has no access to the world.
The memory store is graded against itself.

Coding is the rare domain where the world grades you back. Git history is a
running record of which decisions survived: the revert, the deletion, the
migration that replaced the thing you committed to. A memory system for
coding agents that ignores this signal is choosing not to know whether its
own contents are still true.

There's a second failure the same metrics can't see: the memory that keeps
coming back and keeps being ignored. If retrieval says "relevant" and the
agent never uses it, that disagreement is data — but a retrieval benchmark
scores it as a success.

## How outcomes and auto-demotion work

RoBrain stores each decision with a `historical_relevance` score that starts
neutral and moves only on evidence:

- **`revert`** (git undid it): −0.15
- **`incident`** (it caused a problem in production): −0.10
- **`confirmed`** (it's still what the code does): +0.10

`historical_relevance` is one of the five signals in the composite score that
decides what gets injected into the next session (alongside semantic
similarity, file overlap, recency, and review approval). A reverted decision
doesn't get deleted — it sinks in the ranking and gets flagged for
`robrain review`, where a human decides whether it's superseded. History
stays queryable; it just stops being served as if it were current.

The second mechanism needs no git at all: **auto-demotion of ignored
memories**. Every injection is tracked. A decision that has been placed in
front of the agent at least five times and used in under 20% of those
sessions gets demoted automatically. If the agent keeps declining to act on
a memory, the system stops insisting.

Neither mechanism is exotic. Both are just refusing to grade the memory store
against itself.

## The benchmark: does the agent re-suggest what you already rejected?

The retrieval question has a sharper edge, and it's the one that costs teams
money: **given a task that invites an approach the team already ruled out,
does the agent propose it again?**

We built [VetoBench](https://github.com/adelinamart/robrain/tree/main/packages/vetobench)
to measure exactly that. A checked-in corpus of 24 engineering decisions, 10
of which carry a structured rejection with the reason (an incident, a failed
spike, a rolled-back migration). Ten scenarios each pose a task that
naturally invites one of the rejected approaches — some ask for it outright
("Add Redux Toolkit to manage global state"), some merely invite it ("propose
a caching layer for session data", where the team already ruled out Redis
after an incident).

Four memory conditions face the same tasks: no memory at all; a
conventions-file condition (every recorded *choice*, but no rejections —
what a typical CLAUDE.md contains); a flat dump of everything including
rejections; and RoBrain's top-5 retrieval with rejections rendered as
warnings. A deterministic judge — no LLM judge — checks whether the rejected
approach was re-proposed.

Results across a **five-run archived series** on 2026-07-08,
`claude-haiku-4-5`, quoted as ranges because the Anthropic path has
temperature variance — and, like every number in this post, backed by
committed receipts
([results/builtin-series-2026-07-08/](https://github.com/adelinamart/robrain/tree/main/packages/vetobench/results/builtin-series-2026-07-08)):

| Condition | Violation rate (5 runs) | Acknowledged prior rejection |
|---|---|---|
| No memory | 80–90% | 0–10% |
| Choices only (CLAUDE.md-style) | 10–20% | 80–90% |
| Everything dumped flat | 0% | 100% |
| RoBrain retrieval | 0% | 100% |

With no memory, the agent re-proposed a previously rejected approach in
eight to nine of ten tasks — usually including all four where the rejected
thing was asked for by name. With rejections in context, it re-proposed
none across all 50 cells and named the prior rejection every time. A
conventions file that records only the choices — what most teams' CLAUDE.md
contains today — still let one or two of ten through.

The fine print, because a benchmark you can't audit is marketing: an earlier
unarchived three-run series the day before ran `none` a little lower
(70–80%) and included one RoBrain violation — the agent proposing PostgreSQL
LISTEN/NOTIFY while adding "(or Redis Pub/Sub if we later adopt it)", a
hedge the deterministic judge counts because Redis appeared in the
proposal's technology list. The archived series supersedes those numbers,
but the judge behavior stands and can recur: a judge that starts excusing
hedges stops being deterministic.

Mem0 is wired in as the first third-party adapter (it receives the same
decisions as session-transcript prose; its own production pipeline decides
what becomes memories and what comes back). We ran it five times, and every
one of the 50 cells — retrieved context, agent reply, verdict — is committed
in the repo
([results/mem0-series-2026-07-07/](https://github.com/adelinamart/robrain/tree/main/packages/vetobench/results/mem0-series-2026-07-07)).
Don't take our word for anything in this paragraph; check the receipts.

Across those five runs, the recorded rejection was **absent from what Mem0
retrieved in 38% of cases (19 of 50 cells)** — and re-proposals of vetoed
approaches concentrated almost entirely there: **26% violations where the
veto had vanished vs 3% where it survived**, roughly a 9× difference. For
three scenarios — Express, axios, GraphQL — the veto was missing in every
single run. The cleanest exhibit: five runs where Mem0's memories say
"settled on Hono for its middleware model," and Express's
evaluation-and-rejection appears nowhere. The agent avoided Express every
time — the positive choice steered it — but it could never say why, and on
the axios scenario the same veto loss produced an outright violation in
three of five runs.

To be fair to Mem0: it handles most of this corpus well (0–20% violations
per run), and our absence check is a string match that can't yet distinguish
extraction loss from retrieval misses — separating those is an open, welcome
PR. But the mechanism is the point: a veto that doesn't survive ingestion
isn't just uncitable, it eventually stops protecting. That's the failure
mode a structured `rejected[]` field exists to prevent — and another thing a
retrieval score can't see.

The obvious objection: RoBrain's own condition gets its corpus with
`rejected[]` already structured, as if capture had worked perfectly. Fair —
so there's a `robrain-e2e` condition that pushes the byte-identical
transcripts through RoBrain's real production extractor and uses whatever
*that* produces. Five archived runs: 100 of 100 vetoes survived extraction,
the veto was present in all 50 retrieved contexts, zero violations. Not
because our extractor is smarter — because its prompt asks for `rejected[]`
as a first-class output field, so keeping the veto is the extractor's job
rather than a lucky side effect of fact summarization. Same synthetic-corpus
caveats apply, and those receipts are committed too.

Two more caveats, both also in the benchmark's README: at 24 decisions, the
flat dump ties retrieval — everything fits in the context window, so the
retrieval advantage RoBrain claims only matters at real corpus sizes
(hundreds of decisions). And the fixtures are synthetic and authored by us —
everything is checked in, so read them, dispute them, or send a PR that makes
us look bad. The offline retrieval layer (deterministic, no API key, CI-gated)
is reproducible to the digit on any machine.

## What the incumbents' own numbers say

This isn't an argument that existing memory benchmarks are dishonest — it's
an argument that they're saturated. Honcho's published LoCoMo results make
the point better than we could ([evals.honcho.dev](https://evals.honcho.dev),
accessed 2026-07-07, re-verified 2026-07-08): a **bare, no-memory Claude Haiku 4.5 scores 75.6** on
their overall LoCoMo table — ahead of Mem0 (66.88) and effectively tied with
Zep (75.14). Honcho's own system leads the table at 89.9, and credit to them
for publishing the bare-model baseline at all — most vendors don't. But when
a model with no memory system beats or matches shipping memory products on
the standard benchmark, the benchmark has stopped discriminating. That's why
we measure something else: not "did the item come back?" but "did the agent
repeat the mistake?" and "is the memory still true?"

## Try it

```bash
# the outcomes loop, on your own repo
npx robrain outcomes --dry-run          # scan git reverts, show matches
npx robrain outcomes record <id> --outcome revert --evidence "..."

# the benchmark — offline, no API key, identical numbers on any machine
pnpm --filter @robrain/vetobench bench

# behavioral layer — bring your own key, or run fully local
pnpm --filter @robrain/vetobench bench:live
```

RoBrain is open source (Apache 2.0) and self-hosted — Postgres in Docker,
your data stays on your machine.
[github.com/adelinamart/robrain](https://github.com/adelinamart/robrain)


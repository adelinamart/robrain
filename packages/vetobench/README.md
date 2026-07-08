# VetoBench — does memory stop an agent from re-proposing what you already rejected?

Every memory benchmark we know of asks *"did the right item come back?"*
VetoBench asks the question that actually costs teams money: **given a task
that invites an approach the team already ruled out, does the agent propose
it again?**

It is small, reproducible, and honest about what it does and doesn't show.
Anyone can re-run it; a third-party memory system can plug in by implementing
one interface.

## Design

A checked-in corpus of 24 synthetic engineering decisions (10 carry a
structured `rejected[]` with the reason — an incident, a failed spike, a
rolled-back migration). Ten scenarios each pose a task that naturally invites
one of those rejected approaches:

- **direct traps** — the task asks for the rejected thing outright
  ("Add Redux Toolkit to manage global state")
- **implicit traps** — the task merely invites it ("propose a caching layer
  for session data" → Redis)

Four memory conditions face the same scenarios:

| Condition | What the agent sees |
|---|---|
| `none` | Nothing — the floor |
| `conventions` | Every recorded *choice*, no rejected alternatives — what a typical CLAUDE.md contains |
| `flatfile` | Every decision *including* vetoes, dumped flat, no retrieval |
| `robrain` | Top-5 decisions by RoBrain's 5-signal composite score, vetoes rendered as warnings |

`conventions` vs `flatfile` isolates the value of **storing vetoes**;
`flatfile` vs `robrain` isolates **retrieval** — which the behavioral layer
cannot distinguish at this corpus size (see Honesty, below) and the retrieval
layer measures directly.

## Two layers

**Retrieval (default — offline, deterministic, CI-gated).** For each
scenario, rank the corpus with the same 5-signal composite scoring Perception
uses for `GET /decisions?query=…` and report where the veto decision lands —
with the agent's files in scope, and without (semantic + recency + approval
only). A deterministic hash embedder stands in for a live provider, so no API
key is needed and every machine gets identical numbers.

```bash
pnpm --filter @robrain/vetobench bench
```

Current fixture numbers: **veto recall@5 = 1.00 with files known · 0.70
without.** The gap is the point — file overlap genuinely rescues scenarios
the bag-of-tokens embedder misses (s04, s06, s09); real embeddings would
close some of it. The CI gate is on the files-known number (≥ 0.80).

**Behavioral (`--live` — needs an LLM key).** Each condition × scenario: the
condition's context is placed in front of the agent, the agent returns a
structured proposal (`{proposal, key_technologies, acknowledged_rejections}`),
and a deterministic judge — **no LLM judge** — checks whether the rejected
approach was re-proposed.

```bash
pnpm --filter @robrain/vetobench bench:live          # uses repo .env keys
# LLM_PROVIDER / OPENAI_BASE_URL are honored — runs fully local if configured
# --model X · --adapters none,robrain
```

Results from 2026-07-08, `claude-haiku-4-5` (the project's default
classifier model), quoted as min–max across a **five-run archived series**
([results/builtin-series-2026-07-08/](results/builtin-series-2026-07-08/) —
every retrieved context, agent reply, and verdict committed):

| Condition | Violation rate (5 runs) | Acknowledged prior rejection | Direct traps | Implicit traps |
|---|---|---|---|---|
| `none` | **80–90%** | 0–10% | 3–4/4 | 4–5/6 |
| `conventions` | 10–20% | 80–90% | 1/4 | 0–1/6 |
| `flatfile` | 0% | 100% | 0/4 | 0/6 |
| `robrain` | **0%** | 100% | 0/4 | 0/6 |

The headline: **with no memory, the agent re-proposed a previously rejected
approach in 8–9 of 10 tasks. With vetoes in context (flat dump or RoBrain
retrieval) it re-proposed none across all 50 cells, and named the prior
rejection every time.** An earlier unarchived three-run series (2026-07-07)
ran slightly lower for `none` (70–80%) and included one `robrain` violation —
a hedged parenthetical ("or Redis Pub/Sub if we later adopt it") that the
deterministic judge counts because Redis appeared in `key_technologies`; the
archived series supersedes those numbers, but that judge behavior is
documented under Violation judging and can recur.

## Third-party systems: Mem0

A [Mem0](https://github.com/mem0ai/mem0) adapter ships in-tree
([src/mem0-adapter.ts](src/mem0-adapter.ts)) as the reference third-party
implementation — the fairness contract is documented at the top of that file.
Mem0 receives the **same decision information as session-transcript prose**
(decision, rationale, and every rejected option with its reason); its own
production pipeline (`infer: true` LLM fact extraction) decides what becomes
memories, and its own semantic search retrieves top-5 per task.

```bash
node dist/run.js --live --adapters none,robrain,mem0   # needs OPENAI_API_KEY
```

Five archived runs, 2026-07-07 — `mem0ai@3.0.13` OSS (gpt-4o-mini
extraction, text-embedding-3-small), agent `claude-haiku-4-5`. Each run
re-ingests the corpus through Mem0's LLM extraction, so ingestion itself is
re-rolled every time. Every cell's retrieved context, agent reply, and
verdict is archived in
[results/mem0-series-2026-07-07/](results/mem0-series-2026-07-07/) — these
are the receipts; don't take our word for any claim below.

| Condition | Violation rate (5 runs) | Acknowledged prior rejection |
|---|---|---|
| `mem0` | **0–20%** (runs: 20, 20, 0, 20, 0) | 50–90% |

Mem0 handles most of this corpus well — say so plainly. The interesting
result is in the archived contexts. Checking all 50 cells for whether the
recorded rejection survived into what Mem0 retrieved:

- **In 19 of 50 cells (38%), the veto was absent** from the retrieved
  context — lost at extraction or not retrieved. For three scenarios it was
  absent in *all five runs*: s01 (Express), s04 (axios), s10 (GraphQL).
- **Violations concentrate exactly there: 5/19 (26%) when the veto was
  absent vs 1/31 (3%) when it was present.**
- s01 is the cleanest exhibit: the retrieved memories say "settled on Hono
  for its middleware model" — nothing anywhere about Express having been
  evaluated and declined, or why. Five runs, never once acknowledged.
- s04, where the axios veto was likewise lost every run, produced an
  outright violation in 3 of 5 runs — the agent proposing axios for the
  billing integration.

A veto that doesn't survive ingestion isn't just uncitable; it eventually
stops protecting. That is the failure mode a structured `rejected[]` field
exists to prevent. (The `robrain` condition renders `rejected[]` with every
retrieved decision, so a retrieved decision cannot arrive with its veto
stripped; whether the right decision is retrieved at all is what the offline
layer measures.)

Reproduce the series and the analysis:

```bash
for i in 1 2 3 4 5; do
  node dist/run.js --live --adapters mem0 --archive results/my-series/run-$i.json
done
```

Caveats, same rules as above: five runs; n=10; expect variance. The
veto-absence check is a string match against the retrieved context, so it
cannot distinguish extraction loss from retrieval misses — archiving Mem0's
full store per run would separate them; PRs welcome. Two
practical notes for re-runners: the adapter needs `OPENAI_API_KEY` (Mem0
OSS's default LLM and embedder), and `mem0ai` depends on the native
`better-sqlite3` module — use a Node LTS with prebuilt binaries (v20/v22);
Node 23 requires a working local C++ toolchain.

## End-to-end: `robrain-e2e`

The plain `robrain` condition isolates storage + retrieval — its corpus
arrives with `rejected[]` already structured, as if capture had worked
perfectly. That would be an unfair asymmetry to leave unmeasured: Mem0 had
to run its own extraction, so RoBrain must too. The `robrain-e2e` condition
([src/e2e-adapter.ts](src/e2e-adapter.ts)) pushes the **byte-identical
transcripts** given to Mem0 through RoBrain's real production extractor
(`extractDecisionLlm` from `@robrain/shared` — the exact prompt Sensing and
Perception run, Haiku 4.5), and whatever *that* produces becomes the corpus.
Per-decision extraction records (veto kept / dropped / decision lost) are
archived alongside the contexts.

```bash
node dist/run.js --live --adapters robrain-e2e --archive results/my-e2e/run-1.json
```

Five archived runs, 2026-07-08
([results/robrain-e2e-series-2026-07-08/](results/robrain-e2e-series-2026-07-08/)):

| Stage | Result across 5 runs |
|---|---|
| Extraction | **100/100 vetoes survived** (one veto-less distractor decision dropped once in 120 calls) |
| Retrieval | veto present in **50/50** retrieved contexts |
| Behavior | **0/50 violations**, 100% acknowledgement |

Side by side with the Mem0 series on identical input: Mem0's ingestion lost
the veto from 38% of retrieved contexts and violated in 0–20% of tasks per
run; RoBrain's full pipeline — extraction included — lost none and violated
in none. The structural reason: RoBrain's extraction prompt asks for
`rejected[]` as a first-class output field, so keeping the veto is the
extractor's *job*, not a lucky side effect of fact summarization.

Honest limits of that sentence: same 24 synthetic decisions, transcripts
whose prose explicitly enumerates the rejections (real sessions are
messier), extraction on defaults for both systems, n=10 scenarios. The
receipts for both series are committed — check the work before quoting it.

## Violation judging

A violation is counted when the rejected option appears in the reply's
`key_technologies` (the proposal relies on it), or when a conservative
per-scenario regex matches the proposal prose *and* the option is not listed
in `acknowledged_rejections` — naming an approach while declining it is a
reference, not a proposal. The bias is deliberate: violations are
undercounted, never overcounted. All judging logic is unit-tested
(`src/score.test.ts`).

## Honesty — read before quoting

- **`flatfile` ties `robrain` at this corpus size.** 24 decisions fit in any
  context window, so dumping everything works as well as retrieving the right
  five. The behavioral delta RoBrain claims is at *real* corpus sizes
  (hundreds of decisions across months), which this fixture set does not
  reach. What the benchmark does isolate: vetoes-in-context vs not
  (`conventions` → `flatfile`: 10–20% → 0% violations, and `conventions`'
  acknowledgements are inferences without recorded reasons), and retrieval
  quality directly (the offline layer).
- **Run-to-run variance is real.** The Anthropic path runs at default
  temperature; across nine runs on 2026-07-07/08 we observed `none` between
  70% and 90%. Always run at least 3× with `--archive` and quote the range,
  with the run date and model, for any number you publish.
- **Synthetic fixtures, authored by the RoBrain team.** The scenarios are
  realistic but chosen by us. The antidote is that everything is checked in —
  read the fixtures, dispute them, or add harder ones via PR.
- **The offline retrieval numbers use a hash embedder** — a reproducible
  floor, not production embedding quality.

## Adding a memory system

Implement `MemoryAdapter` (`src/types.ts`): an optional `init()` runs your
system's real ingestion once over the corpus; `buildContext()` returns the
context block your system would put in front of the agent for a scenario.
The in-tree Mem0 adapter ([src/mem0-adapter.ts](src/mem0-adapter.ts)) is the
reference — copy its shape and its fairness contract. PRs adding adapters for
other memory tools are welcome — including ones that make us look bad; that's
what the benchmark is for.

## Extending the fixtures

Add decisions to `fixtures/corpus.json` and scenarios to
`fixtures/scenarios.json`. Keep traps honest: the task should be something a
developer would actually ask, and the rejected approach should be the answer
a competent agent would naturally give without memory. Markers must be
conservative — when in doubt, undercount.

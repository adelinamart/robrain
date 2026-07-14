# Muse Spark 1.1 series

Two generations of runs live here: the quotable **five-run paid series**
(`paid-run-1..5.json`, 2026-07-14) and the earlier **exploratory free-tier
runs** (2026-07-13), kept for provenance. Quote only the paid series; the main
[VetoBench README](../../README.md) rules apply (min–max across runs, n=10
synthetic scenarios — n=9 for this model, see below).

## Paid five-run series (2026-07-14) — the quotable numbers

`meta/muse-spark-1.1` via Vercel AI Gateway (paid credits), temperature 0,
`VETOBENCH_JSON_MODE=0`, `VETOBENCH_MAX_TOKENS=8000`. All four conditions,
five runs, no rate-limit losses. Min–max across runs:

| Condition | Violations | Acknowledged prior rejection |
|---|---|---|
| `none` | **4–6 of 9 (44–67%)** | 0–1 of 9 |
| `conventions` | 0 of 9, every run | 8–9 of 9 (inferred — no recorded reasons) |
| `flatfile` | 0 of 9, every run | 8 of 9 |
| `robrain` | **0 of 9, every run** | **9 of 9, every run** |

Per-scenario consistency under `none`: Redux, Prisma, Jest, GraphQL violated
in 5/5 runs; auto-generated migrations 3/5; localStorage 1/5; Express, axios,
styled-components 0/5.

**s08 is excluded for this model (n=9):** Meta's content filter blocks the
prompt "propose a caching layer for session data" — 20 attempts across all
conditions and runs, 20 deterministic 400s (`isRetryable: false`).

## Exploratory free-tier runs (2026-07-13) — superseded, kept for provenance

## Setup

- Model: `meta/muse-spark-1.1` via **Vercel AI Gateway**
  (`OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v1`, OpenAI-compatible path;
  Meta's own Model API was not used). Agent temperature 0.
- Muse Spark is a reasoning model: it rejects `response_format: json_object`
  and spends a large hidden-reasoning budget before answering. Runs used
  `VETOBENCH_JSON_MODE=0` (prompt-only JSON; fence-tolerant parser) and
  `VETOBENCH_MAX_TOKENS=8000` (a 1024 ceiling truncates the JSON after
  ~900 reasoning tokens and would miscount as "avoided").
- Gateway **free tier** rate limits (burst of roughly ten calls per ~10 min)
  shaped these runs; later cells were paced with `VETOBENCH_THROTTLE_MS=120000`.

## Files

| File | What it is |
|---|---|
| `smoke.json` | First `none`-only attempt. 7/10 cells completed (3 rate-limited): 4 violations. |
| `run-1.json` | Full 4-condition attempt. Free-tier cooldown killed most of it: `none` completed s06/s07/s09/s10 (4/4 violations); all `robrain` cells 429'd. Conventions/flatfile cells all errored. |
| `run-1-robrain.json` | `robrain`-only rerun at 120 s pacing: **9/10 completed, 0 violations, 100 % acknowledged** (s08 errored — see below). |

Every cell records the exact `context` the model saw, its raw `reply`, and the
deterministic `verdict` — check the judging by eye; no LLM judge is involved.

## Known gaps and exclusions

- **s08 is excluded for this model.** It fails deterministically (3/3 attempts,
  all conditions) with Meta's content filter: *"The response was filtered due
  to the prompt triggering our content management policy"* — on the prompt
  "propose a caching layer for session data". Not a rate limit
  (`isRetryable: false`). Effective n = 9 for Muse Spark.
- **s04 never completed** under `none` (rate-limited in both attempts).
- Cells are stitched across separate throttled attempts, so run-to-run
  variance is visible (s07: avoided in `smoke`, violated in `run-1`).

## Combined exploratory tallies (count them yourself from the JSON)

- `none`: violations on 6 of 8 distinct scenarios that completed at least once
  (Redux, Prisma, Jest, CSS-in-JS, drizzle-kit push/generate, GraphQL).
- `robrain`: 0 violations in 9/9 completed cells; the prior rejection was
  explicitly acknowledged in every one.

## Reproduce

Any Vercel AI Gateway key works (Muse Spark is not on OpenRouter; Meta's own
portal is US-only, the gateway is not):

```bash
pnpm --filter @robrain/vetobench build
# from a directory OUTSIDE this repo (its .env would override yours), with .env:
#   LLM_PROVIDER=openai
#   OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v1
#   OPENAI_API_KEY=<your AI Gateway key>
#   VETOBENCH_JSON_MODE=0
#   VETOBENCH_MAX_TOKENS=8000
node <repo>/packages/vetobench/dist/run.js --live \
  --adapters none,conventions,flatfile,robrain \
  --model meta/muse-spark-1.1 --archive my-run.json
```

On paid gateway credits (the free tier can't sustain 40 sequential calls), a
full 4-condition run costs well under $1.

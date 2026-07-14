# Frontier no-memory baselines (2026-07-14)

`none`-condition-only runs to sanity-check cross-model claims in the Muse Spark
write-up: does any frontier model avoid re-proposing rejected approaches
*without* memory? Two runs per model — **directional, not a completed series**
(the [VetoBench rules](../../README.md) ask for 3–5 runs before quoting hard
ranges; treat these as bounds, not measurements).

Setup identical to the [Muse Spark series](../muse-spark-1.1-series/): Vercel
AI Gateway, temperature 0, `VETOBENCH_JSON_MODE=0`, `VETOBENCH_MAX_TOKENS=8000`.
Scored on the same nine scenarios (s08 excluded for comparability — Meta's
content filter blocks it for Muse Spark; these three models completed it).

| Model | No-memory violations (n=9) | Notes |
|---|---|---|
| anthropic/claude-opus-4.8 | 3–4 | best recorded |
| openai/gpt-5.5 | 5 | identical violations both runs |
| google/gemini-3-pro-preview | 6–7 | |

Cross-run constants: **Prisma and Jest were violated by every model in every
run** (as they were by Muse Spark, Haiku, and gpt-4o). No model scored zero.

Reproduce with any AI Gateway key:

```bash
node <repo>/packages/vetobench/dist/run.js --live --adapters none \
  --model anthropic/claude-opus-4.8 --archive my-baseline.json
```

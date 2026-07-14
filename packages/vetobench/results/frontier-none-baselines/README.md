# Frontier baselines — `none` and `robrain` conditions (2026-07-14)

Cross-model runs to sanity-check claims in the Muse Spark write-up: does any
frontier model avoid re-proposing rejected approaches *without* memory, and do
they all stop *with* RoBrain decision memory in context? Two runs per model per
condition — **directional, not a completed series** (the
[VetoBench rules](../../README.md) ask for 3–5 runs before quoting hard
ranges; treat these as bounds, not measurements).

Setup identical to the [Muse Spark series](../muse-spark-1.1-series/): Vercel
AI Gateway, temperature 0, `VETOBENCH_JSON_MODE=0`, `VETOBENCH_MAX_TOKENS=8000`.
Scored on the same nine scenarios (s08 excluded for comparability — Meta's
content filter blocks it for Muse Spark; these three models completed it).

| Model | `none` violations (n=9) | `robrain` violations (n=9) | `robrain` acknowledged |
|---|---|---|---|
| anthropic/claude-opus-4.8 | 3–4 | **0, both runs** | 9/9, both runs |
| openai/gpt-5.5 | 5 (identical both runs) | **0, both runs** | 9/9, both runs |
| google/gemini-3-pro-preview | 6–7 | **0, both runs** | 9/9, both runs |

Cross-run constants: **Prisma and Jest were violated by every model in every
`none` run** (as they were by Muse Spark, Haiku, and gpt-4o). No model scored
zero without memory. With RoBrain context, no model violated anywhere:
combined with the [Muse Spark five-run series](../muse-spark-1.1-series/),
**99 of 99 `robrain` cells across four vendors — zero re-proposals, the prior
rejection named in every cell.**

Reproduce with any AI Gateway key:

```bash
node <repo>/packages/vetobench/dist/run.js --live --adapters none \
  --model anthropic/claude-opus-4.8 --archive my-baseline.json
```

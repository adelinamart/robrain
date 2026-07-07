# @robrain/eval — retrieval-quality eval

A small, reproducible eval of RoBrain's memory retrieval. It exists so you
don't have to take retrieval-quality claims on faith: anyone can re-run the
same fixtures and get the same numbers.

## What it measures

The harness replays a fixed set of queries against a checked-in fixture
corpus (24 synthetic decisions across auth, database, frontend, testing, and
deployment topics) and scores every decision with the **same 5-signal
composite math** Perception uses for `GET /decisions?query=…`:

| Signal | Weight |
|--------|--------|
| semantic similarity | 0.32 |
| file overlap | 0.27 |
| recency | 0.18 |
| historical relevance | 0.13 |
| approval state | 0.10 |

Weights come from `@robrain/shared` (`SCORING_WEIGHTS`) — the same constants
Perception inlines into its SQL. The authoritative scoring implementation
lives in `packages/perception-self-hosted/src/index.ts` (GET /decisions,
`scoreExpr`); `src/scoring.ts` here replicates it, and `src/scoring.test.ts`
pins the weights so any drift fails the suite.

For each query it reports **precision@5** and **recall@5**, plus aggregate
means. The process exits nonzero when the aggregate falls below the
thresholds at the top of `src/run.ts`, so it can gate CI.

## Running it

From the repo root:

```bash
pnpm install
pnpm --filter @robrain/eval eval
```

Sample output:

```
query    p@5    r@5   retrieved (✓ = expected)
q01     0.60   1.00   ✓d001 ✓d004 ✓d002  d021  d015
...
aggregate: mean p@5 0.42 · mean r@5 0.95
✓ PASS
```

Unit tests for the scoring replica and the embedder:

```bash
pnpm --filter @robrain/eval test
```

## Determinism (why it runs offline)

- **Embeddings** come from a deterministic bag-of-tokens hash embedder
  (`src/embedder.ts`) instead of a live provider, so no API key is needed and
  results are identical on every machine. The `Embedder` type is pluggable —
  swap in a real provider client to eval against production embeddings.
- **Recency** is computed against the fixed `as_of` date stored in
  `fixtures/queries.json`, not wall-clock time, so scores don't drift as the
  fixtures age.

## Fixtures

- `fixtures/decisions.json` — the corpus: id, decision, rationale,
  files_affected, created_at, reviewed_at, historical_relevance.
- `fixtures/queries.json` — the queries: text, files in scope, and the
  decision ids a good retrieval should return.

To extend the eval, add decisions and queries there; keep expected sets
honest (what a developer would actually want injected for that query).

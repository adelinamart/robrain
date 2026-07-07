# Memory interchange format — `robrain-memory/v1`

`robrain export --format interchange` writes the project's decision corpus as
[JSONL](https://jsonlines.org/): one JSON object per line, one memory per
object. The goal is that other agent-memory tools can import RoBrain memories
without talking to Perception or its database.

[← Back to README](https://github.com/adelinamart/robrain)

## Producing a file

```bash
npx robrain export --format interchange                 # JSONL to stdout (status on stderr)
npx robrain export --format interchange --out memories.jsonl
```

The export includes the full lifecycle — superseded and invalidated memories
are present too, marked in `lifecycle`. Importers that only want live
memories should keep lines where `lifecycle.invalidated_at` is `null`.

## One line, one memory

```json
{"format":"robrain-memory/v1","id":"5f3c…","decision":"Use pnpm for all workspace commands","rationale":"Repo is standardized on pnpm","rejected":[{"option":"npm","reason":"lockfile drift"}],"files_affected":["package.json"],"scope":"team","lifecycle":{"created_at":"2026-05-01T10:00:00.000Z","invalidated_at":null,"reviewed_at":"2026-05-02T09:00:00.000Z","supersedes_id":null},"provenance":{"session_id":"2026-05-01T09:58:11.873Z-8e39","source_turn_sequence":4,"source_excerpt":"please only ever use pnpm here"},"quality":{"historical_relevance":0.62,"injected_count":14,"used_count":11}}
```

## Fields

Every line has every field. Optional values are explicit `null`s, never
missing keys, so importers can rely on the shape.

### Top level

| Field | Type | Meaning |
|-------|------|---------|
| `format` | string | Always `"robrain-memory/v1"`. Check this first; reject lines with a different value. |
| `id` | string | Stable unique id of the memory (UUID in RoBrain's database). Use it for dedup on re-import. |
| `decision` | string | The decision itself, in plain language. This is the text a tool would inject into an agent's context. |
| `rationale` | string \| null | Why the decision was made. |
| `rejected` | array | Alternatives that were considered and turned down. Each entry is `{"option": string, "reason": string}`. Empty array when none were captured. |
| `files_affected` | string[] | Repo-relative file paths the decision applies to. Empty array for project-wide decisions. |
| `scope` | string | How widely the decision applies: `user`, `local`, `team`, or `global`. |

### `lifecycle` — is this memory still in effect?

| Field | Type | Meaning |
|-------|------|---------|
| `created_at` | string (ISO 8601) | When the memory was captured. |
| `invalidated_at` | string \| null | When it stopped being in effect (superseded or rejected in review). `null` = still live. |
| `reviewed_at` | string \| null | When a human explicitly approved it. `null` = captured but never reviewed — treat with less trust. |
| `supersedes_id` | string \| null | `id` of the earlier memory this one replaced, so importers can rebuild the decision chain. |

### `provenance` — where it came from

| Field | Type | Meaning |
|-------|------|---------|
| `session_id` | string | Id of the coding session the decision was captured in. |
| `source_turn_sequence` | number \| null | Turn number within that session (1-based). `null` on rows captured before provenance snapshots existed. |
| `source_excerpt` | string \| null | Up to 300 characters of the user message that originated the decision — the human words behind the memory. |

### `quality` — how the memory has performed

| Field | Type | Meaning |
|-------|------|---------|
| `historical_relevance` | number \| null | 0–1 score fed by the feedback loop: rises when injections are used and outcomes are confirmed, falls on ignored injections, reverts, and incidents. `null` on rows from older servers. |
| `injected_count` | number | How many times the memory was injected into an agent's context. |
| `used_count` | number | Of those injections, how many times the reply actually drew on it. A large `injected_count` with a tiny `used_count` marks a memory agents consistently ignore. |

## Versioning

The `format` field is the contract. Breaking changes to any field will ship
as `robrain-memory/v2`; `v1` lines will keep the shape documented here.
Additive changes within `v1` may introduce new fields — importers should
ignore keys they don't recognize.

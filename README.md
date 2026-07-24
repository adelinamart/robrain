# RoBrain

[![VetoBench](https://img.shields.io/badge/VetoBench-0%2F50_violations_·_receipts_in--repo-2ea44f)](#vetobench)

**Shared memory across your team and your AI agents — with judgment!**

RoBrain isn't just another memory layer — it's the brain that helps you and your agents make better decisions and avoid costly mistakes.

Self-hosted on your own Postgres. Passive capture, structured vetoes, corpus-wide contradiction scans — nothing leaves your machine. Works with Claude Code, Cursor, GitHub Copilot (VS Code), Codex CLI, Hermes and more.

Measured: without decision memory, a coding agent re-proposes an approach your team already rejected in up to **9 of 10** tasks. Through RoBrain's full pipeline: **0 of 50**, across five archived runs — [VetoBench](#vetobench).

## What it is

RoBrain records what your team and its agents decide — and the alternatives they ruled out — without anyone tagging anything by hand. Sensing captures session turns; Perception extracts each decision into Postgres, where every row can carry a structured `rejected[]` field.

Most agent-memory tools stop at capture: they store what happened and hope you query it later. RoBrain adds judgment. Batch **Synthesis** reads the whole corpus to flag contradictions, stance drift, and recurring entities that no single session could see.

The point is the handoff. Someone makes a deliberate call in Cursor on Tuesday — say, keeping Perception on Hono instead of porting to Express. A new teammate opens Claude Code on Wednesday with no memory of it and asks to make exactly that change. RoBrain surfaces the recorded rationale before the agent steers down a path you already rejected — same Postgres store, same vetoes, captured passively.

> The cost of forgetting a rejection isn't inefficiency. It's the auth bypass you already patched, the migration you already rolled back, the dependency you already removed for a CVE — re-suggested by an agent with no memory of why you said no.

Coding is the first vertical because the feedback loops are tight — reverts, incidents, and rework make the cost of a forgotten rejection measurable. The same architecture applies wherever agents make decisions that outlast a session.

How it works, the two pillars (capture + judgment), and the full walkthrough: [docs/concepts.md](docs/concepts.md#how-it-works).

## Install

Two ways to run RoBrain — pick one:

- **Option 1 · Self-hosted** (free, open source): everything runs on your machine — your Postgres, your API keys, nothing leaves your laptop.
- **Option 2 · [Rory Plans cloud](#option-2--rory-plans-cloud-managed)** (managed): nothing to host, no keys — included with every paid Rory Plans plan.

### Option 1 · Self-hosted (free, open source)

No clone needed — `robrain up` pulls the published Perception image and generates credentials into `~/.robrain/stack/.env`:

```bash
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...   # or add them to ~/.robrain/stack/.env after the first run
npx robrain@latest up                             # start Postgres + Perception from ghcr.io
npx robrain install --self-hosted                 # wire Sensing MCP into your editors
```

<details>
<summary>From a clone instead (development, or building the image yourself)</summary>

First `pnpm docker:up` auto-creates `.env` and fills `PERCEPTION_API_KEY` / `POSTGRES_PASSWORD`. Perception still needs your LLM + embedding keys before it stays up.

```bash
git clone https://github.com/adelinamart/robrain
cd robrain
pnpm install && pnpm build
pnpm docker:up                 # first run: creates .env; Perception won't start yet
# open .env, add ANTHROPIC_API_KEY + your embedding key (e.g. OPENAI_API_KEY)
pnpm docker:up                 # second run: Perception now boots
npx robrain install --self-hosted --repo-root "$(pwd)"
```

</details>

#### Claude Code plugin (self-hosted)

Claude Code users on the self-hosted stack can add hook-based capture and pre-task warnings about previously rejected approaches — no CLAUDE.md protocol needed:

```bash
claude plugin marketplace add adelinamart/robrain
claude plugin install robrain@robrain
```

Details: [plugins/claude-code](plugins/claude-code/README.md). `robrain init-project` also recommends the plugin to collaborators via the project's `.claude/settings.json`, so teammates get an install prompt from Claude Code itself (opt out with `--skip-claude-plugin`).

### Option 2 · Rory Plans cloud (managed)

On any paid Rory Plans plan, RoBrain runs without hosting anything:

```bash
npx robrain install          # no flags — cloud mode
```

Sign in at [roryplans.ai](https://roryplans.ai), create an API token on your profile page, and paste it when the installer asks. That's the whole setup: no Docker, no database, no LLM or embedding keys — extraction and search run on our side. Your editors (Claude Code, Cursor, Copilot, Codex CLI) are wired automatically, and teammates on your Rory Plans team share the same memory.

Every paid plan qualifies — individual standard or annual, Teams, and enterprise. Solo subscribers get a private memory space; teams share one. Self-hosting stays free and fully supported (see Install above); the [comparison table](#self-hosted-vs-rory-plans-cloud) shows what each tier adds.

OpenAI-only: set `LLM_PROVIDER=openai` and `OPENAI_API_KEY` instead of Anthropic — see [Concepts — Prefer not to use Anthropic](docs/concepts.md#prefer-not-to-use-anthropic-run-openai-only).

Upgrading a self-hosted install on a new release — no-clone stack: just re-run `npx robrain@latest up`. From a clone: `git pull` → `pnpm install && pnpm build` → `pnpm docker:up:build` → `npx robrain install --self-hosted --repo-root "$(pwd)"` → fully restart editors. Full checklist: [CLI reference — Upgrading](docs/cli.md#upgrading).

## Quickstart

After either install (self-hosted or cloud):

```bash
# Wire capture into an application project (run inside the repo)
cd /path/to/your/project
npx robrain init-project          # writes CLAUDE.md, AGENTS.md, .cursor/rules/robrain.mdc

# Capture and recall are automatic from here:
#   - every session turn is classified, no tagging
#   - prior decisions load at session start via the always-on summary

# Explain any file's decision history
npx robrain explain path/to/file

# Inspect / approve captured rows (both modes)
npx robrain review

# Run corpus judgment — self-hosted only; cloud runs judgment server-side
npx robrain synth                 # drift, contradictions, entity promotion
```

After `init-project`, every repo gets `CLAUDE.md` and `AGENTS.md` (Codex CLI), and Cursor also gets `.cursor/rules/robrain.mdc` with `alwaysApply: true`. If captures don't land, run `npx robrain doctor` — see [Troubleshooting](docs/troubleshooting.md).

## Synthesis

Synthesis runs three passes over the full `decisions` table — **drift** (stance moving without an explicit reversal), **contradictions** (incompatible decisions from different sessions), and **entity promotion** (recurring tools/patterns condensed into `planning_blocks`). It writes flags and edges into your DB; it does not capture new decisions — it judges the corpus you already have.

```bash
pnpm synthesis:build && pnpm synthesis:run
# or: npx robrain synth
```

Review what it finds with `npx robrain review`. Deep dive (three passes, cron, env vars): [Concepts — Synthesis](docs/concepts.md#synthesis).

## Editor integration

One cross-tool setup covers **Claude Code, Cursor, GitHub Copilot (VS Code), and Codex CLI** against the same Postgres store. The classifier LLM is your choice — Anthropic Haiku or OpenAI. Decisions carry a lifecycle (active / superseded / invalidated) and a graph (`conflicts_with` / `extends` / `related_to`).

**Codex CLI / IDE** also gets hook-based capture and pre-task veto warnings — the same lifecycle hooks as the Claude Code plugin, wired automatically by `robrain install` into `~/.codex/config.toml` (Codex asks you to trust them on first run). Docs: [plugins/codex](plugins/codex/README.md).

Running [Hermes](https://github.com/NousResearch/hermes-agent)? `npx robrain install --hermes` drops a standalone memory-provider plugin into `~/.hermes/plugins/` — passive capture and veto-aware recall through the same Perception API. Docs: [integrations/hermes](integrations/hermes/robrain/README.md).

Decision ledger for git (opt-in):

```bash
npx robrain export-memory --ledger
# custom path: npx robrain export-memory --ledger docs/decisions.md
```

## Compared to other tools

Versus **Mem0**, **Cloudflare Agent Memory**, and **Claude Code Auto-Memory**: only RoBrain stores rejected alternatives as structured fields and runs corpus-wide contradiction scans (manual or cron). And we measured what that difference costs: [VetoBench](#vetobench) found Mem0's ingestion dropped the recorded rejection from **38% of retrieved contexts** on identical input. [Full comparison →](docs/concepts.md#comparisons)

### Self-hosted vs Rory Plans cloud

| Feature | Free / self-hosted | Rory Plans cloud |
|---------|-------------------|------------------|
| Passive session capture | ✓ | ✓ |
| `rejected[]` field as structured data | ✓ | ✓ |
| Decision lifecycle (active / superseded / invalidated) | ✓ | ✓ |
| Cross-tool MCP — Claude Code, Cursor, Copilot, Codex CLI, Hermes | ✓ | ✓ |
| Classifier LLM choice — Anthropic Haiku or OpenAI | ✓ | ✓ |
| Always-on summary at session start | ✓ | ✓ |
| `npx robrain review` / `inject` / `explain` / `export-memory` | ✓ | ✓ |
| Synthesis — drift, contradictions, entity promotion | ✓ | ✓ |
| Decision graph (`conflicts_with` / `extends` / `related_to`) | ✓ | ✓ |
| Provenance on every memory — source session, turn, excerpt | ✓ | ✓ |
| Memory quality feedback — used/ignored counters, auto-demotion | ✓ | ✓ richer: helpful/pushback per injection |
| Outcome linking — git reverts feed back into memory rank | ✓ | ✓ |
| Secrets redaction at capture and ingest | ✓ | ✓ |
| Memory interchange export (`robrain-memory/v1` JSONL) | ✓ | ✓ |
| Open retrieval eval + VetoBench gates in CI | ✓ | same scorer |
| Self-host on your infrastructure | ✓ | — |
| Your data stays local | ✓ | processed remotely |
| Fully-local mode — LLM + embeddings on Ollama/LM Studio/vLLM | ✓ | — |
| Calibrated extraction prompt (fewer false positives) | — | ✓ |
| Calibrated 4-way contradiction taxonomy | — | ✓ |
| Automatic injection at task boundaries | — | ✓ |
| Deterministic veto scan (`POST /veto-scan`) | ✓ | — |
| Pre-task `rejected[]` warning | Claude Code (plugin) + Codex (hooks) + Hermes (provider) | ✓ everywhere |
| Disengagement protocol (⚠ acknowledgement) | — | ✓ |
| Pre-commit conflict verdict (`/dry-run` structured check) | — | ✓ |
| 5-signal relevance scorer | ✓ on retrieval (`GET /decisions?query=`) | ✓ applied automatically per task |
| Conflict auto-resolution (guard-railed) + dashboard visualizations | — | ✓ |
| Vetoes survive supersession — rejection history follows the newest decision | ✓ | ✓ full history merge |
| Write-time supersession detection — "we switched X→Y" never dedups away | — | ✓ |
| Decision lineage timeline (API + dashboard) | — | ✓ |
| Team memory — orgs, API keys, roles, scoped isolation | — | ✓ |
| Web dashboard | — | ✓ |

Self-hosted gives capture, judgment batch jobs, outcomes feedback, and session-start recall; you pull focused context with `inject` when needed. Cloud adds Planning + Control so vetoes and conflicts surface automatically at task boundaries — same CLI surface, wire-compatible with Sensing capture. Details: [Concepts — Free / self-hosted vs Rory Plans cloud](docs/concepts.md#free--self-hosted-vs-rory-plans-cloud).

## VetoBench

Memory benchmarks usually ask "did the right item come back?" [VetoBench](packages/vetobench/README.md) asks what that misses: **given a task that invites an approach the team already rejected, does the agent propose it again?**

| Memory condition | Re-proposed a rejected approach | Could cite the prior rejection |
|---|---|---|
| No memory | 8–9 of 10 tasks | 0–10% |
| Conventions file (choices only — what most teams have today) | 1–2 of 10 | 80–90%, but inferred: the reasons aren't there |
| Mem0 — full pipeline, 5 archived runs | 0–2 of 10 per run | 50–90% |
| **RoBrain — full pipeline, 5 archived runs** | **0 of 10, every run** | **100%** |

(claude-haiku-4-5, 2026-07-07/08; every condition measured as a five-run archived series, ranges because runs vary. Mem0 and RoBrain ingested **byte-identical transcripts**, each through its own real production extraction.)

Two findings behind the table. Mem0's ingestion dropped the recorded rejection from **38% of retrieved contexts**, and violations concentrated exactly there — 26% when the veto was absent vs 3% when present: the agent avoided Express in all five runs but could never say why, and where the axios veto was lost it re-proposed axios outright in 3 of 5 runs. RoBrain's production extractor, on the same input, kept **100/100 vetoes** — keeping the veto is the extraction prompt's job, not a side effect of fact summarization.

**Meta Muse Spark 1.1 (2026-07-14, five archived runs).** Meta's newly launched agentic flagship, via Vercel AI Gateway. Without memory it re-proposed rejected approaches in **4–6 of 9 tasks per run** — Redux, Prisma, Jest, and GraphQL in all five runs. With RoBrain decision memory: **0 violations in all 45 cells, naming the prior rejection every time** — quoting the recorded reason and date verbatim where it elaborated. The cleanest cell: asked to cut mobile overfetching, the no-memory run proposed a full GraphQL rollout (the approach the team had ruled out) five runs out of five; with RoBrain in context it proposed REST sparse fieldsets and quoted the recorded rejection. Honest notes: this is not a Muse Spark problem — every frontier model we baselined violates without memory on the same nine scenarios (claude-opus-4.8: 3–4, gpt-5.5: 5, gemini-3-pro-preview: 6–7, Haiku 7–8; Prisma and Jest fell to every model in every run — and with RoBrain context those same three models went **0 violations in 54/54 cells**, for 99/99 across four vendors — [receipts](packages/vetobench/results/frontier-none-baselines/)), a bare conventions file also prevented violations for this model at this corpus size (the RoBrain delta is verbatim citations vs inferences, automatic capture, and retrieval at scale), and one scenario is excluded (n=9) because Meta's content filter deterministically blocks a benign session-caching prompt. Receipts and caveats: [results/muse-spark-1.1-series/](packages/vetobench/results/muse-spark-1.1-series/) · write-up: [docs/blog/2026-07-14-muse-spark-forgets-your-vetoes.md](docs/blog/2026-07-14-muse-spark-forgets-your-vetoes.md).

Every retrieved context, agent reply, and verdict is committed in [packages/vetobench/results/](packages/vetobench/results/) — check the work before quoting it. The retrieval layer runs offline with no API key and gates CI (`pnpm --filter @robrain/vetobench bench`); judging is deterministic — no LLM judge. Any memory system plugs in through one adapter interface; PRs welcome, including ones that make us look bad. Methodology, honesty caveats, and fixtures: [packages/vetobench/README.md](packages/vetobench/README.md).

## Security

The memory corpus is guarded by `PERCEPTION_API_KEY` — a random secret in the repo-root `.env` that every client (Sensing MCP, CLI, Synthesis) sends as a Bearer token and Perception verifies on every request except `/health`. It is not issued by any service: `pnpm docker:up` generates one automatically on first run, or set your own (e.g. `openssl rand -hex 32`). `npx robrain install --self-hosted` copies the same value into your editor configs so clients authenticate.

Perception refuses to start when the key is empty — running unauthenticated requires an explicit opt-in. **Upgrading from a version that ran without a key:** add one to `.env` (or re-run `pnpm docker:up` to auto-fill it), then re-run `npx robrain install --self-hosted` so editors pick it up. Details and the opt-in flag are documented in [`.env.example`](.env.example).

Also on by default: secrets redaction (API keys, tokens, private keys, connection-string passwords are scrubbed at capture and again at ingest, before anything is embedded or stored), and a fully-local mode where extraction and embeddings run on an OpenAI-compatible local server (Ollama / LM Studio / vLLM) — see [CLI — Fully-local LLM](docs/cli.md#fully-local-llm-ollama--lm-studio--vllm) and [`.env.example`](.env.example).

## What's next

`robrain outcomes` feeds git reverts back into memory quality on both tiers; next is widening that to incidents and cycle time, so RoBrain can surface when a team is optimizing for the wrong thing in its own codebase.

## Requirements

- Docker + Docker Compose (runs Postgres and Perception locally)
- Node.js with pnpm (build and CLI)
- An LLM key for the classifier — Anthropic Haiku or OpenAI — **or** a local OpenAI-compatible server (see [Fully-local LLM](docs/cli.md#fully-local-llm-ollama--lm-studio--vllm))
- An embedding key (e.g. OpenAI) — or the same local server for embeddings
- No data leaves your machine in self-hosted mode

## Docs

- Concepts (how it works, two pillars, Synthesis, comparisons) → [docs/concepts.md](docs/concepts.md)
- CLI reference (`explain`, install, upgrading, editor setup, full command table) → [docs/cli.md](docs/cli.md)
- Fully-local LLM (Ollama / LM Studio / vLLM, no cloud keys) → [docs/cli.md#fully-local-llm-ollama--lm-studio--vllm](docs/cli.md#fully-local-llm-ollama--lm-studio--vllm)
- **Maintainer release checklist** (tag → GHCR → npm → MCP registry) → [docs/release.md](docs/release.md)
- Troubleshooting (silent 401s, Docker rebuilds, stale summaries, local LLM) → [docs/troubleshooting.md](docs/troubleshooting.md)
- Memory interchange format (`robrain export`, `robrain-memory/v1` JSONL) → [docs/memory-interchange.md](docs/memory-interchange.md)
- VetoBench (does memory stop rejected re-proposals? methodology + archived receipts) → [packages/vetobench/README.md](packages/vetobench/README.md)
- Claude Code plugin (hook-based capture + veto warnings) → [plugins/claude-code/README.md](plugins/claude-code/README.md)
- Codex CLI hooks (same lifecycle hooks, wired by `robrain install`) → [plugins/codex/README.md](plugins/codex/README.md)
- eve agents (Vercel's agent framework — dynamic-instructions memory, veto tool, capture hook; verified against `eve dev`) → [plugins/eve/README.md](plugins/eve/README.md)
- Hermes agent plugin (memory-provider, capture + veto warnings) → [integrations/hermes/robrain/README.md](integrations/hermes/robrain/README.md)

## Contributing

Apache 2.0. PRs welcome for extraction accuracy, new editor integrations, and embedding providers. See [Concepts — Reference](docs/concepts.md#reference) for tradeoffs and schema.

## License

Apache 2.0 — see [LICENSE](./LICENSE)

Built by [Rory Plans](https://roryplans.ai)
